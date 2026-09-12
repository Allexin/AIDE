import { createHash } from 'crypto'
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { hostname, userInfo } from 'os'
import { join } from 'path'
import { isWindows } from '../platform'

function safePathSegment(value: string): string {
  const readable = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || 'user'
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${readable}--${suffix}`
}

function currentUserIdentity(): string {
  const username = userInfo().username
  if (!isWindows) return username

  // Domain accounts should keep the same project settings on every workstation.
  // For local accounts, the computer name distinguishes equally named users.
  const authority = process.env.USERDOMAIN?.trim() || hostname()
  return `${authority}.${username}`
}

export function getProjectUserDirectory(projectDir: string): string {
  return join(projectDir, '.aide', 'users', safePathSegment(currentUserIdentity()))
}

export function getProjectUserPath(projectDir: string, ...parts: string[]): string {
  return join(getProjectUserDirectory(projectDir), ...parts)
}

export function getProjectHostLockPath(projectDir: string): string {
  return getProjectUserPath(projectDir, 'locks', `${safePathSegment(hostname())}.json`)
}

function migrateFile(projectDir: string, fileName: string): boolean {
  const source = join(projectDir, '.aide', fileName)
  const destination = getProjectUserPath(projectDir, fileName)
  if (!existsSync(source) || existsSync(destination)) return false

  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
    return true
  } catch {
    // Another local instance may have completed the migration first.
    return false
  }
}

function migrateToolbarScripts(projectDir: string): boolean {
  const source = join(projectDir, '.aide', 'scripts')
  const destination = getProjectUserPath(projectDir, 'scripts')
  if (!existsSync(source)) return true
  if (existsSync(destination)) return true

  try {
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
  } catch {
    // Migration is best-effort; the legacy scripts remain available for recovery.
  }
  return existsSync(destination)
}

function updateMigratedToolbarScriptPaths(projectDir: string): void {
  const toolbarPath = getProjectUserPath(projectDir, 'toolbar.json')
  if (!existsSync(toolbarPath)) return

  try {
    const original = readFileSync(toolbarPath, 'utf8')
    const updated = original
      .replace(/\.aide\\\\scripts\\\\/g, '${aideUserDir}/scripts/')
      .replace(/\.aide\/scripts\//g, '${aideUserDir}/scripts/')
    if (updated !== original) writeFileSync(toolbarPath, updated, 'utf8')
  } catch {
    // A malformed toolbar config is handled by the normal config reader.
  }
}

/** Ensure this user's private project area exists and import legacy personal data once. */
export function ensureProjectUserDirectory(projectDir: string): void {
  mkdirSync(getProjectUserDirectory(projectDir), { recursive: true })
  migrateFile(projectDir, 'settings.json')
  const toolbarMigrated = migrateFile(projectDir, 'toolbar.json')
  const scriptsMigrated = migrateToolbarScripts(projectDir)
  if (toolbarMigrated && scriptsMigrated) updateMigratedToolbarScriptPaths(projectDir)
}
