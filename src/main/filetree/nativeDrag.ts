import { app, nativeImage, type NativeImage, type WebContents } from 'electron'
import { statSync } from 'fs'
import { extname } from 'path'

// OS-level drag of a file-tree entry (file or folder) out of AIDE: to Explorer,
// DaVinci Resolve, any app that takes file drops — and back into AIDE itself,
// where drop targets read the path from dataTransfer.files like any external drop.

// Windows refuses a drag without an image, and app.getFileIcon is asynchronous,
// so icons are cached per kind (folder / extension) to keep later drags instant.
const iconCache = new Map<string, NativeImage>()

let fallback: NativeImage | null = null
function fallbackIcon(): NativeImage {
  if (!fallback) {
    const size = 16
    const bgra = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) bgra.set([0xcc, 0xcc, 0xcc, 0xff], i * 4)
    fallback = nativeImage.createFromBitmap(bgra, { width: size, height: size })
  }
  return fallback
}

async function iconFor(path: string, isDir: boolean): Promise<NativeImage> {
  const key = isDir ? '<dir>' : extname(path).toLowerCase() || '<none>'
  const cached = iconCache.get(key)
  if (cached) return cached
  let icon: NativeImage
  try {
    icon = await app.getFileIcon(path, { size: 'normal' })
  } catch {
    icon = fallbackIcon()
  }
  if (icon.isEmpty()) icon = fallbackIcon()
  iconCache.set(key, icon)
  return icon
}

export async function startNativeDrag(sender: WebContents, path: string): Promise<void> {
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return
  }
  const icon = await iconFor(path, isDir)
  if (sender.isDestroyed()) return
  sender.startDrag({ file: path, icon })
}
