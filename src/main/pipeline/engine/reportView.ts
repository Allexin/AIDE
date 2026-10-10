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
  commits: Array<{ sha: string; subject: string; files: number }>
  /** Visits per step, e.g. `{ implement: 3, review: 3 }` — how hard the loops worked. */
  visits: Record<string, number>
  loops: Record<string, number>
  summaries: Array<{ step: string; summary: string }>
  nonBlockingFindings: string[]
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
    commits: report.commits.map((c) => ({ sha: c.sha, subject: c.message.split('\n')[0], files: c.files.length })),
    visits,
    loops: report.loops ?? {},
    summaries: report.summaries.map((s) => ({ step: s.node, summary: clip(s.summary, 400) })),
    nonBlockingFindings: findings.slice(0, MAX_FINDINGS).map((f) => clip(f, 240)).concat(findings.length > MAX_FINDINGS ? [`… and ${findings.length - MAX_FINDINGS} more (pipeline_report detail: true)`] : []),
    decisions: report.escalations.filter((e) => e.answer).map((e) => ({ step: e.node, kind: e.kind, action: e.answer!.action, by: e.answer!.by, text: clip(e.answer!.text, 240) })),
    ...(report.note ? { note: report.note } : {})
  }
}
