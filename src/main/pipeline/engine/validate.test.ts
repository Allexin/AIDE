import { describe, expect, it } from 'vitest'
import { validateMachine } from './validate'
import { evaluateCondition, parseCondition, renderTemplate } from './expressions'
import { strictSchemaProblems, validateAgainstSchema, BUILTIN_SCHEMAS } from './schema'
import type { MachineDefinition } from './types'

const env = { headlessClis: ['claude-code', 'codex'], roleExists: (p: string) => !p.includes('missing') }

function machine(overrides: Partial<MachineDefinition>): MachineDefinition {
  return {
    id: 'm', name: 'M', description: 'd', defaults: { cli: 'claude-code' }, start: 'a',
    nodes: { a: { type: 'agent', summary: 's', role: 'roles/a.md', output: 'implementerReport' }, end: { type: 'end', result: 'success' } },
    edges: [['a', 'end', 'default']],
    ...overrides
  }
}

describe('validateMachine', () => {
  it('accepts a minimal machine', () => {
    expect(validateMachine(machine({}), env).errors).toEqual([])
  })

  it('rejects an unbounded loop', () => {
    const result = validateMachine(machine({
      nodes: { a: { type: 'agent', summary: 's', role: 'r.md', output: 'implementerReport' }, c: { type: 'check', command: 'x' }, end: { type: 'end', result: 'success' } },
      edges: [['a', 'c', 'default'], ['c', 'end', 'ok'], ['c', 'a', 'fail']]
    }), env)
    expect(result.errors.join('\n')).toMatch(/has no node with "maxVisits"/)
  })

  it('reports unreachable nodes, dead ends and missing routes', () => {
    const result = validateMachine(machine({
      nodes: { a: { type: 'agent', summary: 's', role: 'r.md', output: 'implementerReport' }, island: { type: 'check', command: 'x' }, end: { type: 'end', result: 'success' } },
      edges: [['a', 'end', "outputs.a.status == 'done'"]]
    }), env)
    const text = result.errors.join('\n')
    expect(text).toMatch(/"island" is unreachable/)
    expect(text).toMatch(/"island" has no outgoing edges/)
    expect(text).toMatch(/Node "a" needs a "default" edge/)
  })

  it('checks refs, roles, CLIs, sessions and summaries', () => {
    const result = validateMachine(machine({
      nodes: {
        a: { type: 'agent', role: 'roles/missing.md', cli: 'aider', output: 'nope', inputs: ['params.ghost', 'outputs.a.bogus', 'run.weird'], session: 'continue:end' },
        end: { type: 'end', result: 'success' }
      }
    }), env)
    const text = result.errors.join('\n')
    expect(text).toMatch(/"summary" is required/)
    expect(text).toMatch(/role file "roles\/missing.md" not found/)
    expect(text).toMatch(/CLI "aider" does not support headless/)
    expect(text).toMatch(/output schema "nope" is not defined/)
    expect(text).toMatch(/unknown param "ghost"/)
    expect(text).toMatch(/unknown run value "run.weird"/)
    expect(text).toMatch(/"session" must be/)
  })

  it('requires a strict schema for Codex nodes', () => {
    const result = validateMachine(machine({
      schemas: { loose: { type: 'object', properties: { a: { type: 'string' } } } },
      nodes: { a: { type: 'agent', summary: 's', role: 'r.md', cli: 'codex', output: 'loose' }, end: { type: 'end', result: 'success' } }
    }), env)
    expect(result.errors.join('\n')).toMatch(/not strict enough for Codex/)
  })

  it('requires the commit prep node to output commitMessage and excluded', () => {
    const result = validateMachine(machine({
      nodes: { a: { type: 'agent', summary: 's', role: 'r.md', output: 'implementerReport' }, c: { type: 'commit', prep: 'a', review: 'algorithmic' }, end: { type: 'end', result: 'success' } },
      edges: [['a', 'c', 'default'], ['c', 'end', 'default']]
    }), env)
    expect(result.errors.join('\n')).toMatch(/must output "commitMessage" and "excluded"/)
  })
})

describe('expressions', () => {
  const scope = { params: { mode: 'fast' }, outputs: { review: { verdict: 'accept', count: 2 } }, run: {} }

  it('parses and evaluates conditions', () => {
    expect(evaluateCondition("outputs.review.verdict == 'accept'", 'ok', scope)).toBe(true)
    expect(evaluateCondition("outputs.review.verdict != 'accept'", 'ok', scope)).toBe(false)
    expect(evaluateCondition('outputs.review.count == 2', 'ok', scope)).toBe(true)
    expect(evaluateCondition('fail', 'fail', scope)).toBe(true)
    expect(evaluateCondition('default', 'fail', scope)).toBe(true)
    expect('error' in parseCondition('outputs.review.verdict == accept')).toBe(true)
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
    expect(validateAgainstSchema({ verdict: 'accept', blocking: [], non_blocking: [], summary: '' }, BUILTIN_SCHEMAS.reviewVerdict)).toEqual([])
    const errors = validateAgainstSchema({ verdict: 'maybe', blocking: 'x' }, BUILTIN_SCHEMAS.reviewVerdict)
    expect(errors).toHaveLength(4)
    expect(errors).toEqual(expect.arrayContaining([
      '$.verdict: must be one of "accept", "reject"',
      '$.blocking: expected array, got string',
      '$.non_blocking: required',
      '$.summary: required'
    ]))
  })
})
