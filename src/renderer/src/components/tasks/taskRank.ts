/**
 * Fractional ranks for the Tasks tab (docs/task-tracker-implementation.md §8): a task
 * dragged to a new place in Planned or Backlog gets a rank between its new neighbours,
 * so one write orders it. Unranked tasks sort after the ranked ones; a task dropped
 * among them ranks those above it too, so the order shown is the order written.
 */

export interface Ranked {
  id: string
  rank: number | null
}

export interface RankWrite {
  id: string
  rank: number
}

/**
 * The rank writes that move `id` to index `to` of the list as it will be shown (the list
 * is in shown order: by rank, unranked last). Empty when nothing moves.
 */
export function rankMoves(list: Ranked[], id: string, to: number): RankWrite[] {
  const from = list.findIndex((item) => item.id === id)
  if (from < 0) return []
  const others = list.filter((item) => item.id !== id)
  const at = Math.max(0, Math.min(to, others.length))
  if (at === from) return []
  const moved = list[from]
  const order = [...others.slice(0, at), moved, ...others.slice(at)]

  const writes: RankWrite[] = []
  // Unranked tasks above the drop place get ranks after the last ranked one, in their order.
  let last: number | null = null
  for (let i = 0; i < at; i++) {
    const item = others[i]
    if (item.rank === null) {
      const rank: number = last === null ? 1 : Math.floor(last) + 1
      writes.push({ id: item.id, rank })
      last = rank
    } else {
      last = item.rank
    }
  }
  const next = others[at]?.rank ?? null
  let rank: number
  if (last === null) rank = next === null ? 1 : next - 1
  else if (next === null) rank = Math.floor(last) + 1
  else rank = (last + next) / 2
  if ((last !== null && rank <= last) || (next !== null && rank >= next)) return renumber(order)
  writes.push({ id: moved.id, rank })
  return writes
}

/** Ranks 1, 2, 3… for the whole order: the fallback when two neighbours leave no room between them. */
function renumber(order: Ranked[]): RankWrite[] {
  return order.flatMap((item, index) => item.rank === index + 1 ? [] : [{ id: item.id, rank: index + 1 }])
}

/** The rank of a task added at the end of the list: after the last one, or none when the list ends unranked. */
export function rankAtEnd(list: Ranked[]): number | null {
  if (!list.length) return null
  const last = list[list.length - 1].rank
  return last === null ? null : Math.floor(last) + 1
}
