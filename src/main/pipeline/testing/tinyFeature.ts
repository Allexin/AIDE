import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { MachineDefinition } from '../engine/types'
import { git } from '../git'

/**
 * Fixture for live end-to-end tests: a small code machine and a temporary git
 * repository whose check script verifies `greeting.txt`.
 */

export const TINY_FEATURE: MachineDefinition = {
  id: 'tiny-feature',
  name: 'Tiny feature',
  description: 'Implements a very small change in the repository and commits it after a check and a review. Param taskSpec: what to do.',
  params: { taskSpec: { type: 'string', description: 'What to implement' } },
  defaults: { cli: 'claude-code', model: 'haiku', timeoutMin: 10 },
  start: 'implement',
  nodes: {
    implement: { type: 'agent', summary: 'implements the task', role: 'roles/implementer.md', output: 'implementerReport', inputs: ['params.taskSpec'] },
    checks: { type: 'check', command: 'node check.js' },
    review: { type: 'agent', summary: 'a separate reviewer checks the diff against the task', role: 'roles/reviewer.md', permissions: 'read-only', output: 'reviewVerdict', inputs: ['params.taskSpec', 'run.diff'], maxVisits: 2, onLimit: 'stuck' },
    fix: { type: 'agent', summary: 'fixes failed checks or review findings', role: 'roles/implementer.md', session: 'continue:implement', output: 'implementerReport', inputs: ['outputs.checks.output', 'outputs.review.blocking'] },
    commitPrep: { type: 'agent', summary: 'stages the change and writes the commit message', role: 'roles/commit-prep.md', session: 'continue:implement', output: 'commitPrep', inputs: ['outputs.commit.issues'], maxVisits: 2, onLimit: 'stuck' },
    commit: { type: 'commit', prep: 'commitPrep', review: 'algorithmic' },
    stuck: { type: 'escalate', message: 'did not converge' },
    done: { type: 'end', result: 'success' },
    failed: { type: 'end', result: 'failure' }
  },
  edges: [
    ['implement', 'checks', "outputs.implement.status == 'done'"],
    ['implement', 'stuck', 'default'],
    ['checks', 'review', 'ok'],
    ['checks', 'fix', 'fail'],
    ['review', 'commitPrep', "outputs.review.verdict == 'accept'"],
    ['review', 'fix', 'default'],
    ['fix', 'checks', 'default'],
    ['commitPrep', 'commit', 'default'],
    ['commit', 'done', 'ok'],
    ['commit', 'commitPrep', 'fail'],
    ['stuck', 'failed', 'default']
  ]
}

export const TINY_TASK = 'Create a file greeting.txt in the repository root containing exactly the text: hello pipeline'

export interface TinyWorkspace {
  root: string
  repo: string
  machineDir: string
  runsRoot: string
}

/** Temp workspace: a git repo with check.js, and the machine + roles in `pipelines/` (or the repo's aide/pipelines). */
export async function createTinyWorkspace(prefix: string, machineInRepo = false): Promise<TinyWorkspace> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const repo = join(root, 'repo')
  const machineDir = machineInRepo ? join(repo, 'aide', 'pipelines') : join(root, 'pipelines')
  const runsRoot = join(root, 'runs')
  mkdirSync(join(machineDir, 'roles'), { recursive: true })
  writeFileSync(join(machineDir, 'roles', 'implementer.md'), 'You are the implementer. Implement exactly the task. Keep changes minimal.')
  writeFileSync(join(machineDir, 'roles', 'reviewer.md'), 'You are the reviewer. Accept when the diff does what the task says; list blocking findings otherwise. Never modify files.')
  writeFileSync(join(machineDir, 'roles', 'commit-prep.md'), 'Stage exactly the files of your change with git add, and write a commit message. Do not commit.')
  if (machineInRepo) writeFileSync(join(machineDir, `${TINY_FEATURE.id}.json`), JSON.stringify(TINY_FEATURE, null, 2))
  writeFileSync(join(repo, 'check.js'), "const fs = require('fs'); const ok = fs.existsSync('greeting.txt') && fs.readFileSync('greeting.txt', 'utf8').trim() === 'hello pipeline'; console.log(ok ? 'greeting ok' : 'greeting.txt missing or wrong'); process.exit(ok ? 0 : 1)\n")
  await git(repo, ['init', '-q'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'init'])
  return { root, repo, machineDir, runsRoot }
}
