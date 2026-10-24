import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openCodeHeadless, resolveOpenCodeExecutable } from './openCodeHeadless'
import type { HistoryEntry } from '../../pty/cliTools/types'

// Real OpenCode 2 runs on the model of the user's OpenCode config:
//   AIDE_LIVE_OPENCODE=1 npx vitest run opencode.live
// The sessions it creates are deleted afterwards.
const live = process.env.AIDE_LIVE_OPENCODE === '1'
// Real agent turns take tens of seconds; the default 20 s test timeout is too short.
if (live) vi.setConfig({ testTimeout: 300_000 })

describe.skipIf(!live)('opencode headless (live)', () => {
  // Setup lives in beforeAll: the describe body also runs when the suite is skipped.
  let workdir = ''
  const sessions = new Set<string>()
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'aide-live-opencode-'))
    writeFileSync(join(workdir, 'note.txt'), 'the secret word is pelican\n', 'utf8')
  })
  afterAll(() => {
    const executable = resolveOpenCodeExecutable()
    for (const id of sessions) {
      try { if (executable) execFileSync(executable, ['session', 'delete', id], { cwd: workdir, env: { ...process.env, PWD: workdir }, stdio: 'ignore' }) } catch { /* best effort */ }
    }
    rmSync(workdir, { recursive: true, force: true })
  })
  const schema = { type: 'object', additionalProperties: false, required: ['status', 'word'], properties: { status: { type: 'string', enum: ['done', 'blocked'] }, word: { type: 'string' } } }
  const base = { get cwd(): string { return workdir }, env: process.env, timeoutMs: 300_000, label: 'live', onSessionId: (id: string) => sessions.add(id) }
  let sessionId: string | null = null

  it('read-only run with structured output', async () => {
    const entries: HistoryEntry[] = []
    const result = await openCodeHeadless.run({
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
    expect(result.costUsd).not.toBeNull()
    expect(entries.some((e) => e.blocks.some((b) => b.type === 'tool_use' && b.view?.kind === 'read'))).toBe(true)
    sessionId = result.sessionId
  })

  it('resumes the same session with its context', async () => {
    expect(sessionId).toBeTruthy()
    const result = await openCodeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Without reading any file again: what was the secret word?',
      permissions: 'read-only',
      outputSchema: schema,
      resumeSessionId: sessionId ?? undefined
    }).result
    expect(result.error).toBeNull()
    expect(result.structured).toMatchObject({ word: 'pelican' })
  })

  it('read-only agent blocks writes, write profile allows them', async () => {
    await openCodeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named blocked.txt containing "x", with a file tool or the shell. If you cannot, just say so.',
      permissions: 'read-only'
    }).result
    expect(existsSync(join(workdir, 'blocked.txt'))).toBe(false)

    const allowed = await openCodeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named created.txt containing exactly the text: ok',
      permissions: 'write'
    }).result
    expect(allowed.error).toBeNull()
    expect(readFileSync(join(workdir, 'created.txt'), 'utf8').trim()).toBe('ok')
  })
})
