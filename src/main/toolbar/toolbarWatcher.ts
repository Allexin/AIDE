import { existsSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { readToolbarButtons, type ToolbarItem } from '../config/toolbarConfig'
import { getProjectUserPath } from '../config/projectUserData'

/**
 * Watch the shared and current-user toolbar configs for changes.
 * On change (debounced 300ms), re-reads merged buttons and calls onChange.
 * Returns a cleanup function.
 */
export function startToolbarWatcher(
  projectPath: string,
  onChange: (buttons: ToolbarItem[]) => void
): () => void {
  const watchers: FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange(readToolbarButtons(projectPath))
    }, 300)
  }

  const paths = [
    join(projectPath, 'aide', 'toolbar.json'),
    getProjectUserPath(projectPath, 'toolbar.json')
  ]

  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const w = watch(p, { persistent: false }, () => fire())
      watchers.push(w)
    } catch {
      // file may not be watchable (e.g. network drive)
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) w.close()
  }
}
