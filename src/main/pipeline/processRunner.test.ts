import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { killAllProcessTreesSync, runProcess } from './processRunner'

const FAKE_CLI = join(__dirname, 'testing', 'fakeCli.cjs')

function fake(steps: unknown[], extra: { stdin?: string; timeoutMs?: number; onLine?: (line: string) => void } = {}): ReturnType<typeof runProcess> {
  return runProcess({
    command: process.execPath,
    args: [FAKE_CLI],
    cwd: __dirname,
    env: { ...process.env, FAKE_CLI_SCRIPT: JSON.stringify(steps) },
    stdin: extra.stdin,
    timeoutMs: extra.timeoutMs,
    onStdoutLine: extra.onLine,
    label: 'test'
  })
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('runProcess', () => {
  it('frames stdout into lines and passes stdin', async () => {
    const lines: string[] = []
    const handle = fake([{ out: 'first' }, { echoStdin: true }, { out: 'last' }], { stdin: 'hello\nworld', onLine: (l) => lines.push(l) })
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(lines).toEqual(['first', JSON.stringify('hello\nworld'), 'last'])
  })

  it('reports non-zero exit and stderr tail', async () => {
    const result = await fake([{ err: 'boom' }, { exit: 3 }]).done
    expect(result.exitCode).toBe(3)
    expect(result.stderrTail).toContain('boom')
    expect(result.timedOut).toBe(false)
  })

  it('kills on timeout', async () => {
    const started = Date.now()
    const result = await fake([{ sleep: 30_000 }], { timeoutMs: 500 }).done
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('cancel kills the whole process tree', async () => {
    let grandchild = 0
    const handle = fake([{ spawnChild: true }, { sleep: 30_000 }], {
      onLine: (line) => { grandchild = (JSON.parse(line) as { grandchild: number }).grandchild }
    })
    for (let i = 0; i < 100 && !grandchild; i++) await new Promise((r) => setTimeout(r, 50))
    expect(grandchild).toBeGreaterThan(0)
    expect(isAlive(grandchild)).toBe(true)
    await handle.cancel()
    const result = await handle.done
    expect(result.cancelled).toBe(true)
    for (let i = 0; i < 40 && isAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 50))
    expect(isAlive(grandchild)).toBe(false)
  })

  it('killAllProcessTreesSync kills live trees immediately', async () => {
    let grandchild = 0
    const handle = fake([{ spawnChild: true }, { sleep: 30_000 }], {
      onLine: (line) => { grandchild = (JSON.parse(line) as { grandchild: number }).grandchild }
    })
    for (let i = 0; i < 100 && !grandchild; i++) await new Promise((r) => setTimeout(r, 50))
    expect(killAllProcessTreesSync()).toBe(1)
    expect(isAlive(grandchild)).toBe(false)
    await handle.done
  })

  it('reports a spawn error for a missing executable', async () => {
    const result = await runProcess({ command: 'definitely-not-a-real-binary-xyz', args: [], cwd: __dirname, label: 'test' }).done
    expect(result.spawnError).toBeTruthy()
  })
})
