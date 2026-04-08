import React, { useEffect, useRef, useState } from 'react'

export default function HistoryViewerApp(): React.ReactElement {
  const [toolInfo, setToolInfo] = useState<{ title: string; toolName: string } | null>(null)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const pendingScrollRef = useRef(false)
  const initialLoadRef = useRef(true)

  // Initial data load
  useEffect(() => {
    window.historyViewerApi.getData().then((d) => {
      const data = d as HistoryViewerData
      setToolInfo({ title: data.title, toolName: data.toolName })
      setEntries(data.entries)
      pendingScrollRef.current = true
    })
  }, [])

  // Subscribe to live updates
  useEffect(() => {
    const cleanup = window.historyViewerApi.onNewEntries((newEntries) => {
      if (scrollRef.current) {
        atBottomRef.current = isAtBottom(scrollRef.current)
      }
      if (atBottomRef.current) {
        pendingScrollRef.current = true
      }
      setEntries((prev) => [...prev, ...newEntries])
    })
    return cleanup
  }, [])

  // Scroll after entries change (initial load or live update)
  useEffect(() => {
    if (pendingScrollRef.current) {
      pendingScrollRef.current = false
      if (initialLoadRef.current) {
        initialLoadRef.current = false
        bottomRef.current?.scrollIntoView({ behavior: 'instant' })
      } else {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  })

  function handleScroll(): void {
    if (scrollRef.current) {
      atBottomRef.current = isAtBottom(scrollRef.current)
    }
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#1e1e1e',
        color: '#d4d4d4',
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 13
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid #3d3d3d',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: '#cccccc' }}>
          {toolInfo?.title || 'Session History'}
        </div>
        {toolInfo && (
          <div style={{ fontSize: 11, color: '#666' }}>
            {entries.length} message{entries.length !== 1 ? 's' : ''} · {toolInfo.toolName}
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '12px 0', userSelect: 'text' }}
      >
        {entries.length === 0 && toolInfo === null ? (
          <div style={{ padding: '16px 20px', color: '#555', fontSize: 12 }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '16px 20px', color: '#555', fontSize: 12 }}>No messages found</div>
        ) : (
          entries.map((entry, i) => (
            <MessageRow key={i} entry={entry} toolName={toolInfo?.toolName ?? ''} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function isAtBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100
}

function MessageRow({ entry, toolName }: { entry: HistoryEntry; toolName: string }): React.ReactElement {
  const isUser = entry.role === 'user'

  return (
    <div
      style={{
        padding: '8px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderBottom: '1px solid #252525'
      }}
    >
      {/* Role label */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.04em',
          color: isUser ? '#569cd6' : '#4ec9b0',
          userSelect: 'none'
        }}
      >
        {isUser ? 'You' : toolName}
      </div>

      {/* Content blocks */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entry.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </div>
  )
}

function Block({ block }: { block: HistoryBlock }): React.ReactElement {
  const [open, setOpen] = useState(false)

  if (block.type === 'text') {
    return (
      <div
        style={{
          color: '#d4d4d4',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.55'
        }}
      >
        {block.text}
      </div>
    )
  }

  if (block.type === 'thinking') {
    return (
      <CollapsibleBlock
        label="Thinking"
        labelColor="#858585"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <div style={{ color: '#7a7a7a', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5' }}>
          {block.thinking}
        </div>
      </CollapsibleBlock>
    )
  }

  if (block.type === 'tool_use') {
    const inputText = formatJson(block.input)
    return (
      <CollapsibleBlock
        label={`→ ${block.name}`}
        labelColor="#c586c0"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <div style={{ color: '#9cdcfe', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: '1.45' }}>
          {inputText}
        </div>
      </CollapsibleBlock>
    )
  }

  if (block.type === 'tool_result') {
    const resultText = formatToolResult(block.content ?? '')
    return (
      <CollapsibleBlock
        label="← result"
        labelColor="#4ec9b0"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <div style={{ color: '#b0b0b0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: '1.45' }}>
          {resultText}
        </div>
      </CollapsibleBlock>
    )
  }

  return <></>
}

function CollapsibleBlock({
  label,
  labelColor,
  open,
  onToggle,
  children
}: {
  label: string
  labelColor: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid #3a3a3a',
        borderRadius: 4,
        overflow: 'hidden'
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: '#252526',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 12, color: labelColor, fontFamily: 'inherit' }}>{label}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 10px', background: '#1a1a1a', maxHeight: 400, overflowY: 'auto' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatToolResult(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}
