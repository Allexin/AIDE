import { getToolById } from '../pty/cliTools/registry'
import { cliLog } from '../pty/cliTools/cliLogger'
import { ptyRegistry } from '../pty/registry'
import { getActiveAccount, listAccountInfos, markAccountExhausted, type CliAccountInfo } from '../config/accountStorage'
import { lastAccountSwitch, loadSavedAccount } from '../accounts/accountSwitch'
import { logEvent } from '../diagnostics'
import { orchestrators } from './orchestrators'
import type { PipelineManager } from './manager'

/**
 * Account pool for pipelines: when a step stops on a CLI usage limit and the
 * user checked accounts of that CLI in the Account Manager, AIDE marks the
 * account that hit the limit as exhausted, loads the next checked one, restarts
 * the CLI's tabs so they pick it up (telling an orchestrator in one of them what
 * happened), and resumes the run. When every checked account is exhausted, the
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

export function orchestratorResumeMessage(input: {
  cli: string; from: string; to: string; runId: string; node: string | null; since: number; resumesAt: string | null
}): string {
  const where = input.node ? ` at step ${input.node}` : ''
  const run = input.resumesAt
    ? `Every account in the pool has hit its limit, so run ${input.runId} stays stopped${where} and resumes by itself at ${input.resumesAt} on ${input.to}.`
    : `Run ${input.runId} has been resumed${where} on ${input.to}.`
  return `AIDE switched ${input.cli} from account ${input.from} to ${input.to} because ${input.from} hit its usage limit. ` +
    `Your terminal tab was restarted to pick up the new account, which cut off your pipeline_wait call. ${run} ` +
    `Continue orchestrating: call pipeline_wait for run ${input.runId} with since=${input.since}.`
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
      const next = previous.then(() => this.onLimit(projectPath, runId, cli, data, id)).catch((err) => {
        logEvent('account-pool-failed', { cli, runId, message: err instanceof Error ? err.message : String(err) }, 'warn')
      })
      this.queue.set(cli, next)
    }
    this.manager.on('event', onEvent)
    return () => { this.manager.off('event', onEvent) }
  }

  private async onLimit(projectPath: string, runId: string, cli: string, data: Record<string, unknown>, eventId: number): Promise<void> {
    const tool = getToolById(cli)
    if (!tool?.hasAccountSystem() || !tool.importCredentials) return
    if (!listAccountInfos(cli).some((account) => account.inPool)) return

    const node = typeof data.node === 'string' ? data.node : typeof data.next === 'string' ? data.next : null
    const startedAt = typeof data.visitStartedAt === 'string' ? Date.parse(data.visitStartedAt) : NaN
    const switched = lastAccountSwitch(cli)
    if (switched !== undefined && !Number.isNaN(startedAt) && startedAt < switched) {
      // The step ran on the account AIDE has already switched away from.
      cliLog(LOG_CH, `${tool.name}: run ${runId} hit the limit of the previous account; resuming on the current one.`)
      this.resume(projectPath, runId)
      return
    }

    const activeId = getActiveAccount(cli)
    const resumeAt = typeof data.resumeAt === 'string' ? Date.parse(data.resumeAt) : NaN
    if (activeId) markAccountExhausted(cli, activeId, Number.isNaN(resumeAt) ? null : resumeAt)

    const accounts = listAccountInfos(cli)
    const choice = choosePoolAccount(accounts, activeId)
    const fromName = accounts.find((account) => account.id === activeId)?.name ?? 'the current account'
    if (!choice) {
      cliLog(LOG_CH, `${tool.name}: every checked account has hit its limit and none reports when it resets; run ${runId} stays stopped.`)
      return
    }

    let toName = fromName
    let tabsRestarted: Array<{ oldTabId: string; newTabId: string }> = []
    if (choice.load) {
      if (!(await loadSavedAccount(cli, choice.load.id))) {
        cliLog(LOG_CH, `${tool.name}: could not load account ${choice.load.name}; run ${runId} stays stopped.`)
        return
      }
      toName = choice.load.name
      for (const win of ptyRegistry.keys()) if (!win.isDestroyed()) win.webContents.send('accounts:changed')
      if (tool.accountSwitchNeedsRestart?.() !== false) {
        for (const mgr of ptyRegistry.values()) tabsRestarted = tabsRestarted.concat(await mgr.restartToolTabs(cli))
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

    await this.notifyOrchestrators(projectPath, tabsRestarted, {
      cli: tool.name, from: fromName, to: toName, runId, node, since: eventId, resumesAt: choice.waitUntil
    })
  }

  private resume(projectPath: string, runId: string): void {
    try {
      this.manager.resume(projectPath, runId)
    } catch (err) {
      cliLog(LOG_CH, `Run ${runId} could not be resumed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** An orchestrator whose tab was restarted lost its pipeline_wait; tell it what happened and how to continue. */
  private async notifyOrchestrators(
    projectPath: string,
    restarted: Array<{ oldTabId: string; newTabId: string }>,
    message: Parameters<typeof orchestratorResumeMessage>[0]
  ): Promise<void> {
    const orchestratorTabs = new Set(orchestrators.forProject(projectPath).map((c) => c.tabId).filter((id): id is string => !!id))
    const text = orchestratorResumeMessage(message)
    for (const { oldTabId, newTabId } of restarted) {
      if (!orchestratorTabs.has(oldTabId)) continue
      for (const mgr of ptyRegistry.values()) {
        if (mgr.getTabs().some((tab) => tab.tabId === newTabId)) {
          if (!(await mgr.submitWhenReady(newTabId, text))) cliLog(LOG_CH, `The orchestrator tab ${newTabId} did not start; tell it to continue with pipeline_wait.`)
        }
      }
    }
  }
}
