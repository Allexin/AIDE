import React, { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react'
import type * as MonacoNS from 'monaco-editor'
import '../../monacoSetup'
import { useEditorStore } from '../../store/useEditorStore'
import { usePanelStore } from '../../store/usePanelStore'

// ── Language detection ────────────────────────────────────────────────────────

const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'c',
  h: 'c',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  r: 'r',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql'
}

function getLanguage(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? ''
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return LANG_MAP[ext] ?? 'plaintext'
}

// ── Modal overlay ─────────────────────────────────────────────────────────────

function Modal({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          padding: '20px 24px',
          minWidth: 340,
          maxWidth: 480,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          color: '#cccccc',
          fontSize: 13
        }}
      >
        {children}
      </div>
    </div>
  )
}

const dialogBtnBase: React.CSSProperties = {
  border: '1px solid #555',
  borderRadius: 3,
  padding: '5px 14px',
  fontSize: 12,
  cursor: 'pointer',
  color: '#cccccc',
  background: '#3c3c3c'
}

// ── Large file dialog ─────────────────────────────────────────────────────────

function LargeFileDialog({
  sizeMb,
  onOpen,
  onCancel
}: {
  sizeMb: number
  onOpen: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <Modal>
      <p style={{ margin: '0 0 14px 0', lineHeight: 1.5 }}>
        This file is <strong>{sizeMb.toFixed(1)} MB</strong>. Opening large files may cause
        performance issues. Open anyway?
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={dialogBtnBase} onClick={onCancel}>
          No
        </button>
        <button style={{ ...dialogBtnBase, background: '#0e639c', borderColor: '#0e639c' }} onClick={onOpen}>
          Yes
        </button>
      </div>
    </Modal>
  )
}

// ── Conflict dialog ───────────────────────────────────────────────────────────

function ConflictDialog({
  filePath,
  onReload,
  onKeepMine,
  onBackup
}: {
  filePath: string
  onReload: () => void
  onKeepMine: () => void
  onBackup: () => void
}): React.ReactElement {
  const name = filePath.split(/[/\\]/).pop() ?? filePath
  return (
    <Modal>
      <p style={{ margin: '0 0 6px 0', fontWeight: 600, fontSize: 14 }}>File conflict</p>
      <p style={{ margin: '0 0 16px 0', color: '#9d9d9d', lineHeight: 1.5 }}>
        <strong style={{ color: '#cccccc' }}>{name}</strong> was modified externally while you
        were editing it.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={dialogBtnBase} onClick={onReload}>
          Reload <span style={{ color: '#7a7a7a', fontSize: 11 }}>(Discard my changes)</span>
        </button>
        <button style={dialogBtnBase} onClick={onKeepMine}>
          Keep mine <span style={{ color: '#7a7a7a', fontSize: 11 }}>(Discard external edit)</span>
        </button>
        <button style={dialogBtnBase} onClick={onBackup}>
          Backup &amp; Open
        </button>
      </div>
    </Modal>
  )
}

// ── No-diff dialog ────────────────────────────────────────────────────────────

function NoDiffDialog({
  reason,
  source,
  onOpenEditor,
  onOk
}: {
  reason: 'identical' | 'untracked'
  source: 'button' | 'context'
  onOpenEditor: () => void
  onOk: () => void
}): React.ReactElement {
  const msg =
    reason === 'identical'
      ? 'File has not changed since last commit.'
      : 'File is not tracked by git — there is no diff to show.'
  return (
    <Modal>
      <p style={{ margin: '0 0 16px 0', lineHeight: 1.5 }}>{msg}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {source === 'context' ? (
          <>
            <button style={dialogBtnBase} onClick={onOk}>
              Cancel
            </button>
            <button
              style={{ ...dialogBtnBase, background: '#0e639c', borderColor: '#0e639c' }}
              onClick={onOpenEditor}
            >
              Open Editor
            </button>
          </>
        ) : (
          <button style={{ ...dialogBtnBase, background: '#0e639c', borderColor: '#0e639c' }} onClick={onOk}>
            OK
          </button>
        )}
      </div>
    </Modal>
  )
}

