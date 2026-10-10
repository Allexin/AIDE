import React, { useEffect, useState } from 'react'
import { isRunActive, liveKey, usePipelineStore, type VisitRef } from '../../store/usePipelineStore'
import { TranscriptView } from '../history/TranscriptView'
import { blockTitle, walkSteps, type Step } from '../../../../shared/pipelineMachine'

/**
 * Pipeline run view (plan §4.1), shown as a tab of the terminal panel next to
 * the CLI session tabs: the machine's step tree with step states, the transcript
 * or log of any visit, run controls, escalation answers and the final report.
 * The tab can be closed only after the run ended.
 */

const STATUS_LABEL: Record<PipelineRunStatus, string> = {
  running: 'Running', pausing: 'Pausing…', paused: 'Paused', waiting: 'Waiting for a decision', stopped: 'Stopped', finished: 'Finished', failed: 'Failed'
}
const STATUS_COLOR: Record<PipelineRunStatus, string> = {
  running: '#4ec9b0', pausing: '#dcdcaa', paused: '#dcdcaa', waiting: '#f48771', stopped: '#dcdcaa', finished: '#4ec9b0', failed: '#f48771'
}

type LoopStepDef = Extract<Step, { type: 'loop' | 'commit' }>

/** The step with this id and its enclosing blocks (outermost first). A commit action resolves to its commit step. */
function locate(steps: Step[], id: string | null): { step: Step; ancestors: Step[] } | null {
  if (!id) return null
  let found: { step: Step; ancestors: Step[] } | null = null
  walkSteps(steps, (step, ancestors) => { if (!found && step.id === id) found = { step, ancestors } })
  return found
}

function loopLimit(step: LoopStepDef, state: PipelineRunState): number {
  return (step.type === 'loop' ? step.maxIterations : step.maxAttempts ?? 3) + (state.bonus?.[step.id] ?? 0)
}

/** Whether the current step is inside this loop/commit block. */
function holdsCurrent(step: LoopStepDef, current: string | null): boolean {
  if (step.type === 'commit') return current === step.id || current === step.prep.id
  return locate(step.steps, current) !== null
}

