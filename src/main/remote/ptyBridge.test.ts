import { describe, expect, it } from 'vitest'
import { PtyBridge } from './ptyBridge'

function bridge(): PtyBridge {
  const manager = { getTabs: () => [{ tabId: 't1' }], resize: () => {}, subscribeToOutput: () => () => {} }
  return new PtyBridge(new Map([[{} as never, manager as never]]))
}

const client = (readyState = 1): { readyState: number; send: () => void } => ({ readyState, send: () => {} })

describe('PtyBridge.takeTab', () => {
  it('refuses a tab held by an open socket', () => {
    const b = bridge()
    expect(b.takeTab(client(), 't1', 80, 24)).toBe(true)
    expect(b.takeTab(client(), 't1', 80, 24)).toBe(false)
  })

  it('takes over a tab whose holder is closing its socket', () => {
    const b = bridge()
    const leaving = client()
    expect(b.takeTab(leaving, 't1', 80, 24)).toBe(true)
    leaving.readyState = 2
    const next = client()
    expect(b.takeTab(next, 't1', 80, 24)).toBe(true)
    b.releaseAll(leaving)
    expect(b.getAllTabs()[0].locked).toBe(true)
  })
})
