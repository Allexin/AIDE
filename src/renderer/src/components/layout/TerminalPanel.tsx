import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usePanelStore } from '../../store/usePanelStore'
import { useSessionStore } from '../../store/useSessionStore'
import { useFileTreeStore } from '../../store/useFileTreeStore'

// VS Dark terminal theme
const VS_DARK_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
  cursor: '#d4d4d4',
  selectionBackground: '#264f78'
}

const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#858585',
  cursor: 'pointer',
  fontSize: 16,
  padding: '2px 6px',
  lineHeight: 1,
  flexShrink: 0
}

interface FitFn {
  fit: () => void
  focus: () => void
}

// ── TerminalTab: one xterm.js instance per session tab ───────────────────────

interface TerminalTabProps {
  tabId: string
  isActive: boolean
  onMount: (tabId: string, fit: FitFn) => void
  onUnmount: (tabId: string) => void
  onAttention: (tabId: string) => void
}

function TerminalTab({ tabId, isActive, onMount, onUnmount, onAttention }: TerminalTabProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // Ref so OSC handler can read current isActive without stale closure
  const isActiveRef = useRef(isActive)
  const onAttentionRef = useRef(onAttention)
  // Ref so fit calls can check whether the terminal panel currently has focus
  const focusedPanel = usePanelStore((s) => s.focusedPanel)
  const focusedPanelRef = useRef(focusedPanel)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { onAttentionRef.current = onAttention }, [onAttention])
  useEffect(() => { focusedPanelRef.current = focusedPanel }, [focusedPanel])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      theme: VS_DARK_THEME,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 10000
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // D1: flash tab when Claude Code signals it's waiting (OSC 9)
    const oscDisposable = terminal.parser.registerOscHandler(9, (_data) => {
      if (!isActiveRef.current) {
        onAttentionRef.current(tabId)
      }
      return true
    })

    // Expose fit + focus to parent
    onMount(tabId, {
      fit: () => {
        try {
          fitAddon.fit()
          window.editorApi.terminalResize(tabId, terminal.cols, terminal.rows)
        } catch {}
      },
      focus: () => { terminal.focus() }
    })

    // Forward keypresses to PTY
    terminal.onData((data) => {
      window.editorApi.terminalWrite(tabId, data)
    })

    // Subscribe to PTY data for this tab
    const removeData = window.editorApi.onTerminalData((receivedTabId, data) => {
      if (receivedTabId === tabId) {
        terminal.write(data)
      }
    })



    // Initial fit if active and terminal panel has focus
    if (isActive && focusedPanelRef.current === 'terminal') {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          window.editorApi.terminalResize(tabId, terminal.cols, terminal.rows)
        } catch {}
      })
    }

    return () => {
      oscDisposable.dispose()
      removeData()
      onUnmount(tabId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [tabId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit when becoming the active tab — only if the terminal panel itself has focus
  useEffect(() => {
    if (isActive && focusedPanelRef.current === 'terminal' && fitAddonRef.current && terminalRef.current) {
      const t = setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
          const term = terminalRef.current
          if (term) {
            window.editorApi.terminalResize(tabId, term.cols, term.rows)
          }
        } catch {}
      }, 50)
      return () => clearTimeout(t)
    }
    return undefined
  }, [isActive, tabId])

  // H1: Right-click = copy selection or paste (no context menu)
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const terminal = terminalRef.current
    if (!terminal) return
    if (terminal.hasSelection()) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {})
      terminal.clearSelection()
    } else {
      navigator.clipboard.readText().then((text) => {
        if (text) terminal.paste(text)
      }).catch(() => {})
    }
  }

  return (
    <div
      ref={containerRef}
      onContextMenu={handleContextMenu}
      style={{
        position: 'absolute',
        inset: 0,
        display: isActive ? 'block' : 'none',
        overflow: 'hidden'
      }}
    />
  )
}

// ── TerminalPanel: tab strip + xterm.js instances ────────────────────────────

interface TerminalPanelProps {
  style?: React.CSSProperties
}

