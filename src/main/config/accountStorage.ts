import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

type BetterSqlite3Database = import('better-sqlite3').Database

/** Full account record stored on disk (credentials included). */
export interface CliAccount {
  id: string
  name: string
  identifier: string // human-readable login identifier (e.g. email)
  savedAt: string // ISO 8601
  credentials: Record<string, unknown>
  /** Monotonic row version used to reject stale concurrent token updates. */
  revision: number
}

/** Account info safe to send to renderer (no credentials). */
export interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
  /** Checked for automatic switching when a pipeline step hits a usage limit. */
  inPool: boolean
  /** Set while the account is out of the pool's rotation after hitting a limit;
   *  `exhaustedUntil` is when it resets, null when that is not known. */
  exhausted: boolean
  exhaustedUntil: string | null
}

export interface SubscriptionUsageCache {
  payload: Record<string, unknown>
  fetchedAtMs: number
  source: string
}

interface AccountRow {
  id: string
  name: string
  identifier: string
  saved_at: string
  credentials_json: string
  revision: number
  in_pool: number
  exhausted_at_ms: number | null
  exhausted_until_ms: number | null
}

interface LegacyAccount {
  id: string
  name: string
  identifier: string
  savedAt: string
  credentials: Record<string, unknown>
}

type LegacyAccountsFile = Record<string, LegacyAccount[]>
type LegacyActiveAccountsFile = Record<string, string | null>

const MIGRATION_KEY = 'json_accounts_migrated_v1'
let database: BetterSqlite3Database | null = null

function db(): BetterSqlite3Database {
  if (!database) throw new Error('Account storage is not initialized')
  return database
}

function readLegacyJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function moveLegacyFileToBackup(path: string): void {
  if (!existsSync(path)) return
  let backup = `${path}.migrated.bak`
  let suffix = 1
  while (existsSync(backup)) {
    backup = `${path}.migrated.${suffix}.bak`
    suffix += 1
  }
  try {
    renameSync(path, backup)
  } catch {
    // Migration is already committed. Leaving the legacy file in place is
    // safer than failing application startup; the metadata marker prevents a
    // second import.
  }
}

function migrateLegacyJson(accountsPath: string, activeAccountsPath: string): void {
  const storage = db()
  const migrated = storage.prepare('SELECT value FROM metadata WHERE key = ?').get(MIGRATION_KEY)
  if (migrated) return

  const legacyAccounts = readLegacyJson<LegacyAccountsFile>(accountsPath, {})
  const legacyActive = readLegacyJson<LegacyActiveAccountsFile>(activeAccountsPath, {})
  const insertAccount = storage.prepare(`
    INSERT OR IGNORE INTO accounts
      (tool_id, id, name, identifier, saved_at, credentials_json, revision)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `)
  const insertActive = storage.prepare(`
    INSERT INTO active_accounts (tool_id, account_id)
    VALUES (?, ?)
    ON CONFLICT(tool_id) DO UPDATE SET account_id = excluded.account_id
  `)

  storage.transaction(() => {
    for (const [toolId, accounts] of Object.entries(legacyAccounts)) {
      if (!Array.isArray(accounts)) continue
      for (const account of accounts) {
        if (!account || typeof account.id !== 'string') continue
        insertAccount.run(
          toolId,
          account.id,
          account.name,
          account.identifier,
          account.savedAt,
          JSON.stringify(account.credentials ?? {})
        )
      }
    }
    for (const [toolId, accountId] of Object.entries(legacyActive)) {
      if (typeof accountId === 'string') insertActive.run(toolId, accountId)
    }
    storage.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .run(MIGRATION_KEY, new Date().toISOString())
  })()

  // Keep the original plaintext files as uniquely named rollback copies. They
  // are no longer read after the migration marker has been committed.
  moveLegacyFileToBackup(accountsPath)
  moveLegacyFileToBackup(activeAccountsPath)
}

