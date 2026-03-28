import React, { useEffect, useRef, useState } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'
import { useSessionStore } from '../../store/useSessionStore'
import { usePanelStore } from '../../store/usePanelStore'
import { useToastStore } from '../../store/useToastStore'

// ── Virtual tree for "Modified only" mode ────────────────────────────────────

interface VNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  children?: VNode[]
}

function buildModifiedTree(changedPaths: string[], projectPath: string): VNode[] {
  interface VDir {
    subs: Map<string, VDir>
    files: string[]
    relPath: string
  }
  const root: VDir = { subs: new Map(), files: [], relPath: '' }

  for (const rel of changedPaths) {
    const parts = rel.split('/')
    let cur = root
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (i === parts.length - 1) {
        if (p) cur.files.push(p) // skip empty segment (trailing slash = untracked dir entry)
      } else {
        if (!cur.subs.has(p)) {
          cur.subs.set(p, {
            subs: new Map(),
            files: [],
            relPath: cur.relPath ? cur.relPath + '/' + p : p
          })
        }
        cur = cur.subs.get(p)!
      }
    }
  }

  const sep = projectPath.includes('\\') ? '\\' : '/'

  function vdirToNodes(vdir: VDir, basePath: string): VNode[] {
    const dirs: VNode[] = Array.from(vdir.subs.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => ({
        name,
        path: basePath + sep + name,
        relativePath: child.relPath,
        type: 'directory' as const,
        children: vdirToNodes(child, basePath + sep + name)
      }))

    const files: VNode[] = vdir.files
      .slice()
      .sort()
      .map((name) => ({
        name,
        path: basePath + sep + name,
        relativePath: vdir.relPath ? vdir.relPath + '/' + name : name,
        type: 'file' as const
      }))

    return [...dirs, ...files]
  }

  return vdirToNodes(root, projectPath)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function getBasename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(idx + 1) : filePath
}

function getDirname(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx >= 0 ? filePath.slice(0, idx) : ''
}

function makeCopyName(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx > 0) return filename.slice(0, dotIdx) + '_Copy' + filename.slice(dotIdx)
  return filename + '_Copy'
}

// ── Context menu ──────────────────────────────────────────────────────────────

function ContextMenuSeparator(): React.ReactElement {
  return <div style={{ height: 1, background: '#3d3d3d', margin: '3px 0' }} />
}

function ContextMenuItem({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        padding: '4px 16px',
        cursor: 'pointer',
        color: '#cccccc',
        background: hovered ? '#094771' : 'transparent'
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {label}
    </div>
  )
}

function ContextMenu({
  x,
  y,
  filePath,
  relativePath,
  onClose,
  onDeleteRequest,
  onRenameRequest,
  onDuplicateRequest
}: {
  x: number
  y: number
  filePath: string
  relativePath: string
  onClose: () => void
  onDeleteRequest: () => void
  onRenameRequest: () => void
  onDuplicateRequest: () => void
}): React.ReactElement {
  const { viewDiff } = useEditorStore()
  const activeTabId = useSessionStore((s) => s.activeTabId)

  const handleAddToContext = (): void => {
    if (activeTabId) {
      window.editorApi.terminalWrite(activeTabId, `@${relativePath} `)
      // H2: Focus the terminal after adding to context
      usePanelStore.getState().focusTerminal()
    }
    onClose()
  }

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 999 }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 1000,
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 3,
          padding: '4px 0',
          minWidth: 160,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          fontSize: 13
        }}
      >
        <ContextMenuItem
          label="Open in Explorer"
          onClick={() => {
            window.editorApi.shellShowItemInFolder(filePath)
            onClose()
          }}
        />
        <ContextMenuItem label="Add to Claude context" onClick={handleAddToContext} />
        <ContextMenuSeparator />
        <ContextMenuItem
          label="View Diff"
          onClick={() => {
            viewDiff(filePath, relativePath)
            onClose()
          }}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          label="Rename"
          onClick={() => {
            onRenameRequest()
            onClose()
          }}
        />
        <ContextMenuItem
          label="Duplicate"
          onClick={() => {
            onDuplicateRequest()
            onClose()
          }}
        />
        <ContextMenuItem
          label="Delete"
          onClick={() => {
            onDeleteRequest()
            onClose()
          }}
        />
      </div>
    </>
  )
}

