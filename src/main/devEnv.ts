import { delimiter, sep } from 'path'

/**
 * Sanitizes the environment AIDE hands down to every process it starts.
 *
 * A child process inherits the parent's environment block by default — on
 * Windows `CreateProcess(lpEnvironment = NULL)`, on POSIX `execve` with the
 * caller's `environ`. Applications launched through a file association get the
 * same treatment, and `ShellExecuteEx` (which backs `shell.openPath`) has no
 * environment parameter at all, so the only place to control what they see is
 * our own `process.env`.
 *
 * In dev the launcher pollutes that environment. `electron-vite` adds
 * NODE_ENV=development and ELECTRON_RENDERER_URL; `npm run` adds the npm_* block
 * plus INIT_CWD, and prepends every ancestor `node_modules/.bin` to PATH. None
 * of it belongs to the user's session, and all of it leaked into pty shells,
 * toolbar processes, and externally opened applications. One such application
 * (MarkText, a packaged electron-vite app that decides it is in development from
 * NODE_ENV alone) then loaded AIDE's dev server instead of its own renderer.
 *
 * We capture the one value AIDE itself needs and strip the rest, so a dev run
 * spawns processes with the same environment a packaged build would.
 *
 * This module runs on import and must be imported before any window is created
 * or any process is spawned. Window modules use `rendererDevUrl` instead of
 * reading process.env.
 */

/** electron-vite's renderer dev server URL, captured before it is stripped. */
export const rendererDevUrl: string | null = process.env['ELECTRON_RENDERER_URL'] ?? null

/** What the sanitize pass removed — reported to diagnostics once it is up. */
export interface StrippedDevEnv {
  vars: string[]
  pathEntries: string[]
}

/**
 * Variables npm injects into a `npm run` script. Deliberately an explicit list
 * rather than an `npm_*` prefix match: a user-defined NPM_TOKEN and friends live
 * in the same namespace and must survive, or `npm install` from AIDE's terminal
 * loses its registry credentials.
 */
const NPM_INJECTED_EXACT = new Set([
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'npm_lifecycle_event',
  'npm_lifecycle_script',
  // Set by the npm.cmd shim on Windows.
  'npm_cli_js',
  'npm_prefix_js',
  'npm_prefix_npm_cli_js'
])

const NPM_INJECTED_PREFIXES = ['npm_config_', 'npm_package_']

function isNpmInjected(key: string): boolean {
  const lower = key.toLowerCase()
  return NPM_INJECTED_EXACT.has(lower) || NPM_INJECTED_PREFIXES.some((p) => lower.startsWith(p))
}

function isNpmBinDir(entry: string): boolean {
  const normalized = entry.replace(/[\/]+$/, '').toLowerCase()
  return normalized.endsWith(`node_modules${sep}.bin`) || normalized.endsWith('node_modules/.bin')
}

function stripDevEnv(): StrippedDevEnv {
  const vars: string[] = []
  const pathEntries: string[] = []

  const remove = (key: string): void => {
    if (process.env[key] === undefined) return
    delete process.env[key]
    vars.push(key)
  }

  remove('ELECTRON_RENDERER_URL')
  if (process.env['NODE_ENV'] === 'development') remove('NODE_ENV')

  // `npm run` was our launcher: drop everything it injected, including the
  // node_modules/.bin entries it prepended to PATH. Outside an npm launch a
  // node_modules/.bin on PATH is the user's own choice and is left alone.
  const launchedByNpm =
    process.env['npm_execpath'] !== undefined || process.env['npm_lifecycle_event'] !== undefined

  for (const key of Object.keys(process.env)) {
    if (isNpmInjected(key)) remove(key)
  }
  remove('INIT_CWD')

  if (launchedByNpm && process.env['PATH']) {
    const entries = process.env['PATH'].split(delimiter)
    const kept = entries.filter((entry) => {
      if (!entry || !isNpmBinDir(entry)) return true
      pathEntries.push(entry)
      return false
    })
    if (pathEntries.length > 0) process.env['PATH'] = kept.join(delimiter)
  }

  return { vars, pathEntries }
}

export const strippedDevEnv: StrippedDevEnv = stripDevEnv()
