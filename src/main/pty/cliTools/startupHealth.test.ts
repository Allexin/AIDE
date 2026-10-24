import { describe, expect, it } from 'vitest'
import { tuiReadyForInput } from './startupHealth'

// Chunks recorded from real ConPTY sessions (opencode v2.1.4, codex v0.163.0).
const CONPTY_START = '\x1b[?9001h\x1b[?1004h'
const POWERSHELL_CLEAR = '\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07\x1b[?25h'

describe('tuiReadyForInput', () => {
  it('is not fooled by the output ConPTY emits before the CLI starts', () => {
    expect(tuiReadyForInput(CONPTY_START)).toBe(false)
    expect(tuiReadyForInput(CONPTY_START + POWERSHELL_CLEAR)).toBe(false)
  })

  it('waits for the cursor after the TUI enters the alternate screen', () => {
    const entered = CONPTY_START + POWERSHELL_CLEAR + '\x1b[?2026h\x1b[?25l\x1b[?1049h\x1b[?1003;1006h'
    expect(tuiReadyForInput(entered)).toBe(false)
    expect(tuiReadyForInput(entered + '\x1b[27;3H\x1b[?25h')).toBe(true)
  })
})