// ── Inline dialogs ────────────────────────────────────────────────────────────

function ModalBackdrop({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {children}
    </div>
  )
}

function ModalBox({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        background: '#252526',
        border: '1px solid #454545',
        borderRadius: 4,
        padding: '20px 24px',
        minWidth: 320,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        fontSize: 13
      }}
    >
      {children}
    </div>
  )
}

function DialogActions({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
      {children}
    </div>
  )
}

function DialogButton({
  label,
  onClick,
  primary
}: {
  label: string
  onClick: () => void
  primary?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 14px',
        fontSize: 13,
        cursor: 'pointer',
        borderRadius: 3,
        border: primary ? 'none' : '1px solid #555',
        background: primary ? '#0e639c' : 'transparent',
        color: '#cccccc'
      }}
    >
      {label}
    </button>
  )
}

function DeleteConfirmDialog({
  filePath,
  onTrash,
  onPermanent,
  onCancel
}: {
  filePath: string
  onTrash: () => void
  onPermanent: () => void
  onCancel: () => void
}): React.ReactElement {
  const filename = getBasename(filePath)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <ModalBackdrop>
      <ModalBox>
        <div style={{ color: '#cccccc', marginBottom: 4 }}>
          Delete <strong>{filename}</strong>?
        </div>
        <DialogActions>
          <DialogButton label="Cancel" onClick={onCancel} />
          <DialogButton label="Move to Trash" onClick={onTrash} primary />
          <button
            onClick={onPermanent}
            style={{
              padding: '5px 14px',
              fontSize: 13,
              cursor: 'pointer',
              borderRadius: 3,
              border: 'none',
              background: '#c72e2e',
              color: '#ffffff'
            }}
          >
            Delete permanently
          </button>
        </DialogActions>
      </ModalBox>
    </ModalBackdrop>
  )
}

function RenameDialog({
  filePath,
  onConfirm,
  onCancel
}: {
  filePath: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [value, setValue] = useState(getBasename(filePath))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleConfirm = (): void => {
    const trimmed = value.trim()
    if (trimmed) onConfirm(trimmed)
  }

  return (
    <ModalBackdrop>
      <ModalBox>
        <div style={{ color: '#cccccc', marginBottom: 10 }}>Rename file</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
            else if (e.key === 'Escape') onCancel()
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#3c3c3c',
            border: '1px solid #007fd4',
            borderRadius: 3,
            color: '#cccccc',
            fontSize: 13,
            padding: '5px 8px',
            outline: 'none'
          }}
        />
        <DialogActions>
          <DialogButton label="Cancel" onClick={onCancel} />
          <DialogButton label="Rename" onClick={handleConfirm} primary />
        </DialogActions>
      </ModalBox>
    </ModalBackdrop>
  )
}

function DuplicateDialog({
  filePath,
  onConfirm,
  onCancel
}: {
  filePath: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [value, setValue] = useState(makeCopyName(getBasename(filePath)))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleConfirm = (): void => {
    const trimmed = value.trim()
    if (trimmed) onConfirm(trimmed)
  }

  return (
    <ModalBackdrop>
      <ModalBox>
        <div style={{ color: '#cccccc', marginBottom: 10 }}>Duplicate file</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
            else if (e.key === 'Escape') onCancel()
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#3c3c3c',
            border: '1px solid #007fd4',
            borderRadius: 3,
            color: '#cccccc',
            fontSize: 13,
            padding: '5px 8px',
            outline: 'none'
          }}
        />
        <DialogActions>
          <DialogButton label="Cancel" onClick={onCancel} />
          <DialogButton label="Duplicate" onClick={handleConfirm} primary />
        </DialogActions>
      </ModalBox>
    </ModalBackdrop>
  )
}

// ── Tree node ─────────────────────────────────────────────────────────────────

type AnyNode = {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  children?: AnyNode[]
}

