/** Marks on images (docs/file-viewer-spec.md, "Marks on images"). Pure; used by main and the viewer. */

export type MarkAuthor = 'agent' | 'user'

export type Mark =
  | { id: string; by: MarkAuthor; type: 'text'; x: number; y: number; text: string; moved?: boolean }
  | { id: string; by: MarkAuthor; type: 'arrow' | 'line'; x1: number; y1: number; x2: number; y2: number; note?: string; moved?: boolean }
  | { id: string; by: MarkAuthor; type: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; note?: string; moved?: boolean }

export type MarkType = Mark['type']
export const MARK_TYPES: MarkType[] = ['text', 'arrow', 'line', 'rect', 'ellipse']

function num(v: unknown, name: string, i: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`marks[${i}].${name} must be a number.`)
  return Math.round(v * 100) / 100
}

function optText(v: unknown, name: string, i: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`marks[${i}].${name} must be a string.`)
  return v
}

/** Marks the agent passes to view_show: validated, authored by the agent, ids `a1…` where missing. */
export function parseAgentMarks(input: unknown): Mark[] {
  if (!Array.isArray(input)) throw new Error('"marks" is true or a list of marks.')
  const used = new Set<string>()
  const out: Mark[] = input.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`marks[${i}] must be an object.`)
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : ''
    if (id) {
      if (used.has(id)) throw new Error(`marks[${i}].id "${id}" is used twice.`)
      used.add(id)
    }
    switch (m.type) {
      case 'text': {
        const text = optText(m.text, 'text', i)
        if (!text) throw new Error(`marks[${i}].text is required for a text mark.`)
        return { id, by: 'agent', type: 'text', x: num(m.x, 'x', i), y: num(m.y, 'y', i), text }
      }
      case 'arrow':
      case 'line':
        return { id, by: 'agent', type: m.type, x1: num(m.x1, 'x1', i), y1: num(m.y1, 'y1', i), x2: num(m.x2, 'x2', i), y2: num(m.y2, 'y2', i), note: optText(m.note, 'note', i) }
      case 'rect':
      case 'ellipse':
        return { id, by: 'agent', type: m.type, x: num(m.x, 'x', i), y: num(m.y, 'y', i), w: num(m.w, 'w', i), h: num(m.h, 'h', i), note: optText(m.note, 'note', i) }
      default:
        throw new Error(`marks[${i}].type is one of ${MARK_TYPES.join(', ')}.`)
    }
  })
  let n = 1
  for (const m of out) {
    if (m.id) continue
    while (used.has(`a${n}`)) n++
    m.id = `a${n}`
    used.add(m.id)
  }
  return out
}

/** The next free id for a new user mark. */
export function nextUserId(marks: Mark[]): string {
  let n = 1
  while (marks.some((m) => m.id === `u${n}`)) n++
  return `u${n}`
}

export function moveMark(m: Mark, dx: number, dy: number): Mark {
  const r = (v: number): number => Math.round(v * 100) / 100
  switch (m.type) {
    case 'arrow':
    case 'line':
      return { ...m, x1: r(m.x1 + dx), y1: r(m.y1 + dy), x2: r(m.x2 + dx), y2: r(m.y2 + dy), moved: true }
    default:
      return { ...m, x: r(m.x + dx), y: r(m.y + dy), moved: true }
  }
}

const fmt = (v: number): string => String(Math.round(v))

function geometry(m: Mark): string {
  switch (m.type) {
    case 'text': return `at (${fmt(m.x)},${fmt(m.y)})`
    case 'arrow':
    case 'line': return `(${fmt(m.x1)},${fmt(m.y1)})→(${fmt(m.x2)},${fmt(m.y2)})`
    default: return `(${fmt(m.x)},${fmt(m.y)} ${fmt(m.w)}×${fmt(m.h)})`
  }
}

export interface MarksReport {
  path: string
  shownAt: number
  /** 'viewBox units' for SVG, 'image pixels' for raster images. */
  units: string
  marks: Mark[]
  /** Ids of the agent's marks the user deleted. */
  removedAgent: string[]
  /** The image with the marks drawn on it, when one was written. */
  snapshotPath?: string | null
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The marks section of the message Send writes. */
export function formatMarks(r: MarksReport): string {
  const lines = [`Marks on ${r.path} (shown ${clock(r.shownAt)}), coordinates in ${r.units}:`]
  r.marks.forEach((m, i) => {
    const who = m.by === 'agent' ? ` (agent's${m.moved ? ', moved' : ''})` : ''
    const note = m.type === 'text' ? `: "${m.text}"` : m.note ? `: "${m.note}"` : ''
    lines.push(`${i + 1}. ${m.type} ${m.id}${who} ${geometry(m)}${note}`)
  })
  if (r.marks.length === 0) lines.push('No marks left.')
  if (r.removedAgent.length) lines.push(`Removed agent marks: ${r.removedAgent.join(', ')}.`)
  const json = r.marks.map((m) => {
    const { moved: _moved, ...rest } = m
    return rest
  })
  lines.push(`Marks JSON: ${JSON.stringify(json)}`)
  if (r.snapshotPath) lines.push(`Image with the marks: ${r.snapshotPath}`)
  return lines.join('\n')
}
