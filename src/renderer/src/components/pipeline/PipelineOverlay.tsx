import React, { useEffect, useMemo, useState } from 'react'
import { isRunActive, liveKey, usePipelineStore, type VisitRef } from '../../store/usePipelineStore'
import { TranscriptView } from '../history/TranscriptView'

/**
 * Pipeline run view (plan §4.1): the machine's flow with node states, the
 * transcript or log of any visit, run controls, escalation answers and the
 * final report. Collapsible to a strip; closable only after the run ended.
 */

const STATUS_LABEL: Record<PipelineRunStatus, string> = {
  running: 'Running', pausing: 'Pausing…', paused: 'Paused', waiting: 'Waiting for a decision', stopped: 'Stopped', finished: 'Finished', failed: 'Failed'
}
const STATUS_COLOR: Record<PipelineRunStatus, string> = {
  running: '#4ec9b0', pausing: '#dcdcaa', paused: '#dcdcaa', waiting: '#f48771', stopped: '#dcdcaa', finished: '#4ec9b0', failed: '#f48771'
}

function flowOrder(machine: PipelineMachine): string[] {
  const order: string[] = []
  const queue = [machine.start]
  const seen = new Set(queue)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    const next = machine.edges.filter((e) => e[0] === id).map((e) => e[1])
    const limit = machine.nodes[id]?.onLimit
    for (const to of limit ? [...next, limit] : next) if (!seen.has(to) && machine.nodes[to]) { seen.add(to); queue.push(to) }
  }
  for (const id of Object.keys(machine.nodes)) if (!seen.has(id)) order.push(id)
  return order
}

