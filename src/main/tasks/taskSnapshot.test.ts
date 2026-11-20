import { describe, expect, it } from 'vitest'
import type { TaskFile } from '../../shared/task'
import { ORIENTATION_LIMIT, TRACKER_RULE, claimsSection, renderSnapshot, staleActives, trackerOrientation } from './taskSnapshot'
import { serverInstructions } from '../pipeline/mcp/tools'

function task(fields: Partial<TaskFile> & { id: string }): TaskFile {
  return {
    title: fields.id, status: 'backlog', rank: null, tags: [], docs: [], code: [], reason: null, blockedFrom: null,
    label: null, claim: null, decidedAgainst: null, reopened: false, history: null, confirmed: null, acknowledged: null,
    check: null, source: null, activeBy: [], created: '2026-11-01T00:00:00.000Z', closed: null, description: '', journal: [],
    ...fields
  }
}

const CONFIRMED = { at: '2026-11-02T00:00:00.000Z', by: 'close' as const, files: {} }

/** A done task with a claim, closed on day `day` of November. */
function claim(id: string, tag: string, day: number, extra: Partial<TaskFile> = {}): TaskFile {
  const closed = `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`
  return task({ id, title: `Title of ${id}`, status: 'done', tags: [tag], label: `Label of the feature named ${id}`, claim: `Claim of ${id}.`, confirmed: CONFIRMED, closed, ...extra })
}

describe('orientation', () => {
  it('a project without a tracker gets the rule only', () => {
    expect(trackerOrientation(null)).toBe(TRACKER_RULE)
    expect(TRACKER_RULE.split('. ').length).toBe(3)
  })

  it('with 300 claims the tracker part stays within 2,500 characters and starts with the rule', () => {
    const tasks: TaskFile[] = []
    for (let i = 0; i < 300; i++) tasks.push(claim(`claim-${i}`, `area-with-a-long-name-${i % 120}`, 1 + (i % 28)))
    for (let i = 0; i < 12; i++) tasks.push(task({ id: `plan-${i}`, title: `A planned task with a rather long title number ${i} `.repeat(4), status: 'planned', rank: i }))
    const part = trackerOrientation(tasks)
    expect(part.length).toBeLessThanOrEqual(ORIENTATION_LIMIT)
    expect(part.startsWith(TRACKER_RULE)).toBe(true)
    expect(part).toContain('Rules: task_guide.')
    expect(part).toMatch(/Tags \(claims\): area-with-a-long-name-\d+ 3, .*…/)
    expect(part).toContain('Planned next: A planned task with a rather long title number 0')
    expect(part.endsWith('(as of session start)')).toBe(true)

    const instructions = serverInstructions('Work instruction.', part)
    const start = instructions.indexOf(TRACKER_RULE)
    expect(start).toBeGreaterThan(0)
    expect(instructions.slice(start, start + part.length)).toBe(part)
  })

  it('counts claims under the first tag, most first, and lists planned tasks by rank', () => {
    const tasks = [
      claim('a', 'terminal', 1), claim('b', 'terminal', 2), task({ ...claim('c', 'pipeline', 3), tags: ['pipeline', 'terminal'] }),
      claim('d', 'old', 4, { history: { at: 'x', by: null, reason: 'gone' } }),
      task({ id: 'p2', title: 'Second', status: 'planned', rank: 2 }), task({ id: 'p1', title: 'First', status: 'planned', rank: 1 })
    ]
    expect(trackerOrientation(tasks)).toBe(`${TRACKER_RULE} Rules: task_guide.\nTags (claims): terminal 2, pipeline 1 Planned next: First; Second (as of session start)`)
  })
})

