import { describe, expect, it } from 'vitest'
import { TrackerTail, diffState, journalBy, tailText, type TaskSummary, type TrackerState } from './taskTail'

function summary(fields: Partial<TaskSummary> = {}): TaskSummary {
  return { revision: 'r1', title: 'T', status: 'planned', inHistory: false, historyBy: null, activeBy: [], journal: ['2026-11-20 created by alice'], ...fields }
}

function state(tasks: Record<string, TaskSummary>, problems: string[] = []): TrackerState {
  return { tasks: new Map(Object.entries(tasks)), problems: new Set(problems) }
}

describe('diffState', () => {
  it('names each change and who made it, by revision, and counts new problems', () => {
    const before = state({
      a: summary(),
      b: summary({ status: 'active', activeBy: ['alice'] }),
      c: summary({ status: 'done' }),
      d: summary({ status: 'done' }),
      same: summary(),
      gone: summary()
    }, ['invalid:x'])
    const after = state({
      a: summary({ revision: 'r2', status: 'active', activeBy: ['bob'], journal: ['2026-11-20 created by alice', '2026-11-20 bob/tab 4: started (planned → active)'] }),
      b: summary({ revision: 'r2', status: 'done', journal: ['2026-11-20 created by alice', '2026-11-20 alice/tab 2: closed done'] }),
      c: summary({ revision: 'r2', status: 'done', inHistory: true, historyBy: 'b', journal: ['2026-11-20 created by alice', '2026-11-20 alice/tab 2: superseded by b'] }),
      d: summary({ revision: 'r2', status: 'active', journal: ['2026-11-20 created by alice', '2026-11-20 carol: reopened: broken'] }),
      same: summary(),
      fresh: summary({ journal: ['2026-11-20 created by alice/tab 1'] })
    }, ['invalid:x', 'stale:a', 'invalid:y'])
    expect(diffState(before, after)).toEqual([
      { text: 'task a started', by: 'bob/tab 4' },
      { text: 'task b closed done', by: 'alice/tab 2' },
      { text: 'task c moved to history (superseded by b)', by: 'alice/tab 2' },
      { text: 'task d reopened', by: 'carol' },
      { text: 'task fresh created', by: 'alice/tab 1' },
      { text: 'task gone removed', by: null },
      { text: '2 new problems (task_snapshot)', by: null }
    ])
  })

  it('a hand edit names no one; a start without a journal line names the user who joined', () => {
    const before = state({ a: summary(), b: summary({ status: 'active', activeBy: ['alice'] }) })
    const after = state({ a: summary({ revision: 'r2', title: 'Edited' }), b: summary({ revision: 'r2', status: 'active', activeBy: ['alice', 'bob'] }) })
    expect(diffState(before, after)).toEqual([{ text: 'task a changed', by: null }, { text: 'task b started', by: 'bob' }])
  })

  it('reads by from journal lines', () => {
    expect(journalBy('2026-11-20 created by alice/tab 3')).toBe('alice/tab 3')
    expect(journalBy('2026-11-20 bob: note: with a colon')).toBe('bob')
    expect(journalBy('free text')).toBeNull()
  })
})

describe('tailText', () => {
  it('shows at most 5 items, then "and N more"; nothing when nothing changed', () => {
    expect(tailText([])).toBeNull()
    expect(tailText(['task a closed done by bob'])).toBe('— tracker since your last call: task a closed done by bob.')
    const text = tailText(['1', '2', '3', '4', '5', '6', '7'])!
    expect(text).toBe('— tracker since your last call: 1; 2; 3; 4; 5; and 2 more.')
  })
})

describe('TrackerTail', () => {
  it('a connection gets a tail only when something changed since its last tail, without its own changes', () => {
    let current = state({ a: summary() })
    let reads = 0
    const tail = new TrackerTail(() => { reads++; return current })
    tail.seen('/p', 'c1') // session start
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBeNull()

    // A change event that changed nothing (a second notice of one write): no tail.
    tail.markDirty('/p')
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBeNull()

    current = state({ a: summary({ revision: 'r2', status: 'done', journal: ['x', '2026-11-20 bob: closed done'] }) })
    // Not read again without a change event: a quiet tracker costs nothing.
    const before = reads
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBeNull()
    expect(reads).toBe(before)

    tail.markDirty('/p')
    tail.markDirty('/p')
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBe('— tracker since your last call: task a closed done by bob.')
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBeNull()

    // Bob's own connection is not told about his own change.
    tail.seen('/p', 'c2')
    current = state({ a: summary({ revision: 'r3', status: 'done', journal: ['x', '2026-11-20 bob: closed done', '2026-11-20 bob: note'] }) })
    tail.markDirty('/p')
    expect(tail.take('/p', 'c2', 'bob')).toBeNull()
    expect(tail.take('/p', 'c1', 'alice/tab 1')).toBe('— tracker since your last call: task a changed by bob.')
  })

  it('a connection seen for the first time starts from now; a snapshot resets what it has seen', () => {
    let current = state({})
    const tail = new TrackerTail(() => current)
    expect(tail.take('/p', 'c1', null)).toBeNull()
    current = state(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, summary()])))
    tail.markDirty('/p')
    expect(tail.take('/p', 'c1', null)).toBe('— tracker since your last call: task t0 created by alice; task t1 created by alice; task t2 created by alice; task t3 created by alice; task t4 created by alice; and 3 more.')
    current = state({})
    tail.markDirty('/p')
    tail.seen('/p', 'c1')
    expect(tail.take('/p', 'c1', null)).toBeNull()
  })
})
