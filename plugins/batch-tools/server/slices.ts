// Hardened `quick_outline` and `read_slices` tools with fail-closed PolicyGuard
// authorization, per-call canonical-path file caching, breadth-first outline
// packing, water-filling UTF-8 byte/char budgets, audit logging, and secret redaction.
import path from "node:path";
import type { AuditLog } from "./audit.ts";
import {
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  clampInt,
  computeWaterFillBudgets,
  fitSectionsToByteBudget,
  truncateWithByteNotice,
  utf8ByteLength,
} from "./budget.ts";
import { readTextFile, toPosixPath } from "./fs.ts";
import {
  extractSymbolsFromLines,
  formatSymbolLine,
  type SymbolEntry,
} from "./outline.ts";
import type { PolicyGuard, ResolvedTarget } from "./policy.ts";
import { redactSecrets } from "./redact.ts";

export interface SliceRequest {
  path: string;
  ranges: Array<[number, number]>;
}

export interface ReadSlicesInput {
  cwd?: string;
  outlines?: string[] | string;
  slices?: Array<SliceRequest | string> | string;
  lineRanges?: string[] | string;
  maxChars?: number;
}

export interface QuickOutlineInput {
  cwd?: string;
  paths?: string[] | string;
  maxChars?: number;
}

export interface SlicesRuntimeDeps {
  policy: PolicyGuard;
  audit?: AuditLog;
}

type ToolName = "quick_outline" | "read_slices";

const MAX_OUTLINES = 40;
const MAX_SLICE_FILES = 30;
const MIN_MAX_CHARS = 500;

const SLICE_TRUNCATION_TIP =
  "\n[tip: responses are capped <=8.8KB inline; narrow ranges or split large reads across calls]";
const OUTLINE_BATCH_TIP =
  "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";

const EXAMPLES = {
  quick_outline: '{"paths":["src/app.ts"]}',
  read_slices: '{"outlines":["src/app.ts"],"lineRanges":["src/app.ts:1-60"]}',
  read_slices_line_range: '{"lineRanges":["src/app.ts:1-60"]}',
} as const;

function withExample(message: string, example: string): string {
  return `${message}\nExample: ${example}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array (len=${value.length})`;
  if (typeof value === "boolean") return `boolean (${String(value)})`;
  if (typeof value === "number") return `number (${String(value)})`;
  if (typeof value === "string") return `string (len=${value.length})`;
  return typeof value;
}

type ParsedArray =
  | { ok: true; value: unknown[] }
  | { ok: false; detail: string };

function parseMaybeJsonArray(value: unknown): ParsedArray {
  if (Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, detail: "empty string" };
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
      return {
        ok: false,
        detail: `decoded to ${describeType(parsed)} instead of a JSON array`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: false, detail: describeType(value) };
}

function parseMaybeStringOrJsonArray(value: unknown): ParsedArray {
  const parsed = parseMaybeJsonArray(value);
  if (parsed.ok) return parsed;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      !trimmed ||
      trimmed.startsWith("[") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("```") ||
      /[\r\n]/.test(trimmed) ||
      parsed.detail.startsWith("decoded to ")
    ) {
      return parsed;
    }
    return { ok: true, value: [trimmed] };
  }
  return parsed;
}

function parseSliceShorthand(
  raw: string,
  label: string,
): { ok: true; value: SliceRequest } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const match = /^(.+):(\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)$/.exec(trimmed);
  if (!match || !match[1] || !match[1].trim() || !match[2]) {
    return {
      ok: false,
      error: withExample(
        `Error: ${label} must use 'path:start-end' or 'path:start1-end1,start2-end2' format (got ${JSON.stringify(raw)}).`,
        EXAMPLES.read_slices_line_range,
      ),
    };
  }
  const filePath = match[1].trim();
  const ranges: Array<[number, number]> = match[2].split(",").map((part) => {
    const seg = part.trim();
    const dash = seg.indexOf("-");
    if (dash === -1) {
      const n = Number(seg);
      return [n, n];
    }
    return [Number(seg.slice(0, dash)), Number(seg.slice(dash + 1))];
  });
  return { ok: true, value: { path: filePath, ranges } };
}