export default function TerminalPanel({ style }: TerminalPanelProps): React.ReactElement {
  const { terminalCollapsed, collapsedWidthPx, toggleTerminalCollapse, focusTerminal, focusedPanel } =
    usePanelStore()

  const { tabs, activeTabId, initialized, initWithTab, initWithTabs, addTab, setActiveTab, closeTab, resetTabs, updateSlug, updateSessionId, markExited, setAttention } =
    useSessionStore()

  const projectPath = useFileTreeStore((s) => s.projectPath)

  const [deadSessionDialog, setDeadSessionDialog] = useState(false)

  // Tool name for the collapsed label — derived reactively from the active tab
  const currentToolName = useSessionStore(
    (s) => s.tabs.find((t) => t.tabId === s.activeTabId)?.toolName ?? 'terminal'
  )

  // Map of tabId → fit+focus functions (populated by TerminalTab on mount)
  const fitFunctions = useRef<Map<string, FitFn>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  // Track whether fit() calls are allowed (only when terminal panel has focus).
  // useLayoutEffect runs synchronously after DOM updates, so the ref is current
  // before any ResizeObserver callbacks fire for that same DOM change.
  const shouldFitRef = useRef(focusedPanel === 'terminal')
  useLayoutEffect(() => {
    shouldFitRef.current = focusedPanel === 'terminal'
    // When terminal regains focus, re-fit immediately so it fills the expanded slot
    if (focusedPanel === 'terminal' && activeTabId) {
      fitFunctions.current.get(activeTabId)?.fit()
    }
  }, [focusedPanel, activeTabId])

  const handleMount = useCallback((tabId: string, fitFn: FitFn) => {
    fitFunctions.current.set(tabId, fitFn)
  }, [])

  const handleUnmount = useCallback((tabId: string) => {
    fitFunctions.current.delete(tabId)
  }, [])

  const handleAttention = useCallback((tabId: string) => {
    setAttention(tabId, true)
  }, [setAttention])

  // H2: Focus xterm when clicking a tab (including the already-active one)
  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTab(tabId)
    setTimeout(() => fitFunctions.current.get(tabId)?.focus(), 50)
  }, [setActiveTab])

  // H3: Close tab — kill PTY, remove from store
  const handleCloseTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return // can't close the last tab
    window.editorApi.terminalCloseTab(tabId)
    closeTab(tabId)
  }, [tabs.length, closeTab])

  // C1/C2: drag & drop files into terminal
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!activeTabId) return

    let absPath: string | null = null

    // C2: internal drag from file tree (check first)
    const internal = e.dataTransfer.getData('aide/absolute-path')
    if (internal) {
      absPath = internal
    } else if (e.dataTransfer.files.length > 0) {
      // C1: external drag from Windows Explorer
      const p = window.editorApi.getPathForFile(e.dataTransfer.files[0])
      absPath = p || null
    }

    if (!absPath) return

    let text: string
    if (projectPath && (absPath.startsWith(projectPath + '\\') || absPath.startsWith(projectPath + '/'))) {
      const rel = absPath.slice(projectPath.length + 1).replace(/\\/g, '/')
      text = `@${rel} `
    } else {
      text = `${absPath} `
    }

    window.editorApi.terminalWrite(activeTabId, text)
    fitFunctions.current.get(activeTabId)?.focus()
  }, [activeTabId, projectPath])

  // Initialize on first mount: restore saved sessions or create initial PTY tab
  const initCalledRef = useRef(false)
  useEffect(() => {
    if (initialized || initCalledRef.current) return
    initCalledRef.current = true
    window.editorApi.terminalCreateInitial().then((result) => {
      if (!result) return
      if (result.tabs.length === 1) {
        initWithTab(result.tabs[0])
      } else if (result.tabs.length > 1) {
        const activeTab = result.activeSessionId
          ? result.tabs.find((t) => t.sessionId === result.activeSessionId)
          : null
        initWithTabs(result.tabs, activeTab?.tabId ?? null)
      }
    })
  }, [initialized, initWithTab, initWithTabs])

  // Sessions are now saved on window close from the main process (editor.ts)
  // No debounced persistence needed here

  // Listen for push events from main process
  useEffect(() => {
    const removeTitle = window.editorApi.onTerminalTabTitle((tabId, title) => updateSlug(tabId, title))
    const removeSessionId = window.editorApi.onTerminalTabSessionId((tabId, sessionId) =>
      updateSessionId(tabId, sessionId)
    )
    const removeExited = window.editorApi.onTerminalTabExited((tabId) => markExited(tabId))
    const removeSwitch = window.editorApi.onTerminalSwitchTab((tabId) => setActiveTab(tabId))
    const removeNewTab = window.editorApi.onTerminalNewTab((tab) => addTab(tab))
    const removeDeadSession = window.editorApi.onTerminalDeadSession((tabId, _sessionId) => {
      // Close the dead tab (unless it's the last one)
      if (useSessionStore.getState().tabs.length > 1) {
        window.editorApi.terminalCloseTab(tabId)
        closeTab(tabId)
      }
      setDeadSessionDialog(true)
    })

    // Silent tab close from restore (dead session during startup)
    const removeTabClosed = window.editorApi.onTerminalTabClosed((tabId) => {
      closeTab(tabId)
    })

    // Account switch: replace all tabs with a fresh one
    const removeResetTabs = window.editorApi.onTerminalResetTabs((newTabs) => {
      resetTabs(newTabs)
    })

    return () => {
      removeTitle()
      removeSessionId()
      removeExited()
      removeSwitch()
      removeNewTab()
      removeDeadSession()
      removeTabClosed()
      removeResetTabs()
    }
  }, [updateSessionId, markExited, setActiveTab, addTab, updateSlug, closeTab, resetTabs])

  // Resize active terminal when the panel container resizes — but only when the
  // terminal panel has focus. When the editor takes focus the container shrinks,
  // but we intentionally skip fit() so xterm keeps its cols/rows intact and the
  // content is merely clipped by overflow:hidden rather than reflown.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      if (activeTabId && shouldFitRef.current) {
        fitFunctions.current.get(activeTabId)?.fit()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [activeTabId])

  // Collapsed state: 20px vertical strip
  if (terminalCollapsed) {
    return (
      <div
        style={{
          width: collapsedWidthPx,
          flexShrink: 0,
          background: '#1e1e1e',
          borderLeft: '1px solid #3d3d3d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          overflow: 'hidden',
          ...style
        }}
        onClick={() => {
          toggleTerminalCollapse()
          focusTerminal()
        }}
        title="Restore terminal"
      >
        <span
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            fontSize: 11,
            color: '#555',
            letterSpacing: 1,
            userSelect: 'none',
            whiteSpace: 'nowrap'
          }}
        >
          {currentToolName}
        </span>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#1e1e1e',
        ...style
      }}
      onMouseDown={focusTerminal}
    >
      {/* Terminal panel header */}
      <div
        style={{
          height: 35,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 6,
          paddingRight: 4,
          gap: 2,
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d'
        }}
      >
        {/* Session tab strip — scrolls horizontally on overflow */}
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
        />

        {/* [ history ] open history viewer for current tab */}
        {(() => {
          const activeTab = tabs.find((t) => t.tabId === activeTabId)
          if (!activeTab?.sessionId) return null
          return (
            <button
              title="Open session history"
              style={headerBtnStyle}
              onClick={(e) => {
                e.stopPropagation()
                window.editorApi.terminalOpenHistory(
                  activeTab.sessionId!,
                  activeTab.toolId,
                  activeTab.slug
                )
              }}
            >
              ☰
            </button>
          )
        })()}

        {/* [ + ] open session picker */}
        <button
          title="Open session picker"
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            window.editorApi.terminalOpenSessionPicker()
          }}
        >
          +
        </button>

        {/* [ collapse ] */}
        <button
          title="Collapse terminal"
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            toggleTerminalCollapse()
          }}
        >
          ⌄
        </button>
      </div>

      {/* xterm.js instances (one per tab, stacked with position:absolute) */}
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.tabId}
            tabId={tab.tabId}
            isActive={tab.tabId === activeTabId}
            onMount={handleMount}
            onUnmount={handleUnmount}
            onAttention={handleAttention}
          />
        ))}
        {!initialized && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#444',
              fontSize: 12
            }}
          >
            Starting terminal…
          </div>
        )}
      </div>

      {/* Dead session notification dialog */}
      {deadSessionDialog && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
            zIndex: 100
          }}
        >
          <div style={{
            background: '#252526',
            border: '1px solid #3d3d3d',
            borderRadius: 6,
            padding: '20px 24px',
            maxWidth: 360,
            textAlign: 'center'
          }}>
            <div style={{ color: '#d4d4d4', fontSize: 13, marginBottom: 16 }}>
              Session not found. The tab has been closed.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={() => setDeadSessionDialog(false)}
                style={{
                  background: '#3d3d3d',
                  color: '#d4d4d4',
                  border: 'none',
                  borderRadius: 4,
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: 12
                }}
              >
                OK
              </button>
              <button
                onClick={() => {
                  setDeadSessionDialog(false)
                  window.editorApi.terminalCreateNew().then((tab) => {
                    if (tab) addTab(tab)
                  })
                }}
                style={{
                  background: '#0e639c',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '6px 16px',
                  cursor: 'pointer',
                  fontSize: 12
                }}
              >
                Start New Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── TabButton ─────────────────────────────────────────────────────────────────