// ── EditorPanel ───────────────────────────────────────────────────────────────

interface EditorPanelProps {
  style?: React.CSSProperties
}

const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #3d3d3d',
  color: '#cccccc',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 7px',
  borderRadius: 3,
  lineHeight: 1.4,
  flexShrink: 0
}

export default function EditorPanel({ style }: EditorPanelProps): React.ReactElement {
  const {
    openFile,
    openRelativePath,
    editorConfig,
    openDiffOnLoad,
    triggerDiffNow,
    setOpenDiffOnLoad,
    setTriggerDiffNow,
    closeEditor,
    openFileInEditor
  } = useEditorStore()
  const { focusEditor } = usePanelStore()

  // ── Monaco refs ─────────────────────────────────────────────────────────────
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof MonacoNS | null>(null)

  // ── File state refs ─────────────────────────────────────────────────────────
  // loadedFileRef tracks what file is actually rendered in Monaco (may lag openFile briefly)
  const loadedFileRef = useRef<string | null>(null)
  const diskContentRef = useRef<string>('')
  const diskMtimeRef = useRef<number>(0)
  // Used when loadFile runs before Monaco mounts
  const pendingContentRef = useRef<string | null>(null)
  const pendingLangRef = useRef<string | null>(null)

  // ── Conflict refs ───────────────────────────────────────────────────────────
  const conflictSuppressedRef = useRef<boolean>(false)
  const conflictDiskContentRef = useRef<string>('')
  const conflictDiskMtimeRef = useRef<number>(0)

  // ── Large file ref ──────────────────────────────────────────────────────────
  const pendingLargeFileRef = useRef<{ path: string; content: string; mtime: number } | null>(null)

  // ── UI state ────────────────────────────────────────────────────────────────
  const [diffMode, setDiffMode] = useState(false)
  const [language, setLanguage] = useState('plaintext')
  const [headContent, setHeadContent] = useState<string>('')
  const [diffDiskContent, setDiffDiskContent] = useState<string>('')
  const [largeFileSizeMb, setLargeFileSizeMb] = useState<number | null>(null)
  const [showConflict, setShowConflict] = useState(false)
  const [noDiffState, setNoDiffState] = useState<{
    reason: 'identical' | 'untracked'
    source: 'button' | 'context'
  } | null>(null)

  // ── Apply loaded content to Monaco ─────────────────────────────────────────

  const applyFileToEditor = useCallback(
    (filePath: string, content: string, mtime: number) => {
      loadedFileRef.current = filePath
      diskContentRef.current = content
      diskMtimeRef.current = mtime
      const lang = getLanguage(filePath)
      setLanguage(lang)
      useEditorStore.getState().setCurrentLanguage(lang)

      if (editorRef.current && monacoRef.current) {
        if (editorRef.current.getValue() !== content) {
          editorRef.current.setValue(content)
          editorRef.current.setScrollPosition({ scrollTop: 0 })
        }
        const model = editorRef.current.getModel()
        if (model) monacoRef.current.editor.setModelLanguage(model, lang)
      } else {
        // Monaco not mounted yet; content applied in onMount
        pendingContentRef.current = content
        pendingLangRef.current = lang
      }
    },
    []
  )

  // ── Diff loading ────────────────────────────────────────────────────────────

  const loadDiff = useCallback(
    async (filePath: string, diskContent: string, source: 'button' | 'context') => {
      const relPath = useEditorStore.getState().openRelativePath
      if (!relPath) return

      const headResult = await window.editorApi.gitShowHead(relPath)

      if ('error' in headResult) {
        setNoDiffState({
          reason: headResult.error === 'untracked' ? 'untracked' : 'identical',
          source
        })
        return
      }

      // Check if HEAD content matches disk — no changes to show
      if (headResult.content === diskContent) {
        setNoDiffState({ reason: 'identical', source })
        return
      }

      setHeadContent(headResult.content)
      setDiffDiskContent(diskContent)
      setDiffMode(true)
    },
    []
  )

  // ── File loading ────────────────────────────────────────────────────────────

  const loadFile = useCallback(
    async (filePath: string) => {
      let result: { content: string; mtime: number; size: number }
      try {
        result = await window.editorApi.readFile(filePath)
      } catch {
        return
      }

      // Bail if the user switched to a different file while we were reading
      if (filePath !== useEditorStore.getState().openFile) return

      const maxBytes = (editorConfig?.maxFileSizeMb ?? 5) * 1024 * 1024
      if (result.size > maxBytes) {
        pendingLargeFileRef.current = { path: filePath, content: result.content, mtime: result.mtime }
        setLargeFileSizeMb(result.size / (1024 * 1024))
        return
      }

      applyFileToEditor(filePath, result.content, result.mtime)
      setDiffMode(false)

      // If openDiffOnLoad was set (from "View Diff" context menu), load diff now
      const shouldDiff = useEditorStore.getState().openDiffOnLoad
      if (shouldDiff) {
        setOpenDiffOnLoad(false)
        await loadDiff(filePath, result.content, 'context')
      }
    },
    [editorConfig, applyFileToEditor, loadDiff, setOpenDiffOnLoad]
  )

  // ── React to openFile changes ───────────────────────────────────────────────

  useEffect(() => {
    if (!openFile) {
      // Editor is being closed
      loadedFileRef.current = null
      setDiffMode(false)
      setNoDiffState(null)
      setLargeFileSizeMb(null)
      pendingLargeFileRef.current = null
      useEditorStore.getState().setCursorPosition(null)
      useEditorStore.getState().setCurrentLanguage(null)
      return
    }

    // Auto-save previous file before loading the new one
    const prevFile = loadedFileRef.current
    if (prevFile && prevFile !== openFile && editorRef.current) {
      const content = editorRef.current.getValue()
      if (content !== diskContentRef.current) {
        window.editorApi.writeFile(prevFile, content).catch(() => {})
      }
    }

    setLargeFileSizeMb(null)
    pendingLargeFileRef.current = null
    setNoDiffState(null)

    loadFile(openFile)
  }, [openFile]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── React to triggerDiffNow (file already open, View Diff from context menu)
  useEffect(() => {
    if (!triggerDiffNow) return
    setTriggerDiffNow(false)
    const filePath = loadedFileRef.current
    if (filePath) {
      loadDiff(filePath, diskContentRef.current, 'context')
    }
  }, [triggerDiffNow, setTriggerDiffNow, loadDiff])

  // ── Auto-save ───────────────────────────────────────────────────────────────

  const saveFile = useCallback(async (filePath: string, content: string): Promise<void> => {
    try {
      const result = await window.editorApi.writeFile(filePath, content)
      // Only update refs if this file is still loaded (user might have switched)
      if (loadedFileRef.current === filePath) {
        diskContentRef.current = content
        diskMtimeRef.current = result.mtime
      }
    } catch {
      // ignore write errors
    }
  }, [])

  // Blur handler stored in ref so the onMount registration always calls the latest version
  const handleBlurRef = useRef<() => void>(() => {})
  useEffect(() => {
    handleBlurRef.current = () => {
      if (conflictSuppressedRef.current) return
      const filePath = loadedFileRef.current
      if (!filePath || !editorRef.current) return
      const content = editorRef.current.getValue()
      if (content !== diskContentRef.current) {
        saveFile(filePath, content)
      }
    }
  })

  // ── External modification (FS watcher) ──────────────────────────────────────

  useEffect(() => {
    const unsub = window.editorApi.onFsChanged(async (event) => {
      if (conflictSuppressedRef.current) return
      const changedPath = event.path
      if (changedPath !== loadedFileRef.current) return

      let result: { content: string; mtime: number; size: number }
      try {
        result = await window.editorApi.readFile(changedPath)
      } catch {
        return // File deleted — FileTreeStore will close the editor
      }

      // Ignore if mtime hasn't advanced (means this was triggered by our own save)
      if (result.mtime <= diskMtimeRef.current) return

      if (!editorRef.current) return
      const currentContent = editorRef.current.getValue()
      const hasLocalChanges = currentContent !== diskContentRef.current

      if (!hasLocalChanges) {
        // Silent reload: user has no pending edits
        applyFileToEditor(changedPath, result.content, result.mtime)
      } else {
        // Conflict: store the new disk state for the conflict dialog
        conflictDiskContentRef.current = result.content
        conflictDiskMtimeRef.current = result.mtime
        conflictSuppressedRef.current = true
        setShowConflict(true)
      }
    })
    return unsub
  }, [applyFileToEditor])

  // ── Conflict resolution ─────────────────────────────────────────────────────

  const handleConflictReload = (): void => {
    const filePath = loadedFileRef.current
    if (filePath) {
      applyFileToEditor(filePath, conflictDiskContentRef.current, conflictDiskMtimeRef.current)
    }
    conflictSuppressedRef.current = false
    setShowConflict(false)
  }

  const handleConflictKeepMine = async (): Promise<void> => {
    if (!loadedFileRef.current || !editorRef.current) return
    const content = editorRef.current.getValue()
    await saveFile(loadedFileRef.current, content)
    conflictSuppressedRef.current = false
    setShowConflict(false)
  }

  const handleConflictBackup = async (): Promise<void> => {
    if (!loadedFileRef.current || !editorRef.current || !openRelativePath) return
    const content = editorRef.current.getValue()
    const timestamp = Date.now()
    const backupAbsPath = `${loadedFileRef.current}.${timestamp}.backup`
    const backupRelPath = `${openRelativePath}.${timestamp}.backup`
    try {
      await window.editorApi.writeFile(backupAbsPath, content)
    } catch {
      return
    }
    conflictSuppressedRef.current = false
    setShowConflict(false)
    openFileInEditor(backupAbsPath, backupRelPath)
  }

  // ── Diff toggle ─────────────────────────────────────────────────────────────

  const handleToggleDiff = async (): Promise<void> => {
    if (diffMode) {
      setDiffMode(false)
      return
    }
    if (!loadedFileRef.current) return
    await loadDiff(loadedFileRef.current, diskContentRef.current, 'button')
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  const handleClose = (): void => {
    // Auto-save before closing
    if (loadedFileRef.current && editorRef.current) {
      const content = editorRef.current.getValue()
      if (content !== diskContentRef.current) {
        window.editorApi.writeFile(loadedFileRef.current, content).catch(() => {})
      }
    }
    closeEditor()
  }

  // ── Notify main process when file is open (for Edit menu enable/disable) ────

  useEffect(() => {
    window.editorApi.notifyEditorFileChanged(true)
    return () => {
      window.editorApi.notifyEditorFileChanged(false)
    }
  }, [])

  // ── Handle Edit menu commands from native menu bar ────────────────────────

  useEffect(() => {
    const monacoCommandIds: Record<string, string> = {
      undo: 'undo',
      redo: 'redo',
      cut: 'editor.action.clipboardCutAction',
      copy: 'editor.action.clipboardCopyAction',
      paste: 'editor.action.clipboardPasteAction'
    }

    const unsub = window.editorApi.onMenuEditCommand((command) => {
      const editor = editorRef.current
      if (!editor) return
      const commandId = monacoCommandIds[command]
      if (commandId) {
        editor.focus()
        editor.trigger('menu', commandId, null)
      }
    })
    return unsub
  }, [])

  // ── Monaco mount ────────────────────────────────────────────────────────────

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor
    monacoRef.current = monacoInstance as unknown as typeof MonacoNS

    // Apply content that was loaded before Monaco finished initializing
    if (pendingContentRef.current !== null) {
      editor.setValue(pendingContentRef.current)
      if (pendingLangRef.current) {
        const model = editor.getModel()
        if (model) monacoInstance.editor.setModelLanguage(model, pendingLangRef.current)
      }
      editor.setScrollPosition({ scrollTop: 0 })
      pendingContentRef.current = null
      pendingLangRef.current = null
    }

    editor.onDidBlurEditorText(() => handleBlurRef.current())

    // Track cursor position for status bar
    editor.onDidChangeCursorPosition((e) => {
      useEditorStore.getState().setCursorPosition({
        line: e.position.lineNumber,
        column: e.position.column
      })
    })
    const initialPos = editor.getPosition()
    if (initialPos) {
      useEditorStore.getState().setCursorPosition({
        line: initialPos.lineNumber,
        column: initialPos.column
      })
    }
  }

  // ── Large file handlers ─────────────────────────────────────────────────────

  const handleLargeFileOpen = (): void => {
    const pending = pendingLargeFileRef.current
    if (!pending) return
    applyFileToEditor(pending.path, pending.content, pending.mtime)
    setLargeFileSizeMb(null)
    pendingLargeFileRef.current = null
    setDiffMode(false)
  }

  const handleLargeFileCancel = (): void => {
    setLargeFileSizeMb(null)
    pendingLargeFileRef.current = null
    closeEditor()
  }

  // ── No-diff dialog handlers ──────────────────────────────────────────────────

  const handleNoDiffOk = (): void => {
    setNoDiffState(null)
    setDiffMode(false)
  }

  // For context menu source: "Open Editor" means just close the dialog and
  // stay in edit mode (openFileInEditor was already called by viewDiff)
  const handleNoDiffOpenEditor = (): void => {
    setNoDiffState(null)
    setDiffMode(false)
  }

  // ── Monaco options ──────────────────────────────────────────────────────────

  const monacoOptions: MonacoNS.editor.IStandaloneEditorConstructionOptions = {
    fontFamily: editorConfig?.fontFamily ?? 'Cascadia Code, Consolas, monospace',
    fontSize: editorConfig?.fontSize ?? 14,
    minimap: { enabled: editorConfig?.minimap ?? false },
    wordWrap: (editorConfig?.wordWrap ?? 'off') as 'off' | 'on',
    lineNumbers: (editorConfig?.lineNumbers ?? 'on') as 'on' | 'off',
    tabSize: editorConfig?.tabSize ?? 2,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    contextmenu: true
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRight: '1px solid #3d3d3d',
        ...style
      }}
      onMouseDown={focusEditor}
    >
      {/* ── Header ── */}
      <div
        style={{
          height: 35,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 10,
          paddingRight: 6,
          gap: 6,
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d'
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 13,
            color: openRelativePath ? '#cccccc' : '#858585',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {openRelativePath ?? '— no file open —'}
        </span>

        <button
          title={diffMode ? 'Back to editor' : 'View diff (HEAD vs disk)'}
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            handleToggleDiff()
          }}
        >
          {diffMode ? 'Edit' : 'Diff'}
        </button>

        <button
          title="Close file"
          style={{ ...headerBtnStyle, fontSize: 15, border: 'none' }}
          onClick={(e) => {
            e.stopPropagation()
            handleClose()
          }}
        >
          ×
        </button>
      </div>

      {/* ── Editor area — both Editor and DiffEditor always mounted ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Regular Monaco Editor */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: diffMode ? 'none' : 'block'
          }}
        >
          <Editor
            theme="vs-dark"
            defaultValue=""
            language={language}
            onMount={handleEditorMount}
            options={monacoOptions}
          />
        </div>

        {/* Monaco Diff Editor */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: diffMode ? 'block' : 'none'
          }}
        >
          <DiffEditor
            theme="vs-dark"
            original={headContent}
            modified={diffDiskContent}
            options={{
              readOnly: true,
              renderSideBySide: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              minimap: { enabled: false }
            }}
          />
        </div>
      </div>

      {/* ── Dialogs ── */}
      {largeFileSizeMb !== null && (
        <LargeFileDialog
          sizeMb={largeFileSizeMb}
          onOpen={handleLargeFileOpen}
          onCancel={handleLargeFileCancel}
        />
      )}

      {showConflict && loadedFileRef.current && (
        <ConflictDialog
          filePath={loadedFileRef.current}
          onReload={handleConflictReload}
          onKeepMine={handleConflictKeepMine}
          onBackup={handleConflictBackup}
        />
      )}

      {noDiffState && (
        <NoDiffDialog
          reason={noDiffState.reason}
          source={noDiffState.source}
          onOpenEditor={handleNoDiffOpenEditor}
          onOk={handleNoDiffOk}
        />
      )}
    </div>
  )
}
