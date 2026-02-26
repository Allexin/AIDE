import React, { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usePanelStore } from '../../store/usePanelStore'
import { useSessionStore } from '../../store/useSessionStore'

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
}

// ── TerminalTab: one xterm.js instance per session tab ───────────────────────

interface TerminalTabProps {
  tabId: string
  isActive: boolean
  onMount: (tabId: string, fit: FitFn) => void
  onUnmount: (tabId: string) => void
  onTitle: (tabId: string, title: string) => void
  onAttention: (tabId: string) => void
}

interface CtxMenuState { x: number; y: number; hasSel: boolean }

function TerminalTab({ tabId, isActive, onMount, onUnmount, onTitle, onAttention }: TerminalTabProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  // Ref so OSC handler can read current isActive without stale closure
  const isActiveRef = useRef(isActive)
  const onTitleRef = useRef(onTitle)
  const onAttentionRef = useRef(onAttention)

  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { onTitleRef.current = onTitle }, [onTitle])
  useEffect(() => { onAttentionRef.current = onAttention }, [onAttention])

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

    // D1: update tab label from VT title escape (OSC 0/2)
    const titleDisposable = terminal.onTitleChange((title) => {
      if (title) onTitleRef.current(tabId, title)
    })

    // D1: flash tab when Claude Code signals it's waiting (OSC 9)
    const oscDisposable = terminal.parser.registerOscHandler(9, (_data) => {
      if (!isActiveRef.current) {
        onAttentionRef.current(tabId)
      }
      return true
    })

    // Expose fit to parent
    onMount(tabId, {
      fit: () => {
        try {
          fitAddon.fit()
          window.editorApi.terminalResize(tabId, terminal.cols, terminal.rows)
        } catch {}
      }
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

    // Initial fit if active
    if (isActive) {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          window.editorApi.terminalResize(tabId, terminal.cols, terminal.rows)
        } catch {}
      })
    }

    return () => {
      titleDisposable.dispose()
      oscDisposable.dispose()
      removeData()
      onUnmount(tabId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [tabId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit when becoming the active tab
  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      hasSel: !!(terminalRef.current?.getSelection())
    })
  }

  const handleCopy = () => {
    const sel = terminalRef.current?.getSelection()
    if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    setCtxMenu(null)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      terminalRef.current?.paste(text)
    } catch {}
    setCtxMenu(null)
    // A2: restore focus after context menu closes
    setTimeout(() => terminalRef.current?.focus(), 0)
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
    >
      {ctxMenu && (
        <TerminalContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSel={ctxMenu.hasSel}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

// ── TerminalContextMenu ───────────────────────────────────────────────────────

interface TerminalContextMenuProps {
  x: number
  y: number
  hasSel: boolean
  onCopy: () => void
  onPaste: () => void
  onClose: () => void
}

function TerminalContextMenu({ x, y, hasSel, onCopy, onPaste, onClose }: TerminalContextMenuProps): React.ReactElement {
  // Close on any click outside
  useEffect(() => {
    const handle = () => onClose()
    window.addEventListener('mousedown', handle)
    return () => window.removeEventListener('mousedown', handle)
  }, [onClose])

  // Keep menu within viewport
  const menuW = 140
  const menuH = 64
  const left = x + menuW > window.innerWidth ? x - menuW : x
  const top = y + menuH > window.innerHeight ? y - menuH : y

  const itemStyle = (enabled: boolean): React.CSSProperties => ({
    padding: '5px 12px',
    cursor: enabled ? 'pointer' : 'default',
    color: enabled ? '#d4d4d4' : '#555',
    fontSize: 12,
    userSelect: 'none',
    background: 'none',
    border: 'none',
    width: '100%',
    textAlign: 'left'
  })

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()} // prevent outside-click handler from firing
      style={{
        position: 'fixed',
        left,
        top,
        width: menuW,
        background: '#252526',
        border: '1px solid #454545',
        borderRadius: 4,
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        zIndex: 9999,
        paddingBlock: 4
      }}
    >
      <button
        style={itemStyle(hasSel)}
        disabled={!hasSel}
        onMouseDown={hasSel ? onCopy : undefined}
      >
        Copy
      </button>
      <button
        style={itemStyle(true)}
        onMouseDown={onPaste}
      >
        Paste
      </button>
    </div>
  )
}

