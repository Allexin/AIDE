import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { claudeHeadless } from './claudeHeadless'
import { getSessionsDir } from '../../pty/cliTools/claudeCodeScanner'
import type { HistoryEntry } from '../../pty/cliTools/types'

// Spends a few cents on real Claude Code runs. Opt in: AIDE_LIVE_CLAUDE=1 npx vitest run claude.live
const live = process.env.AIDE_LIVE_CLAUDE === '1'
// Real agent turns take tens of seconds; the default 20 s test timeout is too short.
if (live) vi.setConfig({ testTimeout: 300_000 })

describe.skipIf(!live)('claude headless (live)', () => {
  // Setup lives in beforeAll: the describe body also runs when the suite is skipped.
  let workdir = ''
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'aide-live-claude-'))
    writeFileSync(join(workdir, 'note.txt'), 'the secret word is pelican\n', 'utf8')
  })
  const schema = { type: 'object', additionalProperties: false, required: ['status', 'word'], properties: { status: { type: 'string', enum: ['done', 'blocked'] }, word: { type: 'string' } } }
  const base = { get cwd(): string { return workdir }, env: process.env, model: 'haiku', maxBudgetUsd: 0.5, timeoutMs: 180_000, label: 'live' }
  let sessionId: string | null = null

  // Claude Code stores the test sessions under ~/.claude/projects/<encoded workdir>.
  afterAll(() => {
    rmSync(getSessionsDir(workdir), { recursive: true, force: true })
    rmSync(workdir, { recursive: true, force: true })
  })

  it('read-only run with structured output', async () => {
    const entries: HistoryEntry[] = []
    const result = await claudeHeadless.run({
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
    expect(entries.some((e) => e.blocks.some((b) => b.type === 'tool_use' && b.view?.kind === 'read'))).toBe(true)
    sessionId = result.sessionId
  })

  it('resumes the same session with its context', async () => {
    expect(sessionId).toBeTruthy()
    const result = await claudeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
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
    const blocked = await claudeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named blocked.txt containing "x". If you cannot, just say so.',
      permissions: 'read-only'
    }).result
    expect(blocked.error).toBeNull()
    expect(existsSync(join(workdir, 'blocked.txt'))).toBe(false)

    const allowed = await claudeHeadless.run({
      ...base,
      runDir: mkdtempSync(join(tmpdir(), 'aide-live-run-')),
      prompt: 'Create a file named created.txt containing exactly the text: ok',
      permissions: 'write'
    }).result
    expect(allowed.error).toBeNull()
    expect(readFileSync(join(workdir, 'created.txt'), 'utf8').trim()).toBe('ok')
  })
})
