import path from "node:path";

export interface SymbolEntry {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  depth: number;
}

export type OutlineLanguage =
  | "tsjs"
  | "python"
  | "go"
  | "rust"
  | "clike"
  | "html"
  | "vue"
  | "svelte"
  | "css"
  | "shell"
  | "markdown"
  | "json"
  | "yaml"
  | "unknown";

type BraceLang = "js" | "c" | "go" | "rust" | "shell";

interface ScanState {
  inBlockComment: boolean;
  blockCommentDepth: number;
  inBacktick: boolean;
  templateExprStack: number[];
  rustRawStringHashes: number | null;
  parenDepth: number;
}

interface LineScanResult {
  open: number;
  close: number;
  openParen: number;
  closeParen: number;
  endsWithSemi: boolean;
  lastCodeChar: string;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "new",
  "yield",
  "await",
]);

const JS_CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "try",
  "return",
  "new",
  "throw",
  "await",
  "super",
  "typeof",
  "delete",
  "yield",
]);

const CLIKE_EXCLUDED_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "return",
  "sizeof",
  "alignof",
  "decltype",
  "new",
  "delete",
  "throw",
  "typedef",
  "using",
  "case",
  "do",
  "try",
  "lock",
  "fixed",
  "foreach",
  "synchronized",
]);

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_RAW_SKIP_TAGS = new Set([
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
]);

const HTML_HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const HTML_SEMANTIC_TAGS = new Set([
  "head",
  "body",
  "header",
  "nav",
  "main",
  "aside",
  "section",
  "article",
  "footer",
  "form",
  "dialog",
  "template",
]);

const HTML_CONTAINER_TAGS = new Set([
  "div",
  "ul",
  "ol",
  "table",
  "fieldset",
  "details",
]);

const PASCAL_COMPONENT_RE = /^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*$/;
const MAX_HTML_DEPTH = 3;
const MAX_TAG_HEADER_SCAN = 8192;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectLanguage(
  filePath: string,
  firstLine?: string,
): OutlineLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "tsjs";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".c":
    case ".h":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hh":
    case ".hpp":
    case ".hxx":
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
      return "clike";
    case ".html":
    case ".htm":
      return "html";
    case ".vue":
      return "vue";
    case ".svelte":
      return "svelte";
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return "css";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".json":
    case ".jsonc":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      break;
  }

  if (firstLine && firstLine.startsWith("#!")) {
    const shebang = firstLine.toLowerCase();
    if (/\b(?:bash|zsh|sh)\b/.test(shebang)) return "shell";
    if (/\bpython\d*\b/.test(shebang)) return "python";
    if (/\b(?:node|deno|bun|tsx)\b/.test(shebang)) return "tsjs";
  }

  return "unknown";
}

export function formatSymbolLine(entry: SymbolEntry): string {
  const indent = "  ".repeat(Math.max(0, entry.depth));
  const span =
    entry.endLine > entry.startLine
      ? `L${entry.startLine}-L${entry.endLine}`
      : `L${entry.startLine}`;
  return `${indent}${entry.kind} ${entry.name} [${span}]`;
}

export function extractSymbolsFromLines(
  filePath: string,
  lines: readonly string[],
): SymbolEntry[] {
  if (lines.length === 0) return [];
  const cleanLines = normalizeInputLines(lines);
  if (cleanLines.length === 0) return [];

  const lang = detectLanguage(filePath, cleanLines[0]);
  switch (lang) {
    case "tsjs":
      return extractTsJsSymbols(cleanLines);
    case "python":
      return extractPythonSymbols(cleanLines);
    case "go":
      return extractGoSymbols(cleanLines);
    case "rust":
      return extractRustSymbols(cleanLines);
    case "clike":
      return extractCLikeSymbols(cleanLines);
    case "html":
      return extractTemplateSymbols(cleanLines, "html");
    case "vue":
      return extractTemplateSymbols(cleanLines, "vue");
    case "svelte":
      return extractTemplateSymbols(cleanLines, "svelte");
    case "css":
      return extractCssSymbols(cleanLines, false);
    case "shell":
      return extractShellSymbols(cleanLines);
    case "markdown":
      return extractMarkdownSymbols(cleanLines);
    case "json":
      return extractJsonSymbols(cleanLines);
    case "yaml":
      return extractYamlSymbols(cleanLines);
    case "unknown":
      return [];
  }
}

export function extractSymbols(filePath: string, content: string): SymbolEntry[] {
  if (!content) return [];
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return [];
  const trimmedTrailing = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  const lines = trimmedTrailing.split("\n");
  return extractSymbolsFromLines(filePath, lines);
}

// ---------------------------------------------------------------------------
// Shared Lexical & Brace Scanner
// ---------------------------------------------------------------------------

function normalizeInputLines(lines: readonly string[]): string[] {
  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (i === 0 && line.startsWith("\uFEFF")) {
      line = line.slice(1);
    }
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    out[i] = line;
  }
  return out;
}

function createScanState(): ScanState {
  return {
    inBlockComment: false,
    blockCommentDepth: 0,
    inBacktick: false,
    templateExprStack: [],
    rustRawStringHashes: null,
    parenDepth: 0,
  };
}

function isRegexStartContext(line: string, slashIdx: number): boolean {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j] ?? "")) j--;
  if (j < 0) return true;
  const prev = line[j] ?? "";
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k] ?? "")) k--;
  const word = line.slice(k + 1, j + 1);
  return REGEX_PRECEDING_KEYWORDS.has(word);
}

function isJsxSelfClosingSlash(line: string, slashIdx: number): boolean {
  if (line[slashIdx + 1] !== ">") return false;
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j] ?? "")) j--;
  // JSX self-closing `/>` reaches regex-start context after `}` (`<Icon s={1} />`)
  // or on a continuation line (`  />`); regex literals like `/>/g` follow `=`, `(`, `return`, etc.
  if (j >= 0 && line[j] !== "}") return false;
  return line[slashIdx + 2] !== "/";
}

function matchRustRawStringStart(
  line: string,
  idx: number,
): { hashes: number; quoteIdx: number } | null {
  const ch = line[idx];
  let rIdx = -1;
  if (ch === "r") {
    rIdx = idx;
  } else if ((ch === "b" || ch === "c") && line[idx + 1] === "r") {
    rIdx = idx + 1;
  } else {
    return null;
  }
  if (idx > 0 && /[A-Za-z0-9_]/.test(line[idx - 1] ?? "")) {
    return null;
  }
  let p = rIdx + 1;
  let hashes = 0;
  while (p < line.length && line[p] === "#") {
    hashes++;
    p++;
  }
  if (line[p] === '"') {
    return { hashes, quoteIdx: p };
  }
  return null;
}

function isRustCharLiteralStart(line: string, idx: number): boolean {
  const next = line[idx + 1];
  if (next === undefined) return false;
  if (next === "\\") return true;
  if (next === "'") return false;
  const cp = line.codePointAt(idx + 1);
  const step = cp !== undefined && cp > 0xffff ? 3 : 2;
  return line[idx + step] === "'";
}

function scanBracesOnLine(
  line: string,
  state: ScanState,
  lang: BraceLang,
  ignoreBracesInParensBeforeOpen = false,
  alreadySeenOpen = false,
): LineScanResult {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (lang === "rust" && ch === "/" && next === "*") {
        state.blockCommentDepth++;
        i++;
      } else if (ch === "*" && next === "/") {
        if (lang === "rust" && state.blockCommentDepth > 1) {
          state.blockCommentDepth--;
        } else {
          state.inBlockComment = false;
          state.blockCommentDepth = 0;
        }
        i++;
      }
      continue;
    }

    if (state.rustRawStringHashes !== null) {
      if (ch === '"') {
        const needed = state.rustRawStringHashes;
        let matched = true;
        for (let h = 1; h <= needed; h++) {
          if (line[i + h] !== "#") {
            matched = false;
            break;
          }
        }
        if (matched) {
          state.rustRawStringHashes = null;
          lastCodeChar = '"';
          i += needed;
        }
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }

    if (state.inBacktick) {
      if (ch === "\\" && lang !== "go") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "\\" && lang !== "shell") {
        escape = true;
      } else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }

    // Comments
    if (
      lang === "shell" &&
      ch === "#" &&
      (i === 0 || /[\s;&|()]/.test(line[i - 1] ?? ""))
    ) {
      break;
    }
    if (lang !== "shell" && ch === "/" && next === "/") {
      break;
    }
    if (lang !== "shell" && ch === "/" && next === "*") {
      state.inBlockComment = true;
      state.blockCommentDepth = 1;
      i++;
      continue;
    }

    // Rust raw strings r#"..."#
    if (lang === "rust" && (ch === "r" || ch === "b" || ch === "c")) {
      const rawStart = matchRustRawStringStart(line, i);
      if (rawStart) {
        state.rustRawStringHashes = rawStart.hashes;
        i = rawStart.quoteIdx;
        continue;
      }
    }

    // JS/TS regex literals (excluding JSX `</Tag>` and self-closing `/>`)
    if (
      lang === "js" &&
      ch === "/" &&
      next !== "/" &&
      next !== "*" &&
      line[i - 1] !== "<" &&
      !isJsxSelfClosingSlash(line, i) &&
      isRegexStartContext(line, i)
    ) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }

    // Strings & character literals
    if (ch === "'") {
      if (lang === "rust") {
        if (isRustCharLiteralStart(line, i)) {
          inSingle = true;
        }
        continue;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c" || lang === "go")) {
      state.inBacktick = true;
      continue;
    }

    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        const topIdx = state.templateExprStack.length - 1;
        state.templateExprStack[topIdx] =
          (state.templateExprStack[topIdx] ?? 0) + 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const topIdx = state.templateExprStack.length - 1;
        const top = state.templateExprStack[topIdx] ?? 0;
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[topIdx] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }

  state.parenDepth = parenDepth;

  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar,
  };
}

