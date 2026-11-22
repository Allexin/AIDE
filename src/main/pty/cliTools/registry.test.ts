import { describe, expect, it } from 'vitest'
import { getDefaultTool, getRegisteredTools, orderToolsWithDefault } from './registry'

describe('CLI tool registry default & ordering', () => {
  it('moves the preferred default tool to the front without changing relative order of others', () => {
    const tools = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderToolsWithDefault(tools, 'c').map((t) => t.id)).toEqual(['c', 'a', 'b'])
    expect(orderToolsWithDefault(tools, 'a').map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(orderToolsWithDefault(tools, 'missing').map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(orderToolsWithDefault(tools, null).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('resolves getDefaultTool using preferredDefaultId when active, else first active, else plain-shell', () => {
    const registered = getRegisteredTools()
    expect(registered.length).toBeGreaterThanOrEqual(2)
    const first = registered[0].id
    const last = registered[registered.length - 1].id

    expect(getDefaultTool([first, last], last).id).toBe(last)
    expect(getDefaultTool([first], last).id).toBe(first)
    expect(getDefaultTool([first, last], null).id).toBe(first)
    expect(getDefaultTool([], last).id).toBe('plain-shell')
  })
})
