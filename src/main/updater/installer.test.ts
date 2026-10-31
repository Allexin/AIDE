import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadFile, findBuildRoot, findChecksum, otherInstances, selectInstallAssets, settleUpdateFolder } from './installer'

const BASE = 'https://github.com/Allexin/AIDE/releases/download/v1.2.3/'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aide-updater-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('selectInstallAssets', () => {
  const archive = { name: 'AIDE-1.2.3-portable.7z', url: `${BASE}AIDE-1.2.3-portable.7z` }
  const checksums = { name: 'SHA256SUMS', url: `${BASE}SHA256SUMS` }

  it('needs both the archive of that version and the checksums', () => {
    expect(selectInstallAssets([archive, checksums], '1.2.3')).toEqual({ archive, checksums })
    expect(selectInstallAssets([archive], '1.2.3')).toBeNull()
    expect(selectInstallAssets([checksums], '1.2.3')).toBeNull()
    expect(selectInstallAssets([archive, checksums], '1.2.4')).toBeNull()
    expect(selectInstallAssets(undefined, '1.2.3')).toBeNull()
  })

  it('refuses a download from anywhere but the release page of the repository', () => {
    expect(selectInstallAssets([{ ...archive, url: 'https://example.com/AIDE-1.2.3-portable.7z' }, checksums], '1.2.3')).toBeNull()
  })
})

describe('findChecksum', () => {
  const hash = 'A'.repeat(64)

  it('finds the line of the file, in text or binary mode, on any line ending', () => {
    expect(findChecksum(`${hash}  a.7z\n`, 'a.7z')).toBe('a'.repeat(64))
    expect(findChecksum(`${'b'.repeat(64)} *other\r\n${hash} *a.7z\r\n`, 'a.7z')).toBe('a'.repeat(64))
  })

  it('finds nothing for another file or a malformed line', () => {
    expect(findChecksum(`${hash}  b.7z\n`, 'a.7z')).toBeNull()
    expect(findChecksum('abc  a.7z\n', 'a.7z')).toBeNull()
  })
})

describe('downloadFile', () => {
  const body = Buffer.from('portable build')

  it('writes the file, reports progress and returns its hash', async () => {
    const dest = join(dir, 'out')
    const seen: number[] = []
    const hash = await downloadFile(async () => new Response(body, { headers: { 'content-length': String(body.length) } }), 'u', dest, {
      onProgress: (received) => seen.push(received)
    })
    expect(readFileSync(dest)).toEqual(body)
    expect(hash).toBe(createHash('sha256').update(body).digest('hex'))
    expect(seen.at(-1)).toBe(body.length)
  })

  it('fails on an HTTP error and on a short body', async () => {
    await expect(downloadFile(async () => new Response('no', { status: 404 }), 'u', join(dir, 'a'))).rejects.toThrow('HTTP 404')
    await expect(downloadFile(async () => new Response(body, { headers: { 'content-length': '999' } }), 'u', join(dir, 'b'))).rejects.toThrow('incomplete')
  })
})

describe('findBuildRoot', () => {
  const makeBuild = (root: string): void => {
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(join(root, 'AIDE.exe'), '')
    writeFileSync(join(root, 'resources', 'app.asar'), '')
  }

  it('accepts the archive root and its only subfolder', () => {
    makeBuild(dir)
    expect(findBuildRoot(dir, 'AIDE.exe')).toBe(dir)
  })

  it('looks one level down', () => {
    makeBuild(join(dir, 'win-unpacked'))
    expect(findBuildRoot(dir, 'AIDE.exe')).toBe(join(dir, 'win-unpacked'))
  })

  it('refuses anything else', () => {
    writeFileSync(join(dir, 'AIDE.exe'), '')
    expect(findBuildRoot(dir, 'AIDE.exe')).toBeNull()
  })
})

describe('otherInstances', () => {
  it('counts main processes only', () => {
    const others = otherInstances([
      { pid: 1, commandLine: 'AIDE.exe' },
      { pid: 2, commandLine: 'AIDE.exe E:\\project' },
      { pid: 3, commandLine: 'AIDE.exe --type=renderer --user-data-dir=x' },
      { pid: 4, commandLine: 'AIDE.exe C:\\AIDE\\resources\\app.asar.unpacked\\resources\\mcp\\aide-mcp.cjs serve' },
      { pid: 5, commandLine: null }
    ], 1)
    expect(others.map((process) => process.pid)).toEqual([2, 5])
  })
})

describe('settleUpdateFolder', () => {
  const update = (): string => join(dir, '.update')
  const dead = (): boolean => false

  beforeEach(() => { mkdirSync(update()) })

  it('tells the waiting helper it runs, and leaves its files alone', () => {
    writeFileSync(join(update(), 'apply.json'), '{}')
    expect(settleUpdateFolder(update(), dead)).toEqual({})
    expect(existsSync(join(update(), 'started'))).toBe(true)
    expect(existsSync(join(update(), 'apply.json'))).toBe(true)
  })

  it('removes the folder after a success', () => {
    writeFileSync(join(update(), 'apply.json'), '{}')
    writeFileSync(join(update(), 'result.json'), JSON.stringify({ ok: true, error: '' }))
    expect(settleUpdateFolder(update(), dead)).toEqual({})
    expect(existsSync(update())).toBe(false)
  })

  it('reports a failure with what the helper logged', () => {
    writeFileSync(join(update(), 'apply.json'), '{}')
    writeFileSync(join(update(), 'helper.log'), 'moved nothing')
    writeFileSync(join(update(), 'result.json'), JSON.stringify({ ok: false, error: 'locked' }))
    expect(settleUpdateFolder(update(), dead)).toEqual({ error: 'locked', log: 'moved nothing' })
    expect(existsSync(update())).toBe(false)
  })

  it('clears up after a helper that died without a result', () => {
    writeFileSync(join(update(), 'apply.json'), '{}')
    writeFileSync(join(update(), 'started'), '1')
    expect(settleUpdateFolder(update(), dead)).toEqual({})
    expect(existsSync(update())).toBe(false)
  })

  it('keeps the download of a live instance and removes that of a dead one', () => {
    mkdirSync(join(update(), 'staging-111'))
    mkdirSync(join(update(), 'staging-222'))
    settleUpdateFolder(update(), (pid) => pid === 111)
    expect(existsSync(join(update(), 'staging-111'))).toBe(true)
    expect(existsSync(join(update(), 'staging-222'))).toBe(false)
  })

  it('removes an abandoned download entirely', () => {
    mkdirSync(join(update(), 'staging-222'))
    settleUpdateFolder(update(), dead)
    expect(existsSync(update())).toBe(false)
  })
})
