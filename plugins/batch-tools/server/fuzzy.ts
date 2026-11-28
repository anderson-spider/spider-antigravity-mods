export interface FuzzyMatchResult {
  path: string;
  score: number;
}

const MAX_GLOB_LENGTH = 2_048;
const MAX_BRACE_DEPTH = 8;
const MAX_WILDCARD_SEGMENTS = 32;
const MAX_DP_CELLS = 4_096;

function findClosingBracket(str: string, openIdx: number): number {
  let i = openIdx + 1;
  if (i < str.length && (str[i] === "!" || str[i] === "^")) i++;
  if (i < str.length && str[i] === "]") i++;
  for (; i < str.length; i++) {
    if (str[i] === "]") return i;
  }
  return -1;
}

function findMatchingBrace(str: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === "[") {
      const close = findClosingBracket(str, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "[") {
      const close = findClosingBracket(inner, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function splitUnbracedPipes(pattern: string): string[] | null {
  if (pattern.includes("{") || pattern.includes("}") || !pattern.includes("|")) {
    return null;
  }
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "[") {
      const close = findClosingBracket(pattern, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (ch === "|") {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(pattern.slice(start));
  return parts;
}

function normalizeGlobSegment(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\*{3,}/g, "**")
    .replace(/(?:\*\*\/)+/g, "**/")
    .replace(/\/\*\*(?=\/\*\*)/g, "");
}

/**
 * Normalizes a glob pattern: converts backslashes to POSIX `/`, strips leading
 * `./`, collapses redundant globstars, and converts simple unbraced `a|b`
 * alternation into `{a,b}`.
 */
export function normalizeGlobPattern(pattern: string): string {
  const base = normalizeGlobSegment(pattern);
  if (!base) return "";

  const piped = splitUnbracedPipes(base);
  if (!piped) return base;

  const cleaned = piped.map((part) => normalizeGlobSegment(part)).filter(Boolean);
  if (cleaned.length < 2) return base;
  return `{${cleaned.join(",")}}`;
}

interface CompileState {
  wildcards: number;
}

function compileGlobBody(
  normalized: string,
  depth: number,
  state: CompileState,
): string {
  if (depth > MAX_BRACE_DEPTH) {
    throw new Error(`Glob brace nesting exceeds maximum depth (${MAX_BRACE_DEPTH})`);
  }

  let re = "";
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === undefined) break;

    if (ch === "*") {
      state.wildcards += 1;
      if (state.wildcards > MAX_WILDCARD_SEGMENTS) {
        throw new Error(
          `Glob pattern exceeds maximum wildcard segments (${MAX_WILDCARD_SEGMENTS})`,
        );
      }

      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = findClosingBracket(normalized, i);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close);
        const negated = inner.startsWith("!") || inner.startsWith("^");
        if (negated) inner = inner.slice(1);
        inner = inner.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        re += negated ? `(?!/)[${"^"}${inner}]` : `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        const compiled = parts
          .map((part) => compileGlobBody(normalizeGlobSegment(part), depth + 1, state))
          .join("|");
        re += `(?:${compiled})`;
        i = close + 1;
      }
    } else if (".+^$()|\\]}".includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }

  return re;
}

/**
 * Compiles a glob pattern (`*`, `**`, `?`, `{a,b}`, `[abc]`) into an anchored
 * `RegExp` for POSIX-normalized paths, escaping regex metacharacters and
 * bounding complexity to avoid catastrophic backtracking (ReDoS).
 */
export function globToRegExp(glob: string, caseSensitive = true): RegExp {
  if (glob.length > MAX_GLOB_LENGTH) {
    throw new Error(`Glob pattern exceeds maximum length (${MAX_GLOB_LENGTH})`);
  }

  const normalized = normalizeGlobSegment(glob);
  const state: CompileState = { wildcards: 0 };
  const body = compileGlobBody(normalized, 0, state);

  try {
    return new RegExp(`^${body}$`, caseSensitive ? "" : "i");
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${glob}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isAsciiSeparator(code: number): boolean {
  return (
    code === 47 /* / */ ||
    code === 95 /* _ */ ||
    code === 45 /* - */ ||
    code === 46 /* . */ ||
    code === 32 /* space */
  );
}

function isAsciiUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLowerOrDigit(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function isUnicodeSeparator(ch: string): boolean {
  return ch === "/" || ch === "_" || ch === "-" || ch === "." || ch === " ";
}

function computeBoundaryMaskAscii(target: string): Uint8Array {
  const len = target.length;
  const mask = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      mask[i] = 1;
      continue;
    }
    const prev = target.charCodeAt(i - 1);
    const curr = target.charCodeAt(i);
    if (isAsciiSeparator(prev) || (isAsciiLowerOrDigit(prev) && isAsciiUpper(curr))) {
      mask[i] = 1;
    }
  }
  return mask;
}

function computeBoundaryMaskUnicode(chars: readonly string[]): Uint8Array {
  const len = chars.length;
  const mask = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      mask[i] = 1;
      continue;
    }
    const prev = chars[i - 1] ?? "";
    const curr = chars[i] ?? "";
    const isCamel =
      prev !== prev.toUpperCase() &&
      curr === curr.toUpperCase() &&
      curr !== curr.toLowerCase();
    if (isUnicodeSeparator(prev) || isCamel) {
      mask[i] = 1;
    }
  }
  return mask;
}

function hasSubsequenceAscii(needle: string, haystack: string): boolean {
  let cursor = 0;
  const hLen = haystack.length;
  for (let i = 0; i < needle.length; i++) {
    const code = needle.charCodeAt(i);
    while (cursor < hLen && haystack.charCodeAt(cursor) !== code) {
      cursor++;
    }
    if (cursor === hLen) return false;
    cursor++;
  }
  return true;
}

function hasSubsequenceChars(needle: readonly string[], haystack: readonly string[]): boolean {
  let cursor = 0;
  const hLen = haystack.length;
  for (let i = 0; i < needle.length; i++) {
    const ch = needle[i];
    while (cursor < hLen && haystack[cursor] !== ch) {
      cursor++;
    }
    if (cursor === hLen) return false;
    cursor++;
  }
  return true;
}

function scoreContiguousBest(
  needleLen: number,
  targetLen: number,
  boundaries: Uint8Array,
  findNext: (from: number) => number,
): number {
  let best = -1;
  let pos = findNext(0);
  while (pos !== -1) {
    let score = 1_000;
    if (pos === 0 && needleLen === targetLen) {
      score += 220;
    } else if (pos === 0) {
      score += 120;
    } else if (boundaries[pos] === 1) {
      score += 70;
    }

    const endPos = pos + needleLen;
    if (endPos === targetLen || boundaries[endPos] === 1) {
      score += 30;
    }

    score -= Math.min(40, pos);
    score -= Math.min(50, Math.floor((targetLen - needleLen) / 2));

    if (score > best) best = score;
    pos = findNext(pos + 1);
  }
  return best;
}

function scoreSubsequenceDp(
  needleLen: number,
  targetLen: number,
  matchesAt: (qi: number, ti: number) => boolean,
  boundaries: Uint8Array,
): number {
  const NEG_INF = -1_000_000;
  // prevRow[ti] = best score matching needle[0..qi] ending at target[ti]
  let prevRow = new Int32Array(targetLen).fill(NEG_INF);
  let currRow = new Int32Array(targetLen).fill(NEG_INF);

  for (let ti = 0; ti < targetLen; ti++) {
    if (matchesAt(0, ti)) {
      let s = 10;
      if (ti === 0) s += 30;
      else if (boundaries[ti] === 1) s += 24;
      s -= Math.min(25, ti);
      prevRow[ti] = s;
    }
  }

  for (let qi = 1; qi < needleLen; qi++) {
    currRow.fill(NEG_INF);
    // Track best score for any previous index < ti - 1, accounting for gap penalty (-2 per skipped char)
    let bestPriorWithGap = NEG_INF;
    for (let ti = qi; ti < targetLen; ti++) {
      if (ti >= 2) {
        const twoBack = prevRow[ti - 2] ?? NEG_INF;
        // Decaying best prior by 2 for each extra gap step
        const decayed = bestPriorWithGap > NEG_INF ? bestPriorWithGap - 2 : NEG_INF;
        const candidateFromTwoBack = twoBack > NEG_INF ? twoBack - 2 : NEG_INF;
        bestPriorWithGap = Math.max(decayed, candidateFromTwoBack);
      }

      if (!matchesAt(qi, ti)) continue;

      const prevAdjacent = prevRow[ti - 1] ?? NEG_INF;
      const fromAdjacent = prevAdjacent > NEG_INF ? prevAdjacent + 18 : NEG_INF;
      const bestBefore = Math.max(fromAdjacent, bestPriorWithGap);
      if (bestBefore <= NEG_INF) continue;

      let bonus = 10;
      if (boundaries[ti] === 1) bonus += 24;
      currRow[ti] = bestBefore + bonus;
    }
    const swap = prevRow;
    prevRow = currRow;
    currRow = swap;
  }

  let best = NEG_INF;
  for (let ti = needleLen - 1; ti < targetLen; ti++) {
    const val = prevRow[ti] ?? NEG_INF;
    if (val > best) best = val;
  }

  if (best <= NEG_INF) return -1;
  const lengthPenalty = Math.min(60, Math.floor((targetLen - needleLen) / 2));
  return Math.max(1, 500 + best - lengthPenalty);
}

function scoreSubsequenceGreedy(
  needleLen: number,
  targetLen: number,
  matchesAt: (qi: number, ti: number) => boolean,
  boundaries: Uint8Array,
): number {
  let cursor = 0;
  let first = -1;
  let prev = -1;
  let score = 500;

  for (let qi = 0; qi < needleLen; qi++) {
    while (cursor < targetLen && !matchesAt(qi, cursor)) {
      cursor++;
    }
    if (cursor === targetLen) return -1;

    score += 10;
    if (first === -1) {
      first = cursor;
      if (cursor === 0) score += 30;
      else if (boundaries[cursor] === 1) score += 24;
      score -= Math.min(25, cursor);
    } else {
      if (cursor === prev + 1) {
        score += 18;
      } else {
        score -= Math.min(40, (cursor - prev - 1) * 2);
      }
      if (boundaries[cursor] === 1) score += 24;
    }

    prev = cursor;
    cursor++;
  }

  score -= Math.min(60, Math.floor((targetLen - needleLen) / 2));
  return Math.max(1, score);
}

function scoreTokenAgainstTarget(token: string, target: string): number {
  if (!token || !target) return -1;

  if (isAscii(token) && isAscii(target)) {
    const qLower = token.toLowerCase();
    const tLower = target.toLowerCase();
    if (qLower.length > tLower.length) return -1;
    if (!hasSubsequenceAscii(qLower, tLower)) return -1;

    const boundaries = computeBoundaryMaskAscii(target);
    const contiguous = scoreContiguousBest(
      qLower.length,
      tLower.length,
      boundaries,
      (from) => tLower.indexOf(qLower, from),
    );
    if (contiguous >= 0) return contiguous;

    const matchesAt = (qi: number, ti: number): boolean =>
      qLower.charCodeAt(qi) === tLower.charCodeAt(ti);
    return qLower.length * tLower.length <= MAX_DP_CELLS
      ? scoreSubsequenceDp(qLower.length, tLower.length, matchesAt, boundaries)
      : scoreSubsequenceGreedy(qLower.length, tLower.length, matchesAt, boundaries);
  }

  const targetChars = Array.from(target);
  const tLowerChars = Array.from(target.toLowerCase());
  const qLowerChars = Array.from(token.toLowerCase());
  if (qLowerChars.length > tLowerChars.length) return -1;
  if (!hasSubsequenceChars(qLowerChars, tLowerChars)) return -1;

  const boundaries = computeBoundaryMaskUnicode(targetChars);
  const contiguous = scoreContiguousBest(
    qLowerChars.length,
    tLowerChars.length,
    boundaries,
    (from) => {
      const maxStart = tLowerChars.length - qLowerChars.length;
      for (let start = from; start <= maxStart; start++) {
        let matched = true;
        for (let offset = 0; offset < qLowerChars.length; offset++) {
          if (tLowerChars[start + offset] !== qLowerChars[offset]) {
            matched = false;
            break;
          }
        }
        if (matched) return start;
      }
      return -1;
    },
  );
  if (contiguous >= 0) return contiguous;

  const matchesAt = (qi: number, ti: number): boolean =>
    qLowerChars[qi] === tLowerChars[ti];
  return qLowerChars.length * tLowerChars.length <= MAX_DP_CELLS
    ? scoreSubsequenceDp(qLowerChars.length, tLowerChars.length, matchesAt, boundaries)
    : scoreSubsequenceGreedy(qLowerChars.length, tLowerChars.length, matchesAt, boundaries);
}

function scoreFuzzyPath(candidate: string, tokens: readonly string[]): number {
  const posix = candidate.replace(/\\/g, "/");
  const slashIdx = posix.lastIndexOf("/");
  const basename = slashIdx === -1 ? posix : posix.slice(slashIdx + 1);
  const basenameLower = basename.toLowerCase();

  let totalScore = 0;
  for (const token of tokens) {
    const fullScore = scoreTokenAgainstTarget(token, posix);
    if (fullScore < 0) return -1;

    const baseScore = !token.includes("/")
      ? scoreTokenAgainstTarget(token, basename)
      : -1;

    // Matching the filename itself gets a strong boost over matching parent directories only
    totalScore += baseScore >= 0 ? Math.max(fullScore, baseScore + 120) : fullScore;

    if (basenameLower === token.toLowerCase()) {
      totalScore += 150;
    }
  }

  // Gentle preference for shallower, shorter paths when token match quality is identical
  const depth = posix.split("/").length - 1;
  totalScore -= Math.min(30, depth * 3);
  totalScore -= Math.min(30, Math.floor(posix.length / 8));

  return Math.max(1, totalScore);
}

/**
 * Ranks file paths against a case-insensitive query using subsequence,
 * word/path/camelCase boundary, and basename-aware scoring.
 * Deterministic tie-breaking sorts lexicographically by `path`.
 */
export function rankFuzzyPaths(
  paths: readonly string[],
  query: string,
  limit?: number,
): FuzzyMatchResult[] {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return [];

  let maxResults: number | undefined;
  if (limit !== undefined) {
    if (!Number.isFinite(limit)) return [];
    const truncated = Math.trunc(limit);
    if (truncated <= 0) return [];
    maxResults = truncated;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: FuzzyMatchResult[] = [];
  for (const candidate of paths) {
    const score = scoreFuzzyPath(candidate, tokens);
    if (score >= 0) {
      scored.push({ path: candidate, score });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );

  return maxResults === undefined ? scored : scored.slice(0, maxResults);
}