export function initAccountStorage(): void {
  const userData = app.getPath('userData')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  database = new Database(join(userData, 'aide-accounts.db'))
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      tool_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      identifier TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      credentials_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tool_id, id)
    );
    CREATE TABLE IF NOT EXISTS active_accounts (
      tool_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_usage_cache (
      tool_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (tool_id, account_id),
      FOREIGN KEY (tool_id, account_id) REFERENCES accounts(tool_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS subscription_usage_refresh_leases (
      tool_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      lease_until_ms INTEGER NOT NULL,
      PRIMARY KEY (tool_id, account_id),
      FOREIGN KEY (tool_id, account_id) REFERENCES accounts(tool_id, id) ON DELETE CASCADE
    );
  `)
  migrateLegacyJson(
    join(userData, 'aide-accounts.json'),
    join(userData, 'aide-active-accounts.json')
  )
  addPoolColumns()
}

/** Account pool columns, added to databases created before the pool existed. */
function addPoolColumns(): void {
  const storage = db()
  const columns = new Set((storage.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map((c) => c.name))
  storage.transaction(() => {
    if (!columns.has('sort_order')) {
      storage.exec('ALTER TABLE accounts ADD COLUMN sort_order INTEGER')
      storage.exec('UPDATE accounts SET sort_order = rowid')
    }
    if (!columns.has('in_pool')) storage.exec('ALTER TABLE accounts ADD COLUMN in_pool INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('exhausted_at_ms')) storage.exec('ALTER TABLE accounts ADD COLUMN exhausted_at_ms INTEGER')
    if (!columns.has('exhausted_until_ms')) storage.exec('ALTER TABLE accounts ADD COLUMN exhausted_until_ms INTEGER')
  })()
}

function accountFromRow(row: AccountRow): CliAccount {
  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    savedAt: row.saved_at,
    credentials: JSON.parse(row.credentials_json) as Record<string, unknown>,
    revision: row.revision
  }
}

export function getActiveAccount(toolId: string): string | null {
  const row = db().prepare('SELECT account_id FROM active_accounts WHERE tool_id = ?')
    .get(toolId) as { account_id: string } | undefined
  return row?.account_id ?? null
}

export function setActiveAccount(toolId: string, accountId: string | null): void {
  if (accountId === null) {
    db().prepare('DELETE FROM active_accounts WHERE tool_id = ?').run(toolId)
    return
  }
  db().prepare(`
    INSERT INTO active_accounts (tool_id, account_id)
    VALUES (?, ?)
    ON CONFLICT(tool_id) DO UPDATE SET account_id = excluded.account_id
  `).run(toolId, accountId)
}

const ACCOUNT_COLUMNS = 'id, name, identifier, saved_at, credentials_json, revision, in_pool, exhausted_at_ms, exhausted_until_ms'

function accountRows(toolId: string): AccountRow[] {
  return db().prepare(`
    SELECT ${ACCOUNT_COLUMNS}
    FROM accounts
    WHERE tool_id = ?
    ORDER BY sort_order, rowid
  `).all(toolId) as AccountRow[]
}

export function listAccounts(toolId: string): CliAccount[] {
  return accountRows(toolId).map(accountFromRow)
}

/** Whether an exhausted mark still applies at `nowMs`: until its reset time, or indefinitely when that is unknown. */
function isExhausted(row: Pick<AccountRow, 'exhausted_at_ms' | 'exhausted_until_ms'>, nowMs: number): boolean {
  if (row.exhausted_at_ms === null) return false
  return row.exhausted_until_ms === null || row.exhausted_until_ms > nowMs
}

function infoFromRow(row: AccountRow, nowMs: number): CliAccountInfo {
  const exhausted = isExhausted(row, nowMs)
  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    savedAt: row.saved_at,
    inPool: row.in_pool === 1,
    exhausted,
    exhaustedUntil: exhausted && row.exhausted_until_ms !== null ? new Date(row.exhausted_until_ms).toISOString() : null
  }
}

/** Return account list without credentials — safe for renderer. */
export function listAccountInfos(toolId: string, nowMs: number = Date.now()): CliAccountInfo[] {
  return accountRows(toolId).map((row) => infoFromRow(row, nowMs))
}

/** Check or uncheck an account for automatic switching in pipelines. */
export function setAccountInPool(toolId: string, accountId: string, inPool: boolean): void {
  db().prepare('UPDATE accounts SET in_pool = ? WHERE tool_id = ? AND id = ?').run(inPool ? 1 : 0, toolId, accountId)
}

/** Move an account one place up (-1) or down (+1) in its tool's list — the pool's switching order. */
export function moveAccount(toolId: string, accountId: string, delta: -1 | 1): void {
  const storage = db()
  storage.transaction(() => {
    const ids = accountRows(toolId).map((row) => row.id)
    const from = ids.indexOf(accountId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    const update = storage.prepare('UPDATE accounts SET sort_order = ? WHERE tool_id = ? AND id = ?')
    ids.forEach((id, index) => update.run(index + 1, toolId, id))
  })()
}

/** Take an account out of the pool's rotation until `untilMs` (null: until it is cleared). */
export function markAccountExhausted(toolId: string, accountId: string, untilMs: number | null, nowMs: number = Date.now()): void {
  db().prepare('UPDATE accounts SET exhausted_at_ms = ?, exhausted_until_ms = ? WHERE tool_id = ? AND id = ?')
    .run(nowMs, untilMs, toolId, accountId)
}

export function clearAccountExhausted(toolId: string, accountId: string): void {
  db().prepare('UPDATE accounts SET exhausted_at_ms = NULL, exhausted_until_ms = NULL WHERE tool_id = ? AND id = ?')
    .run(toolId, accountId)
}

export function saveAccount(
  toolId: string,
  name: string,
  identifier: string,
  credentials: Record<string, unknown>
): CliAccountInfo {
  const account: CliAccount = {
    id: randomUUID(),
    name,
    identifier,
    savedAt: new Date().toISOString(),
    credentials,
    revision: 0
  }
  db().prepare(`
    INSERT INTO accounts
      (tool_id, id, name, identifier, saved_at, credentials_json, revision, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE tool_id = ?))
  `).run(
    toolId,
    account.id,
    account.name,
    account.identifier,
    account.savedAt,
    JSON.stringify(account.credentials),
    account.revision,
    toolId
  )
  return { id: account.id, name: account.name, identifier: account.identifier, savedAt: account.savedAt, inPool: false, exhausted: false, exhaustedUntil: null }
}

export function deleteAccount(toolId: string, accountId: string): void {
  db().transaction(() => {
    db().prepare('DELETE FROM accounts WHERE tool_id = ? AND id = ?').run(toolId, accountId)
    db().prepare('DELETE FROM active_accounts WHERE tool_id = ? AND account_id = ?').run(toolId, accountId)
  })()
}

/**
 * Replace credentials only if the caller still owns the row revision it read.
 * A null result means another process updated or removed the account first.
 */
export function updateAccount(
  toolId: string,
  accountId: string,
  identifier: string,
  credentials: Record<string, unknown>,
  expectedRevision: number
): CliAccountInfo | null {
  const savedAt = new Date().toISOString()
  const result = db().prepare(`
    UPDATE accounts
    SET identifier = ?, credentials_json = ?, saved_at = ?, revision = revision + 1
    WHERE tool_id = ? AND id = ? AND revision = ?
  `).run(identifier, JSON.stringify(credentials), savedAt, toolId, accountId, expectedRevision)
  if (result.changes !== 1) return null

  const row = db().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool_id = ? AND id = ?`)
    .get(toolId, accountId) as AccountRow | undefined
  if (!row) return null
  return infoFromRow(row, Date.now())
}

