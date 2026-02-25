import { BrowserWindow } from 'electron'
import type { PtyManager } from './ptyManager'

/** Maps editor BrowserWindow → PtyManager */
export const ptyRegistry = new Map<BrowserWindow, PtyManager>()

/** Maps session picker BrowserWindow → editor BrowserWindow */
export const pickerEditorMap = new Map<BrowserWindow, BrowserWindow>()
