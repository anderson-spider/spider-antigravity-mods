// Lightweight XSS-safe Markdown-to-React renderer (no dangerouslySetInnerHTML, zero runtime npm deps).
import { Fragment, useState, type ReactNode } from 'react'
import { isFenceClosing, isSafeHttpUrl, parseFenceOpening } from './triggers.ts'

function renderInline(text: string, onOpenLink?: (url: string) => void): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let key = 0

  while (rest.length > 0) {
    // Inline code
    const codeMatch = rest.match(/^`([^`]+)`/)
    if (codeMatch) {
      nodes.push(<code key={key++} className="md-inline-code">{codeMatch[1]}</code>)
      rest = rest.slice(codeMatch[0].length)
      continue
    }

    // Markdown link [label](url)
    const linkMatch = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
    if (linkMatch) {
      const label = linkMatch[1]!
      const url = linkMatch[2]!
      if (isSafeHttpUrl(url)) {
        nodes.push(
          <a
            key={key++}
            href={url}
            className="md-link"
            onClick={(e) => {
              if (onOpenLink) {
                e.preventDefault()
                onOpenLink(url)
              }
            }}
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
          </a>,
        )
      } else {
        nodes.push(<span key={key++}>{label}</span>)
      }
      rest = rest.slice(linkMatch[0].length)
      continue
    }

    // Bold **...**
    const boldMatch = rest.match(/^\*\*([\s\S]+?)\*\*/)
    if (boldMatch) {
      nodes.push(<strong key={key++}>{renderInline(boldMatch[1]!, onOpenLink)}</strong>)
      rest = rest.slice(boldMatch[0].length)
      continue
    }

    // Strikethrough ~~...~~
    const strikeMatch = rest.match(/^~~([\s\S]+?)~~/)
    if (strikeMatch) {
      nodes.push(<del key={key++}>{renderInline(strikeMatch[1]!, onOpenLink)}</del>)
      rest = rest.slice(strikeMatch[0].length)
      continue
    }

    // Italic *...*
    const italicMatch = rest.match(/^\*([^*\n]+)\*/)
    if (italicMatch) {
      nodes.push(<em key={key++}>{renderInline(italicMatch[1]!, onOpenLink)}</em>)
      rest = rest.slice(italicMatch[0].length)
      continue
    }

    // Consume plain text until next special token
    const nextSpecial = rest.slice(1).search(/[`\[*~]/)
    if (nextSpecial === -1) {
      nodes.push(<Fragment key={key++}>{rest}</Fragment>)
      break
    }
    nodes.push(<Fragment key={key++}>{rest.slice(0, nextSpecial + 1)}</Fragment>)
    rest = rest.slice(nextSpecial + 1)
  }

  return nodes
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => undefined)
  }

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="mono">{lang || 'text'}</span>
        <button type="button" className="md-copy-btn" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="md-pre">
        <code className="mono">{code}</code>
      </pre>
    </div>
  )
}

export function MarkdownView({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block (3+ backticks, optional language/info metadata)
    const fence = parseFenceOpening(line)
    if (fence) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !isFenceClosing(lines[i]!, fence.fenceLen)) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      blocks.push(<CodeBlock key={key++} lang={fence.lang} code={codeLines.join('\n')} />)
      continue
    }

    // Blank line
    if (!line.trim()) {
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />)
      i++
      continue
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      const content = renderInline(heading[2]!, onOpenLink)
      const Tag = (`h${Math.min(6, level)}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(<Tag key={key++} className={`md-heading md-h${level}`}>{content}</Tag>)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {quoteLines.map((ql, idx) => (
            <p key={idx}>{renderInline(ql, onOpenLink)}</p>
          ))}
        </blockquote>,
      )
      continue
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1]!)) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map(cell => cell.trim())
      const headers = parseRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(parseRow(lines[i]!))
        i++
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, idx) => (
                  <th key={idx} scope="col">{renderInline(h, onOpenLink)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx}>{renderInline(r[cIdx] ?? '', onOpenLink)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, onOpenLink)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, onOpenLink)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Paragraph (always consumes at least the current line so `i` strictly advances)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !parseFenceOpening(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!)
      i++
    }
    if (paraLines.length === 0) {
      paraLines.push(line)
      i++
    }
    blocks.push(
      <p key={key++} className="md-para">
        {renderInline(paraLines.join('\n'), onOpenLink)}
      </p>,
    )
  }

  return <div className="md-root">{blocks}</div>
}
