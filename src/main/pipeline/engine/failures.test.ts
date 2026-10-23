import { describe, expect, it } from 'vitest'
import { checkFailureLines, limitResetTime } from './failures'
import { renderCommand, shellQuote } from './expressions'

describe('checkFailureLines', () => {
  it('picks failing tests, panics and compiler errors, without duplicates or colors', () => {
    const log = [
      'Compiling app v0.1.0',
      '\x1b[31merror[E0308]\x1b[0m: mismatched types',
      'test a::b ... ok',
      'test a::c ... FAILED',
      "thread 'a::c' panicked at src/a.rs:10:5:",
      'test a::c ... FAILED',
      'FAIL src/x.test.ts > adds',
      'all fine here'
    ].join('\n')
    expect(checkFailureLines(log)).toEqual([
      'error[E0308]: mismatched types',
      'test a::c ... FAILED',
      "thread 'a::c' panicked at src/a.rs:10:5:",
      'FAIL src/x.test.ts > adds'
    ])
  })

  it('keeps the head and the summary at the end of a long list', () => {
    const lines = checkFailureLines(Array.from({ length: 100 }, (_, i) => `case ${i} FAILED`).join('\n'))
    expect(lines).toHaveLength(41)
    expect(lines[0]).toBe('case 0 FAILED')
    expect(lines[10]).toBe('… 60 more failure lines …')
    expect(lines.at(-1)).toBe('case 99 FAILED')
  })
})

describe('limitResetTime', () => {
  const now = new Date(2026, 9, 23, 14, 0, 0)

  it('reads a relative time', () => {
    expect(limitResetTime("You've hit your usage limit. Try again in 2 hours 5 minutes.", now)?.getTime()).toBe(now.getTime() + 125 * 60_000)
    expect(limitResetTime('rate limit, try again in 37 min', now)?.getTime()).toBe(now.getTime() + 37 * 60_000)
  })

  it('reads a clock time, today or tomorrow', () => {
    expect(limitResetTime('Usage limit reached. Try again at 3:45 PM.', now)).toEqual(new Date(2026, 9, 23, 15, 45))
    expect(limitResetTime('5-hour limit reached ∙ resets 9am', now)).toEqual(new Date(2026, 9, 24, 9, 0))
    expect(limitResetTime('limit reached, resets at 16:30', now)).toEqual(new Date(2026, 9, 23, 16, 30))
  })

  it('reads an epoch after a bar', () => {
    const at = Math.floor(now.getTime() / 1000) + 3600
    expect(limitResetTime(`Claude AI usage limit reached|${at}`, now)?.getTime()).toBe(at * 1000)
  })

  it('returns null when the message does not say', () => {
    expect(limitResetTime('usage limit reached', now)).toBeNull()
    expect(limitResetTime('quota exceeded, resets 3', now)).toBeNull()
  })
})

describe('command templates', () => {
  const scope = { params: { stage: 'S5.5', cases: ['a b', 'c'], note: "it's" }, outputs: {}, run: {} }

  it('quotes for sh', () => {
    expect(renderCommand('x {{params.stage}} {{params.cases}} {{params.note}}', scope, 'linux')).toBe(`x S5.5 'a b' c 'it'\\''s'`)
  })

  it('quotes for cmd.exe and refuses what it cannot quote', () => {
    expect(renderCommand('x {{params.stage}} {{params.cases}}', scope, 'win32')).toBe('x S5.5 "a b" c')
    expect(() => shellQuote('50%', 'win32')).toThrow(/cmd.exe/)
    expect(() => shellQuote('say "hi"', 'win32')).toThrow(/cmd.exe/)
  })
})