// ── TerminalPanel: tab strip + xterm.js instances ────────────────────────────

interface TerminalPanelProps {
  style?: React.CSSProperties
}

export default function TerminalPanel({ style }: TerminalPanelProps): React.ReactElement {
  const { terminalCollapsed, collapsedWidthPx, toggleTerminalCollapse, focusTerminal } =
    usePanelStore()

  const { tabs, activeTabId, initialized, initWithTab, addTab, setActiveTab, updateSlug, updateSessionId, markExited, setAttention } =
    useSessionStore()

  // Map of tabId → fit function (populated by TerminalTab on mount)
  const fitFunctions = useRef<Map<string, FitFn>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMount = useCallback((tabId: string, fitFn: FitFn) => {
    fitFunctions.current.set(tabId, fitFn)
  }, [])

  const handleUnmount = useCallback((tabId: string) => {
    fitFunctions.current.delete(tabId)
  }, [])

  const handleTitle = useCallback((tabId: string, title: string) => {
    updateSlug(tabId, title)
  }, [updateSlug])

  const handleAttention = useCallback((tabId: string) => {
    setAttention(tabId, true)
  }, [setAttention])

  // Initialize on first mount: create initial PTY tab
  useEffect(() => {
    if (initialized) return
    window.editorApi.terminalCreateInitial().then((tab) => {
      if (tab) initWithTab(tab)
    })
  }, [initialized, initWithTab])

  // Listen for push events from main process
  useEffect(() => {
    const removeSessionId = window.editorApi.onTerminalTabSessionId((tabId, sessionId) =>
      updateSessionId(tabId, sessionId)
    )
    const removeExited = window.editorApi.onTerminalTabExited((tabId) => markExited(tabId))
    const removeSwitch = window.editorApi.onTerminalSwitchTab((tabId) => setActiveTab(tabId))
    const removeNewTab = window.editorApi.onTerminalNewTab((tab) => addTab(tab))

    return () => {
      removeSessionId()
      removeExited()
      removeSwitch()
      removeNewTab()
    }
  }, [updateSessionId, markExited, setActiveTab, addTab])

  // Resize all terminal on panel container resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      if (activeTabId) {
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
          Claude Code
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
          onSelectTab={setActiveTab}
        />

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
      >
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.tabId}
            tabId={tab.tabId}
            isActive={tab.tabId === activeTabId}
            onMount={handleMount}
            onUnmount={handleUnmount}
            onTitle={handleTitle}
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
    </div>
  )
}

// ── TabButton ─────────────────────────────────────────────────────────────────

interface TabButtonProps {
  tab: { tabId: string; slug: string; exited: boolean; attention: boolean }
  isActive: boolean
  onSelect: () => void
}

function TabButton({ tab, isActive, onSelect }: TabButtonProps): React.ReactElement {
  const [dim, setDim] = useState(false)

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
      title={tab.slug}
      style={{
        background: isActive ? '#1e1e1e' : '#2d2d2d',
        color,
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: '3px 3px 0 0',
        cursor: 'pointer',
        border: '1px solid #3d3d3d',
        borderBottom: isActive ? '1px solid #1e1e1e' : 'none',
        whiteSpace: 'nowrap',
        lineHeight: 1.5,
        flexShrink: 0,
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        userSelect: 'none'
      }}
    >
      {tab.slug}
    </div>
  )
}

// ── TabStrip ─────────────────────────────────────────────────────────────────

interface TabStripProps {
  tabs: Array<{ tabId: string; slug: string; exited: boolean; attention: boolean }>
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
}

function TabStrip({ tabs, activeTabId, onSelectTab }: TabStripProps): React.ReactElement {
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
            onSelect={() => onSelectTab(tab.tabId)}
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