interface NodeItemProps {
  node: AnyNode
  depth: number
  // If set, use these children and treat the directory as always-expanded
  preloadedChildren?: AnyNode[]
  isModifiedOnly?: boolean
}

function NodeItem({
  node,
  depth,
  preloadedChildren,
  isModifiedOnly
}: NodeItemProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)

  const { expandedDirs, dirContents, gitStatus, expandDir, collapseDir, selectFile, setContextMenu } =
    useFileTreeStore()
  const { openFile } = useEditorStore()

  const isDir = node.type === 'directory'
  const isExpanded = isModifiedOnly ? true : expandedDirs.has(node.path)
  const children: AnyNode[] =
    preloadedChildren ?? (isExpanded ? ((dirContents.get(node.path) as AnyNode[]) ?? []) : [])

  const isSelected = openFile === node.path
  const allChanged = gitStatus ? [...gitStatus.changed, ...gitStatus.untracked] : []
  const isChanged = isDir
    ? allChanged.some((p) => p.startsWith(node.relativePath + '/'))
    : allChanged.includes(node.relativePath) ||
      (gitStatus?.untracked.some(
        (p) => p.endsWith('/') && node.relativePath.startsWith(p)
      ) ?? false)

  const bgColor = isSelected ? '#37373d' : hovered ? '#2a2d2e' : 'transparent'

  const handleClick = (): void => {
    if (isDir) {
      if (isModifiedOnly) return
      if (isExpanded) collapseDir(node.path)
      else expandDir(node.path)
    } else {
      selectFile({ name: node.name, path: node.path, relativePath: node.relativePath, type: 'file' })
    }
  }

  const handleDoubleClick = (): void => {
    window.editorApi.shellOpenPath(node.path)
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    if (!isDir) {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, filePath: node.path, relativePath: node.relativePath })
    }
  }

  return (
    <div>
      <div
        style={{
          paddingLeft: depth * 16 + 8,
          paddingRight: 8,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          background: bgColor,
          userSelect: 'none',
          fontSize: 13,
          color: '#cccccc',
          overflow: 'hidden'
        }}
        draggable={!isDir}
        onDragStart={!isDir ? (e: React.DragEvent<HTMLDivElement>) => {
          e.dataTransfer.setData('aide/absolute-path', node.path)
          e.dataTransfer.effectAllowed = 'copy'
        } : undefined}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span
          style={{
            width: 14,
            flexShrink: 0,
            fontSize: isDir ? 10 : 9,
            color: isChanged ? '#73c991' : isDir ? '#aaaaaa' : 'transparent',
            display: 'inline-block',
            textAlign: 'center'
          }}
        >
          {isDir ? (isExpanded ? '▾' : '▸') : isChanged ? '●' : ''}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1
          }}
        >
          {node.name}
        </span>
      </div>

      {isDir &&
        children.map((child) => (
          <NodeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            preloadedChildren={isModifiedOnly ? (child.children ?? []) : undefined}
            isModifiedOnly={isModifiedOnly}
          />
        ))}
    </div>
  )
}

// ── Root component ────────────────────────────────────────────────────────────

const centerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 8px'
}

const msgStyle: React.CSSProperties = {
  color: '#555',
  fontSize: 12,
  fontStyle: 'italic',
  textAlign: 'center'
}

type DialogState =
  | { type: 'delete'; filePath: string }
  | { type: 'rename'; filePath: string }
  | { type: 'duplicate'; filePath: string }
  | null

