import { statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { logEvent } from '../diagnostics'

/**
 * AIDE used to copy its docs into every project's `.aide/docs/`. They are now
 * served by AIDE's MCP server (toolbar_guide, pipeline_hello), and the copies would only go stale.
 * A file is removed only when both its name and its creation date match a copy
 * AIDE made: copying stopped before 2027, so a same-named file created later is
 * someone else's and stays.
 */

const LEGACY_DOCS = ['toolbar.md', 'orchestration-mcp.md']
const COPYING_ENDED = Date.UTC(2027, 0, 1)

/** Remove the doc copies older AIDE versions put into the project. */
export function removeLegacyProjectDocs(projectPath: string): void {
  for (const name of LEGACY_DOCS) {
    const path = join(projectPath, '.aide', 'docs', name)
    try {
      if (statSync(path).birthtimeMs >= COPYING_ENDED) continue
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      logEvent('legacy-doc-remove-failed', { path, message: err instanceof Error ? err.message : String(err) }, 'warn')
    }
  }
}
