import { describe, expect, it } from 'vitest'
import { rankAtEnd, rankMoves, type Ranked } from './taskRank'

const list = (...ranks: (number | null)[]): Ranked[] => ranks.map((rank, i) => ({ id: `t${i}`, rank }))

/** The order after applying the writes, as the board sorts it: by rank, unranked last in their old order. */
function apply(items: Ranked[], writes: { id: string; rank: number }[]): string[] {
  const ranks = new Map(writes.map((w) => [w.id, w.rank]))
  const next = items.map((item, index) => ({ id: item.id, rank: ranks.get(item.id) ?? item.rank, index }))
  next.sort((a, b) => a.rank === b.rank ? a.index - b.index : a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank)
  return next.map((item) => item.id)
}

describe('rankMoves', () => {
  it('writes one fractional rank between the new neighbours', () => {
    const items = list(1, 2, 3)
    expect(rankMoves(items, 't2', 1)).toEqual([{ id: 't2', rank: 1.5 }])
    expect(rankMoves(items, 't0', 2)).toEqual([{ id: 't0', rank: 4 }])
    expect(rankMoves(items, 't2', 0)).toEqual([{ id: 't2', rank: 0 }])
    expect(apply(items, rankMoves(items, 't0', 1))).toEqual(['t1', 't0', 't2'])
  })

  it('writes nothing when the task stays where it is', () => {
    expect(rankMoves(list(1, 2), 't1', 1)).toEqual([])
    expect(rankMoves(list(1, 2), 'missing', 0)).toEqual([])
  })

  it('ranks the unranked tasks above the drop place too', () => {
    const items = list(1, null, null, null)
    const writes = rankMoves(items, 't0', 2)
    expect(writes).toEqual([{ id: 't1', rank: 1 }, { id: 't2', rank: 2 }, { id: 't0', rank: 3 }])
    expect(apply(items, writes)).toEqual(['t1', 't2', 't0', 't3'])
    expect(apply(items, rankMoves(items, 't3', 0))).toEqual(['t3', 't0', 't1', 't2'])
  })

  it('renumbers when two neighbours have the same rank', () => {
    const items = list(1, 1, 2)
    const writes = rankMoves(items, 't2', 1)
    expect(apply(items, writes)).toEqual(['t0', 't2', 't1'])
  })
})

describe('rankAtEnd', () => {
  it('ranks after the last ranked task, or not at all after unranked ones', () => {
    expect(rankAtEnd([])).toBeNull()
    expect(rankAtEnd(list(1, 2.5))).toBe(3)
    expect(rankAtEnd(list(1, null))).toBeNull()
  })
})