/** "name 2/3" for the innermost loop or commit block around the current step. */
function currentLoopLabel(machine: PipelineMachine, state: PipelineRunState): string {
  const found = locate(machine.steps, state.current)
  if (!found) return ''
  const chain = found.step.type === 'commit' ? [...found.ancestors, found.step] : found.ancestors
  const loop = [...chain].reverse().find((s): s is LoopStepDef => s.type === 'loop' || s.type === 'commit')
  if (!loop) return ''
  return `${blockTitle(loop)} ${state.iterations?.[loop.id] ?? 1}/${loopLimit(loop, state)}`
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

/** The pipeline tab in the terminal panel's tab strip. It is not a session tab: selecting it leaves the session selection alone. */
export function PipelineTabButton({ isActive, onSelect }: { isActive: boolean; onSelect: () => void }): React.ReactElement | null {
  const run = usePipelineStore((s) => s.run)
  const seenRunId = usePipelineStore((s) => s.seenRunId)
  const dismiss = usePipelineStore((s) => s.dismiss)
  const [dim, setDim] = useState(false)
  const status = run?.state.status
  // Blink like a session tab that needs attention: a decision is pending, or a new run nobody looked at yet.
  const attention = !isActive && run !== null && (status === 'waiting' || run.runId !== seenRunId)
  useEffect(() => {
    if (!attention) { setDim(false); return }
    const timer = setInterval(() => setDim((d) => !d), 500)
    return () => clearInterval(timer)
  }, [attention])
  if (!run || !status) return null
  const loop = currentLoopLabel(run.machine, run.state)
  const color = attention ? (dim ? '#555' : '#f0a500') : isActive ? '#d4d4d4' : '#858585'
  return <div onClick={onSelect} title={`Pipeline run ${run.runId}\n${STATUS_LABEL[status]}${run.state.current ? ` — ${run.state.current}` : ''}`}
    style={{ background: isActive ? '#1e1e1e' : '#2d2d2d', color, fontSize: 12, padding: '4px 6px 4px 8px', borderRadius: '3px 3px 0 0', cursor: 'pointer', border: '1px solid #3d3d3d', borderBottom: isActive ? '1px solid #1e1e1e' : 'none', whiteSpace: 'nowrap', lineHeight: 1.5, flexShrink: 0, maxWidth: 260, overflow: 'hidden', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
    <span style={{ color: STATUS_COLOR[status], flexShrink: 0 }} className={status === 'running' ? 'pipeline-pulse' : undefined}>●</span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{run.machine.name}</span>
    {loop && isRunActive(status) && <span style={{ color: '#888', flexShrink: 0 }}>↺ {loop}</span>}
    {!isRunActive(status) && <span onClick={(e) => { e.stopPropagation(); dismiss() }} title="Close the pipeline tab" style={{ fontSize: 14, lineHeight: 1, color: '#858585', cursor: 'pointer', flexShrink: 0, padding: '0 2px' }}>×</span>}
  </div>
}

export default function PipelineView(): React.ReactElement | null {
  const run = usePipelineStore((s) => s.run)
  const selected = usePipelineStore((s) => s.selected)
  const { select, dismiss } = usePipelineStore.getState()
  const [controlError, setControlError] = useState<string | null>(null)
  useTick(run !== null && isRunActive(run.state.status))

  if (!run) return null
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

  return <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#1e1e1e', fontFamily: 'Segoe UI, sans-serif', color: '#ccc' }}>
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
        {!active && <Button onClick={dismiss} title="Close the pipeline tab">Close</Button>}
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

interface FlowProps { state: PipelineRunState; shown: VisitRef | null; onSelect: (ref: VisitRef) => void }

function FlowList({ machine, state, shown, onSelect, onFollow, following }: FlowProps & { machine: PipelineMachine; onFollow: () => void; following: boolean }): React.ReactElement {
  return <div style={{ width: 290, flexShrink: 0, borderRight: '1px solid #333', overflowY: 'auto', padding: '6px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 10px 6px', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
      Flow
      {!following && <span onClick={onFollow} style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, color: '#4ea1f3', cursor: 'pointer' }}>Follow current</span>}
    </div>
    <StepList steps={machine.steps} state={state} shown={shown} onSelect={onSelect} />
  </div>
}

function StepList({ steps, ...props }: FlowProps & { steps: Step[] }): React.ReactElement {
  return <>{steps.map((step) => <StepRow key={step.id} step={step} {...props} />)}</>
}

/** A block's children, indented with a guide line. */
function Nested({ children, color = '#3a3a3a' }: { children: React.ReactNode; color?: string }): React.ReactElement {
  return <div style={{ marginLeft: 16, borderLeft: `1px solid ${color}` }}>{children}</div>
}

function StepRow({ step, ...props }: FlowProps & { step: Step }): React.ReactElement {
  const { state } = props
  switch (step.type) {
    case 'group':
      return <div style={{ marginTop: 6 }}>
        <div style={{ padding: '3px 10px', fontSize: 11, color: '#9cdcfe', textTransform: 'uppercase', letterSpacing: 1 }} title={step.summary}>{blockTitle(step)}</div>
        <Nested><StepList steps={step.steps} {...props} /></Nested>
      </div>
    case 'loop':
    case 'commit': {
      const iteration = state.iterations?.[step.id]
      const limit = loopLimit(step, state)
      const active = iteration !== undefined && isRunActive(state.status) && holdsCurrent(step, state.current)
      return <div style={{ marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px', fontSize: 12, color: active ? '#dcdcaa' : '#999' }} title={step.summary}>
          <span style={{ width: 14, textAlign: 'center' }}>{step.type === 'commit' ? '⎇' : '↺'}</span>
          <span>{step.type === 'commit' ? `commit ${step.id}` : blockTitle(step)}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: active ? '#dcdcaa' : '#777' }}>
            {iteration !== undefined ? `${step.type === 'commit' ? 'attempt' : 'iteration'} ${iteration}/${limit}` : `max ${limit}`}
          </span>
        </div>
        <Nested color={active ? '#6a6a3a' : undefined}>
          {step.type === 'loop' ? <StepList steps={step.steps} {...props} /> : <>
            <StepRow step={step.prep} {...props} />
            <LeafRow id={step.id} type="commit" summary={step.review === 'agent' ? 'a reviewer agent checks the staged commit, then AIDE commits' : 'AIDE checks the staged commit and commits'} {...props} />
          </>}
        </Nested>
      </div>
    }
    case 'if':
      return <div>
        <div style={{ padding: '3px 10px', fontSize: 11, color: '#c586c0' }}>if {step.condition}</div>
        <Nested><StepList steps={step.then} {...props} /></Nested>
        {step.else && step.else.length > 0 && <>
          <div style={{ padding: '3px 10px', fontSize: 11, color: '#c586c0' }}>else</div>
          <Nested><StepList steps={step.else} {...props} /></Nested>
        </>}
      </div>
    default:
      return <LeafRow id={step.id} type={step.type} summary={step.summary ?? (step.type === 'check' ? step.command : step.type === 'gate' ? step.question : undefined)} {...props} />
  }
}

function LeafRow({ id, type, summary, state, shown, onSelect }: FlowProps & { id: string; type: string; summary?: string }): React.ReactElement {
  const visits = state.history.filter((h) => h.node === id)
  const last = visits[visits.length - 1]
  const isCurrent = state.current === id && isRunActive(state.status)
  const icon = isCurrent ? (state.status === 'waiting' ? '!' : state.status === 'running' || state.status === 'pausing' ? '●' : '❚❚')
    : !last ? '○' : last.outcome === 'ok' ? '✓' : last.outcome === 'fail' ? '✗' : last.outcome === 'interrupted' ? '⏸' : '·'
  const color = isCurrent ? (state.status === 'waiting' ? '#f48771' : '#4ec9b0') : !last ? '#555' : last.outcome === 'fail' ? '#f48771' : last.outcome === 'ok' ? '#4ec9b0' : '#dcdcaa'
  return <div style={{ padding: '3px 10px', background: shown?.node === id ? '#2a2d2e' : 'transparent' }}>
    <div onClick={() => last && onSelect({ node: id, visit: last.visit })} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: last ? 'pointer' : 'default', fontSize: 12 }}>
      <span style={{ width: 14, textAlign: 'center', color }} className={isCurrent && state.status === 'running' ? 'pipeline-pulse' : undefined}>{icon}</span>
      <span style={{ color: isCurrent ? '#fff' : '#ccc', fontWeight: isCurrent ? 600 : 400 }}>{id}</span>
      <span style={{ color: '#666', fontSize: 11 }}>{type}</span>
      {visits.length > 1 && <span style={{ marginLeft: 'auto', color: '#888', fontSize: 11 }}>×{visits.length}</span>}
    </div>
    {summary && <div style={{ marginLeft: 22, fontSize: 11, color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={summary}>{summary}</div>}
    {visits.length > 1 && <div style={{ marginLeft: 22, display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
      {visits.map((v) => <span key={v.visit} onClick={() => onSelect({ node: id, visit: v.visit })}
        style={{ fontSize: 10, padding: '0 5px', borderRadius: 3, cursor: 'pointer', border: '1px solid #444', color: v.outcome === 'fail' ? '#f48771' : v.outcome === 'ok' ? '#4ec9b0' : '#aaa', background: shown?.node === id && shown.visit === v.visit ? '#37373d' : 'transparent' }}>
        #{v.visit}
      </span>)}
    </div>}
  </div>
}

function VisitDetail({ run, visit }: { run: PipelineRunSnapshot; visit: VisitRef }): React.ReactElement {
  const { state, machine } = run
  const node = locate(machine.steps, visit.node)?.step
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
      {node?.type === 'agent' && <span style={{ color: '#666' }}>{node.cli ?? machine.defaults?.cli}</span>}
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
  const title = escalation.kind === 'engine' ? 'The run cannot continue' : escalation.kind === 'gate' ? 'Approval needed' : escalation.kind === 'limit' ? 'Loop limit reached' : 'Decision needed'
  return <div className="pipeline-attention" style={{ flexShrink: 0, borderTop: '2px solid #a33', background: '#2b1d1d', padding: '8px 12px', fontSize: 12 }}>
    <div style={{ fontWeight: 600, color: '#ffb3b3', marginBottom: 4 }}>{title} — {escalation.node} <span style={{ color: '#888', fontWeight: 400 }}>(for the {escalation.to}; whoever answers first)</span></div>
    <div style={{ whiteSpace: 'pre-wrap', color: '#ddd', marginBottom: 6 }}>{escalation.message}</div>
    <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer (available to the next steps)" style={{ width: '100%', boxSizing: 'border-box', height: 46, background: '#1e1e1e', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: 6, fontFamily: 'inherit', fontSize: 12, resize: 'vertical' }} />
    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
      {escalation.kind === 'engine' && <Button onClick={() => void answer('retry')}>Retry step</Button>}
      {escalation.kind === 'step' && <Button onClick={() => void answer('continue')}>Continue</Button>}
      {escalation.kind === 'step' && <Button onClick={() => void answer('retry')}>Retry step</Button>}
      {escalation.kind === 'limit' && <Button onClick={() => void answer('retry')}>One more iteration</Button>}
      {escalation.kind === 'limit' && <Button onClick={() => void answer('continue')}>Continue anyway</Button>}
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
