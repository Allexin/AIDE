import { getToolById } from '../pty/cliTools/registry'
import { cliLog } from '../pty/cliTools/cliLogger'
import { ptyRegistry } from '../pty/registry'
import { getActiveAccount, listAccountInfos, markAccountExhausted, type CliAccountInfo } from '../config/accountStorage'
import { accountText } from '../accounts/accountDisplay'
import { currentAccount, lastAccountSwitch, loadSavedAccount } from '../accounts/accountSwitch'
import { logEvent } from '../diagnostics'
import type { PipelineManager } from './manager'

/**
 * Account pool for pipelines: when a step stops on a CLI usage limit and the
 * user checked accounts of that CLI in the Account Manager, AIDE marks the
 * account that hit the limit as exhausted, loads the next checked one, restarts
 * the CLI's tabs so they pick it up, and resumes the run. The orchestrator is not
 * told: the limit stop is quiet (`poolHandles`), the switch only goes on with the
 * run. It is told when the pool cannot go on. When every checked account is exhausted, the
 * one that resets soonest is loaded and the run resumes by itself at that time.
 *
 * Only pipeline runs trigger a switch; the tabs are restarted because the
 * credentials are the CLI's, shared by every session on the machine.
 * See docs/account-pool.md.
 */

const LOG_CH = 'Accounts'

export interface PoolChoice {
  /** Account to load, or null to stay on the active one. */
  load: CliAccountInfo | null
  /** When the chosen account resets, if every checked account is exhausted (null: it is available now). */
  waitUntil: string | null
}

/**
 * Pick what to switch to after `activeId` hit a limit (already marked exhausted
 * in `accounts`). The next available checked account in list order; otherwise
 * the account that resets soonest among the checked ones and the active one;
 * null when nothing is known to reset.
 */
export function choosePoolAccount(accounts: CliAccountInfo[], activeId: string | null): PoolChoice | null {
  const pool = accounts.filter((account) => account.inPool)
  if (pool.length === 0) return null
  const next = pool.find((account) => account.id !== activeId && !account.exhausted)
  if (next) return { load: next, waitUntil: null }
  const resetting = accounts
    .filter((account) => (account.inPool || account.id === activeId) && account.exhaustedUntil)
    .sort((a, b) => Date.parse(a.exhaustedUntil!) - Date.parse(b.exhaustedUntil!))
  const soonest = resetting[0]
  if (!soonest) return null
  return { load: soonest.id === activeId ? null : soonest, waitUntil: soonest.exhaustedUntil }
}

/** Whether AIDE switches this CLI to another account when a step hits its usage limit. */
export function poolHandles(cli: string): boolean {
  const tool = getToolById(cli)
  if (!tool?.hasAccountSystem() || !tool.importCredentials) return false
  return listAccountInfos(cli).some((account) => account.inPool)
}

export class AccountPool {
  /** One switch at a time per CLI: two runs hitting the same limit must not both switch. */
  private readonly queue = new Map<string, Promise<void>>()

  constructor(private readonly manager: PipelineManager) {}

  attach(): () => void {
    const onEvent = (projectPath: string, runId: string, type: string, data: Record<string, unknown>, id: number): void => {
      // Only a limit a step just hit: the re-announcement after an AIDE restart (no visitStartedAt) and a
      // rescheduled resume belong to a limit handled before; the run's own resume retries those.
      if (type !== 'run_stopped' || data.reason !== 'usage_limit' || data.rescheduled || typeof data.cli !== 'string' || typeof data.visitStartedAt !== 'string') return
      const cli = data.cli
      const previous = this.queue.get(cli) ?? Promise.resolve()
      const next = previous.then(() => this.onLimit(projectPath, runId, cli, data)).catch((err) => {
        logEvent('account-pool-failed', { cli, runId, message: err instanceof Error ? err.message : String(err) }, 'warn')
      })
      this.queue.set(cli, next)
    }
    this.manager.on('event', onEvent)
    return () => { this.manager.off('event', onEvent) }
  }

