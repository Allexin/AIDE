import { describe, expect, it } from 'vitest'
import { buildRemoteRunView } from './pipelineRunView'
import { TINY_FEATURE } from '../pipeline/testing/tinyFeature'
import type { RunSnapshot } from '../pipeline/manager'
import type { Escalation, NodeVisit, RunState } from '../pipeline/engine/types'

function visit(node: string, n: number, outcome: NodeVisit['outcome']): NodeVisit {
  return { node, visit: n, outcome, startedAt: '2026-10-26T10:00:00Z', finishedAt: outcome ? '2026-10-26T10:05:00Z' : null, sessionId: null, costUsd: null, error: null }
}

function snapshot(state: Partial<RunState>): RunSnapshot {
  return {
    runId: 'run-1', projectPath: '/p', machine: TINY_FEATURE,
    state: {
      runId: 'run-1', machineId: TINY_FEATURE.id, projectPath: '/p', status: 'running', current: null, visits: {}, iterations: {}, bonus: {},
      feedback: {}, outputs: {}, history: [], escalations: [], sessions: {}, startCommit: null, result: null,
      startedAt: '2026-10-26T10:00:00Z', updatedAt: '2026-10-26T10:00:00Z', finishedAt: null, ...state
    }
  }
}

describe('buildRemoteRunView', () => {
  it('flattens the step tree with step states, visits and loop progress', () => {
    const view = buildRemoteRunView(snapshot({
      current: 'review', iterations: { build: 2 },
      history: [visit('implement', 1, 'ok'), visit('checks', 1, 'fail'), visit('implement', 2, 'ok'), visit('checks', 2, 'ok'), visit('review', 1, null)]
    }))
    expect(view.loopLabel).toBe('Implement and review 2/2')
    expect(view.rows?.map((row) => row.kind === 'leaf' ? `${'  '.repeat(row.depth)}${row.id} ${row.state} ×${row.visits.length}` : `${'  '.repeat(row.depth)}[${row.label}${row.kind === 'block' ? ` ${row.progress}${row.active ? ' active' : ''}` : ''}]`)).toEqual([
      '[Implement and review iteration 2/2 active]',
      '  implement ok ×2',
      '  checks ok ×2',
      '  review running ×1',
      '[commit commit max 2]',
      '  commitPrep pending ×0',
      '  commit pending ×0'
    ])
    const review = view.rows?.find((row) => row.kind === 'leaf' && row.id === 'review')
    expect(review).toMatchObject({ agent: true, cli: 'claude-code', current: true })
    expect(view.rows?.find((row) => row.kind === 'leaf' && row.id === 'checks')).toMatchObject({ agent: false, summary: 'node check.js' })
  })

  it('offers the answers the pending escalation takes and keeps the last decision', () => {
    const escalation = (id: string, kind: Escalation['kind'], answer: Escalation['answer']): Escalation =>
      ({ id, node: 'implement', kind, to: 'orchestrator', message: 'blocked: needs a decision', raisedAt: '2026-10-26T10:01:00Z', answer })
    const view = buildRemoteRunView(snapshot({
      status: 'waiting', current: 'implement',
      escalations: [
        escalation('e1', 'engine', { action: 'retry', text: 'try again', by: 'orchestrator', at: '2026-10-26T10:02:00Z' }),
        escalation('e2', 'step', null)
      ]
    }), { brief: true })
    expect(view.rows).toBeUndefined()
    expect(view.pending).toMatchObject({ id: 'e2', title: 'Decision needed' })
    expect(view.pending?.actions.map((a) => a.action)).toEqual(['continue', 'retry', 'stop'])
    expect(view.lastAnswer).toMatchObject({ action: 'retry', by: 'orchestrator', text: 'try again' })
  })
})
