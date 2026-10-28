import { getToolById } from '../pty/cliTools/registry'
import { clearAccountExhausted, getActiveAccount, listAccounts, setActiveAccount, updateAccount } from '../config/accountStorage'

/**
 * Account switching without a user in the loop (the pipeline account pool).
 * The interactive paths (Account Manager, Load Account menu) ask the user about
 * a mismatch between the saved and the current login; here the current
 * credentials go back into the active account's record first when the login is
 * that account's, so a token the CLI rotated since the last save is not lost,
 * and the account that hit a limit is found by the login itself.
 */

/** When each CLI's account last changed through AIDE; a limit hit by a step started earlier belongs to the previous account. */
const switchedAt = new Map<string, number>()

export function lastAccountSwitch(toolId: string): number | undefined {
  return switchedAt.get(toolId)
}

/**
 * The saved account the CLI is logged in to, matched by its login: the recorded
 * active account is stale after a login outside AIDE. When the login is another
 * saved account, that one is recorded as active; null when the login is not a
 * saved account. Without a known login, the recorded active account.
 */
export async function currentAccount(toolId: string): Promise<string | null> {
  const activeId = getActiveAccount(toolId)
  const identifier = await getToolById(toolId)?.getLoginIdentifier?.()
  if (!identifier) return activeId
  const accounts = listAccounts(toolId)
  if (accounts.find((account) => account.id === activeId)?.identifier === identifier) return activeId
  const match = accounts.find((account) => account.identifier === identifier)
  if (!match) return null
  setActiveAccount(toolId, match.id)
  return match.id
}

/**
 * Save the CLI's current credentials into the active account's record — only
 * when the CLI is logged in to that account: another login's credentials would
 * overwrite the record and lose the account.
 */
export async function saveActiveCredentials(toolId: string): Promise<void> {
  const tool = getToolById(toolId)
  const activeId = getActiveAccount(toolId)
  if (!activeId || !tool?.exportCredentials || !tool.getLoginIdentifier) return
  // The revision is read before the credentials, so a concurrent rotation wins over this snapshot.
  const saved = listAccounts(toolId).find((account) => account.id === activeId)
  if (!saved) return
  const [credentials, identifier] = await Promise.all([tool.exportCredentials(), tool.getLoginIdentifier()])
  if (!credentials || identifier !== saved.identifier) return
  updateAccount(toolId, activeId, identifier, credentials, saved.revision)
}

/** Put a saved account's credentials into the CLI and make it the active account. */
export async function loadSavedAccount(toolId: string, accountId: string): Promise<boolean> {
  const tool = getToolById(toolId)
  const stored = listAccounts(toolId).find((account) => account.id === accountId)
  if (!tool?.importCredentials || !stored) return false
  await saveActiveCredentials(toolId)
  await tool.importCredentials(stored.credentials)
  setActiveAccount(toolId, accountId)
  switchedAt.set(toolId, Date.now())
  return true
}

/** A user loading an account by hand puts it back into the pool's rotation. */
export function accountLoadedByUser(toolId: string, accountId: string): void {
  clearAccountExhausted(toolId, accountId)
  switchedAt.set(toolId, Date.now())
}
