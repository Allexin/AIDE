import { BrowserWindow, dialog } from 'electron'
import type { PtyManager } from './ptyManager'
import { getToolById } from './cliTools/registry'

/** Maps editor BrowserWindow → PtyManager */
export const ptyRegistry = new Map<BrowserWindow, PtyManager>()

/** Maps session picker BrowserWindow → editor BrowserWindow */
export const pickerEditorMap = new Map<BrowserWindow, BrowserWindow>()

/**
 * After a credential change, ask whether to restart the tool's open sessions in every window.
 * Tools whose live sessions pick up the new account themselves are not asked about; other
 * tools' tabs are never touched.
 */
export async function offerRestartAfterAccountChange(toolId: string, parent?: BrowserWindow | null): Promise<void> {
  const tool = getToolById(toolId)
  if (tool?.accountSwitchNeedsRestart?.() === false) return

  let count = 0
  for (const mgr of ptyRegistry.values()) count += mgr.countToolTabs(toolId)
  if (count === 0) return

  const name = tool?.name ?? toolId
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Restart sessions?',
    message: `Restart ${count} ${name} session${count === 1 ? '' : 's'}?`,
    detail: `The ${name} account has changed. Sessions that are not restarted keep using the previous account.`,
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1
  }
  const { response } = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return

  for (const mgr of ptyRegistry.values()) await mgr.restartToolTabs(toolId)
}
