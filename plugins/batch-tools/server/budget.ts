import { Buffer } from "node:buffer";

/**
 * Keep default MCP tool responses <= 8,800 UTF-8 bytes so hosts deliver them
 * inline instead of spilling large outputs to disk.
 */
export const DEFAULT_INLINE_MAX_BYTES = 8_800;

/**
 * Default character budget paired with {@link DEFAULT_INLINE_MAX_BYTES}.
 */
export const DEFAULT_MAX_CHARS = 8_500;

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export interface FitSectionsOptions {
  maxChars?: number;
  maxBytes?: number;
  separator?: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function codePointUtf8Bytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const truncated = Math.trunc(limit);
  return truncated > 0 ? truncated : 0;
}

function normalizeOptionalLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  return normalizeLimit(limit);
}

/**
 * Clamps a numeric input to an integer in `[min, max]`, falling back to
 * `fallback` (also clamped to `[min, max]`) for non-number or non-finite inputs.
 */
export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const rawLo = Number.isFinite(min) ? Math.trunc(min) : 0;
  const rawHi = Number.isFinite(max) ? Math.trunc(max) : rawLo;
  const lo = Math.min(rawLo, rawHi);
  const hi = Math.max(rawLo, rawHi);

  const chosen =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.isFinite(fallback)
        ? Math.trunc(fallback)
        : lo;

  const clamped = Math.min(hi, Math.max(lo, chosen));
  return clamped === 0 ? 0 : clamped;
}

/**
 * Returns the UTF-8 encoded byte length of `text`.
 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Slices a prefix of at most `maxChars` UTF-16 code units without splitting a
 * UTF-16 surrogate pair (or leaving a trailing dangling high surrogate).
 */
