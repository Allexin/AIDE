import { app, BrowserWindow } from 'electron'
import { initAppConfig } from './config/appConfig'
import { releaseLock } from './lock'
import { createPickerWindow } from './windows/picker'
import { setupIpcHandlers } from './ipc'

// Map of projectPath → editor BrowserWindow
const openProjects = new Map<string, BrowserWindow>()

app.whenReady().then(() => {
  initAppConfig()
  setupIpcHandlers(openProjects)
  createPickerWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPickerWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  for (const [projectPath] of openProjects) {
    releaseLock(projectPath)
  }
})
