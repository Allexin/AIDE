import type { Outcome } from './types'

/**
 * Edge conditions, references and templates.
 *
 * References are dotted paths into the run scope: `params.<name>`,
 * `outputs.<node>.<field>...`, `run.<value>`. Conditions are `ok`, `fail`,
 * `default`, or `<ref> == <literal>` / `<ref> != <literal>` with a quoted
 * string, number, true, false or null literal. Templates replace `{{ref}}`.
 */

export interface Scope {
  params: Record<string, unknown>
  outputs: Record<string, unknown>
  run: Record<string, unknown>
}

export type ParsedCondition =
  | { kind: 'default' }
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'compare'; ref: string; op: '==' | '!='; literal: unknown }

const COMPARE = /^\s*([A-Za-z_][\w.]*)\s*(==|!=)\s*(.+?)\s*$/

export function parseCondition(condition: string): ParsedCondition | { error: string } {
  const text = condition.trim()
  if (text === 'default') return { kind: 'default' }
  if (text === 'ok' || text === 'fail') return { kind: 'outcome', outcome: text }
  const match = COMPARE.exec(text)
  if (!match) return { error: `Unsupported condition "${condition}". Use ok, fail, default, or "<ref> == <literal>".` }
  const literal = parseLiteral(match[3])
  if (literal === INVALID) return { error: `Invalid literal in condition "${condition}". Quote strings: 'value'.` }
  if (!/^(params|outputs|run)\./.test(match[1])) return { error: `Condition "${condition}" must reference params., outputs. or run.` }
  return { kind: 'compare', ref: match[1], op: match[2] as '==' | '!=', literal }
}

const INVALID = Symbol('invalid')

function parseLiteral(text: string): unknown {
  if (/^'(?:[^'\\]|\\.)*'$/.test(text) || /^"(?:[^"\\]|\\.)*"$/.test(text)) return text.slice(1, -1).replace(/\\(.)/g, '$1')
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return INVALID
}

export function resolveRef(ref: string, scope: Scope): unknown {
  const [root, ...path] = ref.split('.')
  let value: unknown = (scope as unknown as Record<string, unknown>)[root]
  for (const key of path) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function evaluateCondition(condition: string, outcome: Outcome, scope: Scope): boolean {
  const parsed = parseCondition(condition)
  if ('error' in parsed) return false
  if (parsed.kind === 'default') return true
  if (parsed.kind === 'outcome') return parsed.outcome === outcome
  const equal = JSON.stringify(resolveRef(parsed.ref, scope)) === JSON.stringify(parsed.literal)
  return parsed.op === '==' ? equal : !equal
}

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.map((item) => `- ${item}`).join('\n')
  return JSON.stringify(value, null, 2)
}

export function renderTemplate(text: string, scope: Scope): string {
  return text.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, ref: string) => stringifyValue(resolveRef(ref, scope)))
}

/** References used by a template, for validation. */
export function templateRefs(text: string): string[] {
  return Array.from(text.matchAll(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g), (match) => match[1])
}
