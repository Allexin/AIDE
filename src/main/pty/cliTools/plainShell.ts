import type { CliTool } from './types'

export const plainShellTool: CliTool = {
  id: 'plain-shell',
  name: 'Terminal',

  async isInstalled(): Promise<boolean> {
    return true
  },

  newSessionCommand(): string {
    return ''
  },

  resumeCommand(_sessionId: string): string {
    return ''
  },

  async scanSessions(_projectPath: string) {
    return []
  },

  watchForNewSessions(_projectPath, _onNew) {
    return () => {}
  },

  hasAccountSystem(): boolean {
    return false
  }
}