export function sliceSafeChars(text: string, maxChars: number): string {
  const limit = normalizeLimit(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  let end = limit;
  if (isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function sliceSafeCharsTail(text: string, maxChars: number): string {
  const limit = normalizeLimit(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  let start = text.length - limit;
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  return text.slice(start);
}

/**
 * Slices a prefix of at most `maxBytes` UTF-8 bytes without splitting a UTF-8
 * sequence or a UTF-16 surrogate pair.
 */
export function sliceSafeBytes(text: string, maxBytes: number): string {
  const limit = normalizeLimit(maxBytes);
  if (limit <= 0) return "";
  if (utf8ByteLength(text) <= limit) return text;

  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = codePointUtf8Bytes(cp);
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}

function sliceSafeBytesTail(text: string, maxBytes: number): string {
  const limit = normalizeLimit(maxBytes);
  if (limit <= 0) return "";
  if (utf8ByteLength(text) <= limit) return text;

  let bytes = 0;
  let startIndex = text.length;
  for (let i = text.length; i > 0; ) {
    let unitLen = 1;
    let cp = text.charCodeAt(i - 1);
    if (
      i >= 2 &&
      isLowSurrogate(cp) &&
      isHighSurrogate(text.charCodeAt(i - 2))
    ) {
      unitLen = 2;
      cp = text.codePointAt(i - 2) ?? cp;
    }
    const chBytes = codePointUtf8Bytes(cp);
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i -= unitLen;
    startIndex = i;
  }
  return text.slice(startIndex);
}

function sliceSafeBoth(text: string, maxChars: number, maxBytes: number): string {
  let out = sliceSafeChars(text, maxChars);
  if (Number.isFinite(maxBytes) && utf8ByteLength(out) > maxBytes) {
    out = sliceSafeBytes(out, maxBytes);
  }
  return out;
}

function sliceSafeBothTail(text: string, maxChars: number, maxBytes: number): string {
  let out = sliceSafeCharsTail(text, maxChars);
  if (Number.isFinite(maxBytes) && utf8ByteLength(out) > maxBytes) {
    out = sliceSafeBytesTail(out, maxBytes);
  }
  return out;
}

/**
 * Fair water-filling budget allocator: items smaller than the current equal
 * share keep their exact size and donate unused budget to larger items.
 * Guarantees `sum(result) <= Math.max(0, Math.trunc(totalBudget))` and each
 * allocated entry is within `[0, sanitizedSize]`.
 */
export function computeWaterFillBudgets(
  sizes: readonly number[],
  totalBudget: number,
): number[] {
  if (sizes.length === 0) return [];
  const budgets = new Array<number>(sizes.length).fill(0);
  let remainingBudget = normalizeLimit(totalBudget);
  if (remainingBudget <= 0) return budgets;

  const order = sizes
    .map((raw, idx) => ({
      idx,
      size: normalizeLimit(raw),
    }))
    .sort((a, b) => a.size - b.size || a.idx - b.idx);

  for (let i = 0; i < order.length; i++) {
    const item = order[i];
    if (!item) break;
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);

    if (item.size <= share) {
      budgets[item.idx] = item.size;
      remainingBudget -= item.size;
    } else {
      for (let j = i; j < order.length; j++) {
        const entry = order[j];
        if (!entry) break;
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[entry.idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }

  return budgets;
}

function formatTruncationNotice(
  shownBytes: number,
  totalBytes: number,
  noticePrefix?: string,
): string {
  const details = `[truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  if (!noticePrefix) {
    return `\n... ${details}`;
  }
  const leading = noticePrefix.startsWith("\n") ? noticePrefix : `\n${noticePrefix}`;
  const sep = /\s$/.test(leading) ? "" : " ";
  return `${leading}${sep}${details}`;
}

/**
 * Truncates `text` from the end so it fits strictly within `maxChars` UTF-16
 * code units and optional `maxBytes` UTF-8 bytes, appending a byte notice when
 * space permits. Never splits UTF-16 surrogate pairs.
 */
export function truncateWithByteNotice(
  text: string,
  maxChars: number,
  maxBytes?: number,
  noticePrefix?: string,
): TruncateResult {
  const charLimit = normalizeLimit(maxChars);
  const byteLimit = normalizeOptionalLimit(maxBytes);

  if (charLimit <= 0 || byteLimit <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  const totalBytes = utf8ByteLength(text);
  if (text.length <= charLimit && totalBytes <= byteLimit) {
    return { text, truncated: false };
  }

  const worstNotice = formatTruncationNotice(totalBytes, totalBytes, noticePrefix);
  const availChars = charLimit - worstNotice.length;
  const availBytes = Number.isFinite(byteLimit)
    ? byteLimit - utf8ByteLength(worstNotice)
    : Number.POSITIVE_INFINITY;

  if (availChars >= 8 && availBytes >= 8) {
    let slice = sliceSafeBoth(text, availChars, availBytes);
    const lastNewline = slice.lastIndexOf("\n");
    if (lastNewline > 0) {
      const beforeNewline = slice.slice(0, lastNewline);
      const keepsEnoughChars = beforeNewline.length > slice.length * 0.6;
      const keepsEnoughBytes =
        !Number.isFinite(byteLimit) ||
        utf8ByteLength(beforeNewline) > availBytes * 0.6;
      if (keepsEnoughChars && keepsEnoughBytes) {
        slice = beforeNewline;
      }
    }

    const shownBytes = utf8ByteLength(slice);
    const candidate = `${slice}${formatTruncationNotice(shownBytes, totalBytes, noticePrefix)}`;
    if (candidate.length <= charLimit && utf8ByteLength(candidate) <= byteLimit) {
      return { text: candidate, truncated: true };
    }
  }

  if (charLimit <= 3 || byteLimit <= 3) {
    return { text: sliceSafeBoth(text, charLimit, byteLimit), truncated: true };
  }

  const compact = sliceSafeBoth(
    text,
    charLimit - 3,
    Number.isFinite(byteLimit) ? byteLimit - 3 : Number.POSITIVE_INFINITY,
  );
  return { text: `${compact}...`, truncated: true };
}

/**
 * Truncates `text` by preserving both head (~38%) and tail (~62%) with a middle
 * byte-folded marker, strictly respecting `maxChars` and optional `maxBytes`.
 * Falls back to {@link truncateWithByteNotice} for small budgets.
 */
export function truncateHeadTailWithByteNotice(
  text: string,
  maxChars: number,
  maxBytes?: number,
): TruncateResult {
  const charLimit = normalizeLimit(maxChars);
  const byteLimit = normalizeOptionalLimit(maxBytes);

  if (charLimit <= 0 || byteLimit <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  const totalBytes = utf8ByteLength(text);
  if (text.length <= charLimit && totalBytes <= byteLimit) {
    return { text, truncated: false };
  }

  if (charLimit < 120 || byteLimit < 120) {
    return truncateWithByteNotice(text, charLimit, maxBytes);
  }

  const buildMarker = (omittedBytes: number): string =>
    `\n... [truncated: folded ${omittedBytes} middle bytes; total ${totalBytes} bytes] ...\n`;
  const worstMarker = buildMarker(totalBytes);
  const contentChars = charLimit - worstMarker.length;
  const contentBytes = Number.isFinite(byteLimit)
    ? byteLimit - utf8ByteLength(worstMarker)
    : Number.POSITIVE_INFINITY;

  if (contentChars < 40 || contentBytes < 40) {
    return truncateWithByteNotice(text, charLimit, maxBytes);
  }

  const headChars = Math.max(16, Math.floor(contentChars * 0.38));
  const tailChars = Math.max(24, contentChars - headChars);
  const headBytes = Number.isFinite(contentBytes)
    ? Math.max(16, Math.floor(contentBytes * 0.38))
    : Number.POSITIVE_INFINITY;
  const tailBytes = Number.isFinite(contentBytes)
    ? Math.max(24, contentBytes - headBytes)
    : Number.POSITIVE_INFINITY;

  let head = sliceSafeBoth(text, headChars, headBytes);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > 0) {
    const beforeNewline = head.slice(0, lastNewline);
    const charsOk = beforeNewline.length > head.length * 0.5;
    const bytesOk =
      !Number.isFinite(headBytes) ||
      utf8ByteLength(beforeNewline) > headBytes * 0.5;
    if (charsOk && bytesOk) {
      head = beforeNewline;
    }
  }

  let tail = sliceSafeBothTail(text, tailChars, tailBytes);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline !== -1) {
    const afterNewline = tail.slice(firstNewline + 1);
    const charsOk = afterNewline.length > tail.length * 0.5;
    const bytesOk =
      !Number.isFinite(tailBytes) ||
      utf8ByteLength(afterNewline) > tailBytes * 0.5;
    if (charsOk && bytesOk) {
      tail = afterNewline;
    }
  }

  if (head.length + tail.length >= text.length) {
    return truncateWithByteNotice(text, charLimit, maxBytes);
  }

  const omittedBytes = Math.max(
    1,
    totalBytes - utf8ByteLength(head) - utf8ByteLength(tail),
  );
  const candidate = `${head}${buildMarker(omittedBytes)}${tail}`;
  if (candidate.length <= charLimit && utf8ByteLength(candidate) <= byteLimit) {
    return { text: candidate, truncated: true };
  }

  const fallback = truncateWithByteNotice(candidate, charLimit, maxBytes);
  return { text: fallback.text, truncated: true };
}

/**
 * Joins `sections` with `separator` while fairly water-filling both character
 * and UTF-8 byte budgets so small sections stay intact and the final output is
 * strictly `<= maxChars` code units and `<= maxBytes` UTF-8 bytes.
 */
export function fitSectionsToByteBudget(
  sections: readonly string[],
  options: FitSectionsOptions = {},
): TruncateResult {
  if (sections.length === 0) {
    return { text: "", truncated: false };
  }

  const charLimit = normalizeLimit(options.maxChars ?? DEFAULT_MAX_CHARS);
  const byteLimit = normalizeLimit(options.maxBytes ?? DEFAULT_INLINE_MAX_BYTES);
  const separator = options.separator ?? "\n\n";
  const joined = sections.join(separator);

  if (charLimit <= 0 || byteLimit <= 0) {
    return { text: "", truncated: joined.length > 0 };
  }

  if (joined.length <= charLimit && utf8ByteLength(joined) <= byteLimit) {
    return { text: joined, truncated: false };
  }

  const sepCount = sections.length - 1;
  const sepChars = separator.length * sepCount;
  const sepBytes = utf8ByteLength(separator) * sepCount;

  if (sepChars >= charLimit || sepBytes >= byteLimit) {
    const fallback = truncateWithByteNotice(joined, charLimit, byteLimit);
    return { text: fallback.text, truncated: true };
  }

  const charBudgets = computeWaterFillBudgets(
    sections.map((section) => section.length),
    charLimit - sepChars,
  );
  const byteBudgets = computeWaterFillBudgets(
    sections.map((section) => utf8ByteLength(section)),
    byteLimit - sepBytes,
  );

  let anyTruncated = false;
  const fittedSections = sections.map((section, idx) => {
    const res = truncateWithByteNotice(
      section,
      charBudgets[idx] ?? 0,
      byteBudgets[idx] ?? 0,
    );
    if (res.truncated) anyTruncated = true;
    return res.text;
  });

  const fitted = fittedSections.join(separator);
  if (fitted.length <= charLimit && utf8ByteLength(fitted) <= byteLimit) {
    return { text: fitted, truncated: anyTruncated || fitted !== joined };
  }

  const hardFallback = truncateWithByteNotice(fitted, charLimit, byteLimit);
  return { text: hardFallback.text, truncated: true };
}
