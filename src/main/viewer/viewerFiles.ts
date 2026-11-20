import { realpathSync, statSync, readFileSync } from 'fs'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import { spawn } from 'child_process'
import type { ViewerKind } from '../../shared/viewer/types'

/** File access for the viewer: containment, kinds, reading (docs/file-viewer-spec.md). */

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

export const MAX_TEXT_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function viewerKind(path: string): ViewerKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (IMAGE_TYPES[ext]) return 'image'
  return 'text'
}

function sameOrInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === '') return true
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false
  return true
}

/**
 * The real path of `path` (project-relative or absolute) when it is an existing file inside
 * the project; links and junctions pointing out of it are refused. Throws with a readable text.
 */
export function resolveProjectFile(projectPath: string, path: string): { absolute: string; relPath: string } {
  const root = realpathSync.native(projectPath)
  const target = resolve(root, path)
  let real: string
  try {
    real = realpathSync.native(target)
  } catch {
    throw new Error(`File not found: ${path}`)
  }
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (!sameOrInside(fold(root), fold(real))) throw new Error(`The file is outside the project: ${path}`)
  if (!statSync(real).isFile()) throw new Error(`Not a file: ${path}`)
  return { absolute: real, relPath: relative(root, real).split(sep).join('/') }
}

/** Text of a text file, a data URL of an image; throws on binary or oversized files. */
export function readForView(absolute: string, kind: ViewerKind): string {
  const size = statSync(absolute).size
  if (kind === 'image') {
    if (size > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
    return `data:${IMAGE_TYPES[extname(absolute).toLowerCase()]};base64,${readFileSync(absolute).toString('base64')}`
  }
  if (size > MAX_TEXT_BYTES) throw new Error(`The file is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB.`)
  const buffer = readFileSync(absolute)
  if (buffer.subarray(0, 8000).includes(0)) throw new Error('Cannot show a binary file.')
  return buffer.toString('utf8').replace(/^﻿/, '')
}

/** `git show HEAD:<relPath>`; '' when the file is not in HEAD, null on other failures. */
export function gitShowHead(projectPath: string, relPath: string, kind: ViewerKind): Promise<string | null> {
  return new Promise((done) => {
    const proc = spawn('git', ['show', `HEAD:${relPath}`], { cwd: projectPath, windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => { proc.kill(); done(null) }, 5000)
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('error', () => { clearTimeout(timer); done(null) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const msg = Buffer.concat(err).toString()
        done(/exists on disk|did not match any|does not exist/.test(msg) ? '' : null)
        return
      }
      const data = Buffer.concat(out)
      done(kind === 'image'
        ? `data:${IMAGE_TYPES[extname(relPath).toLowerCase()]};base64,${data.toString('base64')}`
        : data.toString('utf8').replace(/^﻿/, ''))
    })
  })
}