function findBraceBlockEnd(
  lines: readonly string[],
  startIdx: number,
  lang: BraceLang = "c",
): number {
  let depth = 0;
  let seenOpen = false;
  const state = createScanState();
  const maxScan = Math.min(lines.length, startIdx + 2000);

  for (let i = startIdx; i < maxScan; i++) {
    const line = lines[i] ?? "";
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      line,
      state,
      lang,
      lang === "js" || lang === "go",
      seenOpen,
    );
    if (open > 0) seenOpen = true;
    depth += open - close;

    if (!seenOpen && depth < 0) {
      return startIdx + 1;
    }

    if (seenOpen && depth <= 0) {
      // Inline generic return type like `): Promise<{ ok: boolean }>\n{`
      if (lang === "js" && lastCodeChar === ">" && i <= startIdx + 12) {
        seenOpen = false;
        depth = 0;
        continue;
      }
      return i + 1;
    }

    if (!seenOpen && state.parenDepth <= 0 && endsWithSemi) {
      return i + 1;
    }

    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }

  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}

function findParenCallEnd(
  lines: readonly string[],
  startIdx: number,
  lang: BraceLang = "js",
): number {
  const state = createScanState();
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);

  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i] ?? "", state, lang);
    if (openParen > 0) seenParen = true;
    if (seenParen && state.parenDepth <= 0) {
      return i + 1;
    }
  }

  return startIdx + 1;
}

function hasArrowOrBraceWithin(
  lines: readonly string[],
  startIdx: number,
  maxLookahead = 12,
  lang: BraceLang = "js",
): { hasArrow: boolean; hasBrace: boolean } {
  const state = createScanState();
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);

  for (let i = startIdx; i < end; i++) {
    const line = lines[i] ?? "";
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(
      line,
      state,
      lang,
    );
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (lang === "js" && line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }

  return { hasArrow, hasBrace: false };
}

function findTypeAliasEnd(lines: readonly string[], startIdx: number): number {
  const firstLine = lines[startIdx] ?? "";
  const eqIdx = firstLine.indexOf("=");
  const rhs = eqIdx >= 0 ? firstLine.slice(eqIdx + 1) : firstLine;
  const state = createScanState();
  const firstScan = scanBracesOnLine(rhs, state, "js");

  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, startIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return startIdx + 1;
  }

  let endIdx = startIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);

  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation =
      parenBal > 0 ||
      prevLast === "=" ||
      prevLast === "|" ||
      prevLast === "&" ||
      prevLast === "?" ||
      prevLast === ":" ||
      /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }

  return endIdx + 1;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript / TSX / JSX
// ---------------------------------------------------------------------------

