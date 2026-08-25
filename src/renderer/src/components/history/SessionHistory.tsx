import React, { useEffect, useRef, useState } from 'react'

export function SessionHistory({ entries, toolName, loading = false, resetKey }: { entries: HistoryEntry[]; toolName: string; loading?: boolean; resetKey?: string | null }): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const initialLoadRef = useRef(true)
  useEffect(() => { atBottomRef.current = true; initialLoadRef.current = true }, [resetKey])
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !atBottomRef.current) return
    // Keep scrolling strictly inside the history widget. scrollIntoView() also
    // moves ancestor containers and used to push the startup controls off-screen.
    element.scrollTo({
      top: element.scrollHeight,
      behavior: initialLoadRef.current ? 'auto' : 'smooth'
    })
    initialLoadRef.current = false
  }, [entries])
  return <div ref={scrollRef} onScroll={() => {
    const element = scrollRef.current
    if (element) atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
  }} style={{ flex: '1 1 0', height: '100%', minHeight: 0, overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', padding: '12px 0', userSelect: 'text' }}>
    {loading ? <Empty text="Loading history…" /> : entries.length === 0 ? <Empty text="No messages found" /> : entries.map((entry, index) => <MessageRow key={index} entry={entry} toolName={toolName} />)}
  </div>
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div style={{ padding: '16px 20px', color: '#777', fontSize: 12 }}>{text}</div>
}

function MessageRow({ entry, toolName }: { entry: HistoryEntry; toolName: string }): React.ReactElement {
  const isUser = entry.role === 'user'
  return <div style={{ padding: '8px 20px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid #252525' }}>
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: isUser ? '#569cd6' : '#4ec9b0', userSelect: 'none' }}>{isUser ? 'You' : toolName}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{entry.blocks.map((block, index) => <Block key={index} block={block} />)}</div>
  </div>
}

function Block({ block }: { block: HistoryBlock }): React.ReactElement {
  const [open, setOpen] = useState(false)
  if (block.type === 'text') return <div style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.55' }}>{block.text}</div>
  if (block.type === 'thinking') return <Collapsible label="Thinking" color="#858585" open={open} toggle={() => setOpen(!open)}><div style={{ color: '#7a7a7a', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.5' }}>{block.thinking}</div></Collapsible>
  if (block.type === 'tool_use') return <Collapsible label={`→ ${block.name}`} color="#c586c0" open={open} toggle={() => setOpen(!open)}><div style={{ color: '#9cdcfe', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: '1.45' }}>{formatJson(block.input)}</div></Collapsible>
  if (block.type === 'tool_result') return <Collapsible label="← result" color="#4ec9b0" open={open} toggle={() => setOpen(!open)}><div style={{ color: '#b0b0b0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: '1.45' }}>{formatToolResult(block.content ?? '')}</div></Collapsible>
  return <></>
}

function Collapsible({ label, color, open, toggle, children }: { label: string; color: string; open: boolean; toggle: () => void; children: React.ReactNode }): React.ReactElement {
  return <div style={{ border: '1px solid #3a3a3a', borderRadius: 4, overflow: 'hidden' }}>
    <div onClick={toggle} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#252526', cursor: 'pointer', userSelect: 'none' }}><span style={{ fontSize: 10, color: '#555' }}>{open ? '▾' : '▸'}</span><span style={{ fontSize: 12, color }}>{label}</span></div>
    {open && <div style={{ padding: '8px 10px', background: '#1a1a1a', maxHeight: 400, overflowY: 'auto' }}>{children}</div>}
  </div>
}

function formatJson(value: unknown): string { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
function formatToolResult(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content.filter((block) => block.type === 'text' && block.text).map((block) => block.text ?? '').join('\n')
}
