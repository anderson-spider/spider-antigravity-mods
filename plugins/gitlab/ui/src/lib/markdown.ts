// Safe Markdown-to-AST parser for MR descriptions and comments (no raw HTML injection).
// Supports headings, paragraphs, fenced code blocks, blockquotes, bullet lists, interactive task checkboxes,
// inline code, bold text, and http(s) links.

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'link'; label: string; href: string }

export type MarkdownBlock =
  | { type: 'heading'; level: number; inlines: InlineNode[] }
  | { type: 'paragraph'; inlines: InlineNode[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'blockquote'; inlines: InlineNode[] }
  | { type: 'list'; items: { lineIndex: number; checked?: boolean; inlines: InlineNode[] }[] }

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g

export function parseInlines(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let last = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) })
    const full = m[0]
    if (full.startsWith('`')) nodes.push({ type: 'code', text: full.slice(1, -1) })
    else if (full.startsWith('**')) nodes.push({ type: 'strong', text: full.slice(2, -2) })
    else if (m[2] !== undefined && m[3] !== undefined) nodes.push({ type: 'link', label: m[2], href: m[3] })
    last = m.index + full.length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) {
      i++
      continue
    }

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim() || undefined
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      blocks.push({ type: 'code', ...(lang ? { lang } : {}), text: codeLines.join('\n') })
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, inlines: parseInlines(heading[2]!) })
      i++
      continue
    }

    if (trimmed.startsWith('> ')) {
      const quoteParts: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('> ')) {
        quoteParts.push(lines[i]!.trim().slice(2))
        i++
      }
      blocks.push({ type: 'blockquote', inlines: parseInlines(quoteParts.join(' ')) })
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: { lineIndex: number; checked?: boolean; inlines: InlineNode[] }[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!.trim())) {
        const raw = lines[i]!.trim().replace(/^[-*]\s+/, '')
        const task = /^\[(x|X| )\]\s+(.*)$/.exec(raw)
        if (task) {
          items.push({ lineIndex: i, checked: task[1]!.toLowerCase() === 'x', inlines: parseInlines(task[2]!) })
        } else {
          items.push({ lineIndex: i, inlines: parseInlines(raw) })
        }
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.trim().startsWith('```') &&
      !/^#{1,4}\s+/.test(lines[i]!.trim()) &&
      !lines[i]!.trim().startsWith('> ') &&
      !/^[-*]\s+/.test(lines[i]!.trim())
    ) {
      para.push(lines[i]!.trim())
      i++
    }
    blocks.push({ type: 'paragraph', inlines: parseInlines(para.join(' ')) })
  }

  return blocks
}

/** Toggles a single markdown task checkbox at `lineIndex` without disturbing the rest of the description. */
export function toggleMarkdownCheckbox(source: string, lineIndex: number, checked: boolean): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const line = lines[lineIndex]
  if (line === undefined) return source
  lines[lineIndex] = checked ? line.replace(/^(\s*[-*]\s+)\[ \]/, '$1[x]') : line.replace(/^(\s*[-*]\s+)\[[xX]\]/, '$1[ ]')
  return lines.join('\n')
}
