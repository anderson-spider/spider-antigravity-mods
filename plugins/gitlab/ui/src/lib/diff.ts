// Unified diff parser, side-by-side split pairer, and lightweight syntax tokenizer (zero runtime deps).

export type DiffLine = {
  type: 'ctx' | 'add' | 'del'
  oldNum: number | null
  newNum: number | null
  text: string
}

export type DiffHunk = {
  header: string
  lines: DiffLine[]
}

export type SplitPair = {
  left: DiffLine | null
  right: DiffLine | null
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  if (!raw.trim()) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNum = 0
  let newNum = 0

  const lines = raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }
    const hunkMatch = HUNK_RE.exec(line)
    if (hunkMatch) {
      oldNum = Number(hunkMatch[1])
      newNum = Number(hunkMatch[2])
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\ No newline at end of file')) continue
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', oldNum: null, newNum: newNum++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', oldNum: oldNum++, newNum: null, text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'ctx', oldNum: oldNum++, newNum: newNum++, text: line.slice(1) })
    } else if (line === '') {
      current.lines.push({ type: 'ctx', oldNum: oldNum++, newNum: newNum++, text: '' })
    }
  }
  return hunks
}

export function buildSplitPairs(lines: readonly DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.type === 'ctx') {
      pairs.push({ left: line, right: line })
      i++
    } else {
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!)
      while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!)
      const max = Math.max(dels.length, adds.length)
      for (let k = 0; k < max; k++) {
        pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null })
      }
    }
  }
  return pairs
}

export type SyntaxToken = {
  kind: 'plain' | 'kw' | 'str' | 'com' | 'num'
  text: string
}

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default', 'defer',
  'elif', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for', 'from', 'func', 'function',
  'go', 'if', 'implements', 'import', 'in', 'interface', 'let', 'match', 'mut', 'new', 'nil', 'None',
  'null', 'package', 'private', 'protected', 'pub', 'public', 'readonly', 'return', 'select', 'static',
  'struct', 'switch', 'throw', 'true', 'True', 'False', 'try', 'type', 'typeof', 'undefined', 'use', 'var', 'void', 'while',
])

const TOKEN_RE = /(\/\/.*$|#(?=\s|$).*$|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:[._]\d+)*\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gm

export function tokenizeCode(line: string): SyntaxToken[] {
  if (!line) return []
  const tokens: SyntaxToken[] = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', text: line.slice(last, m.index) })
    const raw = m[0]
    let kind: SyntaxToken['kind'] = 'plain'
    if (raw.startsWith('//') || raw.startsWith('#')) kind = 'com'
    else if (raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')) kind = 'str'
    else if (/^\d/.test(raw)) kind = 'num'
    else if (KEYWORDS.has(raw)) kind = 'kw'
    tokens.push({ kind, text: raw })
    last = m.index + raw.length
  }
  if (last < line.length) tokens.push({ kind: 'plain', text: line.slice(last) })
  return tokens
}
