import { getToolById } from '../pty/cliTools/registry'
import { getActiveAccount, listAccounts, setActiveAccount } from '../config/accountStorage'

/** The CLI's current account as the status bar shows it; `saved: false` when AIDE has no record of it. */
export interface AccountDisplay {
  label: string
  saved: boolean
}

/** The account a CLI is logged in to, for display (the status bar, the pipeline tab, the remote pipeline page). */
export async function currentAccountDisplay(toolId: string): Promise<AccountDisplay | null> {
  const tool = getToolById(toolId)
  if (!tool?.getLoginIdentifier) return null

  const identifier = await tool.getLoginIdentifier()
  if (!identifier) return null

  // Tools without account system (e.g. OpenCode) — show identifier without "not saved"
  if (!tool.hasAccountSystem()) {
    return { label: identifier, saved: true }
  }

  // First: check tracked active account
  const activeId = getActiveAccount(toolId)
  if (activeId) {
    const active = listAccounts(toolId).find((a) => a.id === activeId)
    if (active) return { label: `${active.name} (${identifier})`, saved: true }
  }

  // Fallback: find by identifier string match (e.g. email for Claude Code)
  const byIdentifier = listAccounts(toolId).find((a) => a.identifier === identifier)
  if (byIdentifier) {
    setActiveAccount(toolId, byIdentifier.id)
    return { label: `${byIdentifier.name} (${identifier})`, saved: true }
  }

  return { label: `account not saved (${identifier})`, saved: false }
}
