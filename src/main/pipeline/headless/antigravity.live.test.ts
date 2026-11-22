import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { antigravityHeadless } from './antigravityHeadless'
import type { HistoryEntry } from '../../pty/cliTools/types'

// Opt-in live test against installed `agy`. Run with:
//   AIDE_LIVE_ANTIGRAVITY=1 npx vitest run antigravity.live
const live = process.env.AIDE_LIVE_ANTIGRAVITY === '1'
if (live) vi.setConfig({ testTimeout: 300_000 })

describe.skipIf(!live)('antigravity headless (live)', () => {
  let workdir = ''
  const runDirs: string[] = []
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'aide-live-agy-'))
    writeFileSync(join(workdir, 'note.txt'), 'the secret word is pelican\n', 'utf8')
  })
  afterAll(() => {
    for (const dir of runDirs) rmSync(dir, { recursive: true, force: true })
    if (workdir) rmSync(workdir, { recursive: true, force: true })
  })

  const makeRunDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'aide-live-agy-run-'))
    runDirs.push(dir)
    return dir
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'word'],
    properties: {
      status: { type: 'string', enum: ['done', 'blocked'] },
      word: { type: 'string' }
    }
  }
  const proxy = process.env.AIDE_LIVE_PROXY
  const env = proxy ? { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } : process.env
  const base = { get cwd(): string { return workdir }, env, effort: 'low', timeoutMs: 180_000, label: 'live' }
  let sessionId: string | null = null

  it('read-only run with structured output', async () => {
    const entries: HistoryEntry[] = []
    const result = await antigravityHeadless.run({
      ...base,
      runDir: makeRunDir(),
      prompt: 'Read note.txt and report the secret word.',
      systemAppend: 'You are a careful reader. Never modify files.',
      permissions: 'read-only',
      outputSchema: schema,
      onEntry: (entry) => entries.push(entry)
    }).result
    expect(result.error).toBeNull()
    expect(result.structured).toMatchObject({ status: 'done', word: 'pelican' })
    expect(entries.some((e) => e.blocks.some((b) => b.type === 'tool_use' && b.view?.kind === 'read'))).toBe(true)
    sessionId = result.sessionId
  })

  it('resumes the same conversation with its context', async () => {
    expect(sessionId).toBeTruthy()
    const result = await antigravityHeadless.run({
      ...base,
      runDir: makeRunDir(),
      prompt: 'Without reading any file again: what was the secret word?',
      permissions: 'read-only',
      outputSchema: schema,
      resumeSessionId: sessionId ?? undefined
    }).result
    expect(result.error).toBeNull()
    expect(result.sessionId).toBe(sessionId)
    expect(result.structured).toMatchObject({ word: 'pelican' })
  })

  it('read-only profile blocks writes, write profile allows them', async () => {
    const blocked = await antigravityHeadless.run({
      ...base,
      runDir: makeRunDir(),
      prompt: 'Create a file named blocked.txt containing "x". If you cannot, just say so.',
      permissions: 'read-only'
    }).result
    expect(blocked.error).toBeNull()
    expect(existsSync(join(workdir, 'blocked.txt'))).toBe(false)

    const allowed = await antigravityHeadless.run({
      ...base,
      runDir: makeRunDir(),
      prompt: 'Create a file named created.txt containing exactly the text: ok',
      permissions: 'write'
    }).result
    expect(allowed.error).toBeNull()
    expect(readFileSync(join(workdir, 'created.txt'), 'utf8').trim()).toBe('ok')
  })
})
