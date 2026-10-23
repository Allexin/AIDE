import { BrowserWindow } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import type { ToolbarButton } from '../config/toolbarConfig'
import { findUnrealEngineDir, findUnrealVersionSelector } from '../unreal/engineFinder'
import { getProjectUserDirectory } from '../config/projectUserData'

interface RunningProcess {
  proc: ChildProcess
  button: ToolbarButton
}

// Per-window process registry — keyed by button id
const windowProcesses = new Map<BrowserWindow, Map<string, RunningProcess>>()

type ProcessObserver = (win: BrowserWindow, event: 'started' | 'exited', buttonId: string, exitCode?: number | null) => void
type OutputObserver = (channelName: string, line: string) => void
const processObservers = new Set<ProcessObserver>()
const outputObservers = new Set<OutputObserver>()

export function addProcessObserver(fn: ProcessObserver): () => void {
  processObservers.add(fn)
  return () => { processObservers.delete(fn) }
}

export function addOutputObserver(fn: OutputObserver): () => void {
  outputObservers.add(fn)
  return () => { outputObservers.delete(fn) }
}

export function getRunningButtonIds(win: BrowserWindow): string[] {
  return [...getMap(win).keys()]
}

function getMap(win: BrowserWindow): Map<string, RunningProcess> {
  if (!windowProcesses.has(win)) windowProcesses.set(win, new Map())
  return windowProcesses.get(win)!
}

/** Safety limit on waiting for a killed process tree — the wait itself is on exit events. */
const KILL_TIMEOUT_MS = 5000

/** Kill the process tree. Resolves once it is gone (or after KILL_TIMEOUT_MS), so a
 *  restart does not race the old process for its port or files. */
function forceKill(proc: ChildProcess): Promise<void> {
  const exited = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => { proc.once('exit', () => resolve()) })
  let killed = Promise.resolve()
  if (proc.pid && process.platform === 'win32') {
    // Kill entire process tree so child processes (e.g. spawned by npm) also die.
    // taskkill exits only after the whole tree is terminated.
    const taskkill = spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      windowsHide: true,
      shell: false
    })
    killed = new Promise<void>((resolve) => {
      taskkill.once('exit', () => resolve())
      taskkill.once('error', () => resolve())
    })
  } else {
    proc.kill('SIGTERM')
  }
  const timeout = new Promise<void>((resolve) => { setTimeout(resolve, KILL_TIMEOUT_MS).unref() })
  return Promise.race([Promise.all([exited, killed]).then(() => undefined), timeout])
}

export function getRunningCount(win: BrowserWindow): number {
  return getMap(win).size
}