function elapsed(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)
  const minutes = Math.floor(ms / 60_000)
  return minutes < 1 ? `${Math.max(0, Math.floor(ms / 1000))} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function useTick(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [active])
}

export function PipelineStrip(): React.ReactElement | null {
  const run = usePipelineStore((s) => s.run)
  const dismissed = usePipelineStore((s) => s.dismissedRunId)
  const expanded = usePipelineStore((s) => s.expanded)
  const setExpanded = usePipelineStore((s) => s.setExpanded)
  useTick(run !== null && isRunActive(run.state.status))
  if (!run || run.runId === dismissed || expanded) return null
  const { state, machine } = run
  const current = state.current
  const max = current ? machine.nodes[current]?.maxVisits : undefined
  const visits = current ? state.visits[current] ?? 0 : 0
  return <div onClick={() => setExpanded(true)} title="Show the pipeline run" className={state.status === 'waiting' ? 'pipeline-attention' : undefined}
    style={{ height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', background: '#252526', borderBottom: '1px solid #3d3d3d', cursor: 'pointer', fontSize: 12, fontFamily: 'Segoe UI, sans-serif', color: '#ccc' }}>
    <span style={{ color: STATUS_COLOR[state.status] }}>●</span>
    <span style={{ fontWeight: 600 }}>{machine.name}</span>
    {current && <span>{current}{max ? ` ${visits}/${max}` : ''}</span>}
    <span style={{ color: '#888' }}>{elapsed(state.startedAt, state.finishedAt)}</span>
    <span style={{ color: STATUS_COLOR[state.status] }}>{STATUS_LABEL[state.status]}</span>
    <span style={{ marginLeft: 'auto', color: '#888' }}>▾ Show</span>
  </div>
}

export default function PipelineOverlay(): React.ReactElement | null {
  const run = usePipelineStore((s) => s.run)
  const dismissed = usePipelineStore((s) => s.dismissedRunId)
  const expanded = usePipelineStore((s) => s.expanded)
  const selected = usePipelineStore((s) => s.selected)
  const { setExpanded, select, dismiss } = usePipelineStore.getState()
  const [controlError, setControlError] = useState<string | null>(null)
  useTick(run !== null && isRunActive(run.state.status))

  if (!run || run.runId === dismissed || !expanded) return null
  const { state, machine } = run
  const active = isRunActive(state.status)

  // Follow the current node unless the user picked a visit.
  const lastVisitOf = (node: string): VisitRef | null => {
    const visits = state.history.filter((h) => h.node === node)
    return visits.length ? { node, visit: visits[visits.length - 1].visit } : null
  }
  const shown: VisitRef | null = selected ?? (state.current ? lastVisitOf(state.current) : null) ?? (state.history.length ? { node: state.history[state.history.length - 1].node, visit: state.history[state.history.length - 1].visit } : null)

  const control = async (action: 'pause' | 'stop' | 'resume' | 'abandon'): Promise<void> => {
    setControlError(await window.editorApi.pipelineControl(action))
  }
  const pending = state.escalations.find((e) => e.answer === null) ?? null

  return <div style={{ position: 'absolute', inset: 0, zIndex: 20, display: 'flex', flexDirection: 'column', background: '#1e1e1e', fontFamily: 'Segoe UI, sans-serif', color: '#ccc' }}>
    <div style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', background: '#252526', borderBottom: '1px solid #3d3d3d', fontSize: 12 }}>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{machine.name}</span>
      <span style={{ color: STATUS_COLOR[state.status] }}>● {STATUS_LABEL[state.status]}</span>
      <span style={{ color: '#888' }}>{elapsed(state.startedAt, state.finishedAt)}</span>
      <span style={{ color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.runId}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {state.status === 'running' && <Button onClick={() => void control('pause')} title="Finish the current step, then hold">Pause</Button>}
        {(state.status === 'running' || state.status === 'pausing') && <Button onClick={() => void control('stop')} title="Interrupt the current step now (resumable)">Stop now</Button>}
        {(state.status === 'paused' || state.status === 'stopped') && <Button onClick={() => void control('resume')}>Resume</Button>}
        {(state.status === 'paused' || state.status === 'stopped') && <Button onClick={() => void control('abandon')} title="End this run for good">Abandon</Button>}
        <Button onClick={() => setExpanded(false)} title="Collapse to a strip">▴ Collapse</Button>
        {!active && <Button onClick={dismiss}>Close</Button>}
      </span>
    </div>
    {controlError && <div style={{ padding: '4px 10px', fontSize: 12, color: '#f48771', background: '#3a1f1f' }}>{controlError}</div>}

    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <FlowList machine={machine} state={state} shown={shown} onSelect={(ref) => select(ref)} onFollow={() => select(null)} following={selected === null} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!active && <ReportPanel runId={state.runId} />}
        {shown ? <VisitDetail run={run} visit={shown} /> : <div style={{ padding: 16, color: '#777', fontSize: 12 }}>No step has run yet.</div>}
      </div>
    </div>

    {pending && <EscalationPanel escalation={pending} />}
  </div>
}

function FlowList({ machine, state, shown, onSelect, onFollow, following }: { machine: PipelineMachine; state: PipelineRunState; shown: VisitRef | null; onSelect: (ref: VisitRef) => void; onFollow: () => void; following: boolean }): React.ReactElement {
  const order = useMemo(() => flowOrder(machine), [machine])
  return <div style={{ width: 270, flexShrink: 0, borderRight: '1px solid #333', overflowY: 'auto', padding: '6px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 10px 6px', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
      Flow
      {!following && <span onClick={onFollow} style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, color: '#4ea1f3', cursor: 'pointer' }}>Follow current</span>}
    </div>
    {order.map((id) => {
      const node = machine.nodes[id]
      const visits = state.history.filter((h) => h.node === id)
      const last = visits[visits.length - 1]
      const isCurrent = state.current === id && isRunActive(state.status)
      const icon = isCurrent ? (state.status === 'waiting' ? '!' : state.status === 'running' || state.status === 'pausing' ? '●' : '❚❚')
        : !last ? '○' : last.outcome === 'ok' ? '✓' : last.outcome === 'fail' ? '✗' : last.outcome === 'interrupted' ? '⏸' : '·'
      const color = isCurrent ? (state.status === 'waiting' ? '#f48771' : '#4ec9b0') : !last ? '#555' : last.outcome === 'fail' ? '#f48771' : last.outcome === 'ok' ? '#4ec9b0' : '#dcdcaa'
      const count = state.visits[id] ?? 0
      return <div key={id} style={{ padding: '3px 10px', background: shown?.node === id ? '#2a2d2e' : 'transparent' }}>
        <div onClick={() => last && onSelect({ node: id, visit: last.visit })} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: last ? 'pointer' : 'default', fontSize: 12 }}>
          <span style={{ width: 14, textAlign: 'center', color }} className={isCurrent && state.status === 'running' ? 'pipeline-pulse' : undefined}>{icon}</span>
          <span style={{ color: isCurrent ? '#fff' : '#ccc', fontWeight: isCurrent ? 600 : 400 }}>{id}</span>
          <span style={{ color: '#666', fontSize: 11 }}>{node.type}</span>
          {(node.maxVisits || count > 1) && <span style={{ marginLeft: 'auto', color: '#888', fontSize: 11 }}>{count}{node.maxVisits ? `/${node.maxVisits}` : ''}</span>}
        </div>
        {node.summary && <div style={{ marginLeft: 22, fontSize: 11, color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.summary}>{node.summary}</div>}
        {visits.length > 1 && <div style={{ marginLeft: 22, display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {visits.map((v) => <span key={v.visit} onClick={() => onSelect({ node: id, visit: v.visit })}
            style={{ fontSize: 10, padding: '0 5px', borderRadius: 3, cursor: 'pointer', border: '1px solid #444', color: v.outcome === 'fail' ? '#f48771' : v.outcome === 'ok' ? '#4ec9b0' : '#aaa', background: shown?.node === id && shown.visit === v.visit ? '#37373d' : 'transparent' }}>
            #{v.visit}
          </span>)}
        </div>}
      </div>
    })}
  </div>
}

function VisitDetail({ run, visit }: { run: PipelineRunSnapshot; visit: VisitRef }): React.ReactElement {
  const { state, machine } = run
  const node = machine.nodes[visit.node]
  const record = state.history.filter((h) => h.node === visit.node && h.visit === visit.visit).slice(-1)[0]
  const running = !record?.finishedAt && state.current === visit.node && isRunActive(state.status)
  const output = state.outputs[visit.node]
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: '6px 12px', borderBottom: '1px solid #2d2d2d', fontSize: 12, display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ fontWeight: 600, color: '#e0e0e0' }}>{visit.node}</span>
      <span style={{ color: '#888' }}>visit {visit.visit}</span>
      {record?.outcome && <span style={{ color: record.outcome === 'fail' ? '#f48771' : '#4ec9b0' }}>{record.outcome}</span>}
      {running && <span style={{ color: '#4ec9b0' }}>running…</span>}
      {record && <span style={{ color: '#666' }}>{elapsed(record.startedAt, record.finishedAt)}</span>}
      {record?.costUsd ? <span style={{ color: '#666' }}>${record.costUsd.toFixed(3)}</span> : null}
      {node?.cli && <span style={{ color: '#666' }}>{node.cli}</span>}
    </div>
    {record?.error && <div style={{ padding: '6px 12px', fontSize: 12, color: '#f48771', whiteSpace: 'pre-wrap' }}>{record.error}</div>}
    {node?.type === 'agent' || (node?.type === 'commit' && node.review === 'agent')
      ? <AgentTranscript runId={state.runId} visit={visit} running={running} />
      : node?.type === 'check'
        ? <CheckLog runId={state.runId} visit={visit} running={running} />
        : <pre style={PRE}>{output === undefined ? '(no output)' : JSON.stringify(output, null, 2)}</pre>}
    {(node?.type === 'agent' || node?.type === 'commit') && output !== undefined && !running && <details style={{ borderTop: '1px solid #2d2d2d', padding: '4px 12px', fontSize: 12 }}>
      <summary style={{ cursor: 'pointer', color: '#888' }}>Output</summary>
      <pre style={{ ...PRE, maxHeight: 240, padding: '6px 0' }}>{JSON.stringify(output, null, 2)}</pre>
    </details>}
  </div>
}

function AgentTranscript({ runId, visit, running }: { runId: string; visit: VisitRef; running: boolean }): React.ReactElement {
  const live = usePipelineStore((s) => s.live[liveKey(runId, visit.node, visit.visit)])
  const [stored, setStored] = useState<HistoryEntry[] | null>(null)
  useEffect(() => {
    setStored(null)
    void window.editorApi.pipelineGetTranscript(runId, visit.node, visit.visit).then(setStored)
  }, [runId, visit.node, visit.visit, running])
  // Stored entries are complete once the visit ended; while it runs, live entries are newer.
  const entries = running && live && live.length > (stored?.length ?? 0) ? live : stored ?? live ?? []
  return <TranscriptView entries={entries} toolName="Agent" loading={stored === null && !live} resetKey={`${runId}:${visit.node}:${visit.visit}`} />
}

function CheckLog({ runId, visit, running }: { runId: string; visit: VisitRef; running: boolean }): React.ReactElement {
  const [log, setLog] = useState('')
  useEffect(() => {
    let alive = true
    const load = (): void => { void window.editorApi.pipelineGetCheckLog(runId, visit.node, visit.visit).then((text) => { if (alive) setLog(text) }) }
    load()
    if (!running) return () => { alive = false }
    const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [runId, visit.node, visit.visit, running])
  return <pre style={PRE}>{log || (running ? 'Waiting for output…' : '(no output)')}</pre>
}

function ReportPanel({ runId }: { runId: string }): React.ReactElement | null {
  const [report, setReport] = useState<Record<string, unknown> | null>(null)
  useEffect(() => { void window.editorApi.pipelineGetReport(runId).then(setReport) }, [runId])
  if (!report) return null
  const commits = (report.commits as Array<{ sha: string; message: string }> | undefined) ?? []
  const findings = (report.nonBlockingFindings as string[] | undefined) ?? []
  const cost = typeof report.costUsd === 'number' ? report.costUsd : 0
  return <div style={{ padding: '8px 12px', borderBottom: '1px solid #2d2d2d', fontSize: 12, lineHeight: 1.5 }}>
    <div style={{ fontWeight: 600, color: report.result === 'success' ? '#4ec9b0' : '#f48771' }}>
      Run {String(report.result)}{report.reason ? ` — ${String(report.reason)}` : ''}
    </div>
    {commits.length > 0 && <div>Commits: {commits.map((c) => `${c.sha.slice(0, 8)} ${c.message.split('\n')[0]}`).join('; ')}</div>}
    {findings.length > 0 && <div>Non-blocking findings: {findings.length}<ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{findings.slice(0, 8).map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
    {cost > 0 && <div style={{ color: '#888' }}>Cost: ${cost.toFixed(2)}</div>}
  </div>
}

function EscalationPanel({ escalation }: { escalation: PipelineEscalation }): React.ReactElement {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const answer = async (action: 'continue' | 'retry' | 'reject' | 'stop'): Promise<void> => {
    setError(await window.editorApi.pipelineAnswer(escalation.id, action, text))
  }
  const title = escalation.kind === 'engine' ? 'The run cannot continue' : escalation.kind === 'gate' ? 'Approval needed' : 'Escalation'
  return <div className="pipeline-attention" style={{ flexShrink: 0, borderTop: '2px solid #a33', background: '#2b1d1d', padding: '8px 12px', fontSize: 12 }}>
    <div style={{ fontWeight: 600, color: '#ffb3b3', marginBottom: 4 }}>{title} — {escalation.node} <span style={{ color: '#888', fontWeight: 400 }}>(for the {escalation.to}; whoever answers first)</span></div>
    <div style={{ whiteSpace: 'pre-wrap', color: '#ddd', marginBottom: 6 }}>{escalation.message}</div>
    <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer (available to the next steps)" style={{ width: '100%', boxSizing: 'border-box', height: 46, background: '#1e1e1e', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: 6, fontFamily: 'inherit', fontSize: 12, resize: 'vertical' }} />
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
      {escalation.kind === 'engine' && <Button onClick={() => void answer('retry')}>Retry step</Button>}
      {escalation.kind === 'node' && <Button onClick={() => void answer('continue')}>Continue</Button>}
      {escalation.kind === 'gate' && <Button onClick={() => void answer('continue')}>Approve</Button>}
      {escalation.kind === 'gate' && <Button onClick={() => void answer('reject')}>Reject</Button>}
      <Button onClick={() => void answer('stop')}>Stop run</Button>
      {error && <span style={{ color: '#f48771', alignSelf: 'center' }}>{error}</span>}
    </div>
  </div>
}

function Button({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }): React.ReactElement {
  return <button onClick={onClick} title={title} style={{ padding: '3px 10px', fontSize: 12, borderRadius: 3, border: '1px solid #555', background: '#2d2d2d', color: '#ccc', cursor: 'pointer' }}>{children}</button>
}

const PRE: React.CSSProperties = {
  flex: 1, minHeight: 0, margin: 0, padding: '8px 12px', overflow: 'auto', fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, color: '#bbb', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
}
