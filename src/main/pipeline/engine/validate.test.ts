import { describe, expect, it } from 'vitest'
import { validateMachine } from './validate'
import { evaluateCondition, parseCondition, renderTemplate } from './expressions'
import { strictSchemaProblems, validateAgainstSchema, BUILTIN_SCHEMAS } from './schema'
import type { MachineDefinition, Step } from './types'
import { ENGINE_VERSION } from './compat'

const env = { headlessClis: ['claude-code', 'codex'], roleExists: (p: string) => !p.includes('missing') }

const agent = (id: string, extra: Record<string, unknown> = {}): Step => ({ type: 'agent', id, summary: 's', role: 'roles/a.md', output: 'implementerReport', ...extra } as Step)

function machine(steps: Step[], overrides: Partial<MachineDefinition> = {}): MachineDefinition {
  return { id: 'm', name: 'M', description: 'd', engineVersion: ENGINE_VERSION, defaults: { cli: 'claude-code' }, steps, ...overrides }
}

const errorsOf = (m: MachineDefinition): string => validateMachine(m, env).errors.join('\n')

describe('validateMachine', () => {
  it('accepts a minimal machine', () => {
    expect(validateMachine(machine([agent('a')]), env)).toEqual({ errors: [], warnings: [] })
  })

  it('sends decisions to "agent" or "user"; "orchestrator" is accepted only in machines of engine 5 or older', () => {
    const gate = (to: string): Step => ({ type: 'gate', id: 'g', question: 'ok?', to } as unknown as Step)
    expect(validateMachine(machine([agent('a'), gate('agent')]), env).errors).toEqual([])
    expect(validateMachine(machine([agent('a'), gate('orchestrator')]), env).errors.join()).toContain('"orchestrator" is now "agent"')
    expect(validateMachine(machine([agent('a'), gate('orchestrator')], { engineVersion: 5 }), env).errors).toEqual([])
    expect(validateMachine(machine([{ ...agent('a'), escalateTo: 'nobody' } as unknown as Step]), env).errors.join()).toContain('must be "agent" or "user"')
  })

  it('rejects the old graph format with a pointer to the new one', () => {
    expect(errorsOf({ id: 'm', name: 'M', description: 'd', start: 'a', nodes: {}, edges: [] } as unknown as MachineDefinition)).toMatch(/old graph format/)
  })

  it('requires bounded loops and unique, valid ids', () => {
    const text = errorsOf(machine([
      { type: 'loop', id: 'l', steps: [agent('a'), { type: 'check', id: 'a', command: 'x' }] } as unknown as Step,
      agent('bad id')
    ]))
    expect(text).toMatch(/"maxIterations" must be a positive integer/)
    expect(text).toMatch(/Step id "a" is used more than once/)
    expect(text).toMatch(/invalid "id" \("bad id"\)/)
  })

  it('accepts path filters on the run.* file inputs only', () => {
    expect(errorsOf(machine([agent('a', { inputs: [{ ref: 'run.diff', exclude: ['golden/**'] }, { ref: 'run.changedFiles', include: ['src/**'] }] })]))).toBe('')
    const text = errorsOf(machine([agent('a', { inputs: [{ ref: 'outputs.a.summary', exclude: ['x'] }, { ref: 'run.diff', include: 'src/**' }, { exclude: ['x'] }] })]))
    expect(text).toMatch(/"exclude" filters only run.diff/)
    expect(text).toMatch(/"include" must be a list of globs/)
    expect(text).toMatch(/an input must be a reference string/)
  })

  it('checks the refs of check commands: params and outputs only', () => {
    const text = errorsOf(machine([
      agent('a'),
      { type: 'check', id: 'c', command: 'run {{params.stage}} {{outputs.a.status}} {{run.diff}} {{params.nope}}' }
    ], { params: { stage: { type: 'string' } } }))
    expect(text).toMatch(/"\{\{run\.diff\}\}" — commands can only use params\.\* and outputs\.\* values/)
    expect(text).toMatch(/unknown param "nope"/)
    expect(text).not.toMatch(/stage|outputs\.a/)
  })

  it('accepts run.iterations.<loop> and rejects other ids', () => {
    const steps: Step[] = [{ type: 'loop', id: 'l', maxIterations: 2, steps: [agent('a', { repeatIf: 'run.iterations.l == 1' }), agent('b', { escalateIf: 'run.iterations.a == 1' })] }]
    expect(errorsOf(machine(steps))).toMatch(/run\.iterations\.a.*use run\.iterations\.<loop id>/)
    expect(errorsOf(machine(steps))).not.toMatch(/iterations\.l\b/)
  })

  it('warns about a loop that nothing can repeat', () => {
    const result = validateMachine(machine([{ type: 'loop', id: 'l', maxIterations: 2, steps: [agent('a')] }]), env)
    expect(result.errors).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/nothing inside the loop can repeat it/)
  })

  it('allows repeats only inside loops, and repeatLoop only to an enclosing loop', () => {
    const text = errorsOf(machine([
      agent('outside', { repeatIf: "outputs.outside.status != 'done'" }),
      { type: 'loop', id: 'first', maxIterations: 2, steps: [{ type: 'check', id: 'c', command: 'x' }] },
      { type: 'loop', id: 'second', maxIterations: 2, steps: [agent('inner', { repeatIf: "outputs.inner.status != 'done'", repeatLoop: 'first' })] }
    ]))
    expect(text).toMatch(/Step "outside": "repeatIf"\/"repeatLoop" only work inside a loop/)
    expect(text).toMatch(/Step "inner": "repeatLoop" must name an enclosing loop/)
  })

  it('checks conditions, refs, roles, CLIs, sessions and summaries', () => {
    const text = errorsOf(machine([
      { type: 'agent', id: 'a', role: 'roles/missing.md', cli: 'aider', output: 'nope', inputs: ['params.ghost', 'run.weird'], session: 'continue:b' } as Step,
      agent('b', { escalateIf: 'ok' }),
      { type: 'if', id: 'branch', condition: "outputs.nobody.x == 'y'", then: [agent('c')] }
    ]))
    expect(text).toMatch(/"summary" is required/)
    expect(text).toMatch(/role file "roles\/missing.md" not found/)
    expect(text).toMatch(/CLI "aider" does not support headless/)
    expect(text).toMatch(/output schema "nope" is not defined/)
    expect(text).toMatch(/unknown param "ghost"/)
    expect(text).toMatch(/unknown run value "run.weird"/)
    expect(text).toMatch(/must name a step that runs earlier|different CLI/)
    expect(text).toMatch(/Step "b" "escalateIf": Unsupported condition "ok"/)
    expect(text).toMatch(/unknown step "nobody"/)
  })

  it('warns about a reference to a step that has not run yet', () => {
    const result = validateMachine(machine([agent('a', { inputs: ['outputs.b.summary'] }), agent('b')]), env)
    expect(result.warnings.join('\n')).toMatch(/has not run yet/)
    // Inside a shared loop a later step's output is the previous iteration's — no warning.
    const looped = validateMachine(machine([{ type: 'loop', id: 'l', maxIterations: 2, steps: [agent('a', { inputs: ['outputs.b.summary'] }), { type: 'check', id: 'b', command: 'x' }] }]), env)
    expect(looped.warnings).toEqual([])
  })

  it('checks effort levels per CLI', () => {
    expect(validateMachine(machine([agent('a', { effort: 'high' }), agent('b', { cli: 'codex', effort: 'ultra' })]), env).errors).toEqual([])
    const text = errorsOf(machine([agent('a', { effort: 'ultra' })], { defaults: { cli: 'claude-code', effort: 'turbo' } }))
    expect(text).toMatch(/"defaults": effort "turbo" is not one of low, medium, high, xhigh, max for claude-code/)
    expect(text).toMatch(/Step "a": effort "ultra" is not one of/)
  })

  it('accepts any effort for OpenCode, whose variants depend on the model', () => {
    const openCodeEnv = { ...env, headlessClis: [...env.headlessClis, 'open-code'] }
    expect(validateMachine(machine([agent('a', { cli: 'open-code', effort: 'max' })]), openCodeEnv).errors).toEqual([])
  })

  it('requires a strict schema for Codex steps', () => {
    const text = errorsOf(machine([agent('a', { cli: 'codex', output: 'loose' })], { schemas: { loose: { type: 'object', properties: { a: { type: 'string' } } } } }))
    expect(text).toMatch(/not strict enough for Codex/)
  })

  it('requires the commit prep agent to output commitMessage and excluded', () => {
    const text = errorsOf(machine([agent('a'), { type: 'commit', id: 'c', review: 'algorithmic', prep: agent('prep') as Extract<Step, { type: 'agent' }> }]))
    expect(text).toMatch(/prep step "prep" must output "commitMessage" and "excluded"/)
    expect(errorsOf(machine([{ type: 'commit', id: 'c', review: 'algorithmic', prep: { type: 'check' } } as unknown as Step]))).toMatch(/"prep" must be an agent step/)
  })
})

