import { create } from 'zustand'
import { useEditorStore } from './useEditorStore'
import { logManager } from './useLogStore'

interface FileTreeState {
  projectPath: string | null
  // Each loaded directory maps to its direct children (sorted by main process)
  dirContents: Map<string, TreeNode[]>
  expandedDirs: Set<string>
  gitStatus: GitStatusResult | null
  modifiedOnly: boolean
  contextMenu: { x: number; y: number; filePath: string; relativePath: string } | null
  loading: boolean

  init: (projectPath: string) => Promise<void>
  expandDir: (dirPath: string) => Promise<void>
  collapseDir: (dirPath: string) => void
  selectFile: (node: TreeNode) => void
  toggleModifiedOnly: () => void
  refresh: () => Promise<void>
  updateGitStatus: (status: GitStatusResult) => void
  handleFsChange: (event: { path: string }) => Promise<void>
  setContextMenu: (menu: { x: number; y: number; filePath: string; relativePath: string } | null) => void
}

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  projectPath: null,
  dirContents: new Map(),
  expandedDirs: new Set(),
  gitStatus: null,
  modifiedOnly: false,
  contextMenu: null,
  loading: false,

  init: async (projectPath: string) => {
    set({ projectPath, loading: true, dirContents: new Map(), expandedDirs: new Set() })

    const [rootNodes, gitStatus] = await Promise.all([
      window.editorApi.readDir(projectPath),
      window.editorApi.getGitStatus()
    ])

    set({
      dirContents: new Map([[projectPath, rootNodes]]),
      gitStatus,
      loading: false
    })

    // Subscribe to push events from main process.
    // No cleanup needed — the window is replaced when project changes.
    window.editorApi.onGitStatusUpdated((status) => get().updateGitStatus(status))
    window.editorApi.onFsChanged((event) => get().handleFsChange(event))
  },

  expandDir: async (dirPath: string) => {
    const { dirContents } = get()
    // Load children only if not already cached
    if (!dirContents.has(dirPath)) {
      const children = await window.editorApi.readDir(dirPath)
      const newContents = new Map(get().dirContents)
      newContents.set(dirPath, children)
      set({ dirContents: newContents })
    }
    const newExpanded = new Set(get().expandedDirs)
    newExpanded.add(dirPath)
    set({ expandedDirs: newExpanded })
  },

  collapseDir: (dirPath: string) => {
    const newExpanded = new Set(get().expandedDirs)
    newExpanded.delete(dirPath)
    set({ expandedDirs: newExpanded })
  },

  selectFile: (node: TreeNode) => {
    useEditorStore.getState().openFileInEditor(node.path, node.relativePath)
  },

  toggleModifiedOnly: () => set((s) => ({ modifiedOnly: !s.modifiedOnly })),

  refresh: async () => {
    const { projectPath, expandedDirs, dirContents } = get()
    if (!projectPath) return

    // Re-read root and all currently expanded directories
    const dirsToRead = [projectPath, ...Array.from(expandedDirs)]
    const newContents = new Map<string, TreeNode[]>()

    await Promise.all(
      dirsToRead.map(async (dir) => {
        // Only re-read dirs that were previously loaded
        if (dir === projectPath || dirContents.has(dir)) {
          try {
            newContents.set(dir, await window.editorApi.readDir(dir))
          } catch {
            // Directory was deleted — drop it silently
          }
        }
      })
    )

    const gitStatus = await window.editorApi.getGitStatus()

    // Log explicit refresh to the Git channel (channel auto-created on first append)
    logManager.append('Git', '> git status')
    if (!gitStatus.available) {
      logManager.append('Git', 'git not available in this directory')
    } else {
      logManager.append(
        'Git',
        `${gitStatus.changed.length} changed, ${gitStatus.deleted.length} deleted`
      )
    }

    set({ dirContents: newContents, gitStatus })
  },

  updateGitStatus: (status: GitStatusResult) => set({ gitStatus: status }),

  handleFsChange: async (event: { path: string }) => {
    const { dirContents, expandedDirs, projectPath } = get()
    if (!projectPath) return

    const changedPath = event.path
    const lastSep = Math.max(changedPath.lastIndexOf('/'), changedPath.lastIndexOf('\\'))
    const parentDir = lastSep > 0 ? changedPath.substring(0, lastSep) : projectPath

    // Only update directories that are currently loaded/visible
    const isLoaded = parentDir === projectPath || expandedDirs.has(parentDir)
    if (!isLoaded) return

    try {
      const newChildren = await window.editorApi.readDir(parentDir)
      const newContents = new Map(get().dirContents)
      newContents.set(parentDir, newChildren)
      set({ dirContents: newContents })

      // Close editor if the open file no longer exists in this directory
      const { openFile, closeEditor } = useEditorStore.getState()
      if (openFile) {
        const sep = openFile.includes('\\') ? '\\' : '/'
        const openName = openFile.substring(openFile.lastIndexOf(sep) + 1)
        const openParent = openFile.substring(0, openFile.lastIndexOf(sep))
        if (openParent === parentDir && !newChildren.some((n) => n.name === openName)) {
          closeEditor()
        }
      }
    } catch {
      // Parent directory was deleted — clean up expanded state
      const newExpanded = new Set(get().expandedDirs)
      newExpanded.delete(parentDir)
      const newContents = new Map(get().dirContents)
      newContents.delete(parentDir)
      set({ dirContents: newContents, expandedDirs: newExpanded })

      const { openFile, closeEditor } = useEditorStore.getState()
      if (openFile?.startsWith(parentDir)) closeEditor()
    }
  },

  setContextMenu: (menu) => set({ contextMenu: menu })
}))
