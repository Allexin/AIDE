import { describe, expect, it, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { contentType, pageCsp, parseRange, resolvePreviewPath } from './previewFiles'

const base = mkdtempSync(join(tmpdir(), 'aide-preview-'))
const project = join(base, 'Project')
const outside = join(base, 'outside')
mkdirSync(join(project, 'site', 'sub dir'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(project, 'site', 'index.html'), '<p>hi</p>')
writeFileSync(join(project, 'site', 'sub dir', 'a b.css'), 'p{}')
writeFileSync(join(outside, 'secret.txt'), 'secret')
let linked = false
try {
  symlinkSync(outside, join(project, 'escape'), 'junction')
  linked = true
} catch { /* no rights for links: that case is skipped */ }

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('resolvePreviewPath', () => {
  it('serves files of the project', () => {
    const r = resolvePreviewPath(project, '/site/index.html')
    expect(r.ok && r.relPath).toBe('site/index.html')
  })

  it('decodes escaped segments', () => {
    const r = resolvePreviewPath(project, '/site/sub%20dir/a%20b.css')
    expect(r.ok && r.relPath).toBe('site/sub dir/a b.css')
  })

  it('refuses paths out of the project', () => {
    expect(resolvePreviewPath(project, '/../outside/secret.txt')).toMatchObject({ ok: false, status: 403 })
    expect(resolvePreviewPath(project, '/%2e%2e/outside/secret.txt')).toMatchObject({ ok: false, status: 403 })
    expect(resolvePreviewPath(project, '/..%5Coutside%5Csecret.txt')).toMatchObject({ ok: false, status: 403 })
    expect(resolvePreviewPath(project, '/' + join(outside, 'secret.txt').replace(/\\/g, '/'))).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses UNC paths', () => {
    expect(resolvePreviewPath(project, '//server/share/x.txt').ok).toBe(false)
    expect(resolvePreviewPath(project, '/%5C%5Cserver%5Cshare%5Cx.txt').ok).toBe(false)
  })

  it.skipIf(!linked)('refuses links that point out of the project', () => {
    expect(resolvePreviewPath(project, '/escape/secret.txt')).toMatchObject({ ok: false, status: 403 })
  })

  it('accepts a different case on Windows', () => {
    if (process.platform !== 'win32') return
    const r = resolvePreviewPath(project.toUpperCase(), '/SITE/INDEX.HTML')
    expect(r.ok).toBe(true)
  })

  it('reports missing files, directories, bad escapes and NUL as not found', () => {
    expect(resolvePreviewPath(project, '/site/none.html')).toMatchObject({ ok: false, status: 404 })
    expect(resolvePreviewPath(project, '/site')).toMatchObject({ ok: false, status: 404 })
    expect(resolvePreviewPath(project, '/')).toMatchObject({ ok: false, status: 404 })
    expect(resolvePreviewPath(project, '/%E0%A4%A')).toMatchObject({ ok: false, status: 404 })
    expect(resolvePreviewPath(project, '/site/index.html%00.png')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('parseRange', () => {
  it('reads spans, open ends and suffixes', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('tells unsatisfiable from absent', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('bad')
    expect(parseRange('bytes=5-2', 1000)).toBe('bad')
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })
})

describe('content types and CSP', () => {
  it('knows the media of pages', () => {
    expect(contentType('a/B.MP3')).toBe('audio/mpeg')
    expect(contentType('x.html')).toMatch(/^text\/html/)
    expect(contentType('x.unknown')).toBe('application/octet-stream')
  })

  it('allows https only with the network on', () => {
    expect(pageCsp(false)).not.toContain('https:')
    expect(pageCsp(true)).toContain('https:')
    expect(pageCsp(false)).toContain('aide-preview:')
  })
})