function extractTsJsSymbols(lines: readonly string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  const topPatterns: ReadonlyArray<{ re: RegExp; kind: string }> = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
    },
  ];

  const multilineArrowStartRe =
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?\(/;

  const exportedObjectHandlerRe =
    /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/;

  const methodHeaderRe =
    /^([ \t]{1,6})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

  const routeRegisterRe =
    /^([ \t]{0,8})(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;

  const testSuiteRe =
    /^([ \t]{0,6})(?:describe|suite)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*['"`]([^'"`]+)['"`]/;

  const testCaseRe =
    /^([ \t]{0,8})(?:it|test)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*['"`]([^'"`]+)['"`]/;

  const classStack: Array<{ endLine: number; memberIndent: number }> = [];
  const fnStack: Array<{ endLine: number }> = [];
  const suiteStack: Array<{ endLine: number }> = [];
  const scanState = createScanState();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    while (classStack.length > 0 && classStack[classStack.length - 1]!.endLine < lineNo) {
      classStack.pop();
    }
    while (fnStack.length > 0 && fnStack[fnStack.length - 1]!.endLine < lineNo) {
      fnStack.pop();
    }
    while (suiteStack.length > 0 && suiteStack[suiteStack.length - 1]!.endLine < lineNo) {
      suiteStack.pop();
    }

    const wasInComment = scanState.inBlockComment;
    const wasInBacktick = scanState.inBacktick;
    scanBracesOnLine(line, scanState, "js");
    if (wasInComment || wasInBacktick) continue;

    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }

    const isTopColumn = !line.startsWith(" ") && !line.startsWith("\t");
    let matched = false;

    if (isTopColumn) {
      for (const pattern of topPatterns) {
        const m = pattern.re.exec(line);
        const name = m?.[1];
        if (name) {
          const endLine =
            pattern.kind === "type"
              ? findTypeAliasEnd(lines, i)
              : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: pattern.kind,
            name,
            startLine: lineNo,
            endLine,
            depth: 0,
          });
          if (pattern.kind === "class") {
            classStack.push({ endLine, memberIndent: -1 });
          } else if (pattern.kind === "function" && endLine > lineNo) {
            fnStack.push({ endLine });
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        const ma = multilineArrowStartRe.exec(line);
        const name = ma?.[1];
        if (name) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12, "js");
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name,
              startLine: lineNo,
              endLine,
              depth: 0,
            });
            if (endLine > lineNo) {
              fnStack.push({ endLine });
            }
            matched = true;
          }
        }
      }

      if (!matched) {
        const mo = exportedObjectHandlerRe.exec(line);
        const name = mo?.[1];
        if (name) {
          const endLine = findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: "const",
            name,
            startLine: lineNo,
            endLine,
            depth: 0,
          });
          matched = true;
        }
      }
    }

    if (matched) continue;

    // Express / Fastify routes (top-level or inside a function)
    if (isTopColumn || fnStack.length > 0) {
      const mr = routeRegisterRe.exec(line);
      const method = mr?.[2];
      const routePath = mr?.[3];
      if (method && routePath) {
        const endLine = findParenCallEnd(lines, i, "js");
        symbols.push({
          kind: "route",
          name: `${method.toUpperCase()} ${routePath}`,
          startLine: lineNo,
          endLine,
          depth: fnStack.length > 0 ? 1 : 0,
        });
        continue;
      }
    }

    // Test suites (describe / suite)
    const ms = testSuiteRe.exec(line);
    if (ms && ms[2] && (isTopColumn || suiteStack.length > 0)) {
      const endLine = findParenCallEnd(lines, i, "js");
      const depth = suiteStack.length;
      symbols.push({
        kind: "suite",
        name: ms[2].slice(0, 64),
        startLine: lineNo,
        endLine,
        depth,
      });
      suiteStack.push({ endLine });
      continue;
    }

    // Class methods
    if (classStack.length > 0) {
      const currentClass = classStack[classStack.length - 1]!;
      const mm = methodHeaderRe.exec(line);
      const indentStr = mm?.[1];
      const methodName = mm?.[2];
      if (indentStr && methodName && !JS_CONTROL_KEYWORDS.has(methodName)) {
        const indentWidth = indentStr.replace(/\t/g, "  ").length;
        if (currentClass.memberIndent === -1) {
          currentClass.memberIndent = indentWidth;
        }
        if (indentWidth === currentClass.memberIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10, "js");
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: methodName,
              startLine: lineNo,
              endLine,
              depth: classStack.length,
            });
            continue;
          }
        }
      }
    }

    // Test cases (it / test)
    if (classStack.length === 0 && fnStack.length === 0) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[2]) {
        const endLine = findParenCallEnd(lines, i, "js");
        symbols.push({
          kind: "test",
          name: mt[2].slice(0, 64),
          startLine: lineNo,
          endLine,
          depth: suiteStack.length,
        });
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function isPythonFStringPrefix(line: string, quoteIdx: number): boolean {
  let k = quoteIdx - 1;
  while (k >= 0 && /[A-Za-z]/.test(line[k] ?? "")) k--;
  if (k >= 0 && /[0-9_]/.test(line[k] ?? "")) return false;
  const prefix = line.slice(k + 1, quoteIdx).toLowerCase();
  return prefix === "f" || prefix === "fr" || prefix === "rf";
}

function indentWidthPy(line: string): number {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
  return ws.replace(/\t/g, "    ").length;
}

function extractPythonSymbols(lines: readonly string[]): SymbolEntry[] {
  const defRe = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const isContinuation = new Array<boolean>(lines.length).fill(false);
  const inStringContinuation = new Array<boolean>(lines.length).fill(false);

  let activeTriple: '"""' | "'''" | null = null;
  let activeSingle: '"' | "'" | null = null;
  let activeSingleIsFString = false;
  let bracketDepth = 0;
  let backslashContinued = false;
  const fExprStack: Array<{
    quote: '"' | "'";
    braceDepth: number;
    baseBracketDepth: number;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    inStringContinuation[i] =
      activeTriple !== null || activeSingle !== null || backslashContinued;

    // Recover from unclosed brackets/f-strings before a valid statement header
    if (
      !inStringContinuation[i] &&
      (bracketDepth > 0 || fExprStack.length > 0) &&
      defRe.test(line)
    ) {
      bracketDepth = 0;
      fExprStack.length = 0;
      const defIndent = indentWidthPy(line);
      for (let k = i - 1; k >= 0; k--) {
        if (inStringContinuation[k]) break;
        const t = (lines[k] ?? "").trim();
        if (!t || t.startsWith("#")) {
          isContinuation[k] = false;
          continue;
        }
        if (t.startsWith("@") && indentWidthPy(lines[k] ?? "") === defIndent) {
          isContinuation[k] = false;
          continue;
        }
        break;
      }
    }

    isContinuation[i] =
      Boolean(inStringContinuation[i]) ||
      bracketDepth > 0 ||
      fExprStack.length > 0;
    backslashContinued = false;

    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else if (activeSingle) {
        if (line[j] === "\\") {
          if (j === line.length - 1) {
            backslashContinued = true;
            break;
          }
          j += 2;
          continue;
        }
        if (activeSingleIsFString) {
          if (line[j] === "{") {
            if (line[j + 1] === "{") {
              j += 2;
              continue;
            }
            fExprStack.push({
              quote: activeSingle,
              braceDepth: 1,
              baseBracketDepth: bracketDepth,
            });
            activeSingle = null;
            activeSingleIsFString = false;
            j++;
            continue;
          }
          if (line[j] === "}" && line[j + 1] === "}") {
            j += 2;
            continue;
          }
        }
        if (line[j] === activeSingle) {
          activeSingle = null;
          activeSingleIsFString = false;
          j++;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeTriple = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeTriple = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          activeSingle = line[j] === '"' ? '"' : "'";
          activeSingleIsFString = isPythonFStringPrefix(line, j);
          j++;
          continue;
        }
        if (fExprStack.length > 0) {
          const top = fExprStack[fExprStack.length - 1]!;
          if (
            top.braceDepth === 1 &&
            bracketDepth === top.baseBracketDepth &&
            line[j] === ":" &&
            line[j + 1] !== "="
          ) {
            let specDepth = 1;
            j++;
            while (j < line.length && specDepth > 0) {
              if (line[j] === "\\") {
                j += 2;
                continue;
              }
              if (line[j] === "{") specDepth++;
              else if (line[j] === "}") specDepth--;
              j++;
            }
            if (specDepth === 0) {
              fExprStack.pop();
              activeSingle = top.quote;
              activeSingleIsFString = true;
            }
            continue;
          }
          if (line[j] === "{") {
            top.braceDepth++;
            bracketDepth++;
            j++;
            continue;
          }
          if (line[j] === "}") {
            if (top.braceDepth === 1) {
              fExprStack.pop();
              activeSingle = top.quote;
              activeSingleIsFString = true;
              j++;
              continue;
            }
            top.braceDepth--;
            bracketDepth = Math.max(0, bracketDepth - 1);
            j++;
            continue;
          }
        }
        if (line[j] === "(" || line[j] === "[" || line[j] === "{") {
          bracketDepth++;
        } else if (line[j] === ")" || line[j] === "]" || line[j] === "}") {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (line[j] === "\\" && j === line.length - 1) {
          backslashContinued = true;
        }
        j++;
      }
    }

    if (activeSingle && !backslashContinued) {
      activeSingle = null;
      activeSingleIsFString = false;
    }
  }

  const raw: Array<{ indent: number; rawKind: string; name: string; defIdx: number }> =
    [];
  for (let i = 0; i < lines.length; i++) {
    if (isContinuation[i]) continue;
    const m = defRe.exec(lines[i] ?? "");
    if (!m || !m[2] || !m[3]) continue;
    const indent = (m[1] ?? "").replace(/\t/g, "    ").length;
    raw.push({ indent, rawKind: m[2], name: m[3], defIdx: i });
  }

  const symbols: SymbolEntry[] = [];
  const scopeStack: Array<{ indent: number; kind: string; endLine: number }> = [];

  for (const item of raw) {
    // Include decorators directly above the definition at the same indent
    let startIdx = item.defIdx;
    for (let j = item.defIdx - 1; j >= 0; j--) {
      if (isContinuation[j] || !(lines[j] ?? "").trim()) continue;
      const trimmed = (lines[j] ?? "").trimStart();
      if (trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("@") || indentWidthPy(lines[j] ?? "") !== item.indent) {
        break;
      }
      startIdx = j;
    }

    let endIdx = lines.length - 1;
    for (let j = item.defIdx + 1; j < lines.length; j++) {
      if (isContinuation[j]) continue;
      const l = lines[j] ?? "";
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (indentWidthPy(l) <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }

    while (endIdx > item.defIdx) {
      const l = lines[endIdx] ?? "";
      const trimmed = l.trim();
      if (
        trimmed &&
        !(
          !isContinuation[endIdx] &&
          trimmed.startsWith("#") &&
          indentWidthPy(l) <= item.indent
        )
      ) {
        break;
      }
      endIdx--;
    }

    const startLine = startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);

    while (
      scopeStack.length > 0 &&
      (scopeStack[scopeStack.length - 1]!.endLine < startLine ||
        scopeStack[scopeStack.length - 1]!.indent >= item.indent)
    ) {
      scopeStack.pop();
    }

    const parent = scopeStack[scopeStack.length - 1];
    const kind =
      item.rawKind === "class"
        ? "class"
        : parent?.kind === "class"
          ? "method"
          : "function";
    const depth =
      scopeStack.length > 0 ? scopeStack.length : item.indent > 0 ? 1 : 0;

    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth,
    });

    scopeStack.push({ indent: item.indent, kind, endLine });
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function extractGoSymbols(lines: readonly string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const pkgRe = /^package\s+([A-Za-z_]\w*)/;
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*(?:\[[^\]]*\])?)/;
  const structOrIfaceRe =
    /^type\s+([A-Za-z_]\w*(?:\[[^\]]*\])?)\s+(struct|interface)\b/;
  const typeAliasRe = /^type\s+([A-Za-z_]\w*(?:\[[^\]]*\])?)\s+(?:=\s*)?\S/;
  const state = createScanState();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const wasInComment = state.inBlockComment;
    const wasInBacktick = state.inBacktick;
    scanBracesOnLine(line, state, "go");
    if (wasInComment || wasInBacktick) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }

    const pm = pkgRe.exec(line);
    if (pm && pm[1]) {
      symbols.push({
        kind: "package",
        name: pm[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0,
      });
      continue;
    }

    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      symbols.push({
        kind: recv ? "method" : "function",
        name: recv ? `(${recv}) ${fm[2]}` : fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0,
      });
      continue;
    }

    const sm = structOrIfaceRe.exec(line);
    if (sm && sm[1] && sm[2]) {
      symbols.push({
        kind: sm[2],
        name: sm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0,
      });
      continue;
    }

    const tm = typeAliasRe.exec(line);
    if (tm && tm[1]) {
      const endLine = line.includes("{")
        ? findBraceBlockEnd(lines, i, "go")
        : i + 1;
      symbols.push({
        kind: "type",
        name: tm[1],
        startLine: i + 1,
        endLine,
        depth: 0,
      });
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function findRustMacroEnd(lines: readonly string[], startIdx: number): number {
  const firstLine = lines[startIdx] ?? "";
  const bangIdx = firstLine.indexOf("!");
  const afterBang = bangIdx >= 0 ? firstLine.slice(bangIdx + 1) : firstLine;
  const openMatch = /[{(\[]/.exec(afterBang);
  const openCh = openMatch?.[0] ?? "{";
  if (openCh === "{") {
    return findBraceBlockEnd(lines, startIdx, "rust");
  }
  const closeCh = openCh === "(" ? ")" : "]";
  let depth = 0;
  let seenOpen = false;
  const maxScan = Math.min(lines.length, startIdx + 1000);
  const state = createScanState();

  for (let i = startIdx; i < maxScan; i++) {
    const line = lines[i] ?? "";
    const wasComment = state.inBlockComment;
    const wasRaw = state.rustRawStringHashes !== null;
    scanBracesOnLine(line, state, "rust");
    if (wasComment || wasRaw) continue;

    let inStr = false;
    let esc = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j] ?? "";
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === "/" && line[j + 1] === "/") break;
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === openCh) {
        depth++;
        seenOpen = true;
      } else if (ch === closeCh) {
        depth--;
        if (seenOpen && depth <= 0) {
          return i + 1;
        }
      }
    }
  }

  return startIdx + 1;
}

