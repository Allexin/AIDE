import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { claudeHeadless } from '../headless/claudeHeadless'
import { codexHeadless } from '../headless/codexHeadless'
import { validateAgainstSchema } from '../engine/schema'
import { decisionSchema } from './planService'

// Real CLIs take the Orchestrator's answer schema, with its nullable params.
// Spends a few cents. Opt in: AIDE_LIVE_CLAUDE=1 and/or AIDE_LIVE_CODEX=1 npx vitest run orchestratorSchema.live
const claude = process.env.AIDE_LIVE_CLAUDE === '1'
const codex = process.env.AIDE_LIVE_CODEX === '1'
if (claude || codex) vi.setConfig({ testTimeout: 300_000 })

const schema = decisionSchema({ taskSpec: { type: 'string', description: 'What to do' }, scope: { type: 'string[]', required: false }, retries: { type: 'number', required: false } })
const SYSTEM = 'You are the Orchestrator of a plan. Decide whether the plan goes on. Answer "next" with params, or "wake" with every param null.'

describe.skipIf(!claude && !codex)('the Orchestrator\'s schema (live)', () => {
  const dirs: string[] = []
  const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'aide-live-plan-')); dirs.push(dir); return dir }
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

  const check = (structured: unknown, verdict: string): void => {
    expect(validateAgainstSchema(structured, schema)).toEqual([])
    expect(structured).toMatchObject({ verdict })
  }

  it.runIf(claude)('Claude Code answers next and wake', async () => {
    const cwd = temp()
    writeFileSync(join(cwd, 'note.txt'), 'x\n')
    const base = { cwd, env: process.env, model: 'haiku', maxBudgetUsd: 0.5, timeoutMs: 180_000, label: 'live', permissions: 'read-only' as const, systemAppend: SYSTEM, outputSchema: schema }
    const next = await claudeHeadless.run({ ...base, runDir: temp(), prompt: 'The step went well. Start the next task; taskSpec is "docs/x.md". Leave scope and retries null.' }).result
    expect(next.error).toBeNull()
    check(next.structured, 'next')
    expect((next.structured as { params: unknown }).params).toMatchObject({ taskSpec: 'docs/x.md', scope: null, retries: null })
    const wake = await claudeHeadless.run({ ...base, runDir: temp(), prompt: 'The step broke something a later task relies on. Wake the Strategist.' }).result
    expect(wake.error).toBeNull()
    check(wake.structured, 'wake')
  })

  it.runIf(codex)('Codex answers next and wake', async () => {
    const cwd = temp()
    const base = { cwd, env: process.env, timeoutMs: 180_000, label: 'live', permissions: 'read-only' as const, systemAppend: SYSTEM, outputSchema: schema }
    const next = await codexHeadless.run({ ...base, runDir: temp(), prompt: 'The step went well. Start the next task; taskSpec is "docs/x.md". Leave scope and retries null.' }).result
    expect(next.error).toBeNull()
    check(next.structured, 'next')
    const wake = await codexHeadless.run({ ...base, runDir: temp(), prompt: 'The step broke something a later task relies on. Wake the Strategist.' }).result
    expect(wake.error).toBeNull()
    check(wake.structured, 'wake')
  })
})
