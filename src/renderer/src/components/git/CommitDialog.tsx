import React, { useState, useEffect, useRef } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useToastStore } from '../../store/useToastStore'
import { logManager } from '../../store/useLogStore'

// ── Types ──────────────────────────────────────────────────────────────────────

interface CommitFile {
  path: string
  status: 'changed' | 'deleted' | 'untracked'
}

interface TreeNode {
  name: string
  relPath: string
  type: 'file' | 'dir'
  status?: CommitFile['status']
  children: TreeNode[]
}

interface Props {
  onClose: () => void
}

// ── Tree utilities ─────────────────────────────────────────────────────────────

function buildTree(files: CommitFile[]): TreeNode[] {
  interface VDir {
    subs: Map<string, VDir>
    files: CommitFile[]
    relPath: string
  }
  const root: VDir = { subs: new Map(), files: [], relPath: '' }

  for (const file of files) {
    const parts = file.path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!cur.subs.has(p)) {
        cur.subs.set(p, {
          subs: new Map(),
          files: [],
          relPath: cur.relPath ? `${cur.relPath}/${p}` : p
        })
      }
      cur = cur.subs.get(p)!
    }
    cur.files.push(file)
  }

  function toNodes(vdir: VDir): TreeNode[] {
    const dirs: TreeNode[] = Array.from(vdir.subs.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => ({
        name,
        relPath: child.relPath,
        type: 'dir' as const,
        children: toNodes(child)
      }))

    const fileNodes: TreeNode[] = vdir.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        name: f.path.split('/').pop() ?? f.path,
        relPath: f.path,
        type: 'file' as const,
        status: f.status,
        children: []
      }))

    return [...dirs, ...fileNodes]
  }

  return toNodes(root)
}

function collectFiles(node: TreeNode): string[] {
  if (node.type === 'file') return [node.relPath]
  return node.children.flatMap(collectFiles)
}

function collectAllDirs(nodes: TreeNode[]): string[] {
  const result: string[] = []
  for (const n of nodes) {
    if (n.type === 'dir') {
      result.push(n.relPath)
      result.push(...collectAllDirs(n.children))
    }
  }
  return result
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate'

function nodeCheckState(node: TreeNode, checked: Set<string>): CheckState {
  const files = collectFiles(node)
  if (files.length === 0) return 'unchecked'
  const n = files.filter((f) => checked.has(f)).length
  if (n === 0) return 'unchecked'
  if (n === files.length) return 'checked'
  return 'indeterminate'
}

// ── TreeRow ────────────────────────────────────────────────────────────────────

const FILE_COLOR: Record<string, string> = {
  changed: '#cccccc',
  deleted: '#f48771',
  untracked: '#4ec9b0'
}

interface TreeRowProps {
  node: TreeNode
  depth: number
  checked: Set<string>
  expanded: Set<string>
  onToggleCheck: (node: TreeNode) => void
  onToggleExpand: (relPath: string) => void
}

function TreeRow({
  node,
  depth,
  checked,
  expanded,
  onToggleCheck,
  onToggleExpand
}: TreeRowProps): React.ReactElement {
  const isDir = node.type === 'dir'
  const isExpanded = isDir ? expanded.has(node.relPath) : false
  const checkState = nodeCheckState(node, checked)
  const [hovered, setHovered] = useState(false)

  const cbRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (cbRef.current) cbRef.current.indeterminate = checkState === 'indeterminate'
  }, [checkState])

  const color = isDir ? '#cccccc' : (FILE_COLOR[node.status ?? 'changed'] ?? '#cccccc')

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingLeft: depth * 16 + 6,
          paddingRight: 8,
          height: 22,
          background: hovered ? '#2a2d2e' : 'transparent',
          userSelect: 'none',
          fontSize: 13
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Expand toggle */}
        <span
          onClick={() => isDir && onToggleExpand(node.relPath)}
          style={{
            width: 14,
            flexShrink: 0,
            fontSize: 10,
            color: '#777',
            textAlign: 'center',
            cursor: isDir ? 'pointer' : 'default',
            display: 'inline-block'
          }}
        >
          {isDir ? (isExpanded ? '▾' : '▸') : ''}
        </span>

        {/* Checkbox */}
        <input
          ref={cbRef}
          type="checkbox"
          checked={checkState === 'checked'}
          onChange={() => onToggleCheck(node)}
          style={{ cursor: 'pointer', flexShrink: 0, margin: '0 6px 0 2px' }}
        />

        {/* Label */}
        <span
          onClick={() => (isDir ? onToggleExpand(node.relPath) : onToggleCheck(node))}
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color,
            textDecoration: node.status === 'deleted' ? 'line-through' : undefined,
            cursor: 'pointer'
          }}
        >
          {node.name}
          {isDir && <span style={{ color: '#555', marginLeft: 1 }}>/</span>}
        </span>

        {node.status === 'deleted' && (
          <span style={{ color: '#666', fontSize: 11, fontStyle: 'italic', flexShrink: 0, marginLeft: 6 }}>
            deleted
          </span>
        )}
      </div>

      {isDir &&
        isExpanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.relPath}
            node={child}
            depth={depth + 1}
            checked={checked}
            expanded={expanded}
            onToggleCheck={onToggleCheck}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </div>
  )
}

