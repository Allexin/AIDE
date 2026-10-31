import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import https from 'https'
import { getAppConfig } from '../config/appConfig'
import { selectInstallAssets, type InstallAssets, type ReleaseAsset } from './installer'
import { canSelfUpdate, settleLastUpdate } from './selfUpdate'

export const RELEASES_URL = 'https://github.com/Allexin/AIDE/releases'
const RELEASES_API_URL = 'https://api.github.com/repos/Allexin/AIDE/releases?per_page=100'

export interface ReleaseInfo {
  version: string // e.g. "0.1.144"
  notes: string   // changelog text (markdown)
  assets?: ReleaseAsset[]
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  newReleases: ReleaseInfo[] // releases newer than current, newest first
  hasUpdate: boolean
  shouldNotify: boolean
  lastCheckedAt: number | null
  /** The latest release can be installed in place; otherwise only "go to download". */
  canInstall: boolean
}

interface UpdatesState {
  lastCheckedAt: number
  lastNotifiedAt: number
  skippedVersion: string | null
  cachedReleases: ReleaseInfo[]
}

interface GitHubRelease {
  tag_name: string
  body: string | null
  draft: boolean
  prerelease: boolean
  assets?: Array<{ name: string; browser_download_url: string }>
}

let stateFilePath = ''
let state: UpdatesState = {
  lastCheckedAt: 0,
  lastNotifiedAt: 0,
  skippedVersion: null,
  cachedReleases: []
}

export function initUpdater(): void {
  stateFilePath = join(app.getPath('userData'), 'aide-updates.json')
  if (existsSync(stateFilePath)) {
    try {
      const raw = readFileSync(stateFilePath, 'utf8')
      state = { ...state, ...(JSON.parse(raw) as Partial<UpdatesState>) }
    } catch {
      // use defaults
    }
  }

  // A failed update reopens the dialog with its error instead of waiting for the next reminder.
  if (settleLastUpdate()) state.lastNotifiedAt = 0

  void checkForUpdates()
  setInterval(() => { void checkForUpdates() }, 24 * 60 * 60 * 1000)
}

function saveState(): void {
  try {
    writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // ignore write errors
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function fetchPage(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) { reject(new Error('Too many redirects')); return }
    https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AIDE-Updater/1.0'
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject)
        res.resume()
        return
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`GitHub API returned HTTP ${res.statusCode ?? 'unknown'}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function parseReleases(json: string): ReleaseInfo[] {
  const payload: unknown = JSON.parse(json)
  if (!Array.isArray(payload)) throw new Error('Unexpected GitHub releases response')

  return (payload as GitHubRelease[]).flatMap(release => {
    if (release.draft || release.prerelease || typeof release.tag_name !== 'string') return []

    const versionMatch = /^v?(\d+(?:\.\d+)+)$/.exec(release.tag_name.trim())
    if (!versionMatch) return []

    const body = typeof release.body === 'string' ? release.body.trim() : ''
    const notesMatch = /AIDE Stable Release\s+v?[\d.]+\s*([\s\S]*?)AIDE Release Date[^\n]*/.exec(body)
    const assets = (release.assets ?? []).map(asset => ({ name: asset.name, url: asset.browser_download_url }))
    return [{ version: versionMatch[1], notes: notesMatch?.[1].trim() ?? body, assets }]
  })
}

export async function checkForUpdates(): Promise<void> {
  try {
    const json = await fetchPage(RELEASES_API_URL)
    state.cachedReleases = parseReleases(json)
    state.lastCheckedAt = Date.now()
    saveState()
    broadcastStatusChanged()
  } catch {
    // network error — keep cached state, still broadcast
    broadcastStatusChanged()
  }
}

function getFrequencyMs(): number | null {
  const freq = getAppConfig().updates?.notifyFrequency ?? 'daily'
  switch (freq) {
    case 'never':   return null
    case 'daily':   return 24 * 60 * 60 * 1000
    case 'weekly':  return 7 * 24 * 60 * 60 * 1000
    case 'monthly': return 30 * 24 * 60 * 60 * 1000
    default:        return 24 * 60 * 60 * 1000
  }
}

export function getUpdateStatus(): UpdateStatus {
  const currentVersion = app.getVersion()

  const newReleases = state.cachedReleases
    .filter(r => compareVersions(r.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))

  const latestVersion = newReleases[0]?.version ?? null
  const hasUpdate = newReleases.length > 0

  let shouldNotify = false
  if (hasUpdate && latestVersion) {
    const freqMs = getFrequencyMs()
    if (freqMs !== null) {
      const elapsed = Date.now() - state.lastNotifiedAt
      const notSkipped =
        !state.skippedVersion ||
        compareVersions(latestVersion, state.skippedVersion) > 0
      shouldNotify = notSkipped && elapsed > freqMs
    }
  }

  return {
    currentVersion,
    latestVersion,
    newReleases,
    hasUpdate,
    shouldNotify,
    lastCheckedAt: state.lastCheckedAt || null,
    canInstall: canSelfUpdate() && getInstallTarget() !== null
  }
}

/** The newest release newer than this version, when it has what a self-update needs. */
export function getInstallTarget(): (InstallAssets & { version: string }) | null {
  const latest = state.cachedReleases
    .filter(r => compareVersions(r.version, app.getVersion()) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
  const assets = latest ? selectInstallAssets(latest.assets, latest.version) : null
  return assets ? { ...assets, version: latest.version } : null
}

export function skipVersion(version: string): void {
  state.skippedVersion = version
  saveState()
}

export function dismissNotification(): void {
  state.lastNotifiedAt = Date.now()
  saveState()
}

function broadcastStatusChanged(): void {
  const status = getUpdateStatus()
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) {
      w.webContents.send('updater:status-changed', status)
    }
  })
}
