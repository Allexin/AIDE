import { existsSync, watch, type FSWatcher } from 'fs'
import { basename, dirname, join } from 'path'
import { readToolbarButtons, type ToolbarItem } from '../config/toolbarConfig'
import { getProjectUserPath } from '../config/projectUserData'

/**
 * Watch the shared and current-user toolbar configs for changes.
 * On change (debounced 300ms), re-reads merged buttons and calls onChange.
 * Returns a cleanup function.
 *
 * Each config is watched through its directory, not the file itself: the file
 * may not exist yet (an agent creates `aide/toolbar.json` while the project is
 * open), and a save that replaces the file would silently end a file watch.
 * When the directory does not exist either, its parent is watched until it appears.
 */
export function startToolbarWatcher(
  projectPath: string,
  onChange: (buttons: ToolbarItem[]) => void
): () => void {
  const watchers = new Set<FSWatcher>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange(readToolbarButtons(projectPath))
    }, 300)
  }

  const open = (dir: string, listener: (filename: string | null) => void): FSWatcher | null => {
    try {
      const w = watch(dir, { persistent: false }, (_event, filename) => listener(filename))
      w.on('error', () => {
        w.close()
        watchers.delete(w)
      })
      watchers.add(w)
      return w
    } catch {
      // directory may not be watchable (e.g. network drive)
      return null
    }
  }

  const watchConfig = (file: string): void => {
    if (closed) return
    const dir = dirname(file)
    const name = basename(file)

    if (existsSync(dir)) {
      open(dir, (filename) => {
        if (!filename || filename === name) fire()
      })
      return
    }

    const parent = dirname(dir)
    const dirName = basename(dir)
    if (!existsSync(parent)) return
    const parentWatcher = open(parent, (filename) => {
      if (filename !== dirName || !existsSync(dir)) return
      parentWatcher?.close()
      if (parentWatcher) watchers.delete(parentWatcher)
      watchConfig(file)
      // The config may have been written before the directory watch started.
      fire()
    })
  }

  watchConfig(join(projectPath, 'aide', 'toolbar.json'))
  watchConfig(getProjectUserPath(projectPath, 'toolbar.json'))

  return () => {
    closed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) w.close()
    watchers.clear()
  }
}