export default function FileTree(): React.ReactElement {
  const { projectPath, dirContents, gitStatus, modifiedOnly, contextMenu, loading, setContextMenu } =
    useFileTreeStore()
  const [dialogState, setDialogState] = useState<DialogState>(null)
  const closeDialog = (): void => setDialogState(null)

  const handleDeletePermanent = async (): Promise<void> => {
    if (!dialogState || dialogState.type !== 'delete') return
    try {
      await window.editorApi.fsDeleteFile(dialogState.filePath)
    } catch (err) {
      useToastStore.getState().show(`Failed to delete: ${String(err)}`)
    }
    closeDialog()
  }

  const handleDeleteTrash = async (): Promise<void> => {
    if (!dialogState || dialogState.type !== 'delete') return
    try {
      await window.editorApi.fsTrashFile(dialogState.filePath)
    } catch (err) {
      useToastStore.getState().show(`Failed to move to trash: ${String(err)}`)
    }
    closeDialog()
  }

  const handleRename = async (newName: string): Promise<void> => {
    if (!dialogState || dialogState.type !== 'rename') return
    const dir = getDirname(dialogState.filePath)
    const sep = dir.length > 0 ? dialogState.filePath[dir.length] : ''
    const newPath = dir ? dir + sep + newName : newName
    try {
      await window.editorApi.fsRenameFile(dialogState.filePath, newPath)
    } catch (err) {
      useToastStore.getState().show(`Failed to rename: ${String(err)}`)
    }
    closeDialog()
  }

  const handleDuplicate = async (newName: string): Promise<void> => {
    if (!dialogState || dialogState.type !== 'duplicate') return
    const dir = getDirname(dialogState.filePath)
    const sep =
      dir.length > 0
        ? dialogState.filePath[dir.length]
        : dialogState.filePath.includes('\\')
          ? '\\'
          : '/'
    const newPath = dir ? dir + sep + newName : newName
    try {
      await window.editorApi.fsCopyFile(dialogState.filePath, newPath)
    } catch (err) {
      useToastStore.getState().show(`Failed to duplicate: ${String(err)}`)
    }
    closeDialog()
  }

  if (loading || !projectPath) {
    return (
      <div style={centerStyle}>
        <span style={msgStyle}>Loading…</span>
      </div>
    )
  }

  let treeContent: React.ReactNode

  if (modifiedOnly) {
    if (!gitStatus) {
      treeContent = (
        <div style={centerStyle}>
          <span style={msgStyle}>Loading…</span>
        </div>
      )
    } else if (!gitStatus.available) {
      treeContent = (
        <div style={centerStyle}>
          <span style={msgStyle}>Git is not available</span>
        </div>
      )
    } else if (gitStatus.changed.length === 0 && gitStatus.untracked.length === 0) {
      treeContent = (
        <div style={centerStyle}>
          <span style={msgStyle}>No changes in project</span>
        </div>
      )
    } else {
      const virtualTree = buildModifiedTree([...gitStatus.changed, ...gitStatus.untracked], projectPath)
      treeContent = (
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {virtualTree.map((vnode) => (
            <NodeItem
              key={vnode.path}
              node={vnode}
              depth={0}
              preloadedChildren={vnode.children ?? []}
              isModifiedOnly={true}
            />
          ))}
        </div>
      )
    }
  } else {
    const rootNodes = (dirContents.get(projectPath) as AnyNode[]) ?? []
    treeContent = (
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {rootNodes.map((node) => (
          <NodeItem key={node.path} node={node} depth={0} />
        ))}
      </div>
    )
  }

  return (
    <>
      {treeContent}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.filePath}
          relativePath={contextMenu.relativePath}
          onClose={() => setContextMenu(null)}
          onDeleteRequest={() =>
            setDialogState({ type: 'delete', filePath: contextMenu.filePath })
          }
          onRenameRequest={() =>
            setDialogState({ type: 'rename', filePath: contextMenu.filePath })
          }
          onDuplicateRequest={() =>
            setDialogState({ type: 'duplicate', filePath: contextMenu.filePath })
          }
        />
      )}

      {dialogState?.type === 'delete' && (
        <DeleteConfirmDialog
          filePath={dialogState.filePath}
          onTrash={handleDeleteTrash}
          onPermanent={handleDeletePermanent}
          onCancel={closeDialog}
        />
      )}
      {dialogState?.type === 'rename' && (
        <RenameDialog
          filePath={dialogState.filePath}
          onConfirm={handleRename}
          onCancel={closeDialog}
        />
      )}
      {dialogState?.type === 'duplicate' && (
        <DuplicateDialog
          filePath={dialogState.filePath}
          onConfirm={handleDuplicate}
          onCancel={closeDialog}
        />
      )}
    </>
  )
}
