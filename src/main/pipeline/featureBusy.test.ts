import { describe, expect, it } from 'vitest'
import { featureBusyReason } from './featureBusy'
import type { RunStatus } from './engine/types'

const run = (status: RunStatus): { runId: string; status: RunStatus } => ({ runId: 'r1', status })

describe('turning a feature off while work is going on', () => {
  it('pipelines: refused while a run is running or pausing', () => {
    for (const status of ['running', 'pausing'] as RunStatus[]) {
      const reason = featureBusyReason('P', 'pipelines', { run: run(status), autopilotPlan: null })
      expect(reason).toContain('run r1 of P')
      expect(reason).toContain(status)
    }
  })

  it('pipelines: allowed with a paused, stopped, waiting or ended run, which stays on disk', () => {
    for (const status of ['paused', 'stopped', 'waiting', 'finished', 'failed'] as RunStatus[]) {
      expect(featureBusyReason('P', 'pipelines', { run: run(status), autopilotPlan: null })).toBeNull()
    }
    expect(featureBusyReason('P', 'pipelines', { run: null, autopilotPlan: null })).toBeNull()
  })

  it('pipelines and plans: refused while the plan autopilot is working', () => {
    expect(featureBusyReason('P', 'pipelines', { run: null, autopilotPlan: 'p' })).toContain('autopilot of plan p')
    expect(featureBusyReason('P', 'plans', { run: null, autopilotPlan: 'p' })).toContain('Plans cannot be turned off')
    // A running run outside a plan does not hold plans back.
    expect(featureBusyReason('P', 'plans', { run: run('running'), autopilotPlan: null })).toBeNull()
  })

  it('the tracker is never held back', () => {
    expect(featureBusyReason('P', 'tracker', { run: run('running'), autopilotPlan: 'p' })).toBeNull()
  })
})