function formatNestedOmissionFooter(omittedNested: number, compact = false): string {
  return compact
    ? `\n... (+${omittedNested} nested)`
    : `\n... (+${omittedNested} nested symbols omitted)`;
}

function pickTopLevelOmissionFooter(
  omittedTop: number,
  minStart: number,
  maxEnd: number,
  hasOmittedNested: boolean,
  availChars: number,
  availBytes: number,
): string | null {
  const candidates = [
    hasOmittedNested
      ? `\n... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted, plus nested)`
      : `\n... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted)`,
    `\n... (+${omittedTop} more in L${minStart}-L${maxEnd} omitted)`,
    `\n... (+${omittedTop} L${minStart}-L${maxEnd})`,
  ];
  for (const cand of candidates) {
    if (cand.length <= availChars && utf8ByteLength(cand) <= availBytes) {
      return cand;
    }
  }
  return null;
}

function packOutlineToBudget(
  header: string,
  symbols: readonly SymbolEntry[],
  charBudget: number,
  byteBudget: number,
): string {
  if (charBudget <= 0 || byteBudget <= 0) {
    return "";
  }

  const items = symbols.map((sym) => {
    const line = formatSymbolLine(sym);
    return {
      line,
      chars: line.length + 1,
      bytes: utf8ByteLength(line) + 1,
    };
  });

  const headerChars = header.length;
  const headerBytes = utf8ByteLength(header);
  if (headerChars > charBudget || headerBytes > byteBudget) {
    return truncateWithByteNotice(header, charBudget, byteBudget).text;
  }

  let fullChars = headerChars;
  let fullBytes = headerBytes;
  for (const item of items) {
    fullChars += item.chars;
    fullBytes += item.bytes;
  }

  if (fullChars <= charBudget && fullBytes <= byteBudget) {
    return `${header}\n${items.map((it) => it.line).join("\n")}`;
  }

  const byDepth = new Map<number, number[]>();
  for (let idx = 0; idx < symbols.length; idx++) {
    const sym = symbols[idx];
    if (!sym) continue;
    const d = sym.depth;
    let list = byDepth.get(d);
    if (!list) {
      list = [];
      byDepth.set(d, list);
    }
    list.push(idx);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const topDepth = depths[0] ?? 0;
  const topIndices = byDepth.get(topDepth) ?? [];
  const nestedTotalCount = symbols.length - topIndices.length;

  let topChars = headerChars;
  let topBytes = headerBytes;
  for (const idx of topIndices) {
    const item = items[idx];
    if (!item) continue;
    topChars += item.chars;
    topBytes += item.bytes;
  }

  // Branch A: All top-level (minimum-depth) symbols fit alongside a nested-omission footer;
  // backfill deeper levels breadth-first.
  if (nestedTotalCount > 0) {
    const fullNestedFooter = formatNestedOmissionFooter(nestedTotalCount, false);
    const compactNestedFooter = formatNestedOmissionFooter(nestedTotalCount, true);
    const fitsFullNested =
      topChars + fullNestedFooter.length <= charBudget &&
      topBytes + utf8ByteLength(fullNestedFooter) <= byteBudget;
    const fitsCompactNested =
      !fitsFullNested &&
      topChars + compactNestedFooter.length <= charBudget &&
      topBytes + utf8ByteLength(compactNestedFooter) <= byteBudget;

    if (fitsFullNested || fitsCompactNested) {
      const useCompact = !fitsFullNested;
      const selected = new Set<number>(topIndices);
      let usedChars = topChars;
      let usedBytes = topBytes;
      let omittedNested = nestedTotalCount;
      let stopped = false;

      for (const d of depths) {
        if (d === topDepth) continue;
        if (stopped) break;
        const indices = byDepth.get(d) ?? [];
        for (const idx of indices) {
          const item = items[idx];
          if (!item) continue;
          const nextOmitted = omittedNested - 1;
          const nextFooter =
            nextOmitted > 0
              ? formatNestedOmissionFooter(nextOmitted, useCompact)
              : "";
          if (
            usedChars + item.chars + nextFooter.length <= charBudget &&
            usedBytes + item.bytes + utf8ByteLength(nextFooter) <= byteBudget
          ) {
            selected.add(idx);
            usedChars += item.chars;
            usedBytes += item.bytes;
            omittedNested = nextOmitted;
          } else {
            stopped = true;
            break;
          }
        }
      }

      const ordered = [...selected].sort((a, b) => a - b);
      const footer =
        omittedNested > 0 ? formatNestedOmissionFooter(omittedNested, useCompact) : "";
      if (ordered.length === 0) {
        return `${header}${footer}`;
      }
      return `${header}\n${ordered.map((idx) => items[idx]?.line ?? "").join("\n")}${footer}`;
    }
  }

  // Branch B: Even top-level symbols overflow budget; fit prefix + exact L<min>-L<max> footer.
  const m = topIndices.length;
  const suffixMinStart = new Array<number>(m);
  const suffixMaxEnd = new Array<number>(m);
  for (let k = m - 1; k >= 0; k--) {
    const sym = symbols[topIndices[k] ?? 0];
    if (!sym) continue;
    if (k === m - 1) {
      suffixMinStart[k] = sym.startLine;
      suffixMaxEnd[k] = sym.endLine;
    } else {
      suffixMinStart[k] = Math.min(sym.startLine, suffixMinStart[k + 1] ?? sym.startLine);
      suffixMaxEnd[k] = Math.max(sym.endLine, suffixMaxEnd[k + 1] ?? sym.endLine);
    }
  }

  const tryPackPrefix = (
    tier: "full" | "compact",
  ): { pickedCount: number; footer: string } => {
    let usedChars = headerChars;
    let usedBytes = headerBytes;
    let pickedCount = 0;
    let chosenFooter = "";

    for (let k = 0; k < m; k++) {
      const nextOmitted = m - (k + 1);
      const item = items[topIndices[k] ?? 0];
      if (!item) break;
      if (nextOmitted === 0) {
        if (
          usedChars + item.chars <= charBudget &&
          usedBytes + item.bytes <= byteBudget
        ) {
          pickedCount = k + 1;
          chosenFooter = "";
        }
        break;
      }
      const remChars = charBudget - (usedChars + item.chars);
      const remBytes = byteBudget - (usedBytes + item.bytes);
      const minStart = suffixMinStart[k + 1] ?? 1;
      const maxEnd = suffixMaxEnd[k + 1] ?? minStart;
      const candFooter =
        tier === "full"
          ? (() => {
              const full =
                nestedTotalCount > 0
                  ? `\n... (+${nextOmitted} more top-level symbols in L${minStart}-L${maxEnd} omitted, plus nested)`
                  : `\n... (+${nextOmitted} more top-level symbols in L${minStart}-L${maxEnd} omitted)`;
              return full.length <= remChars && utf8ByteLength(full) <= remBytes
                ? full
                : null;
            })()
          : pickTopLevelOmissionFooter(
              nextOmitted,
              minStart,
              maxEnd,
              nestedTotalCount > 0,
              remChars,
              remBytes,
            );
      if (candFooter !== null) {
        usedChars += item.chars;
        usedBytes += item.bytes;
        pickedCount = k + 1;
        chosenFooter = candFooter;
      } else {
        break;
      }
    }
    return { pickedCount, footer: chosenFooter };
  };

  let packed = tryPackPrefix("full");
  if (packed.pickedCount === 0) {
    packed = tryPackPrefix("compact");
  }

  if (packed.pickedCount > 0) {
    const pickedLines = topIndices
      .slice(0, packed.pickedCount)
      .map((idx) => items[idx]?.line ?? "");
    return `${header}\n${pickedLines.join("\n")}${packed.footer}`;
  }

  const fallbackFooter =
    m > 0
      ? pickTopLevelOmissionFooter(
          m,
          suffixMinStart[0] ?? 1,
          suffixMaxEnd[0] ?? 1,
          nestedTotalCount > 0,
          charBudget - headerChars,
          byteBudget - headerBytes,
        )
      : null;
  return fallbackFooter ? `${header}${fallbackFooter}` : header;
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n?/g, "\n");
  const trimmedTrailing = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return trimmedTrailing.split("\n");
}