export function getSubscriptionUsageCache(
  toolId: string,
  accountId: string
): SubscriptionUsageCache | null {
  const row = db().prepare(`
    SELECT payload_json, fetched_at_ms, source
    FROM subscription_usage_cache
    WHERE tool_id = ? AND account_id = ?
  `).get(toolId, accountId) as {
    payload_json: string
    fetched_at_ms: number
    source: string
  } | undefined
  if (!row) return null
  try {
    const payload = JSON.parse(row.payload_json) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return { payload: payload as Record<string, unknown>, fetchedAtMs: row.fetched_at_ms, source: row.source }
  } catch {
    return null
  }
}

export function setSubscriptionUsageCache(
  toolId: string,
  accountId: string,
  payload: Record<string, unknown>,
  fetchedAtMs: number,
  source: string
): void {
  db().prepare(`
    INSERT INTO subscription_usage_cache
      (tool_id, account_id, payload_json, fetched_at_ms, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tool_id, account_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at_ms = excluded.fetched_at_ms,
      source = excluded.source
  `).run(toolId, accountId, JSON.stringify(payload), fetchedAtMs, source)
}

export function clearSubscriptionUsageCache(toolId: string, accountId: string): void {
  db().prepare(`
    DELETE FROM subscription_usage_cache
    WHERE tool_id = ? AND account_id = ?
  `).run(toolId, accountId)
}

export function tryAcquireSubscriptionUsageRefresh(
  toolId: string,
  accountId: string,
  owner: string,
  nowMs: number,
  leaseMs: number
): boolean {
  const result = db().prepare(`
    INSERT INTO subscription_usage_refresh_leases
      (tool_id, account_id, owner, lease_until_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tool_id, account_id) DO UPDATE SET
      owner = excluded.owner,
      lease_until_ms = excluded.lease_until_ms
    WHERE subscription_usage_refresh_leases.lease_until_ms <= ?
  `).run(toolId, accountId, owner, nowMs + leaseMs, nowMs)
  return result.changes === 1
}

export function releaseSubscriptionUsageRefresh(toolId: string, accountId: string, owner: string): void {
  db().prepare(`
    DELETE FROM subscription_usage_refresh_leases
    WHERE tool_id = ? AND account_id = ? AND owner = ?
  `).run(toolId, accountId, owner)
}
