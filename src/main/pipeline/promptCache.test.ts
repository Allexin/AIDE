import { describe, expect, it } from 'vitest'
import { lastCacheTtl } from './promptCache'

const line = (short: number, long: number): string => JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_5m_input_tokens: short, ephemeral_1h_input_tokens: long } } } })

describe('lastCacheTtl', () => {
  it('reads the last entry that wrote to the cache', () => {
    expect(lastCacheTtl([line(0, 300), line(300, 0)].join('\n'))).toBe('5m')
    expect(lastCacheTtl([line(300, 0), line(0, 300)].join('\n'))).toBe('1h')
  })

  it('a server tool writing some 5-minute tokens next to the 1-hour ones is still a 1-hour session', () => {
    expect(lastCacheTtl(line(40, 300))).toBe('1h')
  })

  it('skips entries that wrote nothing and a cut first line', () => {
    expect(lastCacheTtl(['"cache_creation":{"ephem', line(0, 300), line(0, 0), '{"type":"user"}'].join('\n'))).toBe('1h')
  })

  it('knows nothing from a transcript without cache writes', () => {
    expect(lastCacheTtl('{"type":"user"}\n')).toBeNull()
    expect(lastCacheTtl('')).toBeNull()
  })
})
