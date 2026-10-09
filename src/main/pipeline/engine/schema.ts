import type { JsonSchema } from './types'

/**
 * Output contracts of agent nodes. Built-in schemas are written in the strict
 * form Codex requires (`additionalProperties: false`, every property required),
 * which Claude Code accepts as well.
 */

export const BUILTIN_SCHEMAS: Record<string, JsonSchema> = {
  implementerReport: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'docsChanged'],
    properties: {
      status: { type: 'string', enum: ['done', 'blocked', 'plan_wrong'], description: 'done: the task is implemented; blocked: cannot proceed; plan_wrong: the task as specified should not be done this way.' },
      summary: { type: 'string', description: 'What was done, or why it is blocked / why the plan is wrong.' },
      docsChanged: { type: 'array', items: { type: 'string' }, description: 'Documentation files changed.' }
    }
  },
  reviewVerdict: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'blocking', 'non_blocking', 'summary'],
    properties: {
      verdict: { type: 'string', enum: ['accept', 'reject'] },
      blocking: { type: 'array', items: { type: 'string' }, description: 'Findings that must be fixed before acceptance. Empty when accepting.' },
      non_blocking: { type: 'array', items: { type: 'string' }, description: 'Optional improvements; they do not block acceptance.' },
      summary: { type: 'string' }
    }
  },
  commitPrep: {
    type: 'object',
    additionalProperties: false,
    required: ['commitMessage', 'excluded'],
    properties: {
      commitMessage: { type: 'string', description: 'Full commit message: subject line, blank line, body.' },
      excluded: {
        type: 'array',
        description: 'Changed or untracked files deliberately not staged, with the reason.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'reason'],
          properties: { path: { type: 'string' }, reason: { type: 'string' } }
        }
      }
    }
  },
  commitReview: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'issues'],
    properties: {
      verdict: { type: 'string', enum: ['accept', 'reject'] },
      issues: { type: 'array', items: { type: 'string' } }
    }
  }
}

export function resolveSchema(name: string | undefined, machineSchemas: Record<string, JsonSchema> | undefined): JsonSchema | null {
  if (!name) return null
  return machineSchemas?.[name] ?? BUILTIN_SCHEMAS[name] ?? null
}

/**
 * Validate a value against the JSON Schema subset used by output contracts:
 * type, enum, const, required, properties, additionalProperties (boolean),
 * items, minItems/maxItems, minLength/maxLength, minimum/maximum.
 * Returns human-readable errors (empty when valid).
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = []
  const type = schema.type as string | string[] | undefined
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some((t) => matchesType(value, t))) {
      return [`${path}: expected ${types.join(' | ')}, got ${describe(value)}`]
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}`)
  }
  if ('const' in schema && !deepEqual(schema.const, value)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`)))
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in object)) errors.push(`${path}.${key}: required`)
    }
    for (const [key, propertyValue] of Object.entries(object)) {
      if (properties[key]) errors.push(...validateAgainstSchema(propertyValue, properties[key], `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`)
    }
  }
  return errors
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Strict-mode problems that make Codex reject a schema (every object: no extra properties, all properties required). */
export function strictSchemaProblems(schema: JsonSchema, path = '$'): string[] {
  const problems: string[] = []
  if (schema.type === 'object' || schema.properties) {
    const properties = Object.keys((schema.properties ?? {}) as Record<string, unknown>)
    if (schema.additionalProperties !== false) problems.push(`${path}: set "additionalProperties": false`)
    const required = new Set((schema.required as string[] | undefined) ?? [])
    for (const key of properties) if (!required.has(key)) problems.push(`${path}.${key}: must be listed in "required"`)
    for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) problems.push(...strictSchemaProblems(child, `${path}.${key}`))
  }
  if (schema.items && typeof schema.items === 'object') problems.push(...strictSchemaProblems(schema.items as JsonSchema, `${path}[]`))
  return problems
}
