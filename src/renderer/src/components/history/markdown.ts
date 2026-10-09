import { useEffect, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * Markdown and code rendering for transcripts.
 *
 * Rendering is two-stage: a synchronous sanitized HTML pass (shown immediately)
 * and an asynchronous pass that syntax-highlights fenced code with Monaco's
 * colorizer. Both results are cached by content, because virtualized rows
 * unmount and remount constantly while scrolling.
 */

class BoundedCache<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly limit: number) {}
  get(key: string): V | undefined { return this.map.get(key) }
  set(key: string, value: V): void {
    if (this.map.size >= this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }
}

const MAX_HIGHLIGHT_CHARS = 200_000

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const marked = new Marked({ gfm: true, breaks: true, async: false })
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      return `<pre class="md-code" data-lang="${escapeHtml(language)}"><code>${escapeHtml(text)}</code></pre>`
    }
  }
})

const PURIFY_CONFIG = {
  // No remote loads or interactive elements inside a read-only transcript.
  FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
  FORBID_ATTR: ['style']
}

const syncCache = new BoundedCache<string>(3000)
const highlightedCache = new BoundedCache<string>(3000)
const codeCache = new BoundedCache<string>(1000)

export function renderMarkdown(text: string): string {
  const cached = syncCache.get(text)
  if (cached !== undefined) return cached
  let html: string
  try {
    html = DOMPurify.sanitize(marked.parse(text) as string, PURIFY_CONFIG)
  } catch {
    html = `<p>${escapeHtml(text)}</p>`
  }
  syncCache.set(text, html)
  return html
}

// ── Monaco colorizer (lazy) ──────────────────────────────────────────────────

type Monaco = typeof import('monaco-editor')
let monacoPromise: Promise<Monaco> | null = null

function loadMonaco(): Promise<Monaco> {
  monacoPromise ??= (async () => {
    await import('../../monacoSetup')
    const monaco = await import('monaco-editor')
    // Installs the vs-dark token colours the colorizer's `mtk*` classes rely on.
    monaco.editor.setTheme('vs-dark')
    return monaco
  })()
  return monacoPromise
}

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell',
  ps: 'powershell', ps1: 'powershell', psm1: 'powershell', pwsh: 'powershell',
  py: 'python', yml: 'yaml', md: 'markdown', htm: 'html',
  cs: 'csharp', 'c#': 'csharp', c: 'cpp', cc: 'cpp', 'c++': 'cpp', h: 'cpp', hpp: 'cpp',
  rs: 'rust', golang: 'go', kt: 'kotlin', rb: 'ruby', jsonc: 'json', json5: 'json'
}

export function languageForPath(path: string): string {
  const match = /\.([A-Za-z0-9+#]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

async function colorize(code: string, language: string): Promise<string | null> {
  const requested = language.toLowerCase()
  if (!requested || code.length > MAX_HIGHLIGHT_CHARS) return null
  const monaco = await loadMonaco()
  const id = LANGUAGE_ALIASES[requested] ?? requested
  if (!monaco.languages.getLanguages().some((l) => l.id === id)) return null
  try {
    return await monaco.editor.colorize(code, id, { tabSize: 4 })
  } catch {
    return null
  }
}

async function highlightMarkdown(text: string): Promise<void> {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(text)
  for (const pre of Array.from(template.content.querySelectorAll('pre.md-code'))) {
    const code = pre.querySelector('code')
    if (!code) continue
    const html = await colorize(code.textContent ?? '', pre.getAttribute('data-lang') ?? '')
    if (html !== null) code.innerHTML = html
  }
  highlightedCache.set(text, template.innerHTML)
}

/** Sanitized Markdown HTML; re-renders once fenced code has been highlighted. */
export function useMarkdownHtml(text: string): string {
  const sync = renderMarkdown(text)
  const needsHighlight = sync.includes('class="md-code"')
  const highlighted = needsHighlight ? highlightedCache.get(text) : sync
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!needsHighlight || highlighted !== undefined) return
    let alive = true
    void highlightMarkdown(text).then(() => { if (alive) setTick((tick) => tick + 1) })
    return () => { alive = false }
  }, [text, needsHighlight, highlighted])
  return highlighted ?? sync
}

/** Colorized HTML for a code snippet, or null while pending / unsupported. */
export function useHighlightedCode(code: string, language: string): string | null {
  const key = `${language}\u0000${code}`
  const cached = codeCache.get(key)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (cached !== undefined) return
    let alive = true
    void colorize(code, language).then((html) => {
      codeCache.set(key, html ?? '')
      if (alive && html) setTick((tick) => tick + 1)
    })
    return () => { alive = false }
  }, [key, cached, code, language])
  return cached ? cached : null
}
