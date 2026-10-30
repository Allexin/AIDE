import React, { useEffect, useState } from 'react'
import { usePlanStore, type PlanDetail } from '../../store/usePlanStore'
import { usePipelineStore } from '../../store/usePipelineStore'
import { TranscriptView } from '../history/TranscriptView'
import { planProgress, type AttentionKind, type AutopilotState, type JournalEntry, type PlanAttention, type PlanFile, type PlanTask } from '../../../../shared/plan'

/**
 * The plan as the parent of the pipeline in the pipeline tab (docs/plan-mode-spec.md):
 * the project's plans and the active plan's tasks, each with what happened to it. A
 * run of a task opens in the run view next to it, an Orchestrator call as its transcript.
 */

const ATTENTION_TITLE: Record<AttentionKind, string> = {
  run_failed: 'A run failed',
  wake: 'The Orchestrator asks for the Strategist',
  checkpoint: 'Checkpoint',
  review_due: 'Time for a review',
  no_machine: 'A task cannot start',
  stuck: 'No task can start',
  finished: 'The plan is finished',
  shadow: 'Shadow mode: decision to confirm',
  orchestrator_failed: 'The Orchestrator failed',
  paused: 'Paused',
  outside_run: 'Held for a run outside the plan'
}
const QUIET: ReadonlySet<AttentionKind> = new Set(['paused', 'outside_run', 'finished'])
const AUTOPILOT_LABEL: Record<AutopilotState['status'], string> = { idle: 'Autopilot off', deciding: 'Orchestrator deciding', running: 'Running', held: 'Held', finished: 'Finished' }
const TASK_ICON: Record<PlanTask['status'], string> = { pending: '○', done: '✓', blocked: '!', dropped: '–' }
const TASK_COLOR: Record<PlanTask['status'], string> = { pending: '#666', done: '#4ec9b0', blocked: '#f48771', dropped: '#666' }

const buttonStyle: React.CSSProperties = { background: '#3c3c3c', color: '#ccc', border: '1px solid #555', borderRadius: 3, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }
const primaryStyle: React.CSSProperties = { ...buttonStyle, background: '#0e639c', color: '#fff', borderColor: '#0e639c' }

type Control = (action: 'run' | 'pause' | 'approve' | 'activate', options?: { planId?: string; note?: string }) => Promise<void>

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function planNeedsAttention(attention: PlanAttention | null | undefined): boolean {
  return !!attention && !QUIET.has(attention.kind)
}

/** The status bar's plan sensor: progress and what the plan is doing. */
export function PlanSensor({ style }: { style: React.CSSProperties }): React.ReactElement | null {
  const snapshot = usePlanStore((s) => s.snapshot)
  const active = snapshot?.plans.find((p) => p.id === snapshot.activeId)?.plan
  if (!active) return null
  const { done, total } = planProgress(active)
  const auto = snapshot?.autopilot
  const attention = planNeedsAttention(auto?.attention)
  return <span style={{ ...style, ...(attention ? { color: '#f0a500' } : {}) }} title={`Plan: ${active.title}${auto ? ` — ${AUTOPILOT_LABEL[auto.status]}` : ''}`}>
    Plan {done}/{total}{auto?.status === 'running' && auto.task ? ` · ${auto.task}` : ''}{attention ? ' !' : ''}
  </span>
}