function extractRustSymbols(lines: readonly string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const itemRe =
    /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)(?:\s+|\s*(?=<))([A-Za-z_<][\w:<>,+'&\s]*?)(?:\s*(?:\bwhere\b|[\({;])|$)/;
  const macroRe = /^([ \t]*)macro_rules!\s+([A-Za-z_]\w*)/;
  const state = createScanState();
  const scopeStack: Array<{ endLine: number; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    while (
      scopeStack.length > 0 &&
      scopeStack[scopeStack.length - 1]!.endLine < lineNo
    ) {
      scopeStack.pop();
    }

    const wasInComment = state.inBlockComment;
    const wasInRaw = state.rustRawStringHashes !== null;
    scanBracesOnLine(line, state, "rust");
    if (wasInComment || wasInRaw) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }

    const mm = macroRe.exec(line);
    if (mm && mm[2]) {
      const indent = (mm[1] ?? "").replace(/\t/g, "    ").length;
      if (indent <= 8) {
        const endLine = findRustMacroEnd(lines, i);
        symbols.push({
          kind: "macro",
          name: mm[2],
          startLine: lineNo,
          endLine,
          depth: scopeStack.length,
        });
      }
      continue;
    }

    const m = itemRe.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = (m[1] ?? "").replace(/\t/g, "    ").length;
    if (indent > 8) continue;

    while (
      scopeStack.length > 0 &&
      scopeStack[scopeStack.length - 1]!.indent >= indent
    ) {
      scopeStack.pop();
    }

    const kind = m[2];
    const name = m[3].trim().replace(/\s+/g, " ");
    const endLine = findBraceBlockEnd(lines, i, "rust");
    const depth = scopeStack.length > 0 ? scopeStack.length : indent > 0 ? 1 : 0;

    symbols.push({
      kind,
      name,
      startLine: lineNo,
      endLine,
      depth,
    });

    if (
      (kind === "impl" || kind === "trait" || kind === "mod") &&
      endLine > lineNo
    ) {
      scopeStack.push({ endLine, indent });
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// C / C++ / Java / Kotlin / C# / Swift
// ---------------------------------------------------------------------------

function findCLikeTypeEnd(lines: readonly string[], startIdx: number): number {
  const state = createScanState();
  let seenParen = false;
  let seenBrace = false;
  let braceDepth = 0;
  const maxHeader = Math.min(lines.length, startIdx + 20);

  for (let i = startIdx; i < maxHeader; i++) {
    const line = lines[i] ?? "";
    const scan = scanBracesOnLine(line, state, "c");
    if (scan.openParen > 0) seenParen = true;
    if (scan.open > 0) {
      seenBrace = true;
      braceDepth += scan.open - scan.close;
      if (braceDepth <= 0) return i + 1;
      return findBraceBlockEnd(lines, startIdx, "c");
    }
    if (!seenBrace && state.parenDepth <= 0 && scan.endsWithSemi) {
      return i + 1;
    }
    // Kotlin `data class User(val id: Int)` or `class Empty` with no body braces
    if (!seenBrace && state.parenDepth <= 0 && (seenParen || i === startIdx)) {
      const nextTrim = (lines[i + 1] ?? "").trim();
      const continuesHeader =
        nextTrim.startsWith("{") ||
        nextTrim.startsWith(":") ||
        nextTrim.startsWith("extends ") ||
        nextTrim.startsWith("implements ") ||
        nextTrim.startsWith("where ");
      if (!continuesHeader && !line.trimEnd().endsWith(",") && !line.trimEnd().endsWith(":")) {
        if (seenParen) return i + 1;
      }
    }
  }

  return findBraceBlockEnd(lines, startIdx, "c");
}

function hasAssignmentBeforeParen(line: string): boolean {
  const parenIdx = line.indexOf("(");
  if (parenIdx < 0) return line.includes("=");
  const prefix = line.slice(0, parenIdx);
  return prefix.includes("=");
}

function extractCLikeSymbols(lines: readonly string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  const packageRe = /^package\s+([A-Za-z_][\w.]*)/;
  const typeRe =
    /^([ \t]{0,8})(?:(?:public|private|protected|internal|fileprivate|static|final|abstract|sealed|data|open|export|partial|readonly|ref|unsafe|value|indirect|nonisolated)\s+)*(class|interface|enum|struct|record|protocol|namespace|object|extension|actor)\s+([A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*)/;
  const kwFuncRe =
    /^([ \t]{0,8})(?:(?:public|private|protected|internal|fileprivate|static|final|override|virtual|inline|async|suspend|open|mutating|nonmutating|infix|operator|tailrec|nonisolated|class)\s+)*(?:fun|func)\s+(?:<[^>]*>\s+)?([A-Za-z_][\w.]*)\s*(?:<[^>]*>)?\s*\(/;
  const cMethodRe =
    /^([ \t]{0,8})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|consteval|extern|async|synchronized|native|unsigned|signed|const|volatile|unsafe|partial|sealed|new)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&?]*?\s+)([A-Za-z_~][\w:]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;
  const ctorRe =
    /^([ \t]{1,8})(?:(?:public|private|protected|internal)\s+)+([A-Z][A-Za-z0-9_]*)\s*\([^;]*$/;

  const state = createScanState();
  const containerStack: Array<{ endLine: number; indent: number; kind: string }> =
    [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    while (
      containerStack.length > 0 &&
      containerStack[containerStack.length - 1]!.endLine < lineNo
    ) {
      containerStack.pop();
    }

    const wasInComment = state.inBlockComment;
    scanBracesOnLine(line, state, "c");
    if (wasInComment) continue;

    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("@")
    ) {
      continue;
    }

    const pm = packageRe.exec(line);
    if (pm && pm[1]) {
      symbols.push({
        kind: "package",
        name: pm[1],
        startLine: lineNo,
        endLine: lineNo,
        depth: 0,
      });
      continue;
    }

    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indent = (tm[1] ?? "").replace(/\t/g, "    ").length;
      while (
        containerStack.length > 0 &&
        containerStack[containerStack.length - 1]!.indent >= indent
      ) {
        containerStack.pop();
      }
      const kind = tm[2];
      const endLine =
        kind === "namespace" && trimmed.endsWith(";") && !trimmed.includes("{")
          ? lineNo
          : findCLikeTypeEnd(lines, i);
      const depth = containerStack.length;
      symbols.push({
        kind,
        name: tm[3],
        startLine: lineNo,
        endLine,
        depth,
      });
      if (endLine > lineNo) {
        containerStack.push({ endLine, indent, kind });
      }
      continue;
    }

    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indent = (fm[1] ?? "").replace(/\t/g, "    ").length;
      while (
        containerStack.length > 0 &&
        containerStack[containerStack.length - 1]!.indent >= indent
      ) {
        containerStack.pop();
      }
      const parent = containerStack[containerStack.length - 1];
      const isMethod =
        parent !== undefined && parent.kind !== "namespace"
          ? true
          : indent > 0 && parent === undefined;
      const parenEnd = findParenCallEnd(lines, i, "c");
      const parenEndLine = lines[parenEnd - 1] ?? "";
      const closeParenIdx = parenEndLine.lastIndexOf(")");
      const afterCloseParen =
        closeParenIdx >= 0 ? parenEndLine.slice(closeParenIdx + 1) : "";
      const isExprBody =
        !afterCloseParen.includes("{") &&
        /(?:^|\s)=(?!=)/.test(afterCloseParen);
      const endLine = isExprBody
        ? parenEnd
        : findBraceBlockEnd(lines, i, "c");
      symbols.push({
        kind: isMethod ? "method" : "function",
        name: fm[2],
        startLine: lineNo,
        endLine,
        depth: containerStack.length > 0 ? containerStack.length : indent > 0 ? 1 : 0,
      });
      continue;
    }

    if (!hasAssignmentBeforeParen(trimmed)) {
      const cm = cMethodRe.exec(line);
      if (cm && cm[2] && !CLIKE_EXCLUDED_NAMES.has(cm[2])) {
        const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8, "c");
        if (hasBrace) {
          const indent = (cm[1] ?? "").replace(/\t/g, "    ").length;
          while (
            containerStack.length > 0 &&
            containerStack[containerStack.length - 1]!.indent >= indent
          ) {
            containerStack.pop();
          }
          const parent = containerStack[containerStack.length - 1];
          const isMethod =
            (parent !== undefined && parent.kind !== "namespace") ||
            cm[2].includes("::");
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: isMethod ? "method" : "function",
            name: cm[2],
            startLine: lineNo,
            endLine,
            depth:
              containerStack.length > 0
                ? containerStack.length
                : indent > 0
                  ? 1
                  : 0,
          });
          continue;
        }
      }

      if (containerStack.length > 0) {
        const ctor = ctorRe.exec(line);
        if (ctor && ctor[2] && !CLIKE_EXCLUDED_NAMES.has(ctor[2])) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 6, "c");
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            symbols.push({
              kind: "method",
              name: ctor[2],
              startLine: lineNo,
              endLine,
              depth: containerStack.length,
            });
          }
        }
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Shell (.sh / .bash / .zsh)
// ---------------------------------------------------------------------------