function formatDisplayPath(baseCwd: string, target: ResolvedTarget): string {
  const relFromCwd = toPosixPath(path.relative(baseCwd, target.canonicalPath));
  if (relFromCwd && !relFromCwd.startsWith("..") && !path.isAbsolute(relFromCwd)) {
    return relFromCwd;
  }
  return target.relPath || path.basename(target.canonicalPath);
}

interface CachedFile {
  lines: string[];
  size: number;
}

type SectionOutcome = "ok" | "blocked" | "error";

type RenderedSection =
  | {
      kind: "outline";
      outcome: "ok";
      header: string;
      symbols: SymbolEntry[];
      fullText: string;
    }
  | {
      kind: "static";
      outcome: SectionOutcome;
      blockReason?: string;
      fullText: string;
    };

async function executeSlicesAndOutlines(
  params: {
    toolName: ToolName;
    cwd?: string;
    outlines: readonly string[];
    slices: readonly SliceRequest[];
    maxChars?: number;
  },
  deps: SlicesRuntimeDeps,
): Promise<{ text: string; isError: boolean }> {
  const { toolName, outlines, slices } = params;
  const cwdDecision = await deps.policy.resolveCwd(params.cwd, toolName);
  if (!cwdDecision.ok) {
    const errText = redactSecrets(`Error: ${cwdDecision.error}`);
    deps.audit?.record({
      tool: toolName,
      status: "blocked",
      reason: cwdDecision.reason,
      summary: errText,
    });
    return { text: errText, isError: true };
  }
  const baseCwd = cwdDecision.value.cwd;

  const maxChars = clampInt(
    params.maxChars,
    MIN_MAX_CHARS,
    DEFAULT_INLINE_MAX_BYTES,
    DEFAULT_MAX_CHARS,
  );
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;

  // Per-call deduplicated read cache keyed by canonicalPath.
  const fileCache = new Map<string, Promise<CachedFile>>();
  const loadLines = (canonicalPath: string): Promise<CachedFile> => {
    const cached = fileCache.get(canonicalPath);
    if (cached) return cached;
    const pending = readTextFile(canonicalPath, {
      policy: deps.policy,
      baseCwd,
      toolName,
    }).then((data) => ({
      lines: splitFileLines(data.content),
      size: data.size,
    }));
    fileCache.set(canonicalPath, pending);
    return pending;
  };

  const sectionEntries: RenderedSection[] = [];

  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath): Promise<RenderedSection> => {
        const auth = await deps.policy.authorizeRead(rawPath, baseCwd, toolName);
        if (!auth.ok) {
          const safeLabel = deps.policy.sanitizePathForAudit(rawPath);
          const safeErr = redactSecrets(auth.error);
          return {
            kind: "static",
            outcome: "blocked",
            blockReason: auth.reason,
            fullText: `## Outline: ${safeLabel}\nERROR: ${safeErr}`,
          };
        }
        const displayPath = formatDisplayPath(baseCwd, auth.value);
        try {
          const { lines } = await loadLines(auth.value.canonicalPath);
          const symbols = extractSymbolsFromLines(auth.value.canonicalPath, lines);
          const header = `## Outline: ${displayPath} (${lines.length} lines)`;
          if (symbols.length === 0) {
            return {
              kind: "static",
              outcome: "ok",
              fullText: `${header}\n(no top-level symbols detected)`,
            };
          }
          const formatted = symbols.map(formatSymbolLine);
          return {
            kind: "outline",
            outcome: "ok",
            header,
            symbols,
            fullText: `${header}\n${formatted.join("\n")}`,
          };
        } catch (err) {
          const message = redactSecrets(err instanceof Error ? err.message : String(err));
          return {
            kind: "static",
            outcome: "error",
            fullText: `## Outline: ${redactSecrets(displayPath)}\nERROR: ${message}`,
          };
        }
      }),
    );
    sectionEntries.push(...outlineResults);
  }

  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req): Promise<RenderedSection> => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return {
            kind: "static",
            outcome: "error",
            fullText: "## Slice: (invalid)\nERROR: 'path' must be a non-empty string",
          };
        }

        const auth = await deps.policy.authorizeRead(req.path, baseCwd, toolName);
        if (!auth.ok) {
          const safeLabel = deps.policy.sanitizePathForAudit(req.path);
          const safeErr = redactSecrets(auth.error);
          return {
            kind: "static",
            outcome: "blocked",
            blockReason: auth.reason,
            fullText: `## Slice: ${safeLabel}\nERROR: ${safeErr}`,
          };
        }

        const displayPath = formatDisplayPath(baseCwd, auth.value);
        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return {
            kind: "static",
            outcome: "error",
            fullText: `## Slice: ${redactSecrets(displayPath)}\nERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`,
          };
        }

        try {
          const { lines } = await loadLines(auth.value.canonicalPath);
          const totalLines = lines.length;
          const blocks: string[] = [];

          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Number(range[0]);
            const rawEnd = Number(range[1]);
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(
                redactSecrets(
                  `ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`,
                ),
              );
              continue;
            }
            const truncStart = Math.trunc(rawStart);
            const truncEnd = Math.trunc(rawEnd);
            if (truncStart > truncEnd) {
              blocks.push(
                `ERROR: startLine (${truncStart}) > endLine (${truncEnd})`,
              );
              continue;
            }
            const start = Math.max(1, truncStart);
            const end = Math.min(totalLines, truncEnd);
            if (start > totalLines || end < 1) {
              blocks.push(
                `--- L${truncStart}-L${truncEnd} (out of bounds; file has ${totalLines} lines) ---`,
              );
              continue;
            }

            const width = String(end).length;
            const snippet: string[] = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }

          return {
            kind: "static",
            outcome: "ok",
            fullText: `## Slice: ${displayPath} (${totalLines} lines)\n${blocks.join("\n")}`,
          };
        } catch (err) {
          const message = redactSecrets(err instanceof Error ? err.message : String(err));
          return {
            kind: "static",
            outcome: "error",
            fullText: `## Slice: ${redactSecrets(displayPath)}\nERROR: ${message}`,
          };
        }
      }),
    );
    sectionEntries.push(...sliceResults);
  }

  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  let firstBlockReason: string | undefined;
  for (const entry of sectionEntries) {
    if (entry.outcome === "ok") okCount++;
    else if (entry.outcome === "blocked") {
      blockedCount++;
      if (!firstBlockReason && entry.kind === "static" && entry.blockReason) {
        firstBlockReason = entry.blockReason;
      }
    } else {
      errorCount++;
    }
  }

  const separator = "\n\n";
  const sepCount = Math.max(0, sectionEntries.length - 1);
  const sepChars = separator.length * sepCount;
  const sepBytes = utf8ByteLength(separator) * sepCount;

  const charSizes = sectionEntries.map((s) => s.fullText.length);
  const byteSizes = sectionEntries.map((s) => utf8ByteLength(s.fullText));
  const rawChars = charSizes.reduce((sum, n) => sum + n, 0) + sepChars;
  const rawBytes = byteSizes.reduce((sum, n) => sum + n, 0) + sepBytes;
  const isOverBudget = rawChars > maxChars || rawBytes > maxBytes;

  let finalText: string;
  if (!isOverBudget) {
    finalText = sectionEntries.map((s) => s.fullText).join(separator);
  } else {
    const activeTip =
      slices.length > 0
        ? SLICE_TRUNCATION_TIP
        : outlines.length > 20
          ? OUTLINE_BATCH_TIP
          : null;
    const applyTip =
      activeTip !== null &&
      maxChars > activeTip.length + 200 &&
      maxBytes > utf8ByteLength(activeTip) + 200;
    const tipChars = applyTip ? activeTip.length : 0;
    const tipBytes = applyTip ? utf8ByteLength(activeTip) : 0;
    const bodyMaxChars = maxChars - tipChars;
    const bodyMaxBytes = maxBytes - tipBytes;

    const availChars = Math.max(0, bodyMaxChars - sepChars);
    const availBytes = Math.max(0, bodyMaxBytes - sepBytes);
    const charBudgets = computeWaterFillBudgets(charSizes, availChars);
    const byteBudgets = computeWaterFillBudgets(byteSizes, availBytes);

    const packedSections = sectionEntries.map((entry, idx) => {
      const cBudget = charBudgets[idx] ?? 0;
      const bBudget = byteBudgets[idx] ?? 0;
      const cSize = charSizes[idx] ?? 0;
      const bSize = byteSizes[idx] ?? 0;
      if (entry.kind === "outline" && (cSize > cBudget || bSize > bBudget)) {
        return packOutlineToBudget(entry.header, entry.symbols, cBudget, bBudget);
      }
      return entry.fullText;
    });

    const fitted = fitSectionsToByteBudget(packedSections, {
      maxChars: bodyMaxChars,
      maxBytes: bodyMaxBytes,
      separator,
    });
    finalText = applyTip ? `${fitted.text}${activeTip}` : fitted.text;
    if (finalText.length > maxChars || utf8ByteLength(finalText) > maxBytes) {
      finalText = truncateWithByteNotice(finalText, maxChars, maxBytes).text;
    }
  }

  const isError = okCount === 0 && (blockedCount > 0 || errorCount > 0);
  const auditStatus =
    okCount > 0 ? "ok" : blockedCount > 0 ? "blocked" : "error";

  deps.audit?.record({
    tool: toolName,
    status: auditStatus,
    ...(firstBlockReason && auditStatus === "blocked"
      ? { reason: firstBlockReason }
      : {}),
    summary: `outlines=${outlines.length} slices=${slices.length} ok=${okCount} blocked=${blockedCount} errors=${errorCount} bytes=${utf8ByteLength(finalText)}`,
  });

  return { text: finalText, isError };
}

