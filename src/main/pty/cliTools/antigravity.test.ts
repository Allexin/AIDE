import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  extractUserRequestText,
  getAntigravityTranscriptPath,
  parseAntigravityThinkingBlocks,
  parseAntigravityTranscriptStep,
  readAntigravityFirstMessage,
  readAntigravitySessionHistory,
  readAntigravitySessionPreview,
  workspaceUrisMatchProject
} from './antigravityScanner'
import { antigravityTool, formatAntigravityTitle } from './antigravity'
import {
  formatAntigravityUsage,
  hasElapsedReset,
  parseHookQuotaPayload,
  parseUsageCommandJson
} from './antigravityUsage'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aide-agy-scan-'))
  dirs.push(dir)
  return dir
}

describe('antigravityScanner', () => {
  it('matches workspace URIs against project paths', () => {
    expect(workspaceUrisMatchProject('["file:///E:/Projects/AIDE/AIDE"]', 'E:\\Projects\\AIDE\\AIDE')).toBe(true)
    expect(workspaceUrisMatchProject('["file:///E:/Projects/AIDE/AIDE/"]', 'e:/projects/aide/aide')).toBe(true)
    expect(workspaceUrisMatchProject('["file:///E:/Projects/Other"]', 'E:\\Projects\\AIDE\\AIDE')).toBe(false)
    expect(workspaceUrisMatchProject('not json', 'E:\\Projects\\AIDE\\AIDE')).toBe(false)
  })

  it('unwraps USER_REQUEST envelopes', () => {
    const raw = '<USER_REQUEST>\nFix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>'
    expect(extractUserRequestText(raw)).toBe('Fix the bug')
    expect(extractUserRequestText('plain prompt')).toBe('plain prompt')
  })

  it('parses transcript steps, thinking blocks, tool views, preview, and full history', () => {
    const home = tempHome()
    const sid = 'conv-123'
    const transcriptPath = getAntigravityTranscriptPath(sid, false, home)
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nInspect package.json\n</USER_REQUEST>' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        thinking: 'Checking package.json first.',
        tool_calls: [{ name: 'read_file', args: { Path: '"E:\\\\Projects\\\\AIDE\\\\package.json"' } }]
      }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', content: '{"name":"aide"}' }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', thinking: 'Got it.', content: 'The package is aide.' })
    ]
    writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8')

    expect(parseAntigravityThinkingBlocks(lines[1])).toEqual(['Checking package.json first.'])
    expect(parseAntigravityThinkingBlocks(lines[0])).toEqual([])
    expect(readAntigravityFirstMessage(sid, home)).toBe('Inspect package.json')
    expect(readAntigravitySessionPreview(sid, home)).toEqual([
      { role: 'user', text: 'Inspect package.json' },
      { role: 'assistant', text: 'The package is aide.' }
    ])

    const history = readAntigravitySessionHistory(sid, home)
    expect(history).toHaveLength(4)
    expect(history[1].blocks[0]).toEqual({ type: 'thinking', thinking: 'Checking package.json first.' })
    expect(history[1].blocks[1]).toMatchObject({
      type: 'tool_use',
      id: 'step-1-call-0',
      name: 'read_file',
      view: { kind: 'read', path: 'E:\\Projects\\AIDE\\package.json' }
    })
    expect(history[2].blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'step-1-call-0',
      content: '{"name":"aide"}'
    })
    expect(parseAntigravityTranscriptStep('{invalid')).toBeNull()
  })
})

describe('antigravityTool helpers', () => {
  it('parses agy -p /usage JSON, merges hook updates, computes live countdowns, and detects elapsed resets', () => {
    const now = Date.parse('2026-11-22T02:00:00Z')
    const raw = JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.85, reset_time: '2026-11-28T22:00:00Z' },
                { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.48, reset_time: '2026-11-22T03:30:00Z' }
              ]
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-28T22:00:00Z' },
                { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-22T07:00:00Z' }
              ]
            }
          ]
        }
      }
    })

    const snap = parseUsageCommandJson(raw, now)!
    expect(snap.buckets).toHaveLength(4)
    const info = formatAntigravityUsage({ ...snap, planTier: 'Pro' }, now)
    expect(info).toMatchObject({ summary: '52% / 15%', level: 'normal', fetchedAt: now, hasLimit: true })
    expect(info?.tooltip).toContain('Plan: Pro')
    expect(info?.tooltip).toContain('Gemini Models (5h): 52%')
    expect(info?.tooltip).toContain('resets in 1h 30m')
    expect(hasElapsedReset(snap, now)).toBe(false)

    // 91 minutes later, the 5h reset timestamp has elapsed -> cache must invalidate
    expect(hasElapsedReset(snap, Date.parse('2026-11-22T03:31:00Z'))).toBe(true)

    // Hook payload updates matching bucket in place without losing group/window metadata
    const updated = parseHookQuotaPayload(
      { 'gemini-5h': { remaining_fraction: 0.05, reset_time: '2026-11-22T03:30:00Z' } },
      'Pro',
      now + 60_000,
      snap
    )!
    const updatedInfo = formatAntigravityUsage(updated, now + 60_000)
    expect(updatedInfo).toMatchObject({ summary: '95% / 15%', level: 'critical', hasLimit: true })
    expect(updatedInfo?.tooltip).toContain('Gemini Models (5h): 95%')
    expect(updatedInfo?.tooltip).toContain('resets in 1h 29m')
  })

  it('formats window titles and emits completeAndWait on working -> idle hook transitions', async () => {
    expect(formatAntigravityTitle({ conversation_title: 'Task', agent_state: 'idle' })).toBe('✳ Task')
    expect(formatAntigravityTitle({ conversation_title: 'Task', agent_state: 'working' })).toBe('● Task')
    expect(formatAntigravityTitle({ conversation_title: 'Task', tool_confirmation_pending: true })).toBe('? Task')

    const events: string[] = []
    antigravityTool.registerSignalHandler?.('tab-test', (ev) => events.push(ev))
    const firstBinding = {
      tabId: 'tab-test',
      event: 'Title',
      sessionId: 's1',
      transcriptPath: 'C:\\nonexistent\\.gemini\\antigravity\\brain\\s1\\.system_generated\\logs\\transcript.jsonl',
      payload: { agent_state: 'working', conversation_title: 'Build', email: 'dev@example.com', plan_tier: 'Pro' }
    }
    antigravityTool.onHookEvent?.(firstBinding)
    expect(firstBinding.transcriptPath).toBe(getAntigravityTranscriptPath('s1', false))
    expect(events).toEqual([])
    const reply = antigravityTool.onHookEvent?.({
      tabId: 'tab-test', event: 'Title', sessionId: 's1', transcriptPath: null,
      payload: { agent_state: 'idle', conversation_title: 'Build' }
    })
    expect(reply).toBe('✳ Build')
    expect(events).toEqual(['completeAndWait'])
    expect(await antigravityTool.getLoginIdentifier?.()).toBe('dev@example.com')
    antigravityTool.deregisterTab?.('tab-test')
  })

  it('checks startup health without timing heuristics', () => {
    expect(antigravityTool.checkStartupHealth?.('starting...')).toBe('pending')
    expect(antigravityTool.checkStartupHealth?.('Auto mode: edits & safe commands (shift+tab to cycle)')).toBe('ok')
    expect(antigravityTool.checkStartupHealth?.('Failed to start: authentication required')).toBe('dead')
  })

  it('declares why account management is unsupported', () => {
    expect(antigravityTool.hasAccountSystem()).toBe(false)
    expect(antigravityTool.accountUnsupportedReason).toMatch(/keyring/i)
  })
})
