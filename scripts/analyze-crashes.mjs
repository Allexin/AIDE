#!/usr/bin/env node
/**
 * Crash report analyzer for AIDE.
 *
 * Reads the diagnostics trail written by `src/main/diagnostics/` and correlates
 * it with what the operating system recorded, then reports how each session of
 * the app ended.
 *
 * The central trick is that a session cannot report its own hard death — by
 * definition nothing ran afterwards. So the verdict for session N comes from
 * session N+1, which finds a liveness marker that was never flipped to a clean
 * exit and logs `previous-session-died-hard`. That is what makes silent deaths
 * (unhandled exception, self-quit, OOM kill) visible even though Windows Error
 * Reporting never sees them.
 *
 * Usage:
 *   node scripts/analyze-crashes.mjs [--dir <path>] [--limit N] [--json] [--no-os]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { homedir } from 'os'

// ── arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const getFlag = (name) => argv.includes(name)
const getOpt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const asJson = getFlag('--json')
const skipOs = getFlag('--no-os')
const limit = Number(getOpt('--limit', '20'))

const defaultUserData =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'aide')
    : join(homedir(), '.config', 'aide')

const diagDir = getOpt('--dir', join(defaultUserData, 'diagnostics'))
const crashpadDir = join(defaultUserData, 'Crashpad', 'reports')

// ── formatting helpers ──────────────────────────────────────────────────────

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

const plain = asJson || !process.stdout.isTTY
const c = (color, text) => (plain ? text : `${color}${text}${RESET}`)

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatLocal(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// ── load the event trail ────────────────────────────────────────────────────

function loadEvents() {
  const files = ['events.prev.jsonl', 'events.jsonl']
    .map((name) => join(diagDir, name))
    .filter((path) => existsSync(path))

  const events = []
  const sources = []
  for (const path of files) {
    sources.push({ path, size: statSync(path).size })
    const text = readFileSync(path, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // A torn last line is expected when the process died mid-write; skip it.
      }
    }
  }
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  return { events, sources }
}

/**
 * Fold the flat event stream into per-session records, then resolve each
 * session's ending using the next session's post-mortem report.
 */
function buildSessions(events) {
  const bySid = new Map()

  for (const event of events) {
    if (!event?.sid) continue
    let session = bySid.get(event.sid)
    if (!session) {
      session = {
        sid: event.sid,
        pid: event.pid,
        startedAt: event.ts,
        endedAt: null,
        appVersion: null,
        verdict: 'unknown',
        exitReason: null,
        exitCode: null,
        uptimeMs: null,
        events: [],
        fatals: []
      }
      bySid.set(event.sid, session)
    }
    session.events.push(event)
    if (event.level === 'fatal') session.fatals.push(event)

    if (event.kind === 'session-start') {
      session.startedAt = event.ts
      session.appVersion = event.data?.appVersion ?? null
      session.build = event.data?.build ?? null
    }
    if (event.kind === 'session-exit') {
      session.endedAt = event.ts
      session.verdict = 'clean'
      session.exitReason = event.data?.reason ?? null
      session.exitCode = event.data?.exitCode ?? null
    }
  }

  // A hard death is reported by the session that started afterwards.
  for (const event of events) {
    if (event.kind !== 'previous-session-died-hard') continue
    const victim = bySid.get(event.data?.previousSid)
    if (!victim) continue
    victim.verdict = 'crash'
    victim.endedAt = event.data?.lastAliveAt ?? victim.endedAt
    victim.reportedBy = event.sid
    victim.reportedAt = event.ts
  }

  const sessions = [...bySid.values()]
  for (const session of sessions) {
    if (session.verdict === 'unknown' && !session.endedAt) session.verdict = 'running-or-unreported'
    const start = Date.parse(session.startedAt)
    const end = session.endedAt ? Date.parse(session.endedAt) : Date.now()
    // The liveness marker is stamped a beat before `session-start` is logged, so
    // a death inside the first heartbeat yields a slightly negative span. Clamp
    // it: the meaningful fact is "died immediately", not the sign of a few ms.
    session.uptimeMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
    session.memory = session.events
      .filter((e) => e.kind === 'memory-sample')
      .map((e) => ({ ts: e.ts, ...e.data }))
  }
  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))

  // Separate genuine crashes from dev-server restarts. Under `electron-vite
  // dev`, replacing the source tree kills the main process without letting it
  // run its exit path, which is indistinguishable from a crash by the liveness
  // marker alone. A restart brings a new main bundle with it; a crash does not.
  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i]
    if (session.verdict !== 'crash') continue
    const next = sessions[i + 1]
    if (!next?.build || !session.build) continue
    if (next.build.mtime !== session.build.mtime || next.build.size !== session.build.size) {
      session.verdict = 'restart'
      session.restartReason = `main bundle changed (${formatLocal(session.build.mtime)} → ${formatLocal(next.build.mtime)})`
    }
  }
  return sessions
}

