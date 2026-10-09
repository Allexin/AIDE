export interface DiffLine { op: ' ' | '-' | '+'; text: string }

const CONTEXT = 2
const MAX_LCS_CELLS = 250_000

/**
 * Line diff for rendering an edit's old/new text. Uses an LCS table when the
 * inputs are small enough, otherwise falls back to trimming the common prefix
 * and suffix. Unchanged lines are kept only as short context around changes.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const middle: DiffLine[] = midA.length * midB.length <= MAX_LCS_CELLS
    ? lcsDiff(midA, midB)
    : [...midA.map((text) => ({ op: '-' as const, text })), ...midB.map((text) => ({ op: '+' as const, text }))]

  const lines: DiffLine[] = [
    ...a.slice(Math.max(0, prefix - CONTEXT), prefix).map((text) => ({ op: ' ' as const, text })),
    ...middle,
    ...a.slice(a.length - suffix, a.length - suffix + CONTEXT).map((text) => ({ op: ' ' as const, text }))
  ]
  return lines
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  // lengths[i][j] = LCS length of a[i..] and b[j..], flattened.
  const lengths = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number): number => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[at(i, j)] = a[i] === b[j] ? lengths[at(i + 1, j + 1)] + 1 : Math.max(lengths[at(i + 1, j)], lengths[at(i, j + 1)])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++ }
    else if (lengths[at(i + 1, j)] >= lengths[at(i, j + 1)]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}
