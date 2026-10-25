import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { cursorHeadless } from './cursorHeadless'
import type { HistoryEntry } from '../../pty/cliTools/types'

// Real Cursor Agent runs on the user's default model:
//   AIDE_LIVE_CURSOR=1 [AIDE_LIVE_PROXY=http://host:port] npx vitest run cursor.live
// Chats live in a temporary state directory that is removed afterwards.
const live = process.env.AIDE_LIVE_CURSOR === '1'
// Real agent turns take tens of seconds; the default 20 s test timeout is too short.
if (live) vi.setConfig({ testTimeout: 300_000 })

const proxy = process.env.AIDE_LIVE_PROXY
const env = proxy ? { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } : process.env

describe.skipIf(!live)('cursor headless (live)', () => {
  // Setup lives in beforeAll: the describe body also runs when the suite is skipped.
  let workdir = ''
  let stateDir = ''
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'aide-live-cursor-'))
    stateDir = mkdtempSync(join(tmpdir(), 'aide-live-cursor-state-'))
    writeFileSync(join(workdir, 'note.txt'), 'the secret word is pelican\n', 'utf8')
  })
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) // Windows may hold the directory briefly after the CLI exits
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  })
  const schema = { type: 'object', additionalProperties: false, required: ['status', 'word'], properties: { status: { type: 'string', enum: ['done', 'blocked'] }, word: { type: 'string' } } }
  const base = { get cwd(): string { return workdir }, get stateDir(): string { return stateDir }, env, timeoutMs: 300_000, label: 'live' }
  let sessionId: string | null = null

  it('read-only run with structured output', async () => {
    const entries: HistoryEntry[] = []
    const result = await cursorHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Read note.txt and report the secret word.',
      systemAppend: 'You are a careful reader. Never modify files.',
      permissions: 'read-only',
      outputSchema: schema,
      onEntry: (entry) => entries.push(entry)
    }).result
    expect(result.error).toBeNull()
    expect(result.structured).toMatchObject({ status: 'done', word: 'pelican' })
    expect(result.sessionId).toBeTruthy()
    expect(entries.some((e) => e.blocks.some((b) => b.type === 'tool_use' && b.view?.kind === 'read'))).toBe(true)
    sessionId = result.sessionId
  })

  it('resumes the session with the other permission profile', async () => {
    expect(sessionId).toBeTruthy()
    const result = await cursorHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Without reading any file again: what was the secret word?',
      permissions: 'write',
      outputSchema: schema,
      resumeSessionId: sessionId ?? undefined
    }).result
    expect(result.error).toBeNull()
    expect(result.structured).toMatchObject({ word: 'pelican' })
  })

  it('read-only profile blocks writes, write profile allows them', async () => {
    await cursorHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named blocked.txt containing "x", with a file tool or the shell. If you cannot, just say so.',
      permissions: 'read-only'
    }).result
    expect(existsSync(join(workdir, 'blocked.txt'))).toBe(false)

    const allowed = await cursorHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named created.txt containing exactly the text: ok',
      permissions: 'write'
    }).result
    expect(allowed.error).toBeNull()
    expect(readFileSync(join(workdir, 'created.txt'), 'utf8').trim()).toBe('ok')
  })
})
