import { app, BrowserWindow, net } from 'electron'
import { execFile, spawn } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { logEvent } from '../diagnostics'
import { pipelineManager, planService } from '../pipeline'
import { getRunningCount } from '../toolbar/processManager'
import {
  APPLY_CONFIG, STAGING_PREFIX, downloadFile, findBuildRoot, findChecksum, otherInstances, settleUpdateFolder,
  type AideProcess, type InstallAssets
} from './installer'

export type InstallPhase = 'idle' | 'downloading' | 'verifying' | 'unpacking' | 'ready' | 'failed'

export interface InstallState {
  phase: InstallPhase
  version: string | null
  received: number
  total: number | null
  error: string | null
}

export interface UpdateBlockers {
  /** Pipeline runs and plan autopilots at work, one line each. */
  work: string[]
  toolbarProcesses: number
  otherInstances: Array<{ pid: number; title: string }>
}

export type InstallAnswer = { ok: true } | { ok: false; blockers: UpdateBlockers }

const NO_BLOCKERS: UpdateBlockers = { work: [], toolbarProcesses: 0, otherInstances: [] }
const EXIT_LIMIT_SECONDS = 120
const START_LIMIT_SECONDS = 60
const PROCESS_LIST_TIMEOUT_MS = 15_000

let state: InstallState = { phase: 'idle', version: null, received: 0, total: null, error: null }
let abort: AbortController | null = null
let stagedBuild: string | null = null
let projects: () => Map<string, BrowserWindow> = () => new Map()

export function initSelfUpdate(openProjects: () => Map<string, BrowserWindow>): void {
  projects = openProjects
}

function installDir(): string {
  return dirname(process.execPath)
}

function updateDir(): string {
  return join(installDir(), '.update')
}

function stagingDir(): string {
  return join(updateDir(), `${STAGING_PREFIX}${process.pid}`)
}

function setState(next: Partial<InstallState>): void {
  state = { ...state, ...next }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:install-state', state)
  }
}

export function getInstallState(): InstallState {
  return state
}

/** Self-update replaces the portable folder; a dev run and the Linux packages have none. */
export function canSelfUpdate(): boolean {
  return process.platform === 'win32' && app.isPackaged
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Finish what the last update left. True when it failed, so the user should hear about it. */
export function settleLastUpdate(): boolean {
  if (!canSelfUpdate()) return false
  try {
    const { error, log } = settleUpdateFolder(updateDir(), isAlive)
    if (!error) return false
    logEvent('self-update-failed', { error, log }, 'warn')
    state = { ...state, phase: 'failed', error }
    return true
  } catch (err) {
    logEvent('self-update-settle-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
    return false
  }
}

function workInProgress(): string[] {
  const work: string[] = []
  for (const projectPath of projects().keys()) {
    const project = basename(projectPath)
    const status = pipelineManager.activeRun(projectPath)?.state.status
    if (status === 'running' || status === 'pausing' || status === 'waiting') {
      work.push(`${project}: pipeline run (${status})`)
    }
    const autopilot = planService.snapshot(projectPath).autopilot?.status
    if (autopilot === 'running' || autopilot === 'deciding') {
      work.push(`${project}: plan autopilot (${autopilot})`)
    }
  }
  return work
}

/** Every process of this executable; empty when the list cannot be read (the helper still waits for them). */
function listAideProcesses(): Promise<AideProcess[]> {
  const script = `$e = $env:AIDE_EXE; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $e } | ForEach-Object {
    [pscustomobject]@{ pid = $_.ProcessId; commandLine = $_.CommandLine; title = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle }
  }) | ConvertTo-Json -Compress`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, AIDE_EXE: process.execPath },
      timeout: PROCESS_LIST_TIMEOUT_MS,
      windowsHide: true
    }, (err, stdout) => {
      try {
        if (err) throw err
        const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : []
        resolve((Array.isArray(parsed) ? parsed : [parsed]) as AideProcess[])
      } catch (error) {
        logEvent('self-update-process-list-failed', { message: error instanceof Error ? error.message : String(error) }, 'warn')
        resolve([])
      }
    })
  })
}

/** Start downloading in the background; the answer comes before the download ends. */
export function startInstall(version: string, assets: InstallAssets): InstallAnswer {
  const work = workInProgress()
  if (work.length > 0) return { ok: false, blockers: { ...NO_BLOCKERS, work } }
  if (abort) return { ok: true }

  const controller = new AbortController()
  abort = controller
  stagedBuild = null
  setState({ phase: 'downloading', version, received: 0, total: null, error: null })
  void download(version, assets, controller)
  return { ok: true }
}