  private async onLimit(projectPath: string, runId: string, cli: string, data: Record<string, unknown>): Promise<void> {
    const tool = getToolById(cli)
    if (!tool || !poolHandles(cli)) return

    const node = typeof data.node === 'string' ? data.node : typeof data.next === 'string' ? data.next : null
    const startedAt = typeof data.visitStartedAt === 'string' ? Date.parse(data.visitStartedAt) : NaN
    const switched = lastAccountSwitch(cli)
    if (switched !== undefined && !Number.isNaN(startedAt) && startedAt < switched) {
      // The step ran on the account AIDE has already switched away from.
      cliLog(LOG_CH, `${tool.name}: run ${runId} hit the limit of the previous account; resuming on the current one.`)
      this.resume(projectPath, runId)
      return
    }

    // The account the CLI is logged in to hit the limit, not necessarily the one AIDE recorded as active.
    const recordedId = getActiveAccount(cli)
    const activeId = await currentAccount(cli)
    if (activeId !== recordedId) {
      const name = (id: string | null): string => listAccountInfos(cli).find((account) => account.id === id)?.name ?? 'an account that is not saved'
      cliLog(LOG_CH, `${tool.name}: logged in to ${name(activeId)}, not ${name(recordedId)} as recorded; the limit is put on the account logged in to.`)
    }
    const resumeAt = typeof data.resumeAt === 'string' ? Date.parse(data.resumeAt) : NaN
    if (activeId) markAccountExhausted(cli, activeId, Number.isNaN(resumeAt) ? null : resumeAt)

    const accounts = listAccountInfos(cli)
    const choice = choosePoolAccount(accounts, activeId)
    // The names reach the pipeline tab and the remote page in events, and a name may be an email.
    const fromName = accountText(accounts.find((account) => account.id === activeId)?.name ?? 'the current account')
    if (!choice) {
      cliLog(LOG_CH, `${tool.name}: every checked account has hit its limit and none reports when it resets; run ${runId} stays stopped.`)
      this.stuck(projectPath, runId, node, `every checked ${tool.name} account has hit its usage limit and none says when it resets; the run stays stopped — resume with pipeline_resume once one has reset`)
      return
    }

    let toName = fromName
    if (choice.load) {
      const loadName = accountText(choice.load.name)
      if (!(await loadSavedAccount(cli, choice.load.id))) {
        cliLog(LOG_CH, `${tool.name}: could not load account ${loadName}; run ${runId} stays stopped.`)
        this.stuck(projectPath, runId, node, `${tool.name} hit its usage limit and AIDE could not switch to the account ${loadName}; the run stays stopped — resume with pipeline_resume`)
        return
      }
      toName = loadName
      for (const win of ptyRegistry.keys()) if (!win.isDestroyed()) win.webContents.send('accounts:changed')
      if (tool.accountSwitchNeedsRestart?.() !== false) {
        for (const mgr of ptyRegistry.values()) await mgr.restartToolTabs(cli)
      }
    }

    this.manager.announce(projectPath, 'account_switched', {
      cli, from: fromName, to: toName, resumesAt: choice.waitUntil,
      summary: choice.waitUntil
        ? `${tool.name}: every checked account hit its limit; ${toName} resets soonest (${choice.waitUntil})`
        : `${tool.name}: ${fromName} hit its limit; switched to ${toName}`
    }, runId)
    logEvent('account-pool-switch', { cli, runId, from: fromName, to: toName, waitUntil: choice.waitUntil })

    if (choice.waitUntil) {
      cliLog(LOG_CH, `${tool.name}: every checked account has hit its limit; ${toName} resets soonest — run ${runId} resumes at ${choice.waitUntil}.`)
      this.manager.setLimitResume(projectPath, choice.waitUntil, `every checked ${tool.name} account hit its limit; the run resumes by itself at ${choice.waitUntil} on ${toName} (or pipeline_resume)`, runId)
    } else {
      cliLog(LOG_CH, `${tool.name}: ${fromName} hit its usage limit — switched to ${toName} and resumed run ${runId}.`)
      this.resume(projectPath, runId)
    }
  }

  /** The pool cannot go on with the run: now the orchestrator has to know (the limit stop was quiet). */
  private stuck(projectPath: string, runId: string, node: string | null, summary: string): void {
    this.manager.announce(projectPath, 'run_stopped', { next: node, reason: 'usage_limit', summary }, runId)
  }

  private resume(projectPath: string, runId: string): void {
    try {
      this.manager.resume(projectPath, runId)
    } catch (err) {
      cliLog(LOG_CH, `Run ${runId} could not be resumed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