/**
 * Extracts compact symbol outlines across up to 40 files in one call using
 * PolicyGuard authorization and fair water-filling inline output budgets.
 */
export async function runQuickOutline(
  input: QuickOutlineInput,
  deps: SlicesRuntimeDeps,
): Promise<{ text: string; isError: boolean }> {
  const rawInput = input as Record<string, unknown> | undefined;
  const rawPaths =
    rawInput?.paths !== undefined
      ? rawInput.paths
      : rawInput?.outlines !== undefined
        ? rawInput.outlines
        : rawInput?.files;

  const failInput = (message: string): { text: string; isError: boolean } => {
    const safe = redactSecrets(message);
    deps.audit?.record({
      tool: "quick_outline",
      status: "error",
      reason: "invalid_input",
      summary: safe,
    });
    return { text: safe, isError: true };
  };

  if (rawPaths === undefined) {
    return failInput(
      withExample(
        "Error: provide at least one file path in 'paths'.",
        EXAMPLES.quick_outline,
      ),
    );
  }

  const parsed = parseMaybeStringOrJsonArray(rawPaths);
  if (!parsed.ok) {
    return failInput(
      withExample(
        `Error: 'paths' must be an array of non-empty file path strings (${parsed.detail}).`,
        EXAMPLES.quick_outline,
      ),
    );
  }

  const paths: string[] = [];
  for (let i = 0; i < parsed.value.length; i++) {
    const item = parsed.value[i];
    if (typeof item !== "string" || !item.trim()) {
      return failInput(
        withExample(
          `Error: paths[${i}] must be a non-empty file path string.`,
          EXAMPLES.quick_outline,
        ),
      );
    }
    paths.push(item.trim());
  }

  if (paths.length === 0) {
    return failInput(
      withExample(
        "Error: provide at least one file path in 'paths'.",
        EXAMPLES.quick_outline,
      ),
    );
  }
  if (paths.length > MAX_OUTLINES) {
    return failInput(
      `Error: limit exceeded (max ${MAX_OUTLINES} paths per call).`,
    );
  }

  return executeSlicesAndOutlines(
    {
      toolName: "quick_outline",
      cwd: input?.cwd,
      outlines: paths,
      slices: [],
      maxChars: input?.maxChars,
    },
    deps,
  );
}