describe('expressions', () => {
  const scope = { params: { mode: 'fast' }, outputs: { review: { verdict: 'accept', count: 2 } }, run: {} }

  it('parses and evaluates conditions', () => {
    expect(evaluateCondition("outputs.review.verdict == 'accept'", scope)).toBe(true)
    expect(evaluateCondition("outputs.review.verdict != 'accept'", scope)).toBe(false)
    expect(evaluateCondition('outputs.review.count == 2', scope)).toBe(true)
    expect('error' in parseCondition('outputs.review.verdict == accept')).toBe(true)
    expect('error' in parseCondition('default')).toBe(true)
  })

  it('renders templates', () => {
    expect(renderTemplate('Mode {{params.mode}}, verdict {{ outputs.review.verdict }}', scope)).toBe('Mode fast, verdict accept')
  })
})

describe('schemas', () => {
  it('built-in schemas are strict', () => {
    for (const schema of Object.values(BUILTIN_SCHEMAS)) expect(strictSchemaProblems(schema)).toEqual([])
  })

  it('validates values', () => {
    expect(validateAgainstSchema({ verdict: 'accept', blocking: [], non_blocking: [], summary: '', pipelineIssues: [] }, BUILTIN_SCHEMAS.reviewVerdict)).toEqual([])
    const errors = validateAgainstSchema({ verdict: 'maybe', blocking: 'x' }, BUILTIN_SCHEMAS.reviewVerdict)
    expect(errors).toHaveLength(5)
    expect(errors).toEqual(expect.arrayContaining([
      '$.verdict: must be one of "accept", "reject"',
      '$.blocking: expected array, got string',
      '$.non_blocking: required',
      '$.summary: required',
      '$.pipelineIssues: required'
    ]))
  })
})
