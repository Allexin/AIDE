import { BrowserWindow } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import type { ToolbarButton } from '../config/toolbarConfig'
import { findUnrealEngineDir, findUnrealVersionSelector } from '../unreal/engineFinder'

interface RunningProcess {
  proc: ChildProcess
  button: ToolbarButton
}

// Per-window process registry — keyed by button id
const windowProcesses = new Map<BrowserWindow, Map<string, RunningProcess>>()

function getMap(win: BrowserWindow): Map<string, RunningProcess> {
  if (!windowProcesses.has(win)) windowProcesses.set(win, new Map())
  return windowProcesses.get(win)!
}

function forceKill(proc: ChildProcess): void {
  if (proc.pid && process.platform === 'win32') {
    // Kill entire process tree so child processes (e.g. spawned by npm) also die
    spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      windowsHide: true,
      shell: false
    })
  } else {
    proc.kill('SIGTERM')
  }
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
  if (!win.isDestroyed()) {
    win.webContents.send('toolbar:process-started', { buttonId: button.id })
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
          if (t && !win.isDestroyed()) {
            win.webContents.send('toolbar:output', { channelName, line: t, attention: false })
          }
        })
    })
  }

  // Pipe stderr to log channel
  if (proc.stderr && button.channels?.stderr) {
    const channelName = button.channels.stderr.name
    const attention = button.channels.stderr.attention ?? false
    proc.stderr.on('data', (chunk: Buffer) => {
      chunk
        .toString()
        .split('\n')
        .forEach((line) => {
          const t = line.replace(/\r$/, '')
          if (t && !win.isDestroyed()) {
            win.webContents.send('toolbar:output', { channelName, line: t, attention })
          }
        })
    })
  }

  // Process exited normally
  proc.on('close', (code) => {
    // If removed from map by killButtonProcess, skip — it already notified the renderer
    if (!map.has(button.id)) return
    map.delete(button.id)
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
          attention: button.channels.stderr.attention ?? false
        })
      }
    }
  })
}

/**
 * Kills a running button process and immediately notifies the renderer.
 * The 'close' event handler in spawnButtonProcess skips if entry is gone from map.
 */
export function killButtonProcess(win: BrowserWindow, buttonId: string): void {
  const map = getMap(win)
  const entry = map.get(buttonId)
  if (!entry) return

  // Remove BEFORE killing — 'close' event handler skips if not found in map
  map.delete(buttonId)
  forceKill(entry.proc)

  // Notify renderer immediately (don't wait for OS to report process exit)
  if (!win.isDestroyed()) {
    win.webContents.send('toolbar:process-exited', { buttonId, exitCode: null })
  }
}

/**
 * Kills all running processes for the given window.
 * Does NOT send process-exited events — used when window is closing.
 */
export function killAllProcesses(win: BrowserWindow): void {
  const map = getMap(win)
  for (const [, entry] of [...map.entries()]) {
    forceKill(entry.proc)
  }
  map.clear()
}

/**
 * Kill all processes and remove window from registry. Called on window 'closed'.
 */
export function disposeProcessManager(win: BrowserWindow): void {
  killAllProcesses(win)
  windowProcesses.delete(win)
}
