import type { BrowserWindow } from 'electron'
import { ThinkingWatcher } from './thinkingWatcher'

/** One ThinkingWatcher per editor window, mirrors ptyRegistry structure. */
export const thinkingRegistry = new Map<BrowserWindow, ThinkingWatcher>()
