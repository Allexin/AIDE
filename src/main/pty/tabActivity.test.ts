import { afterEach, describe, expect, it, vi } from 'vitest'
import { tabActivity } from './tabActivity'

const TABS = ['t-draft-1', 't-draft-2', 't-draft-3', 't-draft-4', 't-draft-5', 't-draft-6']

afterEach(() => {
  for (const id of TABS) tabActivity.forget(id)
})

describe('tabActivity draft tracking and idle state', () => {
  it('tracks printable typing, Backspace, Delete, Ctrl+W, Alt+Backspace, and Enter submit', () => {
    const tab = 't-draft-1'
    tabActivity.markIdle(tab)
    expect(tabActivity.hasUserDraft(tab)).toBe(false)

    tabActivity.input(tab, 'hello')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    expect(tabActivity.isIdle(tab)).toBe(true)

    // Delete all 5 chars with Backspace
    tabActivity.input(tab, '\x7f\x7f\x7f\x7f\x7f')
    expect(tabActivity.hasUserDraft(tab)).toBe(false)

    // Type two words, delete one with Ctrl+W, delete remaining with Alt+Backspace
    tabActivity.input(tab, 'foo bar')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    tabActivity.input(tab, '\x17')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    tabActivity.input(tab, '\x1b\x7f')
    expect(tabActivity.hasUserDraft(tab)).toBe(false)

    // Delete key (\x1b[3~)
    tabActivity.input(tab, 'a')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    tabActivity.input(tab, '\x1b[3~')
    expect(tabActivity.hasUserDraft(tab)).toBe(false)

    // Enter submits: clears draft and marks busy
    tabActivity.input(tab, 'ship it\r')
    expect(tabActivity.hasUserDraft(tab)).toBe(false)
    expect(tabActivity.isIdle(tab)).toBe(false)
  })

  it('handles bracketed paste, Shift+Enter, Alt+Enter, and Kitty CSI u without submitting', () => {
    const tab = 't-draft-2'
    tabActivity.markIdle(tab)

    // Bracketed paste containing CR does not submit and marks draft
    tabActivity.input(tab, '\x1b[200~line1\rline2\x1b[201~')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    expect(tabActivity.isIdle(tab)).toBe(true)

    // Shift+Enter (Kitty CSI u) and Alt+Enter keep draft and do not submit
    tabActivity.input(tab, '\x1b[13;2u')
    tabActivity.input(tab, '\x1b\r')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    expect(tabActivity.isIdle(tab)).toBe(true)

    // Plain Kitty Enter submits
    tabActivity.input(tab, '\x1b[13u')
    expect(tabActivity.hasUserDraft(tab)).toBe(false)
    expect(tabActivity.isIdle(tab)).toBe(false)
  })

  it('ignores focus, mouse, and arrow escape sequences so clicking a terminal never fakes a draft', () => {
    const tab = 't-draft-3'
    tabActivity.markIdle(tab)

    tabActivity.input(tab, '\x1b[I')           // focus in
    tabActivity.input(tab, '\x1b[O')           // focus out
    tabActivity.input(tab, '\x1b[<0;12;4M')    // SGR mouse click
    tabActivity.input(tab, '\x1b[A\x1b[B\x1b[C\x1b[D') // arrows
    expect(tabActivity.hasUserDraft(tab)).toBe(false)
  })

  it('clears draft on Ctrl+C, Ctrl+U, and Ctrl+D', () => {
    const tab = 't-draft-4'
    tabActivity.markIdle(tab)

    for (const clear of ['\x03', '\x15', '\x04']) {
      tabActivity.input(tab, 'partial text')
      expect(tabActivity.hasUserDraft(tab)).toBe(true)
      tabActivity.input(tab, clear)
      expect(tabActivity.hasUserDraft(tab)).toBe(false)
    }
  })

  it('treats a single key pressed while busy (permission hotkey) as transient, but preserves multi-char type-ahead', () => {
    const tab = 't-draft-5'
    // Tab is busy (not marked idle yet)
    tabActivity.input(tab, '1')
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
    tabActivity.markIdle(tab)
    expect(tabActivity.hasUserDraft(tab)).toBe(false)

    // Multi-char type-ahead while busy survives markIdle
    tabActivity.markBusy(tab)
    tabActivity.input(tab, 'f')
    tabActivity.input(tab, 'i')
    tabActivity.input(tab, 'x')
    tabActivity.markIdle(tab)
    expect(tabActivity.hasUserDraft(tab)).toBe(true)
  })

  it('emits forget and clears state when a tab is forgotten', () => {
    const tab = 't-draft-6'
    const onForget = vi.fn()
    tabActivity.on('forget', onForget)
    try {
      tabActivity.markIdle(tab)
      tabActivity.input(tab, 'hello')
      tabActivity.forget(tab)
      expect(onForget).toHaveBeenCalledWith(tab)
      expect(tabActivity.isIdle(tab)).toBe(false)
      expect(tabActivity.hasUserDraft(tab)).toBe(false)
    } finally {
      tabActivity.off('forget', onForget)
    }
  })
})
