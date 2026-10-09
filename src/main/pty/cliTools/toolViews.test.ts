import { describe, expect, it } from 'vitest'
import { claudeToolView, codexToolView } from './toolViews'

describe('claudeToolView', () => {
  it('maps file tools', () => {
    expect(claudeToolView('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({ kind: 'edit', path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })
    expect(claudeToolView('Write', { file_path: 'b.md', content: '# hi' })).toEqual({ kind: 'write', path: 'b.md', content: '# hi' })
    expect(claudeToolView('Read', { file_path: 'c.ts', offset: 10, limit: 5 })).toEqual({ kind: 'read', path: 'c.ts', range: 'lines 10–14' })
  })

  it('maps shell and search tools', () => {
    expect(claudeToolView('PowerShell', { command: 'Get-ChildItem' })).toEqual({ kind: 'shell', command: 'Get-ChildItem' })
    expect(claudeToolView('Grep', { pattern: 'foo', path: 'src' })).toEqual({ kind: 'search', pattern: 'foo', path: 'src' })
  })

  it('leaves unknown tools without a view', () => {
    expect(claudeToolView('WebFetch', { url: 'https://example.com' })).toBeUndefined()
  })
})

describe('codexToolView', () => {
  it('shows a single wrapped exec_command cell as a shell command', () => {
    const cell = 'text(await tools.exec_command({cmd:"git status","max_output_tokens":1000}));\n'
    expect(codexToolView('exec', cell)).toEqual({ kind: 'shell', command: 'git status' })
  })

  it('shows other exec cells as scripts, skipping directive comments', () => {
    const cell = '// @exec: {"yield_time_ms": 1000}\nconst r = await tools.view_image({path:"a.png"});\n'
    expect(codexToolView('exec', cell)).toMatchObject({ kind: 'script', language: 'javascript', summary: 'const r = await tools.view_image({path:"a.png"});' })
  })

  it('maps apply_patch with file paths', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch'
    expect(codexToolView('apply_patch', patch)).toEqual({ kind: 'patch', paths: ['src/a.ts', 'src/b.ts'], patch })
  })

  it('maps legacy shell calls', () => {
    expect(codexToolView('shell', { command: ['powershell.exe', '-Command', 'Get-Date'] })).toEqual({ kind: 'shell', command: 'Get-Date' })
    expect(codexToolView('shell_command', { command: 'ls' })).toEqual({ kind: 'shell', command: 'ls' })
  })
})
