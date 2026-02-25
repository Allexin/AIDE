import React, { useEffect, useState } from 'react'
import { usePanelStore } from '../store/usePanelStore'
import { useEditorStore } from '../store/useEditorStore'
import { useFileTreeStore } from '../store/useFileTreeStore'
import { useToastStore } from '../store/useToastStore'
import MainToolbar from '../components/layout/MainToolbar'
import FileTreeColumn from '../components/layout/FileTreeColumn'
import EditorPanel from '../components/layout/EditorPanel'
import TerminalPanel from '../components/layout/TerminalPanel'
import LogPanel from '../components/layout/LogPanel'
import StatusBar from '../components/layout/StatusBar'

export default function EditorApp(): React.ReactElement {
  const [initialized, setInitialized] = useState(false)
  const toast = useToastStore((s) => s.message)
  const hideToast = useToastStore((s) => s.hide)

  const {
    activePanelRatio,
    collapsedWidthPx,
    editorVisible,
    terminalCollapsed,
    focusedPanel,
    initFromConfig
  } = usePanelStore()

  // Load config from main process, initialize panel store and file tree store
  useEffect(() => {
    async function init(): Promise<void> {
      const [projectSettings, appConfig, projectPath] = await Promise.all([
        window.editorApi.getProjectSettings(),
        window.editorApi.getConfig(),
        window.editorApi.getProjectPath()
      ])
      initFromConfig({
        activePanelRatio: projectSettings.activePanelRatio,
        collapsedWidthPx: projectSettings.collapsedWidthPx,
        fileTreeWidthPx: appConfig.ui.fileTreeWidthPx,
        logPanelExpandedHeightPx: appConfig.ui.logPanelExpandedHeightPx
      })
      useEditorStore.getState().setEditorConfig(appConfig.editor)
      if (projectPath) {
        await useFileTreeStore.getState().init(projectPath)
      }
      setInitialized(true)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Blank dark screen while config loads (IPC is fast — imperceptible)
  if (!initialized) {
    return <div style={{ background: '#1e1e1e', height: '100vh' }} />
  }

  // ── Panel sizing ─────────────────────────────────────────────────────────────
  //
  // Center area is a flex row: [left slot] [terminal]
  // The terminal is always on the right. The left slot holds the editor (or an
  // empty spacer that keeps the terminal pinned to the right when collapsed).
  //
  // focusedPanel === 'editor'  → editor gets activePanelRatio,   terminal gets 1-ratio
  // focusedPanel === 'terminal' → terminal gets activePanelRatio, editor gets 1-ratio

  const editorRatio = focusedPanel === 'editor' ? activePanelRatio : 1 - activePanelRatio
  const terminalRatio = focusedPanel === 'terminal' ? activePanelRatio : 1 - activePanelRatio

  // Left slot style (editor panel or empty spacer)
  const leftStyle: React.CSSProperties = terminalCollapsed
    ? { flex: 1, minWidth: 0, overflow: 'hidden' }
    : { flex: editorRatio, minWidth: 0, overflow: 'hidden' }

  // Terminal panel style
  let terminalStyle: React.CSSProperties
  if (terminalCollapsed) {
    terminalStyle = { width: collapsedWidthPx, flexShrink: 0 }
  } else if (editorVisible) {
    terminalStyle = { flex: terminalRatio, minWidth: 0, overflow: 'hidden' }
  } else {
    terminalStyle = { flex: 1, minWidth: 0, overflow: 'hidden' }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        background: '#1e1e1e'
      }}
    >
      <MainToolbar />

      {/* Main content row: file tree + center area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <FileTreeColumn />

        {/* Center area: editor (left) + terminal (right) */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {editorVisible ? (
            // Editor panel with computed flex width
            <EditorPanel style={leftStyle} />
          ) : (
            // Empty spacer keeps terminal strip pinned to the right when collapsed
            terminalCollapsed && <div style={{ flex: 1 }} />
          )}

          <TerminalPanel style={terminalStyle} />
        </div>
      </div>

      <LogPanel />
      <StatusBar />

      {/* Toast notification */}
      {toast && (
        <div
          onClick={hideToast}
          style={{
            position: 'fixed',
            bottom: 36,
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#252526',
            border: '1px solid #454545',
            borderRadius: 4,
            color: '#cccccc',
            fontSize: 13,
            padding: '8px 16px',
            zIndex: 2000,
            cursor: 'pointer',
            maxWidth: 500,
            textAlign: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            fontFamily: 'Cascadia Code, Consolas, monospace',
            whiteSpace: 'pre-wrap'
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
