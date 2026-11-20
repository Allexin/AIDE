import type { ToolContext, ToolDefinition } from './protocol'
import type { RangeBound, ViewRange } from '../../../shared/viewer/range'
import { parseAgentMarks, type Mark } from '../../../shared/viewer/marks'

/** `view_show`: the agent shows the user a file in the viewer window (docs/file-viewer-spec.md). */

export interface ViewToolEnvironment {
  show?: (projectPath: string, tabId: string | null, args: {
    path: string
    base?: 'shown' | 'head' | 'none'
    range?: ViewRange | null
    anchor?: string | number | null
    marks?: true | Mark[]
  }) => Promise<string>
}

const BOUND = {
  oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }]
}

function bound(value: unknown, name: string): RangeBound | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  if (typeof value === 'string' && value.trim()) return value
  throw new Error(`"range.${name}" must be a line number (from 1) or the text of a line.`)
}

export function parseShowArgs(args: Record<string, unknown>): Parameters<NonNullable<ViewToolEnvironment['show']>>[2] {
  if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('"path" is required.')
  const base = args.base
  if (base !== undefined && base !== 'shown' && base !== 'head' && base !== 'none') throw new Error('"base" is one of shown, head, none.')
  let range: ViewRange | null = null
  if (args.range !== undefined && args.range !== null) {
    if (typeof args.range !== 'object' || Array.isArray(args.range)) throw new Error('"range" is an object { from, to }.')
    const r = args.range as Record<string, unknown>
    range = { from: bound(r.from, 'from'), to: bound(r.to, 'to') }
  }
  const anchor = args.anchor
  if (anchor !== undefined && anchor !== null && typeof anchor !== 'string' && typeof anchor !== 'number') throw new Error('"anchor" is a heading text or a line number.')
  let marks: true | Mark[] | undefined
  // Clients with a stale tool schema send JSON values as strings ("true", "[...]").
  let rawMarks = args.marks
  if (typeof rawMarks === 'string') {
    try { rawMarks = JSON.parse(rawMarks) } catch { /* reported below */ }
  }
  if (rawMarks === true) marks = true
  else if (rawMarks !== undefined && rawMarks !== null && rawMarks !== false) marks = parseAgentMarks(rawMarks)
  return { path: args.path, base, range, anchor: (anchor as string | number | undefined) ?? null, ...(marks !== undefined ? { marks } : {}) }
}

export function buildViewTools(env: () => ViewToolEnvironment): ToolDefinition[] {
  return [
    {
      name: 'view_show',
      description:
        'Show the user a project file (Markdown rendered, images, text) in AIDE\'s viewer window, with the changes since you last showed it marked. ' +
        'Call it when the user should read or review something you wrote, once you have finished a set of edits — not after each edit: each call is the base of the next diff. ' +
        'range shows only a part of a large file, for example one chapter: from is a line number or the text of the first line shown (a heading, a marker comment); ' +
        'to is the last line number, or the text of the line where the part ends (that line is not shown). Text bounds follow your edits. ' +
        'The user comments on fragments in the viewer; the comments arrive in this session as one message, with file line numbers. ' +
        'Images: marks: true asks the user to mark the image up (text, arrow, line, rectangle, ellipse); marks: [...] also draws your own marks. ' +
        'Marks come back with coordinates in image pixels (viewBox units for SVG), the notes of the user, the marks as JSON you can pass back, and for raster images a PNG with the marks drawn. ' +
        'A new show drops all marks. Returns at once.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path (or absolute, inside the project).' },
          base: { type: 'string', enum: ['shown', 'head', 'none'], description: 'What the changes are against: shown (default) — the previous view_show of this file; head — the last commit; none — no marks.' },
          range: {
            type: 'object',
            properties: { from: BOUND, to: BOUND },
            additionalProperties: false,
            description: 'Only this part of the file.'
          },
          anchor: { ...BOUND, description: 'A heading text or a line number to scroll to; default: the first change.' },
          marks: {
            description: 'Images only. true: the user may mark the image up and send the marks back. A list: your marks, drawn first; the user can move or delete them. ' +
              'Mark: {type:"text",x,y,text} | {type:"arrow"|"line",x1,y1,x2,y2,note?} | {type:"rect"|"ellipse",x,y,w,h,note?}, optional id.',
            oneOf: [
              { type: 'boolean' },
              { type: 'array', items: { type: 'object' } }
            ]
          }
        },
        required: ['path'],
        additionalProperties: false
      },
      handler: async (args, context: ToolContext) => {
        const show = env().show
        if (!show) return { text: 'The viewer is not available in this AIDE instance.', isError: true }
        try {
          return { text: await show(context.projectPath, context.tabId, parseShowArgs(args)) }
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true }
        }
      }
    }
  ]
}
