import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readOpenCodeCredentials, type OpenCodeCredential } from './openCodeScanner'
import { resolveOpenCodeExecutable } from '../../pipeline/headless/openCodeHeadless'
import { cliLog } from './cliLogger'

/**
 * OpenCode 2 accounts for AIDE's account storage. OpenCode keeps credentials per
 * provider in its database (`credential`: provider, label, value, active), and
 * sends a provider the active one. An AIDE account is the set of active
 * credentials at the time it was saved, one per provider.
 *
 * Reads come from the database; writes go through `opencode auth logout` /
 * `opencode auth import` (with --standalone, so no background service holds a
 * stale copy). `auth import` only adds credentials with ids it does not have and
 * ignores `active`, and a credential imported into a provider without others
 * becomes active — so loading an account first logs out the provider's
 * credentials, then imports the saved one. Verified against opencode 2.1.4.
 */

const LOG_CH = 'OpenCode'

export interface OpenCodeAccount {
  credentials: OpenCodeCredential[]
}

function run(args: string[]): Promise<void> {
  const executable = resolveOpenCodeExecutable()
  if (!executable) return Promise.reject(new Error('OpenCode 2 executable was not found'))
  return new Promise((resolve, reject) => {
    execFile(executable, [...args, '--standalone'], { timeout: 60_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`opencode ${args.slice(0, 2).join(' ')} failed: ${String(stderr || err.message).trim().slice(0, 300)}`))
      else resolve()
    })
  })
}

export function activeOpenCodeCredentials(): OpenCodeCredential[] {
  return readOpenCodeCredentials().filter((credential) => credential.active)
}

/** "DeepSeek · key …a1b2" per provider: enough to tell saved accounts apart without showing a secret. */
export function describeOpenCodeCredentials(credentials: OpenCodeCredential[]): string | null {
  if (credentials.length === 0) return null
  return credentials.map((credential) => {
    const key = typeof credential.value.key === 'string' ? credential.value.key : ''
    const tail = key.length >= 8 ? ` …${key.slice(-4)}` : ''
    return `${credential.integrationID}: ${credential.label}${tail}`
  }).join(', ')
}

export async function importOpenCodeAccount(account: OpenCodeAccount): Promise<void> {
  const current = readOpenCodeCredentials()
  const dir = mkdtempSync(join(tmpdir(), 'aide-opencode-auth-'))
  try {
    for (const saved of account.credentials) {
      for (const existing of current.filter((c) => c.integrationID === saved.integrationID)) {
        await run(['auth', 'logout', saved.integrationID, existing.id])
      }
      const file = join(dir, `${saved.integrationID}.json`)
      writeFileSync(file, JSON.stringify([{ ...saved, active: true }]), 'utf8')
      await run(['auth', 'import', file])
    }
  } catch (err) {
    cliLog(LOG_CH, `[auth] loading the account failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