/** The events immediately preceding the end of a session — the crash context. */
function tailOf(session, n = 12) {
  return session.events
    .filter((e) => e.kind !== 'memory-sample')
    .slice(-n)
}

function describeEvent(event) {
  const d = event.data ?? {}
  switch (event.kind) {
    case 'uncaught-exception':
      return `uncaught-exception ${d.name ?? ''}${d.code ? `[${d.code}]` : ''}: ${d.message ?? ''}`
    case 'unhandled-rejection':
      return `unhandled-rejection: ${d.message ?? ''}`
    case 'render-process-gone':
      return `render-process-gone reason=${d.reason} exit=${d.exitCode}`
    case 'child-process-gone':
      return `child-process-gone ${d.type}${d.serviceName ? `/${d.serviceName}` : ''} reason=${d.reason} exit=${d.exitCode}`
    case 'pty-exit':
      return `pty-exit tab=${d.tabId} code=${d.exitCode}${d.signal ? ` signal=${d.signal}` : ''}`
    case 'pty-spawn':
      return `pty-spawn tab=${d.tabId} pid=${d.pid}`
    case 'memory-sample':
      return `memory rss=${d.rssMb}MB heap=${d.heapUsedMb}MB windows=${d.windows}`
    case 'project-open':
      return `project-open ${d.path} ok=${d.success}`
    case 'session-exit':
      return `session-exit reason=${d.reason} code=${d.exitCode}`
    default:
      return event.kind + (d.message ? `: ${d.message}` : '')
  }
}

/** Group fatal events by their shape so repeats collapse into one line. */
function signatures(sessions) {
  const map = new Map()
  for (const session of sessions) {
    for (const event of session.fatals) {
      if (event.kind === 'previous-session-died-hard') continue
      const d = event.data ?? {}
      const key = [event.kind, d.code ?? '', d.name ?? '', (d.message ?? '').slice(0, 120)].join('|')
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
        existing.lastSeen = event.ts
      } else {
        map.set(key, {
          kind: event.kind,
          code: d.code ?? null,
          message: d.message ?? null,
          stack: d.stack ?? null,
          count: 1,
          firstSeen: event.ts,
          lastSeen: event.ts
        })
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

const SPARK = '▁▂▃▄▅▆▇█'

/**
 * Render the main-process heap over the life of a session. V8 aborts on heap
 * exhaustion without raising a JavaScript exception, so for that class of death
 * this trend is the entire evidence — printing it beside the event tail is the
 * difference between "died silently" and "ran out of memory".
 */
function printMemoryTrend(session) {
  const samples = session.memory ?? []
  if (samples.length < 2) return

  const heaps = samples.map((s) => Number(s.heapUsedMb) || 0)
  const peak = Math.max(...heaps)
  const last = heaps[heaps.length - 1]
  const first = heaps[0]
  const limit = samples.map((s) => Number(s.heapLimitMb) || 0).filter(Boolean).pop() ?? null

  // Compress to a fixed width so long sessions stay one line.
  const width = Math.min(48, heaps.length)
  const step = heaps.length / width
  const bars = []
  for (let i = 0; i < width; i += 1) {
    const slice = heaps.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1))
    const value = Math.max(...slice)
    const level = peak > 0 ? Math.min(SPARK.length - 1, Math.floor((value / peak) * (SPARK.length - 1))) : 0
    bars.push(SPARK[level])
  }

  const pctOfLimit = limit ? Math.round((peak / limit) * 100) : null
  const hot = limit ? peak / limit >= 0.5 : peak >= 1500
  console.log(
    `    ${c(DIM, 'heap')} ${c(hot ? RED : DIM, bars.join(''))} ` +
      `${c(DIM, `${first}→${last} MB, peak ${peak} MB`)}${limit ? c(DIM, ` of ${limit} MB cap (${pctOfLimit}%)`) : ''}`
  )

  // Terminal throughput on the same time base as the heap. If the two rise
  // together the pty path is implicated; if the heap climbs while this stays
  // flat, the memory is coming from somewhere else entirely.
  const ptyMb = samples.map((s) => Number(s.ptyMb) || 0)
  const totalPtyMb = ptyMb.reduce((a, b) => a + b, 0)
  if (totalPtyMb > 0) {
    const ptyPeak = Math.max(...ptyMb)
    const ptyBars = []
    for (let i = 0; i < width; i += 1) {
      const slice = ptyMb.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1))
      const value = Math.max(...slice)
      const level = ptyPeak > 0 ? Math.min(SPARK.length - 1, Math.floor((value / ptyPeak) * (SPARK.length - 1))) : 0
      ptyBars.push(SPARK[level])
    }
    console.log(
      `    ${c(DIM, 'pty ')} ${c(DIM, ptyBars.join(''))} ` +
        `${c(DIM, `${totalPtyMb.toFixed(1)} MB total, peak ${ptyPeak.toFixed(1)} MB per sample`)}`
    )
  }

  const spaces = samples.map((s) => s.spaces).filter(Boolean)
  if (spaces.length) {
    console.log(`    ${c(DIM, 'v8  ')} ${c(DIM, spaces[spaces.length - 1])}`)
  }

  // A final sample far above the preceding trend is the signature of a runaway
  // allocation that the sampling interval was too coarse to follow to the end.
  if (heaps.length >= 3) {
    const priorPeak = Math.max(...heaps.slice(0, -1))
    if (last > priorPeak * 2 && last > 500) {
      console.log(
        c(RED, `    ⚠ heap ${Math.round(last / priorPeak)}× above the prior trend in the last sample before death`) +
          c(DIM, ' — runaway allocation, not a steady leak')
      )
    }
  }
}

