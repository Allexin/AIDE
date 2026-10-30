import { describe, expect, it } from 'vitest'
import type { PlanFile } from '../../../shared/plan'
import { applyOps, markDone, newPlan, nextTask, planProblems, serializePlan, type PlanOp } from './planFile'

function plan(): PlanFile {
  return newPlan({
    id: 'p',
    title: 'P',
    tasks: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', after: ['a'] },
      { id: 'c', title: 'C', after: ['b'] }
    ]
  })
}

describe('plan validation', () => {
  it('fills the defaults of a new plan', () => {
    const created = plan()
    expect(created).toMatchObject({ state: 'draft', revision: 1, followups: [] })
    expect(created.tasks[0].status).toBe('pending')
  })

  it('refuses what cannot be walked', () => {
    expect(() => newPlan({ id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A', after: ['x'] }] })).toThrow('unknown task "x"')
    expect(() => newPlan({ id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })).toThrow('appears twice')
    expect(() => newPlan({ id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A', after: ['b'] }, { id: 'b', title: 'B', after: ['a'] }] })).toThrow('depend on each other')
    expect(planProblems({ id: 'p', title: 'P', state: 'nope', revision: 1, tasks: [], followups: [] })).toEqual([expect.stringContaining('"state"')])
  })

  it('refuses an unknown field, which would be lost or mean a typo', () => {
    expect(() => newPlan({ id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A', acceptence: [] }] })).toThrow('unknown field "acceptence"')
  })

  it('serializes in a stable key order', () => {
    const created = plan()
    const shuffled: PlanFile = { ...created, tasks: [{ after: [], status: 'pending', title: 'T', id: 't' } as never] }
    const text = serializePlan(shuffled)
    expect(text.indexOf('"id": "t"')).toBeLessThan(text.indexOf('"title": "T"'))
    expect(JSON.parse(text).tasks[0].id).toBe('t')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('plan edits', () => {
  it('adds, moves, updates and drops, reporting what changed', () => {
    const { plan: edited, changed } = applyOps(plan(), [
      { op: 'add', task: { id: 'n', title: 'N' }, before: 'b' },
      { op: 'update', id: 'c', fields: { title: 'C2' } },
      { op: 'move', id: 'c', before: 'n' },
      { op: 'drop', id: 'b', reason: 'not needed' }
    ])
    expect(edited.tasks.map((t) => t.id)).toEqual(['a', 'c', 'n', 'b'])
    expect(edited.tasks.find((t) => t.id === 'c')?.title).toBe('C2')
    expect(edited.tasks.find((t) => t.id === 'b')).toMatchObject({ status: 'dropped', reason: 'not needed' })
    expect(changed.sort()).toEqual(['b', 'c', 'n'])
  })

  it('splits a task: the parts inherit its dependencies, its dependants wait for the last part', () => {
    const { plan: edited } = applyOps(plan(), [{ op: 'split', id: 'b', into: [{ id: 'b1', title: 'B1' }, { id: 'b2', title: 'B2', after: ['b1'] }] }])
    expect(edited.tasks.map((t) => t.id)).toEqual(['a', 'b1', 'b2', 'c'])
    expect(edited.tasks[1].after).toEqual(['a'])
    // Every part, not only the first: a part listed with its own "after" keeps the task's too.
    expect(edited.tasks[2].after).toEqual(['a', 'b1'])
    expect(edited.tasks[3].after).toEqual(['b2'])
  })

  it('is all or nothing and leaves the input alone', () => {
    const before = plan()
    expect(() => applyOps(before, [{ op: 'add', task: { id: 'n', title: 'N' } }, { op: 'update', id: 'missing', fields: {} }])).toThrow('Unknown task "missing"')
    expect(() => applyOps(before, [{ op: 'update', id: 'a', fields: { after: ['c'] } }])).toThrow('invalid')
    expect(before.tasks).toHaveLength(3)
  })

  it('removes a field set to null', () => {
    const { plan: edited } = applyOps(plan(), [{ op: 'update', id: 'b', fields: { after: null } as never }])
    expect(edited.tasks[1].after).toBeUndefined()
  })

  it('does not touch the task a running step works on', () => {
    for (const op of [{ op: 'update', id: 'a', fields: { title: 'X' } }, { op: 'drop', id: 'a' }, { op: 'move', id: 'a' }, { op: 'split', id: 'a', into: [{ id: 'x', title: 'X' }] }] satisfies PlanOp[]) {
      expect(() => applyOps(plan(), [op], 'a')).toThrow('is running')
    }
    expect(applyOps(plan(), [{ op: 'update', id: 'b', fields: { title: 'X' } }], 'a').plan.tasks[1].title).toBe('X')
  })
})

describe('what comes next', () => {
  it('goes in file order, waiting for dependencies; a dropped one no longer holds anything up', () => {
    const start = plan()
    expect(nextTask(start)?.id).toBe('a')
    const one = markDone(start, 'a')
    expect(nextTask(one)?.id).toBe('b')
    const dropped = applyOps(one, [{ op: 'drop', id: 'b' }]).plan
    expect(nextTask(dropped)?.id).toBe('c')
    expect(nextTask(markDone(dropped, 'c'))).toBeNull()
  })

  it('a blocked task holds up what depends on it', () => {
    const blocked = applyOps(plan(), [{ op: 'update', id: 'a', fields: { status: 'blocked', reason: 'no key' } }]).plan
    expect(nextTask(blocked)).toBeNull()
  })
})

describe('markDone', () => {
  it('clears the reason, adds new findings once, and is not a revision', () => {
    const blocked = applyOps(plan(), [{ op: 'update', id: 'a', fields: { reason: 'old' } }]).plan
    const done = markDone(blocked, 'a', ['nit', ' nit ', 'other'], '2026-01-01T00:00:00.000Z')
    expect(done.tasks[0]).toMatchObject({ status: 'done' })
    expect(done.tasks[0].reason).toBeUndefined()
    expect(done.followups.map((f) => [f.id, f.text, f.from])).toEqual([['f1', 'nit', 'a'], ['f2', 'other', 'a']])
    expect(done.revision).toBe(blocked.revision)
    expect(markDone(done, 'b', ['nit', 'third']).followups.map((f) => f.text)).toEqual(['nit', 'other', 'third'])
  })
})
