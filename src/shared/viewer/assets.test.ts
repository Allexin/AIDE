import { describe, expect, it } from 'vitest'
import { resolveAsset } from './assets'
import { diffMarkdown } from './mdDiff'

const base = 'aide-preview://tok/docs/guide/'

describe('resolveAsset', () => {
  it('resolves relative paths against the folder of the document', () => {
    expect(resolveAsset('img/a.png', base, 0)).toBe('aide-preview://tok/docs/guide/img/a.png')
    expect(resolveAsset('../a b.png', base, 0)).toBe('aide-preview://tok/docs/a%20b.png')
  })

  it('takes a root-relative path from the project root', () => {
    expect(resolveAsset('/assets/logo.svg', base, 0)).toBe('aide-preview://tok/assets/logo.svg')
  })

  it('adds the version when images were reloaded', () => {
    expect(resolveAsset('a.png', base, 3)).toBe('aide-preview://tok/docs/guide/a.png?v=3')
  })

  it('leaves URLs with a scheme alone', () => {
    for (const src of ['https://x.org/a.png', 'data:image/png;base64,AA', '//cdn.x/a.png']) expect(resolveAsset(src, base, 2)).toBe(src)
  })
})

describe('Mermaid blocks', () => {
  const doc = (body: string): string => `# T\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`

  it('renders a diagram as its source for the viewer to draw', () => {
    const html = diffMarkdown(null, doc('flowchart LR\n  A --> B')).html
    expect(html).toContain('<pre class="md-mermaid"><code>flowchart LR\n  A --&gt; B</code></pre>')
  })

  it('shows a changed diagram before and after', () => {
    const html = diffMarkdown(doc('flowchart LR\n  A --> B'), doc('flowchart LR\n  A --> C')).html
    expect(html).toContain('md-mermaid-before')
    expect(html).toContain('md-mermaid-after')
    expect(html).toContain('A --&gt; C')
  })
})
