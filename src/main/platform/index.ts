import { execFile, execSync } from 'child_process'
import { readFileSync, readdirSync, accessSync, constants } from 'fs'
import { join, delimiter } from 'path'

export const isWindows = process.platform === 'win32'
export const isLinux = process.platform === 'linux'
export const isMac = process.platform === 'darwin'

/** A single process in a snapshot. `name` is the executable/comm name (lowercased
 *  by callers when matching); on Linux it may be truncated to 15 chars. */
export interface ProcInfo {
  pid: number
  ppid: number
  name: string
}

/** Interactive login shell for the integrated terminal. */
export function defaultShell(): { file: string; args: string[] } {
  if (isWindows) return { file: 'powershell.exe', args: [] }
  if (isMac) return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

/** Snapshot of all processes as {pid, ppid, name}. Backend differs per OS. */
export function listProcesses(): Promise<ProcInfo[]> {
  return isWindows ? listProcessesWindows() : listProcessesLinux()
}

function listProcessesWindows(): Promise<ProcInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
      ],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        const text = stdout.trim()
        if (!text) return resolve([])
        try {
          const parsed = JSON.parse(text)
          const arr: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> = Array.isArray(parsed)
            ? parsed
            : [parsed]
          resolve(arr.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name ?? '' })))
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

async function listProcessesLinux(): Promise<ProcInfo[]> {
  const procs: ProcInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return procs
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = parseInt(entry, 10)
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // process vanished between readdir and read
    }
    // Format: pid (comm) state ppid ...  — comm may contain spaces/parens,
    // so split on the LAST ')' to isolate the trailing whitespace-delimited fields.
    const close = stat.lastIndexOf(')')
    const open = stat.indexOf('(')
    if (open === -1 || close === -1 || close < open) continue
    const name = stat.slice(open + 1, close)
    const rest = stat.slice(close + 2).split(' ')
    // rest[0] = state, rest[1] = ppid
    const ppid = parseInt(rest[1], 10)
    if (isNaN(ppid)) continue
    procs.push({ pid, ppid, name })
  }
  return procs
}

/** Resolve an executable on PATH (replaces `where` / PowerShell Get-Command). */
export function findExecutable(name: string): Promise<boolean> {
  return isWindows ? findExecutableWindows(name) : Promise.resolve(findExecutablePosix(name))
}

async function findExecutableWindows(name: string): Promise<boolean> {
  const inPath = await new Promise<boolean>((resolve) => {
    execFile('where', [name], { timeout: 3000 }, (err) => resolve(!err))
  })
  if (inPath) return true
  // `where` only finds executables; also check PowerShell functions/aliases/shims.
  return new Promise<boolean>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Get-Command ${name} -ErrorAction SilentlyContinue`],
      { timeout: 5000 },
      (err, stdout) => resolve(!err && stdout.trim().length > 0)
    )
  })
}

function findExecutablePosix(name: string): boolean {
  const pathVar = process.env.PATH || ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, name), constants.X_OK)
      return true
    } catch {
      // not here — keep scanning
    }
  }
  return false
}

/** Process start time in epoch ms, for lock-file staleness checks. Synchronous
 *  because the sole caller (lock validation) runs on the synchronous project-open
 *  path; both backends are cheap (one exec / one /proc read). */
export function processStartTimeMs(pid: number): number | null {
  return isWindows ? processStartTimeMsWindows(pid) : processStartTimeMsLinux(pid)
}

function processStartTimeMsWindows(pid: number): number | null {
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()"`,
      { timeout: 3000, encoding: 'utf8' }
    ).trim()
    const ms = parseInt(out, 10)
    return isNaN(ms) ? null : ms
  } catch {
    return null
  }
}

/** USER_HZ is 100 on virtually all Linux configurations. */
const LINUX_CLK_TCK = 100

function processStartTimeMsLinux(pid: number): number | null {
  try {
    const bootMs = linuxBootTimeMs()
    if (bootMs === null) return null
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close === -1) return null
    const rest = stat.slice(close + 2).split(' ')
    // starttime is field 22 (1-based); after stripping "pid (comm)" the remaining
    // fields begin at field 3 (state), so starttime is index 22 - 3 = 19.
    const startTicks = parseInt(rest[19], 10)
    if (isNaN(startTicks)) return null
    return Math.round(bootMs + (startTicks / LINUX_CLK_TCK) * 1000)
  } catch {
    return null
  }
}

function linuxBootTimeMs(): number | null {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const m = /^btime\s+(\d+)/m.exec(stat)
    if (!m) return null
    return parseInt(m[1], 10) * 1000
  } catch {
    return null
  }
}