// ── CommitDialog ───────────────────────────────────────────────────────────────

export default function CommitDialog({ onClose }: Props): React.ReactElement {
  const refresh = useFileTreeStore((s) => s.refresh)
  const showToast = useToastStore((s) => s.show)

  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [allFilePaths, setAllFilePaths] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [progressLines, setProgressLines] = useState<
    { line: string; stream: 'stdout' | 'stderr' }[]
  >([])

  const progressEndRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  // Fetch file list on open
  useEffect(() => {
    window.editorApi.gitGetCommitFiles().then((result) => {
      const files: CommitFile[] = [
        ...result.changed.map((p) => ({ path: p, status: 'changed' as const })),
        ...result.untracked.map((p) => ({ path: p, status: 'untracked' as const })),
        ...result.deleted.map((p) => ({ path: p, status: 'deleted' as const }))
      ]
      const t = buildTree(files)
      const paths = files.map((f) => f.path)
      setTree(t)
      setAllFilePaths(paths)
      setChecked(new Set(paths))
      setExpanded(new Set(collectAllDirs(t)))
      setTruncated(result.truncated)
      setLoading(false)
    })
  }, [])

  // Auto-scroll progress
  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [progressLines])

  // Focus textarea after load
  useEffect(() => {
    if (!loading && !isCommitting) setTimeout(() => messageRef.current?.focus(), 50)
  }, [loading, isCommitting])

  // Update select-all indeterminate state
  const checkedCount = allFilePaths.filter((p) => checked.has(p)).length
  const allChecked = allFilePaths.length > 0 && checkedCount === allFilePaths.length
  const someChecked = checkedCount > 0 && !allChecked
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked
  }, [someChecked])

  const checkedFilePaths = allFilePaths.filter((p) => checked.has(p))
  const canCommit = (truncated || checkedFilePaths.length > 0) && message.trim().length > 0

  const handleToggleCheck = (node: TreeNode): void => {
    const files = collectFiles(node)
    const state = nodeCheckState(node, checked)
    setChecked((prev) => {
      const next = new Set(prev)
      if (state === 'checked') files.forEach((f) => next.delete(f))
      else files.forEach((f) => next.add(f))
      return next
    })
  }

  const handleToggleExpand = (relPath: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  const toggleAll = (): void => {
    setChecked(allChecked ? new Set() : new Set(allFilePaths))
  }

  const handleCommit = async (stageAll = false): Promise<void> => {
    if (message.trim().length === 0) return
    if (!stageAll && checkedFilePaths.length === 0) return
    setIsCommitting(true)
    setProgressLines([])

    const unsub = window.editorApi.onGitCommitOutput(({ line, stream }) => {
      setProgressLines((prev) => [...prev, { line, stream }])
      if (stream === 'stderr') logManager.append('Git Errors', line, true)
      else logManager.append('Git', line)
    })

    const result = await window.editorApi.gitRunCommit(
      stageAll ? [] : checkedFilePaths,
      message.trim(),
      stageAll
    )
    unsub()

    if (result.success) {
      await refresh()
      onClose()
    } else {
      onClose()
      showToast(result.error ?? 'Commit failed')
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          width: 540,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'Cascadia Code, Consolas, monospace',
          fontSize: 13,
          color: '#cccccc'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #3d3d3d',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0
          }}
        >
          <span style={{ fontWeight: 600 }}>{isCommitting ? 'Committing…' : 'Commit'}</span>
          {!isCommitting && (
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#cccccc',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
                padding: 0
              }}
            >
              ×
            </button>
          )}
        </div>

        {isCommitting ? (
          /* ── Progress view ───────────────────────────────────────────────────── */
          <div style={{ flex: 1, overflow: 'auto', padding: 12, fontSize: 12 }}>
            {progressLines.map((l, i) => (
              <div
                key={i}
                style={{
                  color: l.stream === 'stderr' ? '#f48771' : '#cccccc',
                  marginBottom: 2,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}
              >
                {l.line}
              </div>
            ))}
            <div ref={progressEndRef} />
          </div>
        ) : loading ? (
          /* ── Loading ─────────────────────────────────────────────────────────── */
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#888'
            }}
          >
            Loading…
          </div>
        ) : (
          /* ── Form view ───────────────────────────────────────────────────────── */
          <>
            {/* Select-all row */}
            {allFilePaths.length > 0 && (
              <div
                style={{
                  padding: '4px 8px 4px 6px',
                  borderBottom: '1px solid #2d2d2d',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
              >
                <span style={{ width: 14, flexShrink: 0 }} />
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  style={{ cursor: 'pointer', flexShrink: 0, margin: '0 6px 0 2px' }}
                />
                <span style={{ color: '#888', fontSize: 12 }}>
                  {checkedCount} / {allFilePaths.length} files
                </span>
              </div>
            )}

            {/* Tree */}
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {allFilePaths.length === 0 ? (
                <div style={{ padding: '8px 16px', color: '#888' }}>No changes</div>
              ) : (
                <>
                  {tree.map((node) => (
                    <TreeRow
                      key={node.relPath}
                      node={node}
                      depth={0}
                      checked={checked}
                      expanded={expanded}
                      onToggleCheck={handleToggleCheck}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                  {truncated && (
                    <div
                      style={{
                        padding: '8px 16px',
                        color: '#e5a74a',
                        fontSize: 12,
                        borderTop: '1px solid #3d3d3d',
                        marginTop: 4
                      }}
                    >
                      ⚠ List truncated at 2000 files. Use "Commit all" to stage everything.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Message */}
            <div style={{ padding: '8px 16px', borderTop: '1px solid #3d3d3d', flexShrink: 0 }}>
              <textarea
                ref={messageRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) handleCommit()
                  if (e.key === 'Escape') onClose()
                }}
                placeholder="Commit message (Ctrl+Enter to commit)"
                rows={3}
                style={{
                  width: '100%',
                  background: '#3c3c3c',
                  border: '1px solid #555',
                  borderRadius: 3,
                  color: '#cccccc',
                  fontSize: 13,
                  padding: '6px 8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: 60,
                  lineHeight: 1.5
                }}
              />
            </div>

            {/* Actions */}
            <div
              style={{
                padding: '8px 16px',
                borderTop: '1px solid #3d3d3d',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                flexShrink: 0
              }}
            >
              {truncated && (
                <button
                  onClick={() => handleCommit(true)}
                  disabled={message.trim().length === 0}
                  title="git add -A && git commit"
                  style={{
                    background: message.trim().length > 0 ? '#5a3e00' : '#2d2d2d',
                    border: '1px solid ' + (message.trim().length > 0 ? '#e5a74a' : '#444'),
                    borderRadius: 3,
                    color: message.trim().length > 0 ? '#e5a74a' : '#555',
                    cursor: message.trim().length > 0 ? 'pointer' : 'default',
                    fontSize: 13,
                    padding: '6px 18px',
                    fontFamily: 'inherit'
                  }}
                >
                  Commit all
                </button>
              )}
              <button
                onClick={() => handleCommit(false)}
                disabled={!canCommit || (truncated && checkedFilePaths.length === 0)}
                style={{
                  background: canCommit && (!truncated || checkedFilePaths.length > 0) ? '#0e639c' : '#2d2d2d',
                  border: 'none',
                  borderRadius: 3,
                  color: canCommit && (!truncated || checkedFilePaths.length > 0) ? '#fff' : '#555',
                  cursor: canCommit && (!truncated || checkedFilePaths.length > 0) ? 'pointer' : 'default',
                  fontSize: 13,
                  padding: '6px 18px',
                  fontFamily: 'inherit'
                }}
              >
                Commit selected
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