interface TabButtonProps {
  tab: { tabId: string; sessionId: string | null; slug: string; exited: boolean; attention: boolean }
  isActive: boolean
  canClose: boolean
  onSelect: () => void
  onClose: () => void
}

function TabButton({ tab, isActive, canClose, onSelect, onClose }: TabButtonProps): React.ReactElement {
  const [dim, setDim] = useState(false)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (!tab.attention) {
      setDim(false)
      return
    }
    const id = setInterval(() => setDim((d) => !d), 500)
    return () => clearInterval(id)
  }, [tab.attention])

  const color = tab.attention
    ? dim ? '#555' : '#f0a500'  // amber blink — same as log panel
    : tab.exited
      ? '#555'
      : isActive
        ? '#d4d4d4'
        : '#858585'

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={tab.sessionId ? `${tab.slug}\n[${tab.sessionId}]` : tab.slug}
      style={{
        background: isActive ? '#1e1e1e' : '#2d2d2d',
        color,
        fontSize: 12,
        padding: '4px 6px 4px 10px',
        borderRadius: '3px 3px 0 0',
        cursor: 'pointer',
        border: '1px solid #3d3d3d',
        borderBottom: isActive ? '1px solid #1e1e1e' : 'none',
        whiteSpace: 'nowrap',
        lineHeight: 1.5,
        flexShrink: 0,
        maxWidth: 200,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 4
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.slug}</span>
      {canClose && (hovered || isActive) && (
        <span
          onClick={(e) => { e.stopPropagation(); onClose() }}
          title="Close tab"
          style={{
            fontSize: 14,
            lineHeight: 1,
            color: '#858585',
            cursor: 'pointer',
            flexShrink: 0,
            padding: '0 2px',
            borderRadius: 3
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#d4d4d4'; (e.currentTarget as HTMLElement).style.background = '#3d3d3d' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#858585'; (e.currentTarget as HTMLElement).style.background = 'none' }}
        >
          ×
        </span>
      )}
    </div>
  )
}

// ── TabStrip ─────────────────────────────────────────────────────────────────

interface TabStripProps {
  tabs: Array<{ tabId: string; sessionId: string | null; slug: string; exited: boolean; attention: boolean }>
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
}

function TabStrip({ tabs, activeTabId, onSelectTab, onCloseTab }: TabStripProps): React.ReactElement {
  const stripRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
  }, [tabs, updateScrollState])

  const scroll = (dir: 'left' | 'right') => {
    stripRef.current?.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
    setTimeout(updateScrollState, 200)
  }

  return (
    <>
      {canScrollLeft && (
        <button style={headerBtnStyle} onClick={() => scroll('left')} title="Scroll tabs left">
          ‹
        </button>
      )}
      <div
        ref={stripRef}
        onScroll={updateScrollState}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          overflowX: 'auto',
          overflowY: 'hidden',
          gap: 2,
          scrollbarWidth: 'none'
        }}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.tabId}
            tab={tab}
            isActive={tab.tabId === activeTabId}
            canClose={tabs.length > 1}
            onSelect={() => onSelectTab(tab.tabId)}
            onClose={() => onCloseTab(tab.tabId)}
          />
        ))}
      </div>
      {canScrollRight && (
        <button style={headerBtnStyle} onClick={() => scroll('right')} title="Scroll tabs right">
          ›
        </button>
      )}
    </>
  )
}
