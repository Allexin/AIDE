import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getToolById } from '../pty/cliTools/registry'
import { runShellCommand } from './processRunner'
import { startHeadless } from './headless'
import type { PipelineManager } from './manager'
import { walkSteps, type Step } from '../../shared/pipelineMachine'

/**
 * `pipeline_smoke` (plan §2.2 step 5): is this machine executable on this
 * computer and account? Runs every check command once, confirms every CLI is
 * installed and headless-capable, and optionally pings each agent CLI.
 */

const CHECK_TIMEOUT_MS = 10 * 60_000
const PING_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply'], properties: { reply: { type: 'string' } } }

export async function smokeTestMachine(manager: PipelineManager, projectPath: string, machineId: string, pingAgents: boolean): Promise<string> {
  const entry = manager.machineEntry(projectPath, machineId)
  if (!entry) return `Unknown machine "${machineId}".`
  const { machine } = entry
  const validation = manager.validate(entry)
  const lines: string[] = [`Smoke test of "${machineId}":`]
  if (validation.errors.length) lines.push(`✗ validation: ${validation.errors.length} error(s) — run pipeline_validate.`)
  else lines.push('✓ validation passed')

  const steps: Step[] = []
  walkSteps(machine.steps, (step) => { steps.push(step) })
  const clis = new Set<string>()
  for (const step of steps) {
    if (step.type === 'agent') clis.add(step.cli ?? machine.defaults?.cli ?? '')
    if (step.type === 'commit' && step.review === 'agent') clis.add(step.reviewer?.cli ?? machine.defaults?.cli ?? '')
  }
  for (const cli of [...clis].filter(Boolean)) {
    const tool = getToolById(cli)
    if (!tool) { lines.push(`✗ CLI "${cli}" is not registered in AIDE`); continue }
    if (!tool.headless) { lines.push(`✗ ${tool.name} has no headless support`); continue }
    if (!(await tool.isInstalled())) { lines.push(`✗ ${tool.name} is not installed`); continue }
    if (!pingAgents) { lines.push(`✓ ${tool.name} installed`); continue }
    const runDir = mkdtempSync(join(tmpdir(), 'aide-smoke-'))
    try {
      const result = await startHeadless(tool, {
        cwd: projectPath, runDir, prompt: 'Reply with the single word "ok" in the reply field. Do nothing else.',
        permissions: 'read-only', outputSchema: PING_SCHEMA, timeoutMs: 180_000, label: `smoke:${cli}`
      }).result
      lines.push(result.ok ? `✓ ${tool.name} answered headless (${JSON.stringify(result.structured)})` : `✗ ${tool.name}: ${result.error?.code} — ${result.error?.message}`)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  for (const step of steps) {
    if (step.type !== 'check') continue
    const id = step.id
    let output = ''
    const exit = await runShellCommand({ commandLine: step.command, cwd: projectPath, timeoutMs: CHECK_TIMEOUT_MS, label: `smoke:${id}`, onStdoutLine: (l) => { output += l + '\n' }, onStderr: (t) => { output += t } }).done
    const tail = output.trim().split('\n').slice(-5).join('\n')
    lines.push(exit.exitCode === 0 ? `✓ check "${id}" (${step.command}) passed` : `✗ check "${id}" (${step.command}) exited ${exit.exitCode ?? (exit.timedOut ? 'timeout' : exit.spawnError)}:\n${tail}`)
  }
  return lines.join('\n')
}
