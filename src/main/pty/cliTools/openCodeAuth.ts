import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readOpenCodeCredentials, type OpenCodeCredential } from './openCodeScanner'
import { homedir } from 'os'
import { readJsonc, resolveOpenCodeExecutable } from '../../pipeline/headless/openCodeHeadless'
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

/**
 * The credentials OpenCode sends, one set per provider: the active ones, or — for a
 * provider without an active one — those with `active` unset (migrated from 1.x).
 */
export function effectiveOpenCodeCredentials(all: OpenCodeCredential[]): OpenCodeCredential[] {
  const withActive = new Set(all.filter((c) => c.active === true).map((c) => c.integrationID))
  return all.filter((c) => c.active === true || (c.active === null && !withActive.has(c.integrationID)))
}

export function activeOpenCodeCredentials(): OpenCodeCredential[] {
  return effectiveOpenCodeCredentials(readOpenCodeCredentials())
}

/**
 * "deepseek: DeepSeek …a1b2, opencode: Personal (me@example.com)" — enough to tell saved
 * accounts apart without showing a secret: the end of an API key, the email of an OAuth login.
 */
export function describeOpenCodeCredentials(credentials: OpenCodeCredential[]): string | null {
  if (credentials.length === 0) return null
  return credentials.map((credential) => {
    const key = typeof credential.value.key === 'string' ? credential.value.key : ''
    const metadata = credential.value.metadata as { email?: unknown } | undefined
    const email = typeof metadata?.email === 'string' && metadata.email ? ` (${metadata.email})` : ''
    const tail = key.length >= 8 ? ` …${key.slice(-4)}` : ''
    return `${credential.integrationID}: ${credential.label}${email || tail}`
  }).join(', ')
}

/** Providers whose API key is written in the user's opencode.json — keys OpenCode uses but AIDE cannot save. */
export function configKeyProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(homedir(), '.config', 'opencode')
  const providers = new Set<string>()
  for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
    const provider = readJsonc(join(dir, name))?.provider
    if (!provider || typeof provider !== 'object') continue
    for (const [id, entry] of Object.entries(provider as Record<string, unknown>)) {
      const options = (entry as { options?: { apiKey?: unknown } } | null)?.options
      if (typeof options?.apiKey === 'string' && options.apiKey) providers.add(id)
    }
  }
  return [...providers]
}

/** The Account Manager's explanation when OpenCode works without a credential AIDE can save. */
export function openCodeAccountHint(credentials: OpenCodeCredential[], keyedProviders: string[]): string | null {
  const saved = new Set(credentials.map((c) => c.integrationID))
  const outside = keyedProviders.filter((id) => !saved.has(id))
  const howTo = 'Add a key with "opencode auth login <provider>", then save the account here.'
  if (credentials.length === 0) {
    return 'OpenCode has no provider credentials stored, so there is nothing to save. Free models need none' +
      (outside.length ? `; the key${outside.length > 1 ? 's' : ''} of ${outside.join(', ')} in opencode.json ${outside.length > 1 ? 'are' : 'is'} not a stored credential and cannot be saved. ` : '. ') + howTo
  }
  if (outside.length) {
    return `The key${outside.length > 1 ? 's' : ''} of ${outside.join(', ')} in opencode.json ${outside.length > 1 ? 'are' : 'is'} not part of a saved account. ${howTo}`
  }
  return null
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
