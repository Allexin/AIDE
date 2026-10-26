import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { PipelineViewService } from './viewService'

function fakeManager(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    pause: () => { throw new Error('No active run.') },
    resume: () => {},
    answer: async (_path: string, id: string) => { if (id !== 'esc-1') throw new Error(`Escalation ${id} is not pending.`) }
  })
}

describe('PipelineViewService', () => {
  it('returns errors of controls and answers as text', async () => {
    const view = new PipelineViewService(fakeManager() as never)
    expect(await view.control('/p', 'pause')).toBe('No active run.')
    expect(await view.control('/p', 'resume')).toBeNull()
    expect(await view.answer('/p', 'esc-1', 'continue', '')).toBeNull()
    expect(await view.answer('/p', 'esc-2', 'retry', 'again')).toBe('Escalation esc-2 is not pending.')
  })

  it('passes on the state and transcript of its project only, until unsubscribed', () => {
    const manager = fakeManager()
    const view = new PipelineViewService(manager as never)
    const seen: string[] = []
    const unsubscribe = view.subscribe('/p', {
      onState: (snapshot) => seen.push(`state ${snapshot.runId}`),
      onTranscript: (runId, node, visit) => seen.push(`entry ${runId} ${node}#${visit}`)
    })
    manager.emit('state', '/p', { runId: 'r1' })
    manager.emit('state', '/other', { runId: 'r2' })
    manager.emit('transcript', '/p', 'r1', 'implement', 2, { role: 'assistant', blocks: [] })
    unsubscribe()
    manager.emit('state', '/p', { runId: 'r1' })
    expect(seen).toEqual(['state r1', 'entry r1 implement#2'])
    expect(manager.listenerCount('state') + manager.listenerCount('transcript')).toBe(0)
  })
})
