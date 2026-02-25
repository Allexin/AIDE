import React, { useState } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'

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
        cur.files.push(p)
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

// ── Context menu ──────────────────────────────────────────────────────────────

function ContextMenu({
  x,
  y,
  filePath,
  relativePath,
  onClose
}: {
  x: number
  y: number
  filePath: string
  relativePath: string
  onClose: () => void
}): React.ReactElement {
  const { viewDiff } = useEditorStore()

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
          minWidth: 140,
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          fontSize: 13
        }}
      >
        <ContextMenuItem
          label="View Diff"
          onClick={() => {
            viewDiff(filePath, relativePath)
            onClose()
          }}
        />
      </div>
    </>
  )
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
  const isChanged = isDir
    ? (gitStatus?.changed.some((p) => p.startsWith(node.relativePath + '/')) ?? false)
    : (gitStatus?.changed.includes(node.relativePath) ?? false)

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
        onClick={handleClick}
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

export default function FileTree(): React.ReactElement {
  const { projectPath, dirContents, gitStatus, modifiedOnly, contextMenu, loading, setContextMenu } =
    useFileTreeStore()

  if (loading || !projectPath) {
    return (
      <div style={centerStyle}>
        <span style={msgStyle}>Loading…</span>
      </div>
    )
  }

  if (modifiedOnly) {
    if (!gitStatus) {
      return (
        <div style={centerStyle}>
          <span style={msgStyle}>Loading…</span>
        </div>
      )
    }
    if (!gitStatus.available) {
      return (
        <div style={centerStyle}>
          <span style={msgStyle}>Git is not available</span>
        </div>
      )
    }
    if (gitStatus.changed.length === 0) {
      return (
        <div style={centerStyle}>
          <span style={msgStyle}>No changes in project</span>
        </div>
      )
    }

    const virtualTree = buildModifiedTree(gitStatus.changed, projectPath)
    return (
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

  // Normal mode
  const rootNodes = (dirContents.get(projectPath) as AnyNode[]) ?? []

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      {rootNodes.map((node) => (
        <NodeItem key={node.path} node={node} depth={0} />
      ))}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.filePath}
          relativePath={contextMenu.relativePath}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