function extractShellSymbols(lines: readonly string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const sameLineRe =
    /^(?:function\s+([A-Za-z_][\w-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*\{/;
  const headerOnlyRe =
    /^(?:function\s+([A-Za-z_][\w-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w-]*)\s*\(\s*\))\s*(?:#.*)?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sm = sameLineRe.exec(line);
    if (sm) {
      const name = sm[1] ?? sm[2];
      if (name) {
        symbols.push({
          kind: "function",
          name,
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "shell"),
          depth: 0,
        });
      }
      continue;
    }

    const hm = headerOnlyRe.exec(line);
    if (hm) {
      const name = hm[1] ?? hm[2];
      if (!name) continue;
      // Check next non-blank line starts with `{`
      let nextIdx = i + 1;
      while (nextIdx < lines.length && !(lines[nextIdx] ?? "").trim()) {
        nextIdx++;
      }
      if (nextIdx < lines.length && (lines[nextIdx] ?? "").trim().startsWith("{")) {
        symbols.push({
          kind: "function",
          name,
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "shell"),
          depth: 0,
        });
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// CSS / SCSS / Less
// ---------------------------------------------------------------------------

function extractCssSymbols(
  lines: readonly string[],
  compactOnly: boolean,
): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const state = createScanState();
  let braceDepth = 0;
  let ruleCount = 0;
  const maxRules = compactOnly ? 25 : 200;

  const mixinRe = /^@mixin\s+([A-Za-z_-][\w-]*)/i;
  const scssFnRe = /^@function\s+([A-Za-z_-][\w-]*)/i;
  const atRuleRe =
    /^@(layer|media|keyframes|supports|container|font-face|theme|scope|property)\b([^{;]*)/i;
  const lessMixinRe = /^(\.[A-Za-z_-][\w-]*)\s*\([^)]*\)\s*\{/;
  const tokenBlockRe =
    /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const sectionCommentRe =
    /^\/\*\s*[=\-*#]*\s*([^*/=][^*/]{1,70}?)\s*[=\-*#]*\s*\*\/$/;

  let pendingSelectorStart = -1;
  let pendingSelectorText = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;

    if (!wasInComment && braceDepth === 0) {
      if (!trimmed || trimmed.startsWith("//")) {
        pendingSelectorStart = -1;
        pendingSelectorText = "";
      } else {
        const cm = sectionCommentRe.exec(trimmed);
        if (cm && cm[1] && /[A-Za-z0-9]/.test(cm[1])) {
          pendingSelectorStart = -1;
          pendingSelectorText = "";
          symbols.push({
            kind: "section",
            name: cm[1].trim().slice(0, 64),
            startLine: i + 1,
            endLine: i + 1,
            depth: 0,
          });
        } else {
          const mx = mixinRe.exec(trimmed);
          const sf = !mx ? scssFnRe.exec(trimmed) : null;
          const ar = !mx && !sf ? atRuleRe.exec(trimmed) : null;
          const lm = !mx && !sf && !ar ? lessMixinRe.exec(trimmed) : null;
          const tb = !mx && !sf && !ar && !lm ? tokenBlockRe.exec(trimmed) : null;

          if (mx && mx[1]) {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
            symbols.push({
              kind: "mixin",
              name: mx[1],
              startLine: i + 1,
              endLine: findBraceBlockEnd(lines, i, "c"),
              depth: 0,
            });
          } else if (sf && sf[1]) {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
            symbols.push({
              kind: "function",
              name: sf[1],
              startLine: i + 1,
              endLine: findBraceBlockEnd(lines, i, "c"),
              depth: 0,
            });
          } else if (ar && ar[1]) {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
            const kind = `@${ar[1].toLowerCase()}`;
            const rest = (ar[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
            const endLine = trimmed.includes("{")
              ? findBraceBlockEnd(lines, i, "c")
              : i + 1;
            symbols.push({
              kind,
              name: rest || kind,
              startLine: i + 1,
              endLine,
              depth: 0,
            });
          } else if (lm && lm[1]) {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
            symbols.push({
              kind: "mixin",
              name: lm[1],
              startLine: i + 1,
              endLine: findBraceBlockEnd(lines, i, "c"),
              depth: 0,
            });
          } else if (tb && tb[1]) {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
            const header = trimmed
              .slice(0, trimmed.indexOf("{"))
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tb[1],
              startLine: i + 1,
              endLine: findBraceBlockEnd(lines, i, "c"),
              depth: 0,
            });
          } else if (
            !trimmed.startsWith("@") &&
            !trimmed.startsWith("/*") &&
            !trimmed.startsWith("*") &&
            !trimmed.startsWith("$") &&
            !trimmed.endsWith(";")
          ) {
            if (trimmed.includes("{")) {
              const beforeBrace = trimmed.slice(0, trimmed.indexOf("{")).trim();
              const startIdx =
                pendingSelectorStart >= 0 ? pendingSelectorStart : i;
              const combined = (
                pendingSelectorText
                  ? `${pendingSelectorText} ${beforeBrace}`
                  : beforeBrace
              )
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 60);
              if (combined && ruleCount < maxRules) {
                symbols.push({
                  kind: "rule",
                  name: combined,
                  startLine: startIdx + 1,
                  endLine: findBraceBlockEnd(lines, i, "c"),
                  depth: 0,
                });
                ruleCount++;
              }
              pendingSelectorStart = -1;
              pendingSelectorText = "";
            } else if (/^[.#\[a-zA-Z*:]/.test(trimmed)) {
              if (pendingSelectorStart < 0) {
                pendingSelectorStart = i;
                pendingSelectorText = trimmed;
              } else {
                pendingSelectorText = `${pendingSelectorText} ${trimmed}`;
              }
            } else {
              pendingSelectorStart = -1;
              pendingSelectorText = "";
            }
          } else {
            pendingSelectorStart = -1;
            pendingSelectorText = "";
          }
        }
      }
    } else {
      pendingSelectorStart = -1;
      pendingSelectorText = "";
    }

    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// HTML / Vue / Svelte
// ---------------------------------------------------------------------------

function leadingWhitespaceCols(line: string, tabWidth = 4): number {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += tabWidth;
    else break;
  }
  return cols;
}

function stripLeadingCols(
  line: string,
  colsToStrip: number,
  tabWidth = 4,
): string {
  if (colsToStrip <= 0) return line;
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < colsToStrip) {
    const ch = line[idx];
    if (ch === " ") {
      cols += 1;
      idx++;
    } else if (ch === "\t") {
      cols += tabWidth;
      idx++;
    } else {
      break;
    }
  }
  if (cols > colsToStrip) {
    return " ".repeat(cols - colsToStrip) + line.slice(idx);
  }
  return line.slice(idx);
}

function dedentBlockLines(
  lines: readonly string[],
  skipFirstLineForIndent = false,
): string[] {
  const startIdx = skipFirstLineForIndent ? 1 : 0;
  let firstNonEmptyIndent = -1;
  let minPosCols = Number.POSITIVE_INFINITY;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    const cols = leadingWhitespaceCols(line);
    if (firstNonEmptyIndent === -1) firstNonEmptyIndent = cols;
    if (cols > 0 && cols < minPosCols) minPosCols = cols;
  }

  if (
    firstNonEmptyIndent <= 0 ||
    !Number.isFinite(minPosCols) ||
    minPosCols <= 0
  ) {
    return [...lines];
  }

  return lines.map((line, idx) => {
    if (idx < startIdx || !line.trim()) return line;
    return stripLeadingCols(line, minPosCols);
  });
}

function findMatchingBrace(
  text: string,
  start: number,
  maxLookahead = 2000,
): number {
  const limit = Math.min(text.length, start + maxLookahead);
  let depth = 0;
  let quote: string | null = null;
  let escape = false;

  for (let i = start; i < limit; i++) {
    const ch = text[i] ?? "";
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function findClosingMustache(
  text: string,
  start: number,
  maxLookahead = 2000,
): number {
  const limit = Math.min(text.length, start + maxLookahead);
  let quote: string | null = null;
  let escape = false;

  for (let i = start + 2; i + 1 < limit; i++) {
    const ch = text[i] ?? "";
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "}" && text[i + 1] === "}") {
      return i;
    }
  }

  return -1;
}

function parseHtmlAttrs(attrText: string): {
  attrs: Map<string, string>;
  vueSlot?: string;
} {
  const attrs = new Map<string, string>();
  let vueSlot: string | undefined;
  let i = 0;
  const len = attrText.length;

  while (i < len) {
    while (i < len && /[\s/]/.test(attrText[i] ?? "")) i++;
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>"'`]/.test(attrText[i] ?? "")) i++;
    const rawName = attrText.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }

    const lowerName = rawName.toLowerCase();
    if (!vueSlot && rawName.startsWith("#") && rawName.length > 1) {
      vueSlot = rawName.slice(1);
    } else if (!vueSlot && lowerName.startsWith("v-slot:") && rawName.length > 7) {
      vueSlot = rawName.slice(7);
    }

    while (i < len && /\s/.test(attrText[i] ?? "")) i++;
    let value = "";
    if (i < len && attrText[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrText[i] ?? "")) i++;
      if (i < len) {
        const ch = attrText[i] ?? "";
        if (ch === '"' || ch === "'") {
          const quote = ch;
          i++;
          const valStart = i;
          while (i < len && attrText[i] !== quote) i++;
          value = attrText.slice(valStart, i);
          if (i < len) i++;
        } else if (ch === "{") {
          const endBrace = findMatchingBrace(attrText, i);
          if (endBrace >= 0) {
            value = attrText.slice(i, endBrace + 1);
            i = endBrace + 1;
          } else {
            const valStart = i;
            while (i < len && !/[\s/>]/.test(attrText[i] ?? "")) i++;
            value = attrText.slice(valStart, i);
          }
        } else {
          const valStart = i;
          while (i < len && !/[\s/>]/.test(attrText[i] ?? "")) i++;
          value = attrText.slice(valStart, i);
        }
      }
    }

    if (!attrs.has(lowerName)) {
      attrs.set(lowerName, value);
    }
  }

  return { attrs, vueSlot };
}

function normalizeInlineAttr(
  value: string | undefined,
  maxChars: number,
): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? compact.slice(0, maxChars) : compact;
}

function formatHtmlTagLabel(
  displayTag: string,
  lowerTag: string,
  rawAttrs: string,
  parsed: { attrs: Map<string, string>; vueSlot?: string },
): string {
  if (lowerTag === "script" || lowerTag === "style") {
    const compact = normalizeInlineAttr(rawAttrs, 40);
    return compact ? `<${lowerTag} ${compact}>` : `<${lowerTag}>`;
  }

  const idVal = normalizeInlineAttr(parsed.attrs.get("id"), 36);
  if (idVal) return `<${displayTag} #${idVal}>`;

  const testIdVal = normalizeInlineAttr(parsed.attrs.get("data-testid"), 36);
  if (testIdVal) return `<${displayTag} data-testid="${testIdVal}">`;

  const roleVal = normalizeInlineAttr(parsed.attrs.get("role"), 36);
  if (roleVal) return `<${displayTag} role="${roleVal}">`;

  const slotVal = normalizeInlineAttr(parsed.vueSlot, 36);
  if (lowerTag === "template" && slotVal) return `<template #${slotVal}>`;

  return `<${displayTag}>`;
}

function isJsScriptType(typeAttr: string | undefined): boolean {
  if (typeAttr === undefined) return true;
  const mime = typeAttr.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    !mime ||
    mime === "module" ||
    mime === "text/javascript" ||
    mime === "application/javascript" ||
    mime === "text/ecmascript" ||
    mime === "application/ecmascript" ||
    mime === "text/typescript" ||
    mime === "ts" ||
    mime === "tsx" ||
    mime === "jsx"
  );
}

function extractHtmlCommentLandmark(inner: string): string | null {
  const cleaned = inner
    .replace(/^[\s=\-*#~:]+/, "")
    .replace(/[\s=\-*#~:]+$/, "");
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/[<>]/.test(cleaned)) return null;
  if (/^(?:eslint|prettier|istanbul|c8|v8|@ts-)/i.test(cleaned)) return null;
  if (!/[A-Za-z0-9]/.test(cleaned)) return null;
  return cleaned;
}

type TemplateMode = "html" | "vue" | "svelte";

function extractTemplateSymbols(
  lines: readonly string[],
  mode: TemplateMode,
): SymbolEntry[] {
  if (lines.length === 0) return [];

  const text = lines.join("\n");
  const lineStarts = new Array<number>(lines.length);
  let acc = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    lineStarts[idx] = acc;
    acc += (lines[idx] ?? "").length + 1;
  }

  const offsetToLineIdx = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  interface OpenFrame {
    lowerTag: string;
    startLine: number;
    emitted: boolean;
    symbol?: SymbolEntry;
  }

  const symbols: SymbolEntry[] = [];
  const stack: OpenFrame[] = [];
  const stackTagCounts = new Map<string, number>();

  const pushFrame = (frame: OpenFrame) => {
    stack.push(frame);
    stackTagCounts.set(
      frame.lowerTag,
      (stackTagCounts.get(frame.lowerTag) ?? 0) + 1,
    );
  };
  const popFrame = (): OpenFrame => {
    const frame = stack.pop()!;
    const prev = stackTagCounts.get(frame.lowerTag) ?? 0;
    if (prev <= 1) stackTagCounts.delete(frame.lowerTag);
    else stackTagCounts.set(frame.lowerTag, prev - 1);
    return frame;
  };

  let emittedCount = 0;
  let noCloseSingle = false;
  let noCloseDouble = false;
  let noCloseScript = false;
  let noCloseStyle = false;
  let noCloseBodyBrace = false;
  let noCloseMustache = false;
  const noCloseRawSkip = new Set<string>();
  let nextRightBrace = text.indexOf("}");
  let nextCloseMustache = mode === "vue" ? text.indexOf("}}") : -1;

  let i = 0;
  const len = text.length;

  while (i < len) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;

    // Skip template expressions in Svelte (`{...}`) and Vue (`{{...}}`)
    if (mode === "svelte" && !noCloseBodyBrace) {
      const bracePos = text.indexOf("{", i);
      if (bracePos >= 0 && bracePos < lt) {
        if (nextRightBrace !== -1 && nextRightBrace < bracePos) {
          nextRightBrace = text.indexOf("}", bracePos);
        }
        if (nextRightBrace === -1) {
          noCloseBodyBrace = true;
        } else if (nextRightBrace < bracePos + 2000) {
          const endBrace = findMatchingBrace(text, bracePos);
          i = endBrace >= 0 ? endBrace + 1 : bracePos + 1;
          continue;
        } else if (nextRightBrace < lt) {
          i = nextRightBrace + 1;
          continue;
        }
      }
    } else if (mode === "vue" && !noCloseMustache) {
      const mustachePos = text.indexOf("{{", i);
      if (mustachePos >= 0 && mustachePos < lt) {
        if (nextCloseMustache !== -1 && nextCloseMustache < mustachePos + 2) {
          nextCloseMustache = text.indexOf("}}", mustachePos + 2);
        }
        if (nextCloseMustache === -1) {
          noCloseMustache = true;
        } else if (nextCloseMustache < mustachePos + 2000) {
          const endMustache = findClosingMustache(text, mustachePos);
          i = endMustache >= 0 ? endMustache + 2 : mustachePos + 2;
          continue;
        } else if (nextCloseMustache < lt) {
          i = nextCloseMustache + 2;
          continue;
        }
      }
    }

    i = lt;

    // 1. HTML comments
    if (text.startsWith("<!--", i)) {
      if (text.startsWith("<!-->", i)) {
        i += 5;
        continue;
      }
      if (text.startsWith("<!--->", i)) {
        i += 6;
        continue;
      }
      const startLineIdx = offsetToLineIdx(i);
      const stdClose = text.indexOf("-->", i + 4);
      const bangClose = text.indexOf("--!>", i + 4);
      let closePos = -1;
      let closeLen = 3;
      if (stdClose >= 0 && (bangClose < 0 || stdClose <= bangClose)) {
        closePos = stdClose;
        closeLen = 3;
      } else if (bangClose >= 0) {
        closePos = bangClose;
        closeLen = 4;
      }
      if (closePos < 0) break;

      const endLineIdx = offsetToLineIdx(closePos + closeLen - 1);
      if (startLineIdx === endLineIdx && closeLen === 3) {
        const lineTrim = (lines[startLineIdx] ?? "").trim();
        if (
          lineTrim.startsWith("<!--") &&
          lineTrim.endsWith("-->") &&
          lineTrim.indexOf("-->", 4) === lineTrim.length - 3
        ) {
          const landmark = extractHtmlCommentLandmark(
            text.slice(i + 4, closePos),
          );
          if (landmark) {
            const ln = startLineIdx + 1;
            symbols.push({
              kind: "section",
              name: landmark,
              startLine: ln,
              endLine: ln,
              depth: Math.min(MAX_HTML_DEPTH, emittedCount),
            });
          }
        }
      }
      i = closePos + closeLen;
      continue;
    }

    // 2. CDATA
    if (text.startsWith("<![CDATA[", i)) {
      const closePos = text.indexOf("]]>", i + 9);
      i = closePos < 0 ? len : closePos + 3;
      continue;
    }

    // 3. Processing instruction or DOCTYPE
    const nextCh = text[i + 1];
    if (nextCh === "?") {
      const closePi = text.indexOf("?>", i + 2);
      if (closePi >= 0) {
        i = closePi + 2;
      } else {
        const closeGt = text.indexOf(">", i + 2);
        i = closeGt >= 0 ? closeGt + 1 : len;
      }
      continue;
    }
    if (nextCh === "!") {
      let quote: string | null = null;
      let j = i + 2;
      while (j < len) {
        const c = text[j] ?? "";
        if (quote) {
          if (c === quote || c === "\n") quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ">") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    // 4. Closing tag
    if (nextCh === "/") {
      const nameStart = i + 2;
      if (nameStart >= len || !/[A-Za-z]/.test(text[nameStart] ?? "")) {
        i += 2;
        continue;
      }
      let j = nameStart + 1;
      while (j < len && /[A-Za-z0-9:._-]/.test(text[j] ?? "")) j++;
      const closeLowerTag = text.slice(nameStart, j).toLowerCase();
      while (j < len && text[j] !== ">") j++;
      if (j < len && text[j] === ">") j++;

      const closeLine = offsetToLineIdx(Math.max(i, j - 1)) + 1;

      if ((stackTagCounts.get(closeLowerTag) ?? 0) > 0) {
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]?.lowerTag === closeLowerTag) {
            matchIdx = s;
            break;
          }
        }
        if (matchIdx >= 0) {
          for (let s = stack.length - 1; s > matchIdx; s--) {
            const unclosed = popFrame();
            if (unclosed.emitted) {
              emittedCount = Math.max(0, emittedCount - 1);
              if (unclosed.symbol) {
                unclosed.symbol.endLine = Math.max(
                  unclosed.symbol.endLine,
                  closeLine > unclosed.startLine
                    ? closeLine - 1
                    : unclosed.startLine,
                );
              }
            }
          }
          const matched = popFrame();
          if (matched.emitted) {
            emittedCount = Math.max(0, emittedCount - 1);
            if (matched.symbol) {
              matched.symbol.endLine = Math.max(
                matched.symbol.endLine,
                closeLine,
              );
            }
          }
        }
      }

      i = j;
      continue;
    }

    // 5. Opening tag
    if (!nextCh || !/[A-Za-z]/.test(nextCh)) {
      i++;
      continue;
    }

    const tagStart = i;
    let nameEnd = i + 1;
    while (nameEnd < len && /[A-Za-z0-9:._-]/.test(text[nameEnd] ?? "")) {
      nameEnd++;
    }
    const afterNameCh = text[nameEnd];
    if (afterNameCh !== undefined && !/[\s/>]/.test(afterNameCh)) {
      i = nameEnd;
      continue;
    }

    const rawTag = text.slice(i + 1, nameEnd);
    const lowerTag = rawTag.toLowerCase();

    const headerLimit = Math.min(len, nameEnd + MAX_TAG_HEADER_SCAN);
    let j = nameEnd;
    let quote: string | null = null;
    let braceDepth = 0;
    let braceQuote: string | null = null;
    let braceEscape = false;
    let lastUnquotedNonWs = "";
    let foundGt = false;

    while (j < headerLimit) {
      const c = text[j] ?? "";
      if (braceDepth > 0) {
        if (braceEscape) {
          braceEscape = false;
        } else if (braceQuote) {
          if (c === "\\") braceEscape = true;
          else if (c === braceQuote) braceQuote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          braceQuote = c;
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
          if (braceDepth === 0) lastUnquotedNonWs = "}";
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if ((c === '"' || c === "'") && lastUnquotedNonWs === "=") {
        if ((c === '"' && !noCloseDouble) || (c === "'" && !noCloseSingle)) {
          quote = c;
        }
        lastUnquotedNonWs = c;
        j++;
        continue;
      }
      if (c === "{") {
        if (nextRightBrace !== -1 && nextRightBrace < j) {
          nextRightBrace = text.indexOf("}", j);
        }
        if (nextRightBrace === -1 || nextRightBrace >= headerLimit) {
          foundGt = false;
          break;
        }
        braceDepth = 1;
        braceQuote = null;
        braceEscape = false;
        j++;
        continue;
      }
      if (c === "<") {
        foundGt = false;
        break;
      }
      if (
        (c === "&" && text[j + 1] === "&") ||
        (c === "|" && text[j + 1] === "|") ||
        (c === "=" && text[j + 1] === ">")
      ) {
        foundGt = false;
        break;
      }
      if (c === ">") {
        foundGt = true;
        break;
      }
      if (!/\s/.test(c)) {
        lastUnquotedNonWs = c;
      }
      j++;
    }

    if (!foundGt) {
      if (j === len) {
        if (quote === '"') noCloseDouble = true;
        else if (quote === "'") noCloseSingle = true;
      }
      i = tagStart + 1;
      continue;
    }

    const gtPos = j;
    const selfClosing = lastUnquotedNonWs === "/";
    const rawAttrSlice = text.slice(
      nameEnd,
      selfClosing ? text.lastIndexOf("/", gtPos) : gtPos,
    );
    const startLineIdx = offsetToLineIdx(tagStart);
    const openEndLineIdx = offsetToLineIdx(gtPos);
    const startLine = startLineIdx + 1;
    const openEndLine = openEndLineIdx + 1;

    // Raw skip tags
    if (HTML_RAW_SKIP_TAGS.has(lowerTag)) {
      if (selfClosing || noCloseRawSkip.has(lowerTag)) {
        i = gtPos + 1;
        continue;
      }
      const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
      closeRe.lastIndex = gtPos + 1;
      const closeMatch = closeRe.exec(text);
      if (closeMatch) {
        i = closeMatch.index + closeMatch[0].length;
      } else {
        noCloseRawSkip.add(lowerTag);
        i = gtPos + 1;
      }
      continue;
    }

    // Inline <script> and <style> blocks with recursive extraction
    if (lowerTag === "script" || lowerTag === "style") {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const tagDepth = Math.min(MAX_HTML_DEPTH, emittedCount);
      const label = formatHtmlTagLabel(lowerTag, lowerTag, rawAttrSlice, parsed);

      if (selfClosing) {
        symbols.push({
          kind: lowerTag,
          name: label,
          startLine,
          endLine: openEndLine,
          depth: tagDepth,
        });
        i = gtPos + 1;
        continue;
      }

      const noCloseLatch = lowerTag === "script" ? noCloseScript : noCloseStyle;
      let closeMatch: RegExpExecArray | null = null;
      if (!noCloseLatch) {
        const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
        closeRe.lastIndex = gtPos + 1;
        closeMatch = closeRe.exec(text);
        if (!closeMatch) {
          if (lowerTag === "script") noCloseScript = true;
          else noCloseStyle = true;
        }
      }

      let closeStart: number;
      let endLine: number;
      let nextPos: number;

      if (closeMatch) {
        closeStart = closeMatch.index;
        const closeEndPos = closeMatch.index + closeMatch[0].length;
        endLine = Math.max(startLine, offsetToLineIdx(closeEndPos - 1) + 1);
        nextPos = closeEndPos;
      } else if (lowerTag === "script" && parsed.attrs.has("src")) {
        closeStart = gtPos + 1;
        endLine = openEndLine;
        nextPos = gtPos + 1;
      } else {
        closeStart = len;
        endLine = Math.max(startLine, lines.length);
        nextPos = len;
      }

      symbols.push({
        kind: lowerTag,
        name: label,
        startLine,
        endLine,
        depth: tagDepth,
      });

      const shouldRecurse =
        closeStart > gtPos + 1 &&
        (lowerTag === "style" ||
          (!parsed.attrs.has("src") && isJsScriptType(parsed.attrs.get("type"))));

      if (shouldRecurse) {
        const closeLineIdx = offsetToLineIdx(
          closeStart < len ? closeStart : Math.max(0, len - 1),
        );
        const innerLines: string[] = [];
        let innerBaseLineIdx: number;
        let hasFirstRest = false;

        if (openEndLineIdx === closeLineIdx) {
          innerBaseLineIdx = openEndLineIdx;
          const singleInner = text.slice(gtPos + 1, closeStart);
          if (singleInner.trim()) innerLines.push(singleInner);
        } else {
          const openLineEnd =
            openEndLineIdx + 1 < lineStarts.length
              ? (lineStarts[openEndLineIdx + 1] ?? len) - 1
              : len;
          const firstRest = text.slice(gtPos + 1, openLineEnd);
          if (firstRest.trim()) {
            innerBaseLineIdx = openEndLineIdx;
            innerLines.push(firstRest.trimStart());
            hasFirstRest = true;
          } else {
            innerBaseLineIdx = openEndLineIdx + 1;
          }
          for (let li = openEndLineIdx + 1; li < closeLineIdx; li++) {
            innerLines.push(lines[li] ?? "");
          }
          if (closeStart < len) {
            const lastPrefix = text.slice(
              lineStarts[closeLineIdx] ?? closeStart,
              closeStart,
            );
            if (lastPrefix.trim()) innerLines.push(lastPrefix);
          } else if (closeLineIdx >= openEndLineIdx + 1) {
            innerLines.push(lines[closeLineIdx] ?? "");
          }
        }

        if (innerLines.some((l) => l.trim().length > 0)) {
          const dedented = dedentBlockLines(innerLines, hasFirstRest);
          const innerSyms =
            lowerTag === "script"
              ? extractTsJsSymbols(dedented)
              : extractCssSymbols(dedented, true);
          for (const s of innerSyms) {
            const childStart = s.startLine + innerBaseLineIdx;
            const childEnd = Math.max(childStart, s.endLine + innerBaseLineIdx);
            symbols.push({
              kind: s.kind,
              name: s.name,
              startLine: childStart,
              endLine: childEnd,
              depth: Math.min(MAX_HTML_DEPTH, tagDepth + 1 + s.depth),
            });
          }
        }
      }

      i = nextPos;
      continue;
    }

    // Headings <h1>..<h6>
    if (HTML_HEADING_TAGS.has(lowerTag)) {
      const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
      closeRe.lastIndex = gtPos + 1;
      const closeMatch = selfClosing ? null : closeRe.exec(text);
      const innerRaw = closeMatch ? text.slice(gtPos + 1, closeMatch.index) : "";
      const headingText = innerRaw
        .replace(/<\/?[A-Za-z][A-Za-z0-9:._-]*(?:\s[^>]*)?>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const endLine = closeMatch
        ? Math.max(
            startLine,
            offsetToLineIdx(closeMatch.index + closeMatch[0].length - 1) + 1,
          )
        : openEndLine;
      symbols.push({
        kind: lowerTag,
        name: headingText || `<${lowerTag}>`,
        startLine,
        endLine,
        depth: Math.min(MAX_HTML_DEPTH, emittedCount),
      });
      i = closeMatch ? closeMatch.index + closeMatch[0].length : gtPos + 1;
      continue;
    }

    const isVoid = HTML_VOID_ELEMENTS.has(lowerTag);
    const isComponent = PASCAL_COMPONENT_RE.test(rawTag);
    const isSemantic = HTML_SEMANTIC_TAGS.has(lowerTag);
    const isContainer = HTML_CONTAINER_TAGS.has(lowerTag);

    let shouldEmit = false;
    let emittedSymbol: SymbolEntry | undefined;

    if (isComponent || isSemantic || isContainer) {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const hasIdentityAttr =
        Boolean(parsed.attrs.get("id")?.trim()) ||
        Boolean(parsed.attrs.get("data-testid")?.trim()) ||
        Boolean(parsed.attrs.get("role")?.trim());
      const keepTemplate =
        lowerTag !== "template" ||
        emittedCount === 0 ||
        Boolean(parsed.vueSlot) ||
        hasIdentityAttr;

      if (
        keepTemplate &&
        (isComponent || isSemantic || (isContainer && hasIdentityAttr))
      ) {
        shouldEmit = true;
        const displayTag = isComponent ? rawTag : lowerTag;
        const kind =
          lowerTag === "template"
            ? "template"
            : isComponent
              ? "component"
              : "block";
        emittedSymbol = {
          kind,
          name: formatHtmlTagLabel(displayTag, lowerTag, rawAttrSlice, parsed),
          startLine,
          endLine: openEndLine,
          depth: Math.min(MAX_HTML_DEPTH, emittedCount),
        };
        symbols.push(emittedSymbol);
      }
    }

    if (!selfClosing && !isVoid) {
      pushFrame({
        lowerTag,
        startLine,
        emitted: shouldEmit,
        symbol: emittedSymbol,
      });
      if (shouldEmit) emittedCount++;
    }

    i = gtPos + 1;
  }

  // Unwind any unclosed tags cleanly at EOF
  const eofLine = lines.length;
  while (stack.length > 0) {
    const frame = popFrame();
    if (frame.emitted && frame.symbol) {
      frame.symbol.endLine = Math.max(frame.symbol.endLine, eofLine);
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function extractMarkdownSymbols(lines: readonly string[]): SymbolEntry[] {
  const raw: Array<{ level: number; name: string; startLine: number }> = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch && fenceMatch[1]) {
      const marker = fenceMatch[1];
      const ch = marker[0] as "`" | "~";
      const rest = (fenceMatch[2] ?? "").trim();
      if (fenceChar === null) {
        // Backtick info strings cannot contain backticks in CommonMark
        if (ch === "`" && rest.includes("`")) {
          // Not a fence
        } else {
          fenceChar = ch;
          fenceLen = marker.length;
          continue;
        }
      } else if (ch === fenceChar && marker.length >= fenceLen && rest === "") {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
    }

    if (fenceChar !== null) continue;

    const m = /^(#{1,4})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({
        level: m[1].length,
        name: m[2].trim(),
        startLine: i + 1,
      });
    }
  }

  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if ((raw[j]?.level ?? 0) <= item.level) {
        endLine = (raw[j]?.startLine ?? endLine) - 1;
        break;
      }
    }
    while (endLine > item.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1,
    };
  });
}

// ---------------------------------------------------------------------------
// JSON / JSONC (top-level & depth-1 structural keys)
// ---------------------------------------------------------------------------

function extractJsonSymbols(lines: readonly string[]): SymbolEntry[] {
  interface JsonContainer {
    type: "object" | "array";
    expectingKey: boolean;
    activeKey?: SymbolEntry;
  }

  const symbols: SymbolEntry[] = [];
  const stack: JsonContainer[] = [];
  let inBlockComment = false;
  let lastTokenLine = 1;

  const currentObjectDepth = (): number => {
    // Only count direct object nesting from root (no intervening arrays)
    for (const c of stack) {
      if (c.type !== "object") return -1;
    }
    return stack.length;
  };

  const closeActiveKey = (endLine: number) => {
    const top = stack[stack.length - 1];
    if (top && top.activeKey) {
      top.activeKey.endLine = Math.max(top.activeKey.startLine, endLine);
      top.activeKey = undefined;
    }
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";
    const lineNo = lineIdx + 1;
    let i = 0;

    while (i < line.length) {
      const ch = line[i] ?? "";
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // JSONC comments
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }

      if (ch === '"') {
        const strStart = i + 1;
        i++;
        let strVal = "";
        while (i < line.length) {
          const c = line[i] ?? "";
          if (c === "\\") {
            if (i + 1 < line.length) {
              strVal += line[i + 1];
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === '"') {
            i++;
            break;
          }
          strVal += c;
          i++;
        }
        if (strStart <= line.length) {
          const top = stack[stack.length - 1];
          const objDepth = currentObjectDepth();
          if (top && top.type === "object" && top.expectingKey) {
            top.expectingKey = false;
            if (objDepth === 1 || objDepth === 2) {
              const entry: SymbolEntry = {
                kind: "key",
                name: strVal,
                startLine: lineNo,
                endLine: lineNo,
                depth: objDepth - 1,
              };
              symbols.push(entry);
              top.activeKey = entry;
            }
          }
          lastTokenLine = lineNo;
        }
        continue;
      }

      if (ch === "{") {
        stack.push({ type: "object", expectingKey: true });
        lastTokenLine = lineNo;
        i++;
        continue;
      }

      if (ch === "[") {
        stack.push({ type: "array", expectingKey: false });
        lastTokenLine = lineNo;
        i++;
        continue;
      }

      if (ch === "}") {
        closeActiveKey(lastTokenLine);
        stack.pop();
        lastTokenLine = lineNo;
        i++;
        continue;
      }

      if (ch === "]") {
        stack.pop();
        lastTokenLine = lineNo;
        i++;
        continue;
      }

      if (ch === ",") {
        closeActiveKey(lastTokenLine);
        const top = stack[stack.length - 1];
        if (top && top.type === "object") {
          top.expectingKey = true;
        }
        i++;
        continue;
      }

      if (ch === ":") {
        i++;
        continue;
      }

      // Primitive token (number, true, false, null)
      while (i < line.length && !/[\s,}\]:]/.test(line[i] ?? "")) {
        i++;
      }
      lastTokenLine = lineNo;
    }
  }

  while (stack.length > 0) {
    closeActiveKey(lastTokenLine);
    stack.pop();
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// YAML (top-level & depth-1 structural keys)
// ---------------------------------------------------------------------------

function isYamlBlockScalarHeader(afterColon: string): boolean {
  const withoutComment = afterColon.replace(/\s+#.*$/, "").trim();
  return /^[|>][+-]?\d*$/.test(withoutComment) || /^[|>]\d*[+-]?$/.test(withoutComment);
}

function extractYamlSymbols(lines: readonly string[]): SymbolEntry[] {
  const keyRe =
    /^([ \t]*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))\s*:(?:\s(.*)|$)/;

  const inBlockScalar = new Array<boolean>(lines.length).fill(false);
  let blockParentIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (blockParentIndent >= 0) {
      if (!trimmed) {
        inBlockScalar[i] = true;
        continue;
      }
      const indent = indentWidthPy(line);
      if (indent > blockParentIndent) {
        inBlockScalar[i] = true;
        continue;
      }
      blockParentIndent = -1;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    // Detect block scalar header on either a key line or list item line (`- run: |` or `- |`)
    const km = keyRe.exec(line);
    if (km && isYamlBlockScalarHeader(km[5] ?? "")) {
      blockParentIndent = indentWidthPy(line);
      continue;
    }
    const listScalar = /^([ \t]*)-\s+(?:[^:#\n]+:\s*)?([|>][+-]?\d*|[|>]\d*[+-]?)\s*(?:#.*)?$/.exec(
      line,
    );
    if (listScalar) {
      blockParentIndent = indentWidthPy(line);
    }
  }

  interface YamlRawKey {
    name: string;
    indent: number;
    depth: number;
    lineIdx: number;
  }

  const raw: YamlRawKey[] = [];
  let activeTopChildIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    if (inBlockScalar[i]) continue;
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") {
      if (trimmed === "---" || trimmed === "...") {
        activeTopChildIndent = -1;
      }
      continue;
    }

    const km = keyRe.exec(line);
    if (!km) continue;

    const name = km[2] ?? km[3] ?? km[4];
    if (!name) continue;
    const indent = (km[1] ?? "").replace(/\t/g, "  ").length;

    if (indent === 0) {
      activeTopChildIndent = -1;
      raw.push({ name, indent: 0, depth: 0, lineIdx: i });
    } else {
      if (activeTopChildIndent === -1) {
        activeTopChildIndent = indent;
      }
      if (indent === activeTopChildIndent) {
        raw.push({ name, indent, depth: 1, lineIdx: i });
      }
    }
  }

  return raw.map((item) => {
    let endIdx = lines.length - 1;
    for (let j = item.lineIdx + 1; j < lines.length; j++) {
      if (inBlockScalar[j]) continue;
      const l = lines[j] ?? "";
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed === "---" || trimmed === "...") {
        endIdx = j - 1;
        break;
      }
      const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "  ").length;
      if (curIndent <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }

    while (endIdx > item.lineIdx) {
      const l = lines[endIdx] ?? "";
      const trimmed = l.trim();
      if (
        trimmed &&
        !(
          !inBlockScalar[endIdx] &&
          trimmed.startsWith("#") &&
          (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "  ").length <= item.indent
        )
      ) {
        break;
      }
      endIdx--;
    }

    return {
      kind: "key",
      name: item.name,
      startLine: item.lineIdx + 1,
      endLine: Math.max(item.lineIdx + 1, endIdx + 1),
      depth: item.depth,
    };
  });
}
