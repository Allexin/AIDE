import { BrowserWindow } from 'electron'
import type { PtyManager } from './ptyManager'

/** Maps editor BrowserWindow → PtyManager */
export const ptyRegistry = new Map<BrowserWindow, PtyManager>()

/** Maps session picker BrowserWindow → editor BrowserWindow */
export const pickerEditorMap = new Map<BrowserWindow, BrowserWindow>()

/** Close all tabs for the given tool and open a fresh session in each window. */
export function restartToolSessions(toolId: string): void {
  for (const mgr of ptyRegistry.values()) {
    if (mgr.hasTool(toolId)) {
      mgr.resetAllTabs()
    }
  }
}
