import { Fragment } from 'react'
import { parseInlines, parseMarkdown, type InlineNode } from '../lib/markdown.ts'

function renderInlines(nodes: readonly InlineNode[], onOpenLink: (url: string) => void) {
  return nodes.map((node, idx) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={idx}>{node.text}</Fragment>
      case 'code':
        return <code key={idx}>{node.text}</code>
      case 'strong':
        return <strong key={idx}>{node.text}</strong>
      case 'link':
        return (
          <a
            key={idx}
            href={node.href}
            onClick={(e) => {
              e.preventDefault()
              onOpenLink(node.href)
            }}
          >
            {node.label}
          </a>
        )
    }
  })
}

export function InlineMarkdown({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  return <span className="md">{renderInlines(parseInlines(text), onOpenLink)}</span>
}

export function MarkdownView({
  source,
  onOpenLink,
  onToggleCheckbox,
}: {
  source: string
  onOpenLink: (url: string) => void
  onToggleCheckbox?: (lineIndex: number, checked: boolean) => void
}) {
  if (!source.trim()) {
    return <div style={{ color: 'var(--fg-tertiary)', fontStyle: 'italic' }}>No description provided.</div>
  }
  const blocks = parseMarkdown(source)
  return (
    <div className="md">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading':
            return <h3 key={idx}>{renderInlines(block.inlines, onOpenLink)}</h3>
          case 'paragraph':
            return <p key={idx}>{renderInlines(block.inlines, onOpenLink)}</p>
          case 'code':
            return (
              <pre key={idx}>
                <code>{block.text}</code>
              </pre>
            )
          case 'blockquote':
            return <blockquote key={idx}>{renderInlines(block.inlines, onOpenLink)}</blockquote>
          case 'list': {
            const hasTasks = block.items.some((item) => item.checked !== undefined)
            return (
              <ul key={idx} className={hasTasks ? 'task-list' : undefined}>
                {block.items.map((item, j) => (
                  <li key={j} style={item.checked !== undefined ? { display: 'flex', alignItems: 'flex-start', gap: 6 } : undefined}>
                    {item.checked !== undefined ? (
                      <input
                        type="checkbox"
                        checked={item.checked}
                        disabled={!onToggleCheckbox}
                        onChange={(e) => onToggleCheckbox?.(item.lineIndex, e.target.checked)}
                        style={{ marginTop: 3, cursor: onToggleCheckbox ? 'pointer' : 'default' }}
                      />
                    ) : null}
                    <span style={item.checked ? { textDecoration: 'line-through', color: 'var(--fg-secondary)' } : undefined}>
                      {renderInlines(item.inlines, onOpenLink)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        }
      })}
    </div>
  )
}
