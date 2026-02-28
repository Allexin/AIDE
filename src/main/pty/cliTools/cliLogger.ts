import { BrowserWindow } from 'electron'

type WindowProvider = () => Iterable<BrowserWindow>

let getWindows: WindowProvider = () => []

/** Call once at startup to wire the logger to the editor windows. */
export function initCliLogger(provider: WindowProvider): void {
  getWindows = provider
}

/** Send a log line to every renderer's LogPanel under the given channel. */
export function cliLog(channel: string, message: string): void {
  for (const win of getWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cli:log', { channel, message })
    }
  }
}
