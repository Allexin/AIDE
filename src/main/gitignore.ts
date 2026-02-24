import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export function ensureGitignoreEntry(projectDir: string, entry: string): void {
  const gitignorePath = join(projectDir, '.gitignore')

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, entry + '\n', 'utf8')
    return
  }

  const content = readFileSync(gitignorePath, 'utf8')
  const lines = content.split('\n')

  if (lines.some(line => line.trim() === entry)) {
    return // Already present
  }

  const newContent = content.endsWith('\n')
    ? content + entry + '\n'
    : content + '\n' + entry + '\n'

  writeFileSync(gitignorePath, newContent, 'utf8')
}