describe('task_snapshot section 0', () => {
  const tasks = [
    claim('t1', 'terminal', 10), claim('t2', 'terminal', 11, { reopened: true, status: 'active', confirmed: null }),
    claim('p1', 'pipeline', 5), claim('p2', 'pipeline', 6),
    claim('g1', 'git', 20),
    claim('o1', 'old', 1), claim('o2', 'old', 2), claim('o3', 'old', 3),
    task({ id: 'no-x', title: 'No X', status: 'cancelled', tags: ['ui'], label: 'X feature', decidedAgainst: 'We do not do X.', closed: '2026-11-15T00:00:00.000Z' }),
    task({ id: 'next', status: 'planned', rank: 1, tags: ['pipeline'] })
  ]

  const COUNTS: Record<string, number> = { terminal: 2, pipeline: 2, git: 1, ui: 1, old: 3 }
  const ORDER = ['terminal', 'pipeline', 'git', 'ui', 'old']
  const claims = (n: number): string => `${n} claim${n === 1 ? '' : 's'}`

  it('lists every claim by tag with its marks when it fits', () => {
    const text = claimsSection(tasks, 10_000)
    expect(text).toContain('terminal: Label of the feature named t1; Label of the feature named t2 (reopened) (unverified)')
    expect(text).toContain('ui: X feature (decided against)')
    expect(text).not.toContain('left out')
  })

  it('orders tags: active tasks, the first planned tasks, then the most recent close', () => {
    // t2 is active (reopened): terminal first; "next" is planned: pipeline; then git (20), ui (15), old (3).
    const order = claimsSection(tasks, 10_000).split('\n').slice(1).map((line) => line.split(':')[0])
    expect(order).toEqual(ORDER)
  })

  it('over budget keeps whole tags in that order and ends with the count left out', () => {
    const full = claimsSection(tasks, 10_000)
    const budget = 300
    expect(full.length).toBeGreaterThan(budget)
    const text = claimsSection(tasks, budget)
    expect(text.length).toBeLessThanOrEqual(budget)
    const lines = text.split('\n')
    const kept = lines.slice(1, -2).map((line) => line.split(':')[0])
    expect(kept.length).toBeGreaterThan(0)
    expect(kept).toEqual(ORDER.slice(0, kept.length))
    // Whole tags only: a kept tag has all its claims.
    for (const line of lines.slice(1, -2)) expect(full.split('\n')).toContain(line)
    const rest = ORDER.slice(kept.length)
    expect(lines.at(-2)).toBe(`Other tags: ${rest.map((tag) => `${tag} (${claims(COUNTS[tag])})`).join(', ')}`)
    expect(lines.at(-1)).toBe(`${claims(rest.reduce((n, tag) => n + COUNTS[tag], 0))} left out — task_search`)
  })

  it('a budget too small for any tag lists them all with their counts', () => {
    expect(claimsSection(tasks, 50).split('\n')).toEqual([
      '## Project: claims by tag',
      `Other tags: ${ORDER.map((tag) => `${tag} (${claims(COUNTS[tag])})`).join(', ')}`,
      '9 claims left out — task_search'
    ])
  })
})

describe('task_snapshot', () => {
  const now = new Date('2026-11-20T12:00:00Z')

  it('has the sections in order: claims, this tab, problems, active and blocked, recent', () => {
    const current = task({ id: 'cur', title: 'Current work', status: 'active', description: 'd'.repeat(700), journal: ['1', '2', '3', '4', '5', '6'], docs: ['docs/x.md'], activeBy: ['alice'] })
    const text = renderSnapshot({
      tasks: [
        claim('c1', 'terminal', 18), current,
        task({ id: 'blk', title: 'Blocked one', status: 'blocked', reason: 'waits for the API', blockedFrom: 'planned' }),
        claim('gone', 'x', 2, { history: { at: '2026-11-19T00:00:00.000Z', by: 'c1', reason: 'superseded by c1' } })
      ],
      labelBudget: 12_000,
      tabId: 'tab-1',
      current,
      problems: ['Task "z" is invalid.'],
      workers: new Map([['cur', ['alice/tab 1', 'bob']]]),
      now
    })
    const heads = text.split('\n').filter((line) => line.startsWith('## '))
    expect(heads).toEqual(['## Project: claims by tag', "## This tab's task", '## Problems', '## Active and blocked', '## Closed or moved to history in the last 7 days'])
    expect(text).toContain(`Current work (cur), active\n${'d'.repeat(599)}…`)
    expect(text).toContain('Journal:\n- 2\n- 3\n- 4\n- 5\n- 6\nDocs: docs/x.md')
    expect(text).toContain('- Task "z" is invalid.')
    expect(text).toContain('- active cur: Current work — alice/tab 1, bob')
    expect(text).toContain('- blocked blk: Blocked one — waits for the API')
    expect(text).toContain('- gone: Title of gone — to history 2026-11-19 (superseded by c1)')
    expect(text).toContain('- c1: Title of c1 — done 2026-11-18, claim "Label of the feature named c1"')
  })

  it('says when the tab has no task or the session no tab', () => {
    const input = { tasks: [], labelBudget: 100, current: null, problems: [], workers: new Map(), now }
    expect(renderSnapshot({ ...input, tabId: 'tab-1' })).toContain('None. task_start the task before you work on it.')
    expect(renderSnapshot({ ...input, tabId: null })).toContain('outside an AIDE terminal tab')
  })

  it('finds stale active tasks: bound to no tab with no run going, or unchanged for 7 days', () => {
    const tasks = [
      task({ id: 'bound', status: 'active', journal: ['2026-11-19 alice: started'] }),
      task({ id: 'free', status: 'active', journal: ['2026-11-19 alice: started'] }),
      task({ id: 'old', status: 'active', journal: ['2026-11-10 alice: started'] })
    ]
    expect(staleActives(tasks, new Set(['bound', 'old']), false, now).map((s) => s.id)).toEqual(['free', 'old'])
    expect(staleActives(tasks, new Set(['bound', 'old']), true, now).map((s) => s.id)).toEqual(['old'])
  })
})
