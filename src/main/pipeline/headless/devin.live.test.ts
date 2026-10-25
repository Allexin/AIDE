import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { devinHeadless } from './devinHeadless'
import { resolveExecutable } from './common'
import type { HistoryEntry } from '../../pty/cliTools/types'

// Real Devin runs on the account's default model:
//   AIDE_LIVE_DEVIN=1 [AIDE_LIVE_PROXY=http://host:port] npx vitest run devin.live
// The sessions it creates are deleted afterwards.
const live = process.env.AIDE_LIVE_DEVIN === '1'
// Real agent turns take tens of seconds; the default 20 s test timeout is too short.
if (live) vi.setConfig({ testTimeout: 300_000 })

const proxy = process.env.AIDE_LIVE_PROXY
const env = proxy ? { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } : process.env

describe.skipIf(!live)('devin headless (live)', () => {
  // Setup lives in beforeAll: the describe body also runs when the suite is skipped.
  let workdir = ''
  const sessions = new Set<string>()
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'aide-live-devin-'))
    writeFileSync(join(workdir, 'note.txt'), 'the secret word is pelican\n', 'utf8')
  })
  afterAll(() => {
    const executable = resolveExecutable('devin')
    for (const id of sessions) {
      try { if (executable) execFileSync(executable, ['rm', '--force', id], { cwd: workdir, env: { ...env, PWD: workdir }, stdio: 'ignore' }) } catch { /* best effort */ }
    }
    rmSync(workdir, { recursive: true, force: true })
  })
  const schema = { type: 'object', additionalProperties: false, required: ['status', 'word'], properties: { status: { type: 'string', enum: ['done', 'blocked'] }, word: { type: 'string' } } }
  const base = { get cwd(): string { return workdir }, env, timeoutMs: 300_000, label: 'live', onSessionId: (id: string) => sessions.add(id) }
  let sessionId: string | null = null

  it('read-only run with structured output', async () => {
    const entries: HistoryEntry[] = []
    const result = await devinHeadless.run({
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
    expect(entries.some((e) => e.role === 'user')).toBe(true)
    expect(entries.some((e) => e.blocks.some((b) => b.type === 'tool_use'))).toBe(true)
    sessionId = result.sessionId
  })

  it('resumes the same session with its context, transcript limited to the new turn', async () => {
    expect(sessionId).toBeTruthy()
    const entries: HistoryEntry[] = []
    const result = await devinHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Without reading any file again: what was the secret word?',
      permissions: 'read-only',
      outputSchema: schema,
      resumeSessionId: sessionId ?? undefined,
      onEntry: (entry) => entries.push(entry)
    }).result
    expect(result.error).toBeNull()
    expect(result.structured).toMatchObject({ word: 'pelican' })
    expect(entries.filter((e) => e.role === 'user')).toHaveLength(1)
  })

  it('read-only mode blocks writes, write mode allows them', async () => {
    await devinHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named blocked.txt containing "x", with a file tool or the shell. If you cannot, just say so.',
      permissions: 'read-only'
    }).result
    expect(existsSync(join(workdir, 'blocked.txt'))).toBe(false)

    const allowed = await devinHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named created.txt containing exactly the text: ok',
      permissions: 'write'
    }).result
    expect(allowed.error).toBeNull()
    expect(readFileSync(join(workdir, 'created.txt'), 'utf8').trim()).toBe('ok')
  })
})