async function download(version: string, assets: InstallAssets, controller: AbortController): Promise<void> {
  const staging = stagingDir()
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    const checksums = await net.fetch(assets.checksums.url, { signal: controller.signal })
    if (!checksums.ok) throw new Error(`Cannot read the release checksums: HTTP ${checksums.status}`)
    const expected = findChecksum(await checksums.text(), assets.archive.name)
    if (!expected) throw new Error(`The release checksums do not list ${assets.archive.name}.`)

    const archive = join(staging, assets.archive.name)
    let lastPercent = -1
    const actual = await downloadFile(net.fetch, assets.archive.url, archive, {
      signal: controller.signal,
      onProgress: (received, total) => {
        // Chunks arrive every few milliseconds; the dialog only needs whole percents.
        const percent = total ? Math.floor((received / total) * 100) : Math.floor(received / (1024 * 1024))
        if (percent === lastPercent) return
        lastPercent = percent
        setState({ received, total })
      }
    })

    setState({ phase: 'verifying' })
    if (actual !== expected) throw new Error('The downloaded archive does not match the release checksum.')

    setState({ phase: 'unpacking' })
    const unpacked = join(staging, 'unpacked')
    await unpack(archive, unpacked, controller.signal)
    const build = findBuildRoot(unpacked, basename(process.execPath))
    if (!build) throw new Error('The downloaded archive does not contain an AIDE build.')
    rmSync(archive, { force: true })

    stagedBuild = build
    setState({ phase: 'ready' })
    logEvent('self-update-staged', { version })
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (controller.signal.aborted) {
      setState({ phase: 'idle', version: null, received: 0, total: null })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      logEvent('self-update-download-failed', { version, message }, 'warn')
      setState({ phase: 'failed', error: message })
    }
  } finally {
    abort = null
  }
}

function unpack(archive: string, target: string, signal: AbortSignal): Promise<void> {
  const sevenZip = join(process.resourcesPath, '7za.exe')
  return new Promise((resolve, reject) => {
    execFile(sevenZip, ['x', '-y', '-bd', '-bso0', '-bsp0', `-o${target}`, archive], { signal, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`Cannot unpack the update: ${stderr.trim() || err.message}`))
      else resolve()
    })
  })
}

/** Stop a download, or drop a staged or failed update. */
export function cancelInstall(): void {
  if (abort) {
    abort.abort()
    return
  }
  if (state.phase === 'ready' || state.phase === 'failed') {
    rmSync(stagingDir(), { recursive: true, force: true })
    stagedBuild = null
    setState({ phase: 'idle', version: null, received: 0, total: null, error: null })
  }
}

/** Quit and let the helper swap the folder, unless something must not be interrupted. */
export async function applyInstall(): Promise<InstallAnswer> {
  const build = stagedBuild
  if (state.phase !== 'ready' || !build) return { ok: false, blockers: NO_BLOCKERS }

  const others = otherInstances(await listAideProcesses(), process.pid)
  const blockers: UpdateBlockers = {
    work: workInProgress(),
    toolbarProcesses: [...projects().values()].reduce((sum, win) => sum + (win.isDestroyed() ? 0 : getRunningCount(win)), 0),
    otherInstances: others.map(({ pid, title }) => ({ pid, title: title || `AIDE (process ${pid})` }))
  }
  if (blockers.work.length > 0 || blockers.toolbarProcesses > 0 || blockers.otherInstances.length > 0) {
    return { ok: false, blockers }
  }

  // will-quit: past the point where a window can still refuse to close.
  app.once('will-quit', () => { startHelper(build) })
  logEvent('self-update-applying', { version: state.version })
  app.quit()
  return { ok: true }
}

function startHelper(build: string): void {
  const dir = updateDir()
  for (const leftover of ['started', 'result.json', 'old', 'helper.log']) {
    rmSync(join(dir, leftover), { recursive: true, force: true })
  }
  const script = join(dir, 'apply-update.ps1')
  // Read through Electron's asar support and written out: the helper must not depend on the folder it replaces.
  writeFileSync(script, readFileSync(join(__dirname, '../../resources/updater/apply-update.ps1')))
  const config = join(dir, APPLY_CONFIG)
  writeFileSync(config, JSON.stringify({
    installDir: installDir(),
    newDir: build,
    exeName: basename(process.execPath),
    args: process.argv.slice(1),
    workingDir: process.cwd(),
    exitLimitSeconds: EXIT_LIMIT_SECONDS,
    startLimitSeconds: START_LIMIT_SECONDS
  }), 'utf8')

  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConfigPath', config], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', (err) => { logEvent('self-update-helper-failed', { message: err.message }, 'warn') })
  child.unref()
}
