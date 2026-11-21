import DOMPurify from 'dompurify'

/**
 * Mermaid diagrams of the file viewer (docs/file-viewer-spec.md, "Images and Mermaid in
 * Markdown"). Mermaid is loaded on the first diagram, so it is its own chunk and costs
 * nothing until a document has one. Renders run one at a time (Mermaid keeps global state
 * while rendering) and are cached by source, so re-renders on live edits are instant.
 */

type MermaidApi = (typeof import('mermaid'))['default']

export type MermaidResult = { svg: string } | { error: string }

let loading: Promise<MermaidApi> | null = null
let queue: Promise<unknown> = Promise.resolve()
let seq = 0
const cache = new Map<string, MermaidResult>()
const CACHE_LIMIT = 200

function load(): Promise<MermaidApi> {
  if (!loading) {
    loading = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })
      return mermaid
    })
  }
  return loading
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown })?.message ?? err)
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ')
}

async function renderNow(source: string): Promise<MermaidResult> {
  const mermaid = await load()
  const id = `vd-mermaid-${++seq}`
  try {
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source)
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject']
    }) as string
    return { svg: clean }
  } catch (err) {
    return { error: message(err) }
  } finally {
    // A failed render leaves its scratch element in the body.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** The SVG of a diagram, or why it does not parse. */
export function renderMermaid(source: string): Promise<MermaidResult> {
  const hit = cache.get(source)
  if (hit) return Promise.resolve(hit)
  const run = queue.then(() => renderNow(source))
  queue = run.catch(() => undefined)
  return run.then((result) => {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(source, result)
    return result
  })
}