// ── operating-system corroboration ──────────────────────────────────────────

function readCrashpadDumps() {
  if (!existsSync(crashpadDir)) return []
  try {
    return readdirSync(crashpadDir)
      .filter((f) => f.endsWith('.dmp'))
      .map((f) => {
        const s = statSync(join(crashpadDir, f))
        return { name: f, size: s.size, mtime: s.mtime.toISOString() }
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
  } catch {
    return []
  }
}

/** Ask Windows whether it saw a native fault for our process recently. */
function readWindowsCrashes(sinceIso) {
  if (process.platform !== 'win32') return []
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$since = [datetime]::Parse('${sinceIso}')
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1026; StartTime=$since} |
  Where-Object { $_.Message -match 'electron|aide|AIDE' } |
  Select-Object -First 25 @{n='ts';e={$_.TimeCreated.ToString('o')}}, Id, @{n='msg';e={($_.Message -split "\`n")[0..2] -join ' | '}} |
  ConvertTo-Json -Compress
`
  for (const exe of ['pwsh', 'powershell']) {
    try {
      const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (!out) return []
      const parsed = JSON.parse(out)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      // Try the next shell, then give up quietly — this is corroboration only.
    }
  }
  return []
}

// ── report ──────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(diagDir)) {
    console.log(`${c(YELLOW, 'No diagnostics directory yet:')} ${diagDir}`)
    console.log('\nThe recorder writes it on first launch. Start AIDE once, then run this again.')
    console.log('If AIDE has been started since diagnostics were added and this is still missing,')
    console.log('the build being run is an older copy that does not include src/main/diagnostics/.')
    process.exit(0)
  }

  const { events, sources } = loadEvents()
  const sessions = buildSessions(events)
  const crashes = sessions.filter((s) => s.verdict === 'crash')
  const restarts = sessions.filter((s) => s.verdict === 'restart')
  const clean = sessions.filter((s) => s.verdict === 'clean')
  const sigs = signatures(sessions)
  const dumps = readCrashpadDumps()
  const earliest = sessions.length ? sessions[0].startedAt : new Date().toISOString()
  const osCrashes = skipOs ? [] : readWindowsCrashes(earliest)

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          diagDir,
          sources,
          totals: { sessions: sessions.length, crashes: crashes.length, clean: clean.length },
          sessions: sessions.map((s) => ({ ...s, events: undefined, tail: tailOf(s).map(describeEvent) })),
          signatures: sigs,
          crashpadDumps: dumps,
          windowsEvents: osCrashes
        },
        null,
        2
      )
    )
    return
  }

  console.log(`${c(BOLD, 'AIDE crash analysis')}`)
  console.log(`${c(DIM, diagDir)}`)
  for (const s of sources) console.log(`${c(DIM, `  ${s.path.split(/[\\/]/).pop()} — ${formatBytes(s.size)}`)}`)
  console.log()

  if (sessions.length === 0) {
    console.log(c(YELLOW, 'The trail exists but holds no sessions yet. Launch AIDE and reproduce the crash.'))
    return
  }

  const ended = crashes.length + clean.length
  const rate = ended > 0 ? Math.round((crashes.length / ended) * 100) : 0
  console.log(
    `Sessions ${c(BOLD, sessions.length)}   ` +
      `Crashes ${c(crashes.length ? RED : GREEN, crashes.length)}${crashes.length ? ` (${rate}% of ended sessions)` : ''}   ` +
      `Clean exits ${c(GREEN, clean.length)}   ` +
      `Dev restarts ${c(DIM, restarts.length)}`
  )
  if (restarts.length) {
    console.log(
      c(DIM, '  Restarts are excluded from the crash count: the main bundle changed between') +
        c(DIM, '\n  those sessions, so the dev server replaced the process rather than it dying.')
    )
  }
  console.log()

  if (crashes.length) {
    console.log(c(BOLD, '── Hard deaths ' + '─'.repeat(50)))
    for (const session of crashes.slice(-limit)) {
      console.log(
        `\n${c(RED, '✗')} ${formatLocal(session.startedAt)} → ${formatLocal(session.endedAt)}  ` +
          `${c(DIM, `uptime ${formatDuration(session.uptimeMs)} · v${session.appVersion ?? '?'} · pid ${session.pid} · sid ${session.sid}`)}`
      )
      const tail = tailOf(session)
      if (tail.length === 0) {
        console.log(c(DIM, '    (no events recorded before death)'))
      } else {
        for (const event of tail) {
          const mark = event.level === 'fatal' ? c(RED, '!') : event.level === 'warn' ? c(YELLOW, '~') : ' '
          console.log(`    ${mark} ${c(DIM, formatLocal(event.ts).slice(11))} ${describeEvent(event)}`)
        }
      }
      printMemoryTrend(session)
    }
    console.log()
  } else {
    console.log(c(GREEN, 'No hard deaths recorded — every ended session exited through its normal path.'))
    console.log()
  }

  if (sigs.length) {
    console.log(c(BOLD, '── Fatal signatures ' + '─'.repeat(45)))
    for (const sig of sigs.slice(0, 10)) {
      console.log(`\n  ${c(BOLD, `×${sig.count}`)} ${sig.kind}${sig.code ? ` [${sig.code}]` : ''}`)
      if (sig.message) console.log(`      ${sig.message}`)
      console.log(c(DIM, `      first ${formatLocal(sig.firstSeen)} · last ${formatLocal(sig.lastSeen)}`))
      if (sig.stack) {
        const frames = sig.stack.split('\n').slice(1, 5)
        for (const frame of frames) console.log(c(DIM, `      ${frame.trim()}`))
      }
    }
    console.log()
  }

  console.log(c(BOLD, '── Operating-system corroboration ' + '─'.repeat(31)))
  console.log(`  Crashpad minidumps: ${dumps.length ? c(YELLOW, dumps.length) : c(DIM, '0')}`)
  for (const dump of dumps.slice(0, 5)) {
    console.log(c(DIM, `    ${formatLocal(dump.mtime)}  ${formatBytes(dump.size)}  ${dump.name}`))
  }
  console.log(`  Windows Application-log faults: ${osCrashes.length ? c(YELLOW, osCrashes.length) : c(DIM, '0')}`)
  for (const entry of osCrashes.slice(0, 5)) {
    console.log(c(DIM, `    ${formatLocal(entry.ts)}  id=${entry.Id}  ${String(entry.msg).slice(0, 110)}`))
  }

  if (crashes.length && dumps.length === 0 && osCrashes.length === 0) {
    console.log()
    console.log(c(YELLOW, '  Deaths recorded, but no native dump and no OS fault.'))
    console.log(
      c(DIM, '  That combination means the process was not killed by a hardware fault: it was an\n') +
        c(DIM, '  unhandled JS exception, an explicit quit, or an out-of-memory kill. Check the\n') +
        c(DIM, '  fatal signatures above and the memory trend in events.jsonl.')
    )
  }
  console.log()
}

main()
