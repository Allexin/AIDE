import { app, crashReporter, BrowserWindow, powerMonitor } from 'electron'
import { getHeapStatistics, getHeapSpaceStatistics, writeHeapSnapshot } from 'v8'
import { join } from 'path'
import {
  logEvent,
  markCleanExit,
  startRecorder,
  getDiagnosticsDir,
  getSessionId,
  drainCounters
} from './crashLog'

export { logEvent, getDiagnosticsDir, getSessionId, countPtyData, countIpcSend } from './crashLog'

/**
 * Wires every channel through which this app can die into the recorder.
 *
 * The motivating observation: AIDE was dying with all windows at once and
 * leaving nothing behind — no Windows Error Reporting entry, no Crashpad dump,
 * no log. All windows share one main process, so "everything died at once"
 * means the main process died; and the absence of a WER record means it was not
 * a native fault but an unhandled JS exception or a self-inflicted quit. Those
 * are precisely the deaths nothing was recording.
 */

/**
 * When false (the default) an uncaught exception is recorded and the process is
 * allowed to keep running. Node would otherwise tear the main process down, and
 * a stray `'error'` event from a socket or server is rarely a reason to lose the
 * whole editor. Set to true to restore the fail-fast behaviour.
 */
const FATAL_ON_UNCAUGHT = false

const MEMORY_SAMPLE_MS = 10_000
/** Below this fraction of the V8 cap, sample at the normal cadence. */
const HEAP_PRESSURE_RATIO = 0.6
/** Under pressure the heap can go from comfortable to dead inside one minute. */
const MEMORY_SAMPLE_PRESSURE_MS = 2_000

let installed = false

/**
 * Sample memory so an out-of-memory death is visible in hindsight. V8 aborts on
 * heap exhaustion without raising a JavaScript exception, so a trend line is the
 * only evidence such a death ever leaves.
 *
 * The cadence tightens once the heap crosses a fraction of the V8 cap: a runaway
 * allocation can cover the remaining distance in seconds, and a coarse interval
 * leaves exactly the final moments unrecorded.
 */
let heapSnapshotTaken = false

/**
 * Write one V8 heap snapshot per session when pressure is first detected.
 *
 * This is the only measurement that names the retainer outright rather than
 * inferring it, but it is expensive: the file is roughly the size of the heap
 * and the process is frozen while it is written. It therefore stays behind
 * `AIDE_HEAP_SNAPSHOT=1` — enable it for a session you expect to crash, then
 * open the `.heapsnapshot` in Chrome DevTools under Memory.
 */
function maybeWriteHeapSnapshot(heapUsedMb: number): void {
  if (heapSnapshotTaken || process.env.AIDE_HEAP_SNAPSHOT !== '1') return
  heapSnapshotTaken = true
  const target = join(getDiagnosticsDir(), `heap-${getSessionId()}-${Date.now()}.heapsnapshot`)
  logEvent('heap-snapshot-writing', { target, heapUsedMb }, 'warn')
  try {
    const startedAt = Date.now()
    writeHeapSnapshot(target)
    logEvent('heap-snapshot-written', { target, elapsedMs: Date.now() - startedAt }, 'warn')
  } catch (err) {
    logEvent('heap-snapshot-failed', { message: (err as Error)?.message ?? String(err) }, 'warn')
  }
}

function startMemorySampling(): void {
  const heapLimitMb = Math.round(getHeapStatistics().heap_size_limit / 1048576)
  let underPressure = false
  let timer: NodeJS.Timeout | null = null

  const sample = (): void => {
    const mem = process.memoryUsage()
    const heapUsedMb = Math.round(mem.heapUsed / 1048576)
    const ratio = heapLimitMb > 0 ? mem.heapUsed / 1048576 / heapLimitMb : 0
    const flow = drainCounters()
    const nowUnderPressureCheck = ratio >= HEAP_PRESSURE_RATIO
    const data: Record<string, unknown> = {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb,
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      externalMb: Math.round(mem.external / 1048576),
      heapLimitMb,
      heapPct: Math.round(ratio * 100),
      windows: BrowserWindow.getAllWindows().length,
      // Throughput since the previous sample — the traffic that produced this heap.
      ptyChunks: flow.ptyChunks,
      ptyMb: Math.round((flow.ptyBytes / 1048576) * 10) / 10,
      ipcSends: flow.ipcSends
    }

    // Which V8 space holds the memory narrows the culprit by object class:
    // `large_object_space` means big buffers or strings, `old_space` means many
    // ordinary retained objects. Cheap enough to gather, but only worth the log
    // volume once something is actually wrong.
    if (nowUnderPressureCheck) {
      data.spaces = getHeapSpaceStatistics()
        .filter((s) => s.space_used_size > 16 * 1048576)
        .map((s) => `${s.space_name}=${Math.round(s.space_used_size / 1048576)}MB`)
        .join(' ')
    }

    const nowUnderPressure = nowUnderPressureCheck
    if (nowUnderPressure && !underPressure) {
      logEvent('heap-pressure-entered', data, 'warn')
      maybeWriteHeapSnapshot(heapUsedMb)
    } else if (!nowUnderPressure && underPressure) {
      logEvent('heap-pressure-left', data)
    }
    logEvent('memory-sample', data, nowUnderPressure ? 'warn' : 'info')

    if (nowUnderPressure !== underPressure) {
      underPressure = nowUnderPressure
      if (timer) clearInterval(timer)
      timer = setInterval(sample, underPressure ? MEMORY_SAMPLE_PRESSURE_MS : MEMORY_SAMPLE_MS)
      timer.unref?.()
    }
  }

  timer = setInterval(sample, MEMORY_SAMPLE_MS)
  timer.unref?.()
}

