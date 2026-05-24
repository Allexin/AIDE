import { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/ptyManager'

interface WsClient {
  readonly readyState: number
  send(data: string): void
}

const WS_OPEN = 1

export class PtyBridge {
  private locks = new Map<string, WsClient>()
  private unsubs = new Map<string, () => void>()
  private clientTabs = new Map<WsClient, Set<string>>()

  onLockChanged?: (tabId: string, locked: boolean) => void

  constructor(private ptyRegistry: Map<BrowserWindow, PtyManager>) {}

  private findManager(tabId: string): PtyManager | null {
    for (const mgr of this.ptyRegistry.values()) {
      if (mgr.getTabs().some((t) => t.tabId === tabId)) return mgr
    }
    return null
  }

  takeTab(client: WsClient, tabId: string, cols: number, rows: number): boolean {
    const existing = this.locks.get(tabId)
    if (existing && existing !== client) return false

    const mgr = this.findManager(tabId)
    if (!mgr) return false

    mgr.resize(tabId, cols, rows)

    const unsub = mgr.subscribeToOutput(tabId, (data) => {
      if (client.readyState === WS_OPEN) {
        client.send(JSON.stringify({ type: 'output', tabId, data }))
      }
    })

    this.locks.set(tabId, client)
    this.unsubs.set(tabId, unsub)

    let tabs = this.clientTabs.get(client)
    if (!tabs) { tabs = new Set(); this.clientTabs.set(client, tabs) }
    tabs.add(tabId)

    this.onLockChanged?.(tabId, true)
    return true
  }

  releaseTab(client: WsClient, tabId: string): void {
    if (this.locks.get(tabId) !== client) return
    this._doRelease(tabId)
    this.clientTabs.get(client)?.delete(tabId)
  }

  releaseAll(client: WsClient): void {
    const tabs = this.clientTabs.get(client)
    if (!tabs) return
    for (const tabId of [...tabs]) {
      if (this.locks.get(tabId) === client) this._doRelease(tabId)
    }
    this.clientTabs.delete(client)
  }

  forceRelease(tabId: string): void {
    const client = this.locks.get(tabId)
    if (!client) return
    this._doRelease(tabId)
    this.clientTabs.get(client)?.delete(tabId)
  }

  writeToTab(client: WsClient, tabId: string, data: string): void {
    if (this.locks.get(tabId) !== client) return
    this.findManager(tabId)?.write(tabId, data)
  }

  resizeTab(client: WsClient, tabId: string, cols: number, rows: number): void {
    if (this.locks.get(tabId) !== client) return
    this.findManager(tabId)?.resize(tabId, cols, rows)
  }

  getAllTabs(): Array<{ tabId: string; sessionId: string | null; toolId: string; toolName: string; locked: boolean }> {
    const result: Array<{ tabId: string; sessionId: string | null; toolId: string; toolName: string; locked: boolean }> = []
    for (const mgr of this.ptyRegistry.values()) {
      for (const tab of mgr.getTabs()) {
        result.push({ ...tab, locked: this.locks.has(tab.tabId) })
      }
    }
    return result
  }

  private _doRelease(tabId: string): void {
    this.unsubs.get(tabId)?.()
    this.unsubs.delete(tabId)
    this.locks.delete(tabId)
    this.onLockChanged?.(tabId, false)
  }
}
