import { describe, expect, it } from 'vitest'
import { makePipelineHtml } from './pipelinePage'

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
}

describe('makePipelineHtml', () => {
  it('produces a page whose script compiles, with the project embedded safely', () => {
    const html = makePipelineHtml(4100, 'E:/Projects/</script><b>x', 'Mech "3"')
    const scripts = inlineScripts(html)
    expect(scripts).toHaveLength(1)
    expect(() => new Function(scripts[0])).not.toThrow()
    expect(html).not.toContain('</script><b>x')
    expect(scripts[0]).toContain('var port = 4100')
  })
})