/** The left column of the pipeline tab. */
export function PlanPanel(): React.ReactElement | null {
  const snapshot = usePlanStore((s) => s.snapshot)
  const [error, setError] = useState<string | null>(null)
  if (!snapshot) return null
  const active = snapshot.plans.find((p) => p.id === snapshot.activeId)?.plan ?? null
  const others = snapshot.plans.filter((p) => p.id !== snapshot.activeId)
  const control: Control = async (action, options) => {
    setError(await window.editorApi.planControl(action, options))
  }
  return <div style={{ width: 340, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #333', padding: '6px 0', fontSize: 12, fontFamily: 'Segoe UI, sans-serif', color: '#ccc' }}>
    {error && <div style={{ padding: '4px 10px', color: '#f48771', background: '#3a1f1f' }}>{error}</div>}
    {active ? <ActivePlan plan={active} journal={snapshot.journal} auto={snapshot.autopilot} control={control} /> : <div style={{ padding: '6px 10px', color: '#777' }}>No plan is active.</div>}
    {others.length > 0 && <div style={{ padding: '10px 10px 2px', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Other plans</div>}
    {others.map((entry) => <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px', color: '#999' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.plan?.title ?? entry.id}</span>
      {entry.plan && <span style={{ color: '#666', flexShrink: 0 }}>{entry.plan.state} · {planProgress(entry.plan).done}/{planProgress(entry.plan).total}</span>}
      {entry.error && <span style={{ color: '#f48771' }} title={entry.error}>invalid file</span>}
      {entry.plan?.state === 'draft' && <button style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => void control('approve', { planId: entry.id })}>Approve</button>}
      {entry.plan?.state === 'approved' && <button style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => void control('activate', { planId: entry.id })}>Activate</button>}
    </div>)}
  </div>
}

function ActivePlan({ plan, journal, auto, control }: { plan: PlanFile; journal: JournalEntry[]; auto: AutopilotState | null; control: Control }): React.ReactElement {
  const { done, total } = planProgress(plan)
  const status = auto?.status ?? 'idle'
  const show = usePlanStore.getState().showDetail
  let phase: string | null = null
  return <>
    <div style={{ padding: '2px 10px 4px' }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{plan.title}</div>
      <div style={{ color: '#888' }}>{done}/{total} · {AUTOPILOT_LABEL[status]}{plan.orchestrator?.shadow ? ' · shadow' : ''}{plan.state !== 'approved' ? ` · ${plan.state}` : ''}</div>
      {plan.goal && <div style={{ color: '#999', marginTop: 2 }}>{plan.goal}</div>}
    </div>
    <div style={{ height: 3, margin: '0 10px 6px', background: '#333' }}><div style={{ height: '100%', width: `${total ? Math.round(done * 100 / total) : 0}%`, background: '#4ec9b0' }} /></div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 10px 6px' }}>
      {(status === 'deciding' || status === 'running') && <button style={buttonStyle} title="Hold the plan after the running step" onClick={() => void control('pause')}>Pause plan</button>}
      {status === 'idle' && plan.state === 'approved' && <button style={primaryStyle} onClick={() => void control('run')}>Run plan</button>}
      {plan.state === 'draft' && <button style={primaryStyle} onClick={() => void control('approve', { planId: plan.id })}>Approve</button>}
      {status === 'deciding' && auto && auto.decisions > 0 && <button style={buttonStyle} onClick={() => show({ kind: 'decision', planId: plan.id, number: auto.decisions })}>Orchestrator transcript</button>}
      {auto?.answering && <button style={buttonStyle} title={`The Orchestrator answers the ${auto.answering.kind} escalation at ${auto.answering.node}`} onClick={() => show({ kind: 'decision', planId: plan.id, number: auto.answering!.decision })}>Orchestrator answering</button>}
    </div>
    {auto?.attention && <AttentionCard attention={auto.attention} pending={auto.pending} planId={plan.id} control={control} />}
    {plan.tasks.map((task) => {
      const heading = (task.phase ?? null) !== phase ? (phase = task.phase ?? null) : null
      const entries = journal.filter((e) => (e.kind === 'decision' || e.kind === 'run') && e.task === task.id)
      return <React.Fragment key={task.id}>
        {heading && <div style={{ padding: '7px 10px 2px', color: '#9cdcfe', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{heading}</div>}
        <TaskRow task={task} live={status === 'running' && auto?.task === task.id} entries={entries} planId={plan.id} />
      </React.Fragment>
    })}
    {plan.followups.length > 0 && <>
      <div style={{ padding: '10px 10px 2px', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Follow-ups ({plan.followups.length})</div>
      {plan.followups.map((f) => <div key={f.id} style={{ padding: '2px 10px', color: '#999' }}>{f.from}: {f.text}</div>)}
    </>}
  </>
}

function AttentionCard({ attention, pending, planId, control }: { attention: PlanAttention; pending: AutopilotState['pending']; planId: string; control: Control }): React.ReactElement {
  const [note, setNote] = useState('')
  const quiet = QUIET.has(attention.kind)
  return <div style={{ margin: '0 10px 8px', padding: '7px 9px', background: quiet ? '#252526' : '#2f2a1c', border: `1px solid ${quiet ? '#444' : '#a78a2a'}`, borderRadius: 4 }}>
    <div style={{ color: quiet ? '#bbb' : '#f0c674', fontWeight: 600 }}>{ATTENTION_TITLE[attention.kind]}{attention.task ? ` — ${attention.task}` : ''}</div>
    <div style={{ margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{attention.reason}</div>
    {attention.proposal && <div style={{ margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Proposal: {attention.proposal}</div>}
    {pending && <div style={{ margin: '4px 0', color: '#bbb', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Would start {pending.task} with {JSON.stringify(pending.decision.params)}{pending.decision.handoff ? `. Handoff: ${pending.decision.handoff}` : ''}</div>}
    {attention.kind !== 'finished' && <>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the Orchestrator (why it can go on)" style={{ width: '100%', minHeight: 44, marginTop: 4, padding: 5, color: '#d4d4d4', background: '#1e1e1e', border: '1px solid #555', borderRadius: 3, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12 }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
        <button style={primaryStyle} onClick={() => { void control('run', { note }); setNote('') }}>{pending ? 'Carry it out' : 'Continue the plan'}</button>
        {attention.decision && <button style={buttonStyle} onClick={() => usePlanStore.getState().showDetail({ kind: 'decision', planId, number: attention.decision! })}>Orchestrator transcript</button>}
      </div>
    </>}
  </div>
}

function TaskRow({ task, live, entries, planId }: { task: PlanTask; live: boolean; entries: JournalEntry[]; planId: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const detail = usePlanStore((s) => s.detail)
  const show = usePlanStore.getState().showDetail
  const isShown = (candidate: PlanDetail): boolean => JSON.stringify(detail) === JSON.stringify(candidate)
  const rowStyle = (selected: boolean): React.CSSProperties => ({ marginTop: 4, padding: '4px 7px', background: selected ? '#37373d' : '#252526', borderRadius: 3, cursor: 'pointer' })
  return <div style={{ borderLeft: `2px solid ${live ? '#4ec9b0' : 'transparent'}`, background: live ? '#2a2d2e' : undefined }}>
    <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 10px', cursor: 'pointer' }}>
      <span style={{ width: 14, textAlign: 'center', flexShrink: 0, color: live ? '#4ec9b0' : TASK_COLOR[task.status] }} className={live ? 'pipeline-pulse' : undefined}>{live ? '●' : TASK_ICON[task.status]}</span>
      <span style={{ color: task.status === 'done' || task.status === 'dropped' ? '#888' : '#ccc', overflowWrap: 'anywhere' }}>{task.title}</span>
      {entries.length > 0 && <span style={{ marginLeft: 'auto', color: '#777', fontSize: 11, flexShrink: 0 }}>{entries.length} {open ? '⌄' : '›'}</span>}
    </div>
    {open && <div style={{ padding: '2px 10px 8px 32px', color: '#999', overflowWrap: 'anywhere' }}>
      <div style={{ color: '#666' }}>{task.id}</div>
      {task.reason && <div>{task.reason}</div>}
      {task.machine && <div>Machine: {task.machine}</div>}
      {task.spec && <div>Spec: {task.spec}</div>}
      {task.after?.length ? <div>After: {task.after.join(', ')}</div> : null}
      {task.acceptance?.length ? <div>Acceptance: {task.acceptance.join('; ')}</div> : null}
      {entries.map((entry, index) => {
        if (entry.kind === 'decision') {
          const target: PlanDetail = { kind: 'decision', planId, number: entry.decision }
          return <div key={index} onClick={() => show(target)} style={rowStyle(isShown(target))}>
            <span style={{ color: entry.verdict === 'next' || entry.verdict === 'answer' ? '#4ec9b0' : '#f0c674', fontWeight: 600 }}>Orchestrator: {entry.verdict}{entry.escalation?.action ? ` ${entry.escalation.action}` : ''}{entry.escalation ? ` (${entry.escalation.kind} escalation at ${entry.escalation.node})` : ''}{entry.shadow ? ' (shadow)' : ''}</span> <span style={{ color: '#777' }}>{clock(entry.at)}</span>
            <div style={{ whiteSpace: 'pre-wrap' }}>{entry.reason}</div>
            {entry.escalation?.text && <div style={{ whiteSpace: 'pre-wrap' }}>Answer: {entry.escalation.text}</div>}
            {entry.proposal && <div style={{ whiteSpace: 'pre-wrap' }}>Proposal: {entry.proposal}</div>}
            {entry.handoff && <div style={{ whiteSpace: 'pre-wrap' }}>Handoff: {entry.handoff}</div>}
          </div>
        }
        if (entry.kind !== 'run') return null
        const target: PlanDetail = { kind: 'run', runId: entry.runId }
        return <div key={index} onClick={() => show(target)} style={rowStyle(isShown(target))}>
          <span style={{ color: entry.result === 'success' ? '#4ec9b0' : '#f48771', fontWeight: 600 }}>Run: {entry.result}</span> <span style={{ color: '#777' }}>{clock(entry.at)}{entry.costUsd ? ` · $${entry.costUsd.toFixed(2)}` : ''}</span>
          {entry.commits.length > 0 && <div>{entry.commits.map((c) => c.slice(0, 8)).join(', ')}</div>}
        </div>
      })}
      {live && <div onClick={() => show(null)} style={rowStyle(detail === null)}><span style={{ color: '#4ec9b0', fontWeight: 600 }}>Run in progress</span></div>}
      {!entries.length && !live && <div>Not started yet.</div>}
    </div>}
  </div>
}

/** One Orchestrator call: its answer and transcript, live while it runs. */
export function DecisionDetail({ planId, number }: { planId: string; number: number }): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [answer, setAnswer] = useState<unknown>(null)
  const snapshot = usePlanStore((s) => s.snapshot)
  const running = (snapshot?.autopilot?.status === 'deciding' && snapshot.autopilot.decisions === number) || snapshot?.autopilot?.answering?.decision === number
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.editorApi.planGetDecision(planId, number).then((record) => {
        if (!alive) return
        setEntries(record?.entries ?? [])
        setAnswer(record?.decision ?? null)
      })
    }
    load()
    const off = window.editorApi.onPlanDecisionEntry((event) => { if (event.planId === planId && event.decision === number) load() })
    return () => { alive = false; off() }
    // A snapshot arrives when the call ends: its answer is there then.
  }, [planId, number, snapshot?.autopilot?.status, snapshot?.autopilot?.answering?.decision])
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#1e1e1e', fontFamily: 'Segoe UI, sans-serif', color: '#ccc', fontSize: 12 }}>
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#252526', borderBottom: '1px solid #333' }}>
      <span style={{ fontWeight: 600 }}>Orchestrator · call {number}</span>
      {running && <span style={{ color: '#4ec9b0' }}>● deciding</span>}
      <button style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => usePlanStore.getState().showDetail(null)}>Close</button>
    </div>
    {answer != null && <pre style={{ flexShrink: 0, maxHeight: '30%', overflow: 'auto', margin: 0, padding: '6px 10px', color: '#bbb', borderBottom: '1px solid #333', fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(answer, null, 2)}</pre>}
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'auto' }}>
      {entries === null ? <div style={{ padding: 12, color: '#777' }}>Loading…</div>
        : entries.length === 0 ? <div style={{ padding: 12, color: '#777' }}>{running ? 'Waiting for the Orchestrator…' : 'No transcript.'}</div>
          : <TranscriptView entries={entries} toolName="Orchestrator" />}
    </div>
  </div>
}

/** Keeps the live run in the store's selection when a run was left open from the plan. */
export function usePastRun(runId: string | null): PipelineRunSnapshot | null {
  const [run, setRun] = useState<PipelineRunSnapshot | null>(null)
  const live = usePipelineStore((s) => s.run)
  useEffect(() => {
    let alive = true
    setRun(null)
    if (!runId) return
    void window.editorApi.planGetRunSnapshot(runId).then((snapshot) => { if (alive) setRun(snapshot) })
    return () => { alive = false }
  }, [runId])
  return runId && live?.runId === runId ? live : run
}
