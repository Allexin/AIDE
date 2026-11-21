import { statSync } from 'fs'
import { join } from 'path'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { findExecutable } from '../../platform'
import type { CliTool } from './types'

const TOOL_ID = 'antigravity'

function windowsInstallPath(): string | undefined {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return
  const path = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
  return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined
}

function launchCommand(): string {
  // A running AIDE may still have the PATH from before the Windows installation.
  const path = windowsInstallPath()
  return path ? `& '${path.replace(/'/g, "''")}'` : 'agy'
}

export const antigravityTool: CliTool = {
  id: TOOL_ID,
  name: 'Google Antigravity',
  installUrl: 'https://antigravity.google/docs/getting-started?tab=cli',

  async isInstalled() {
    return !!windowsInstallPath() || findExecutable('agy')
  },

  newSessionCommand: launchCommand,

  resumeCommand(sessionId) {
    if (!sessionId || /[^a-zA-Z0-9_-]/.test(sessionId)) throw new Error('Invalid Antigravity conversation ID')
    return `${launchCommand()} --conversation=${sessionId}`
  },

  exitCommand() {
    return '/exit'
  },

  // Conversation discovery stays in agy's /resume picker.
  async scanSessions() {
    return []
  },

  watchForNewSessions() {
    return () => {}
  },

  hasAccountSystem() {
    return false
  },

  settingsFields() {
    return [
      {
        key: 'proxy',
        label: 'Proxy address',
        description: 'HTTP proxy for new Antigravity tabs (e.g. http://127.0.0.1:1080). Leave empty to inherit the environment.',
        type: 'string',
        default: ''
      }
    ]
  },

  async getSettings() {
    return getToolConfig(TOOL_ID)
  },

  async updateSettings(values) {
    updateToolConfig(TOOL_ID, values)
  },

  getEnvOverrides(): Record<string, string> {
    const value = getToolConfig(TOOL_ID).proxy
    const proxy = typeof value === 'string' ? value.trim() : ''
    if (!proxy) return {}
    const bypass = 'localhost,127.0.0.1,::1'
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: bypass,
      no_proxy: bypass
    }
  }
}