function installProcessHandlers(): void {
  process.on('uncaughtException', (err: Error, origin) => {
    logEvent(
      'uncaught-exception',
      {
        origin,
        name: err?.name ?? null,
        message: err?.message ?? String(err),
        code: (err as NodeJS.ErrnoException)?.code ?? null,
        syscall: (err as NodeJS.ErrnoException)?.syscall ?? null,
        stack: err?.stack ?? null
      },
      'fatal'
    )
    if (FATAL_ON_UNCAUGHT) {
      markCleanExit('uncaught-exception', 1)
      process.exit(1)
    }
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : null
    logEvent(
      'unhandled-rejection',
      {
        name: err?.name ?? null,
        message: err?.message ?? String(reason),
        code: (err as NodeJS.ErrnoException | null)?.code ?? null,
        stack: err?.stack ?? null
      },
      'fatal'
    )
  })

  // Fires for an orderly interpreter shutdown, including `app.quit()` paths that
  // skip our Electron listeners.
  process.on('exit', (code) => {
    markCleanExit('process-exit', code)
  })

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      logEvent('signal', { signal }, 'warn')
      markCleanExit(`signal:${signal}`)
      process.exit(0)
    })
  }
}

function installAppHandlers(): void {
  // A renderer dying takes its window but leaves main alive — worth recording
  // separately so we can tell "the window vanished" from "the app vanished".
  app.on('render-process-gone', (_e, contents, details) => {
    let url = ''
    try {
      url = contents.getURL()
    } catch {
      // Contents may already be destroyed.
    }
    logEvent(
      'render-process-gone',
      { reason: details.reason, exitCode: details.exitCode, url },
      details.reason === 'clean-exit' ? 'info' : 'fatal'
    )
  })

  // Covers the GPU process, network/audio utilities and — importantly here —
  // anything the pty layer spawns as a helper.
  app.on('child-process-gone', (_e, details) => {
    logEvent(
      'child-process-gone',
      {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName ?? null,
        name: details.name ?? null
      },
      details.reason === 'clean-exit' ? 'info' : 'warn'
    )
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.on('unresponsive', () => {
      let url = ''
      try {
        url = contents.getURL()
      } catch {
        // Ignore.
      }
      logEvent('renderer-unresponsive', { url }, 'warn')
    })
    contents.on('responsive', () => logEvent('renderer-responsive'))
    contents.on('preload-error', (_ev, preloadPath, error) => {
      logEvent('preload-error', { preloadPath, message: error?.message ?? String(error) }, 'fatal')
    })
  })

  app.on('before-quit', () => logEvent('app-before-quit'))
  app.on('will-quit', () => logEvent('app-will-quit'))
  app.on('quit', (_e, exitCode) => markCleanExit('app-quit', exitCode))

  // A second instance being denied, or the OS asking us to close, both look like
  // spontaneous death from the outside.
  app.on('second-instance', (_e, argv) => logEvent('second-instance', { argv }))
  app.on('window-all-closed', () => logEvent('window-all-closed'))
}

function installPowerHandlers(): void {
  // `powerMonitor` throws if touched before the app is ready, and diagnostics
  // start well before that, so subscribe once ready.
  app.whenReady().then(() => {
    try {
      powerMonitor.on('suspend', () => logEvent('power-suspend'))
      powerMonitor.on('resume', () => logEvent('power-resume'))
      powerMonitor.on('shutdown', () => {
        logEvent('power-shutdown', undefined, 'warn')
        markCleanExit('os-shutdown')
      })
    } catch {
      // Non-essential: sleep/shutdown context only.
    }
  })
}

/**
 * Start diagnostics. Call as early as possible in the main entry point —
 * `crashReporter` must start before the first crash, and the recorder must be
 * live before any startup code can throw.
 */
export function initDiagnostics(): void {
  if (installed) return
  installed = true

  // Enables Crashpad, which writes native minidumps for the main, renderer and
  // GPU processes into `userData/Crashpad`. Nothing is uploaded anywhere.
  try {
    crashReporter.start({
      productName: 'AIDE',
      companyName: 'AIDE',
      submitURL: '',
      uploadToServer: false,
      compress: true
    })
  } catch {
    // Not fatal — the JS-level recorder below is the primary source.
  }

  startRecorder()
  installProcessHandlers()
  installAppHandlers()
  installPowerHandlers()
  startMemorySampling()
}
