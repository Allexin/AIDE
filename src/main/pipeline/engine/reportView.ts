import { clip } from '../events'
import type { RunReport } from './runner'

/**
 * The orchestrator's view of a run report: what it needs to update the plan and
 * pick the next task, without the per-visit log. The full report stays on disk
 * and is available with `pipeline_report detail: true`.
 */

export interface CompactReport {
  runId: string
  machine: string
  result: RunReport['result']
  reason: string | null
  durationMin: number
  costUsd: number
  /** Agent visits whose CLI reported no cost: costUsd leaves them out. */
  costUnknownVisits?: number
  commits: Array<{ sha: string; subject: string; files: number }>
  /** Visits per step, e.g. `{ implement: 3, review: 3 }` — how hard the loops worked. */
  visits: Record<string, number>
  loops: Record<string, number>
  /** The last summary of each agent step, in the order those visits ended: a later one supersedes an earlier one. */
  summaries: Array<{ step: string; visit?: number; summary: string }>
  nonBlockingFindings: string[]
  /** Every check command and its last result. A check that passed here ran on the final code: no need to run it again. */
  checks: Array<{ step: string; command: string; result: 'passed' | 'failed'; runs: number }>
  /** Problems with the pipeline itself that agents reported. */
  pipelineIssues: Array<{ step: string; issue: string }>
  /** Instructions added during the run. */
  amendments: Array<{ step: string | null; text: string }>
  decisions: Array<{ step: string; kind: string; action: string; by: string; text: string }>
  note?: string
}

const MAX_FINDINGS = 20

export function compactReport(report: RunReport & { reason?: string | null; note?: string }): CompactReport {
  const visits: Record<string, number> = {}
  for (const v of report.visits) visits[v.node] = Math.max(visits[v.node] ?? 0, v.visit)
  const findings = [...new Set(report.nonBlockingFindings.map((f) => f.trim()).filter(Boolean))]
  return {
    runId: report.runId,
    machine: report.machine.id,
    result: report.result,
    reason: report.reason ? clip(report.reason, 600) : null,
    durationMin: Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 6000) / 10,
    costUsd: Math.round(report.costUsd * 1000) / 1000,
    ...(report.uncostedVisits ? { costUnknownVisits: report.uncostedVisits } : {}),
    commits: report.commits.map((c) => ({ sha: c.sha, subject: c.message.split('\n')[0], files: c.files.length })),
    visits,
    loops: report.loops ?? {},
    summaries: report.summaries.map((s) => ({ step: s.node, ...(s.visit ? { visit: s.visit } : {}), summary: clip(s.summary, 400) })),
    nonBlockingFindings: findings.slice(0, MAX_FINDINGS).map((f) => clip(f, 240)).concat(findings.length > MAX_FINDINGS ? [`… and ${findings.length - MAX_FINDINGS} more (pipeline_report detail: true)`] : []),
    checks: (report.checks ?? []).map((c) => ({ step: c.node, command: clip(c.command, 200), result: c.passed ? 'passed' : 'failed', runs: c.runs })),
    pipelineIssues: (report.pipelineIssues ?? []).slice(0, MAX_FINDINGS).map((p) => ({ step: p.step, issue: clip(p.issue, 300) })),
    amendments: (report.amendments ?? []).map((a) => ({ step: a.node, text: clip(a.text, 240) })),
    decisions: report.escalations.filter((e) => e.answer).map((e) => ({ step: e.node, kind: e.kind, action: e.answer!.action, by: e.answer!.by, text: clip(e.answer!.text, 240) })),
    ...(report.note ? { note: report.note } : {})
  }
}