export function spawnButtonProcess(
  win: BrowserWindow,
  button: ToolbarButton,
  projectRoot: string
): void {
  const map = getMap(win)
  if (map.has(button.id)) return // already running

  let command = button.command.replace(/\$\{projectRoot\}/g, projectRoot)
  let cwd = (button.cwd ?? '${projectRoot}').replace(/\$\{projectRoot\}/g, projectRoot)
  const aideUserDir = getProjectUserDirectory(projectRoot)
  command = command.replace(/\$\{aideUserDir\}/g, aideUserDir)
  cwd = cwd.replace(/\$\{aideUserDir\}/g, aideUserDir)

  // Resolve ${unrealEngine} — lazily, only when the placeholder is present
  if (command.includes('${unrealEngine}') || cwd.includes('${unrealEngine}')) {
    const engineDir = findUnrealEngineDir(projectRoot) ?? ''
    command = command.replace(/\$\{unrealEngine\}/g, engineDir)
    cwd = cwd.replace(/\$\{unrealEngine\}/g, engineDir)
  }

  // Resolve ${unrealVersionSelector} — lazily, only when the placeholder is present
  if (command.includes('${unrealVersionSelector}') || cwd.includes('${unrealVersionSelector}')) {
    const uvs = findUnrealVersionSelector() ?? ''
    command = command.replace(/\$\{unrealVersionSelector\}/g, uvs)
    cwd = cwd.replace(/\$\{unrealVersionSelector\}/g, uvs)
  }

  const proc = spawn(command, [], { cwd, shell: true, windowsHide: true })

  map.set(button.id, { proc, button })
  for (const obs of processObservers) obs(win, 'started', button.id)
  if (!win.isDestroyed()) {
    const clearChannels: string[] = []
    if (button.autoClear !== false && button.channels) {
      if (button.channels.stdout) clearChannels.push(button.channels.stdout.name)
      if (button.channels.stderr) clearChannels.push(button.channels.stderr.name)
    }
    win.webContents.send('toolbar:process-started', { buttonId: button.id, clearChannels })
  }

  // Pipe stdout to log channel
  if (proc.stdout && button.channels?.stdout) {
    const channelName = button.channels.stdout.name
    proc.stdout.on('data', (chunk: Buffer) => {
      chunk
        .toString()
        .split('\n')
        .forEach((line) => {
          const t = line.replace(/\r$/, '')
          if (t) {
            for (const obs of outputObservers) obs(channelName, t)
            if (!win.isDestroyed()) win.webContents.send('toolbar:output', { channelName, line: t, attention: false, flash: button.channels!.stdout!.flash ?? false })
          }
        })
    })
  }

  // Pipe stderr to log channel
  if (proc.stderr && button.channels?.stderr) {
    const channelName = button.channels.stderr.name
    const attention = button.channels.stderr.attention ?? false
    const stderrFlash = button.channels.stderr.flash ?? false
    proc.stderr.on('data', (chunk: Buffer) => {
      chunk
        .toString()
        .split('\n')
        .forEach((line) => {
          const t = line.replace(/\r$/, '')
          if (t) {
            for (const obs of outputObservers) obs(channelName, t)
            if (!win.isDestroyed()) win.webContents.send('toolbar:output', { channelName, line: t, attention, flash: stderrFlash })
          }
        })
    })
  }

  // Process exited normally
  proc.on('close', (code) => {
    if (!map.has(button.id)) return
    map.delete(button.id)
    for (const obs of processObservers) obs(win, 'exited', button.id, code)
    if (!win.isDestroyed()) {
      win.webContents.send('toolbar:process-exited', { buttonId: button.id, exitCode: code })
    }
  })

  proc.on('error', (err) => {
    if (!map.has(button.id)) return
    map.delete(button.id)
    if (!win.isDestroyed()) {
      win.webContents.send('toolbar:process-exited', { buttonId: button.id, exitCode: -1 })
      // Log spawn error to stderr channel if available
      if (button.channels?.stderr) {
        win.webContents.send('toolbar:output', {
          channelName: button.channels.stderr.name,
          line: `[Error: ${err.message}]`,
          attention: button.channels.stderr.attention ?? false,
          flash: button.channels.stderr.flash ?? false
        })
      }
    }
  })
}

/**
 * Kills a running button process and immediately notifies the renderer.
 * The 'close' event handler in spawnButtonProcess skips if entry is gone from map.
 * The returned promise settles once the process tree is gone.
 */
export function killButtonProcess(win: BrowserWindow, buttonId: string): Promise<void> {
  const map = getMap(win)
  const entry = map.get(buttonId)
  if (!entry) return Promise.resolve()

  // Remove BEFORE killing — 'close' event handler skips if not found in map
  map.delete(buttonId)
  const gone = forceKill(entry.proc)
  for (const obs of processObservers) obs(win, 'exited', buttonId, null)
  if (!win.isDestroyed()) {
    win.webContents.send('toolbar:process-exited', { buttonId, exitCode: null })
  }
  return gone
}

/**
 * Kills all running processes for the given window.
 * Does NOT send process-exited events — used when window is closing.
 */
export function killAllProcesses(win: BrowserWindow): void {
  const map = getMap(win)
  for (const [, entry] of [...map.entries()]) {
    void forceKill(entry.proc)
  }
  map.clear()
}

/**
 * Detaches all running processes from the window registry without killing them.
 * Processes continue running in the background after the window closes.
 */
export function detachAllProcesses(win: BrowserWindow): void {
  const map = getMap(win)
  map.clear()
  // Processes keep running; their close/error handlers check win.isDestroyed() before sending IPC
}

/**
 * Kill all processes and remove window from registry. Called on window 'closed'.
 */
export function disposeProcessManager(win: BrowserWindow): void {
  killAllProcesses(win)
  windowProcesses.delete(win)
}
