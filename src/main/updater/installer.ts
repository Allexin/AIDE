import { createHash } from 'crypto'
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'

export interface ReleaseAsset {
  name: string
  url: string
}

export interface InstallAssets {
  archive: ReleaseAsset
  checksums: ReleaseAsset
}

export const CHECKSUMS_ASSET = 'SHA256SUMS'
const DOWNLOAD_URL_PREFIX = 'https://github.com/Allexin/AIDE/releases/download/'

/** The assets a self-update needs, or null: older releases have no checksums and stay manual. */
export function selectInstallAssets(assets: ReleaseAsset[] | undefined, version: string): InstallAssets | null {
  const find = (name: string): ReleaseAsset | undefined =>
    assets?.find((asset) => asset.name === name && asset.url.startsWith(DOWNLOAD_URL_PREFIX))
  const archive = find(`AIDE-${version}-portable.7z`)
  const checksums = find(CHECKSUMS_ASSET)
  return archive && checksums ? { archive, checksums } : null
}

/** The hash of `fileName` in a `sha256sum`-format file, lower-cased, or null. */
export function findChecksum(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === fileName) return match[1].toLowerCase()
  }
  return null
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** Stream `url` into `dest` and return the SHA-256 of what arrived. */
export async function downloadFile(
  fetchFn: FetchLike,
  url: string,
  dest: string,
  options: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void } = {}
): Promise<string> {
  const response = await fetchFn(url, { signal: options.signal })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : null

  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      received += chunk.length
      options.onProgress?.(received, total)
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), meter, createWriteStream(dest), { signal: options.signal })
  if (total !== null && received !== total) throw new Error(`Download incomplete: ${received} of ${total} bytes`)
  return hash.digest('hex')
}

/** The folder of an unpacked build: the archive root, or its only subfolder. Null when it is not a build. */
export function findBuildRoot(unpackedDir: string, exeName: string): string | null {
  const isBuild = (dir: string): boolean =>
    existsSync(join(dir, exeName)) && existsSync(join(dir, 'resources', 'app.asar'))
  if (isBuild(unpackedDir)) return unpackedDir
  const entries = readdirSync(unpackedDir)
  if (entries.length !== 1) return null
  const only = join(unpackedDir, entries[0])
  return statSync(only).isDirectory() && isBuild(only) ? only : null
}

export interface AideProcess {
  pid: number
  commandLine: string | null
  title?: string | null
}

/**
 * Other AIDE instances among the processes of one executable. The rest are not
 * instances: Chromium's helpers carry `--type=`, an MCP shim runs the same exe in Node mode.
 */
export function otherInstances(processes: AideProcess[], selfPid: number): AideProcess[] {
  return processes.filter((process) =>
    process.pid !== selfPid &&
    !process.commandLine?.includes('--type=') &&
    !process.commandLine?.includes('aide-mcp.cjs'))
}

export const STAGING_PREFIX = 'staging-'
export const APPLY_CONFIG = 'apply.json'
const STARTED_MARKER = 'started'
const RESULT_FILE = 'result.json'
const HELPER_LOG = 'helper.log'

export interface SettledUpdate {
  /** Why the last update did not apply; the previous version is running again. */
  error?: string
  /** What the helper logged about that failure. */
  log?: string
}

function readResult(path: string): { ok?: boolean; error?: string } {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { ok?: boolean; error?: string }
  } catch {
    return { ok: false, error: 'The update helper left an unreadable result.' }
  }
}

/**
 * Called at every start. Reports to the helper when it is waiting for this version
 * (`started`), reads its result when it has finished, and removes what is left over.
 * A staging folder of a live process belongs to another instance's download and stays.
 */
export function settleUpdateFolder(updateDir: string, isAlive: (pid: number) => boolean): SettledUpdate {
  if (!existsSync(updateDir)) return {}

  if (existsSync(join(updateDir, APPLY_CONFIG))) {
    const resultPath = join(updateDir, RESULT_FILE)
    const startedPath = join(updateDir, STARTED_MARKER)
    if (!existsSync(resultPath) && !existsSync(startedPath)) {
      // First start after the swap: the helper is waiting for this.
      writeFileSync(startedPath, String(process.pid), 'utf8')
      return {}
    }
    const settled: SettledUpdate = {}
    if (existsSync(resultPath)) {
      const result = readResult(resultPath)
      if (!result.ok) {
        settled.error = result.error || 'The update was not applied.'
        const logPath = join(updateDir, HELPER_LOG)
        if (existsSync(logPath)) settled.log = readFileSync(logPath, 'utf8').slice(-4000)
      }
    }
    rmSync(updateDir, { recursive: true, force: true })
    return settled
  }

  for (const name of readdirSync(updateDir)) {
    const pid = name.startsWith(STAGING_PREFIX) ? Number(name.slice(STAGING_PREFIX.length)) : NaN
    if (!Number.isInteger(pid) || !isAlive(pid)) rmSync(join(updateDir, name), { recursive: true, force: true })
  }
  if (readdirSync(updateDir).length === 0) rmSync(updateDir, { recursive: true, force: true })
  return {}
}
