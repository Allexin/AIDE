import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { removeLegacyProjectDocs } from './legacyDocs'

describe('removeLegacyProjectDocs', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('removes the old doc copies and leaves other files in .aide/docs', () => {
    dir = mkdtempSync(join(tmpdir(), 'aide-legacy-docs-'))
    const docs = join(dir, '.aide', 'docs')
    mkdirSync(docs, { recursive: true })
    for (const name of ['toolbar.md', 'orchestration-mcp.md', 'notes.md']) writeFileSync(join(docs, name), 'x')

    removeLegacyProjectDocs(dir)

    expect(existsSync(join(docs, 'toolbar.md'))).toBe(false)
    expect(existsSync(join(docs, 'orchestration-mcp.md'))).toBe(false)
    expect(existsSync(join(docs, 'notes.md'))).toBe(true)
  })

  it('does nothing when the project has no copies', () => {
    dir = mkdtempSync(join(tmpdir(), 'aide-legacy-docs-'))
    expect(() => removeLegacyProjectDocs(dir)).not.toThrow()
  })
})
