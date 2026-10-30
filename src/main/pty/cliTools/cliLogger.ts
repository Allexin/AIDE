import { BrowserWindow } from 'electron'
import { accountText } from '../../accounts/accountDisplay'

type WindowProvider = () => Iterable<BrowserWindow>
type LogObserver = (channel: string, message: string) => void

let getWindows: WindowProvider = () => []
const logObservers = new Set<LogObserver>()

/** Call once at startup to wire the logger to the editor windows. */
export function initCliLogger(provider: WindowProvider): void {
  getWindows = provider
}

export function addLogObserver(fn: LogObserver): () => void {
  logObservers.add(fn)
  return () => { logObservers.delete(fn) }
}

/** Send a log line to every renderer's LogPanel under the given channel. */
export function cliLog(channel: string, message: string): void {
  const shown = accountText(message)
  for (const obs of logObservers) obs(channel, shown)
  for (const win of getWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cli:log', { channel, message: shown })
    }
  }
}