/**
 * Reads symbol outlines and/or targeted line ranges across multiple files in a
 * single call, deduplicating file reads per canonical path and enforcing
 * PolicyGuard and <= 8,800-byte inline output limits.
 */
export async function runReadSlices(
  input: ReadSlicesInput,
  deps: SlicesRuntimeDeps,
): Promise<{ text: string; isError: boolean }> {
  const failInput = (message: string): { text: string; isError: boolean } => {
    const safe = redactSecrets(message);
    deps.audit?.record({
      tool: "read_slices",
      status: "error",
      reason: "invalid_input",
      summary: safe,
    });
    return { text: safe, isError: true };
  };

  const outlines: string[] = [];
  if (input?.outlines !== undefined) {
    const parsedOutlines = parseMaybeStringOrJsonArray(input.outlines);
    if (!parsedOutlines.ok) {
      return failInput(
        withExample(
          `Error: 'outlines' must be an array of non-empty file path strings (${parsedOutlines.detail}).`,
          EXAMPLES.read_slices,
        ),
      );
    }
    for (let i = 0; i < parsedOutlines.value.length; i++) {
      const item = parsedOutlines.value[i];
      if (typeof item !== "string" || !item.trim()) {
        return failInput(
          withExample(
            `Error: outlines[${i}] must be a non-empty file path string.`,
            EXAMPLES.read_slices,
          ),
        );
      }
      outlines.push(item.trim());
    }
  }

  const slices: SliceRequest[] = [];
  if (input?.slices !== undefined) {
    const parsedSlices = parseMaybeJsonArray(input.slices);
    if (!parsedSlices.ok) {
      return failInput(
        withExample(
          `Error: 'slices' must be an array of slice objects ({ path, ranges }) or 'path:start-end' strings (${parsedSlices.detail}).`,
          EXAMPLES.read_slices,
        ),
      );
    }
    for (let i = 0; i < parsedSlices.value.length; i++) {
      const item = parsedSlices.value[i];
      if (typeof item === "string") {
        const shorthand = parseSliceShorthand(item, `slices[${i}]`);
        if (!shorthand.ok) return failInput(shorthand.error);
        slices.push(shorthand.value);
        continue;
      }
      if (!isPlainObject(item)) {
        return failInput(
          withExample(
            `Error: slices[${i}] must be a slice object ({ path, ranges }) or 'path:start-end' string.`,
            EXAMPLES.read_slices,
          ),
        );
      }
      if (item.ranges !== undefined && !Array.isArray(item.ranges)) {
        return failInput(
          withExample(
            `Error: slices[${i}].ranges must be an array of [startLine, endLine] pairs.`,
            EXAMPLES.read_slices,
          ),
        );
      }
      slices.push(item as unknown as SliceRequest);
    }
  }

  if (input?.lineRanges !== undefined) {
    const parsedRanges = parseMaybeStringOrJsonArray(input.lineRanges);
    if (!parsedRanges.ok) {
      return failInput(
        withExample(
          `Error: 'lineRanges' must be an array of 'path:start-end' strings (${parsedRanges.detail}).`,
          EXAMPLES.read_slices_line_range,
        ),
      );
    }
    for (let i = 0; i < parsedRanges.value.length; i++) {
      const item = parsedRanges.value[i];
      if (typeof item !== "string" || !item.trim()) {
        return failInput(
          withExample(
            `Error: lineRanges[${i}] must be a non-empty 'path:start-end' string.`,
            EXAMPLES.read_slices_line_range,
          ),
        );
      }
      const shorthand = parseSliceShorthand(item, `lineRanges[${i}]`);
      if (!shorthand.ok) return failInput(shorthand.error);
      slices.push(shorthand.value);
    }
  }

  if (outlines.length === 0 && slices.length === 0) {
    return failInput(
      withExample(
        "Error: provide at least one entry in 'outlines', 'slices', or 'lineRanges'.",
        EXAMPLES.read_slices,
      ),
    );
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return failInput(
      `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
    );
  }

  return executeSlicesAndOutlines(
    {
      toolName: "read_slices",
      cwd: input?.cwd,
      outlines,
      slices,
      maxChars: input?.maxChars,
    },
    deps,
  );
}
