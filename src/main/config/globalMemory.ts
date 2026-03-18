import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const MARKER = '#GLOBAL_MEMORY#'

export function syncGlobalMemory(projectPath: string): void {
  const globalMemoryPath = join(app.getPath('userData'), 'GLOBAL_MEMORY.md')
  if (!existsSync(globalMemoryPath)) return

  const globalContent = readFileSync(globalMemoryPath, 'utf8').trimEnd()
  const claudePath = join(projectPath, 'CLAUDE.md')

  if (existsSync(claudePath)) {
    const existing = readFileSync(claudePath, 'utf8')
    const markerIdx = existing.indexOf(MARKER)

    if (markerIdx !== -1) {
      const currentGlobal = existing.slice(0, markerIdx).trimEnd()
      if (currentGlobal === globalContent) return
      const afterMarker = existing.slice(markerIdx + MARKER.length)
      writeFileSync(claudePath, globalContent + '\n' + MARKER + afterMarker, 'utf8')
    } else {
      writeFileSync(claudePath, globalContent + '\n' + MARKER + '\n' + existing, 'utf8')
    }
  } else {
    writeFileSync(claudePath, globalContent + '\n' + MARKER + '\n', 'utf8')
  }
}
