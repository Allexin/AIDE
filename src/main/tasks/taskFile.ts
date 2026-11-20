import { createHash } from 'crypto'
import { Document, isSeq, parse as parseYaml, visit } from 'yaml'
import { CLOSED_TASK_STATUSES, TASK_STATUSES, type TaskFile } from '../../shared/task'

/**
 * The task file format (docs/task-tracker-implementation.md §2):
 *
 *   ---
 *   <YAML front matter: every field of TaskFile but description and journal, in TaskFile order>
 *   ---
 *
 *   ## Description
 *   <Markdown>
 *
 *   ## Journal
 *   - <line>
 *
 * The description is everything between the first "## Description" line and the
 * last "## Journal" line, so a description may hold any heading of its own. It is
 * stored without surrounding blank lines and trailing whitespace.
 */

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Front-matter keys in the order they are written. */
const FRONT_MATTER_KEYS = [
  'id', 'title', 'status', 'rank', 'tags', 'docs', 'code', 'reason', 'blockedFrom', 'label', 'claim',
  'decidedAgainst', 'reopened', 'history', 'confirmed', 'acknowledged', 'check', 'source', 'activeBy',
  'created', 'closed'
] as const satisfies readonly (keyof TaskFile)[]

type FrontMatterKey = typeof FRONT_MATTER_KEYS[number]

/** Keys a hand-written file may leave out, with the value they mean. */
const OPTIONAL_DEFAULTS: Partial<Record<FrontMatterKey, () => unknown>> = {
  rank: () => null,
  tags: () => [],
  docs: () => [],
  code: () => [],
  reason: () => null,
  blockedFrom: () => null,
  label: () => null,
  claim: () => null,
  decidedAgainst: () => null,
  reopened: () => false,
  history: () => null,
  confirmed: () => null,
  acknowledged: () => null,
  check: () => null,
  source: () => null,
  activeBy: () => [],
  closed: () => null
}

const DESCRIPTION_HEADING = '## Description'
const JOURNAL_HEADING = '## Journal'

/** The first 12 hex chars of SHA-256 of the file's bytes. Never stored in the file. */
export function revisionOf(content: string | Buffer): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex').slice(0, 12)
}

/** The description as it is stored: no surrounding blank lines, no trailing whitespace. */
export function normalizeDescription(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
}

function idFromFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}

interface Split { frontMatter: string; body: string }

function splitFile(text: string): Split | string {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trimEnd() !== '---') return 'the file must start with a "---" line opening the front matter'
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
  if (end < 0) return 'the front matter has no closing "---" line'
  return { frontMatter: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') }
}

/** The front matter's `id`, also of an invalid file; null when it cannot be read. */
export function frontMatterId(text: string): string | null {
  const split = splitFile(text)
  if (typeof split === 'string') return null
  try {
    const value = parseYaml(split.frontMatter, { logLevel: 'error' }) as unknown
    const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

function parseBody(body: string, errors: string[]): { description: string; journal: string[] } {
  const lines = body.split('\n')
  const descriptionAt = lines.findIndex((line) => line.trimEnd() === DESCRIPTION_HEADING)
  let journalAt = -1
  for (let i = lines.length - 1; i > descriptionAt; i--) {
    if (lines[i].trimEnd() === JOURNAL_HEADING) { journalAt = i; break }
  }
  const start = descriptionAt >= 0 ? descriptionAt : journalAt >= 0 ? journalAt : lines.length
  if (lines.slice(0, start).some((line) => line.trim())) {
    errors.push(`text before "${DESCRIPTION_HEADING}" would be lost: put it into the description`)
  }
  const description = descriptionAt >= 0 ? normalizeDescription(lines.slice(descriptionAt + 1, journalAt >= 0 ? journalAt : lines.length).join('\n')) : ''
  const journal: string[] = []
  if (journalAt >= 0) {
    lines.slice(journalAt + 1).forEach((line, i) => {
      if (!line.trim()) return
      if (line === '-' || line.startsWith('- ')) journal.push(line.slice(2))
      else errors.push(`journal line ${i + 1} ("${line.slice(0, 40)}") does not start with "- "`)
    })
  }
  return { description, journal }
}

// ── validation ───────────────────────────────────────────────────────────────

type Check = (value: unknown, name: string, errors: string[]) => void

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function isIsoTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value))
}

const str: Check = (value, name, errors) => {
  if (typeof value !== 'string') errors.push(`"${name}" must be a string`)
}

const oneLine: Check = (value, name, errors) => {
  if (typeof value !== 'string' || !value.trim()) errors.push(`"${name}" must be a non-empty string`)
  else if (/[\r\n]/.test(value)) errors.push(`"${name}" must be one line`)
}

const time: Check = (value, name, errors) => {
  if (typeof value !== 'string' || !isIsoTime(value)) errors.push(`"${name}" must be an ISO time such as 2026-11-20T10:00:00Z`)
}

const nullable = (check: Check): Check => (value, name, errors) => {
  if (value !== null) check(value, name, errors)
}

const oneOf = (values: readonly string[]): Check => (value, name, errors) => {
  if (typeof value !== 'string' || !values.includes(value)) errors.push(`"${name}" must be one of ${values.join(', ')}`)
}

const listOf = (item: Check): Check => (value, name, errors) => {
  if (!Array.isArray(value)) { errors.push(`"${name}" must be a list`); return }
  value.forEach((entry, i) => item(entry, `${name}[${i}]`, errors))
}

const relativePath: Check = (value, name, errors) => {
  oneLine(value, name, errors)
  if (typeof value !== 'string') return
  const path = value.split('#')[0]
  if (/^([a-zA-Z]:)?[\\/]/.test(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) errors.push(`"${name}" must be relative to the project root`)
}

const slug: Check = (value, name, errors) => {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) errors.push(`"${name}" must be a slug: lowercase letters, digits and "-", starting with a letter or digit, at most 64 characters`)
}

const object = (fields: Record<string, Check>): Check => (value, name, errors) => {
  if (!isRecord(value)) { errors.push(`"${name}" must be null or an object with ${Object.keys(fields).join(', ')}`); return }
  for (const key of Object.keys(value)) {
    if (!(key in fields)) errors.push(`unknown key "${name}.${key}"`)
  }
  for (const [key, check] of Object.entries(fields)) {
    if (!(key in value)) errors.push(`"${name}.${key}" is missing`)
    else check(value[key], `${name}.${key}`, errors)
  }
}

const fileHashes: Check = (value, name, errors) => {
  if (!isRecord(value)) { errors.push(`"${name}" must be a map of path to hash`); return }
  for (const [path, hash] of Object.entries(value)) {
    if (typeof hash !== 'string') errors.push(`"${name}.${path}" must be a string`)
  }
}

const FIELD_CHECKS: Record<FrontMatterKey, Check> = {
  id: slug,
  title: oneLine,
  status: oneOf(TASK_STATUSES),
  rank: nullable((value, name, errors) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`"${name}" must be a number or null`)
  }),
  tags: listOf(oneLine),
  docs: listOf(relativePath),
  code: listOf(relativePath),
  reason: nullable(str),
  blockedFrom: nullable(oneOf(['backlog', 'planned', 'active'])),
  label: nullable(oneLine),
  claim: nullable((value, name, errors) => {
    if (typeof value !== 'string' || !value.trim()) errors.push(`"${name}" must be a non-empty string or null`)
  }),
  decidedAgainst: nullable(str),
  reopened: (value, name, errors) => {
    if (typeof value !== 'boolean') errors.push(`"${name}" must be true or false`)
  },
  history: nullable(object({ at: time, by: nullable(slug), reason: str })),
  confirmed: nullable(object({ at: time, by: oneOf(['close', 'documenter', 'user', 'migration']), files: fileHashes })),
  acknowledged: nullable(object({ at: time, by: str, kind: oneOf(['keep', 'restore']), note: str })),
  check: nullable(object({ at: time, result: oneOf(['ok', 'suspect']), note: str })),
  source: nullable(str),
  activeBy: listOf(oneLine),
  created: time,
  closed: nullable(time)
}

/** Rules between fields; only called when every field has a valid type. */
function crossFieldProblems(task: TaskFile): string[] {
  const errors: string[] = []
  if (task.rank !== null && task.status !== 'backlog' && task.status !== 'planned') errors.push(`"rank" is only for backlog and planned tasks, this one is ${task.status}`)
  if ((task.label === null) !== (task.claim === null)) errors.push('"label" and "claim" go together: set both or neither')
  if (task.history !== null && !CLOSED_TASK_STATUSES.includes(task.status)) errors.push(`"history" is only for done and cancelled tasks, this one is ${task.status}`)
  if (task.status === 'blocked' && task.blockedFrom === null) errors.push('a blocked task needs "blockedFrom", the status it returns to')
  if (task.status !== 'blocked' && task.blockedFrom !== null) errors.push(`"blockedFrom" is only for blocked tasks, this one is ${task.status}`)
  return errors
}

/**
 * Problems of a task object, as written by the service or read from a file;
 * empty when it is valid. `expectedId` is the id its file name requires.
 */
export function taskProblems(value: unknown, expectedId?: string): string[] {
  if (!isRecord(value)) return ['the task must be an object']
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!(FRONT_MATTER_KEYS as readonly string[]).includes(key) && key !== 'description' && key !== 'journal') errors.push(`unknown key "${key}"`)
  }
  for (const key of FRONT_MATTER_KEYS) {
    if (!(key in value)) errors.push(`"${key}" is missing`)
    else FIELD_CHECKS[key](value[key], key, errors)
  }
  if (typeof value.description !== 'string') errors.push('"description" must be a string')
  if (!Array.isArray(value.journal) || value.journal.some((entry) => typeof entry !== 'string')) errors.push('"journal" must be a list of strings')
  else value.journal.forEach((entry: string, i: number) => {
    if (/[\r\n]/.test(entry)) errors.push(`journal line ${i + 1} must be one line`)
  })
  if (expectedId !== undefined && typeof value.id === 'string' && value.id !== expectedId) errors.push(`"id" is "${value.id}" but the file is ${expectedId}.md`)
  if (!errors.length) errors.push(...crossFieldProblems(value as unknown as TaskFile))
  return errors
}

/** Parse and validate a task file. `fileName` is `<id>.md` (a path is fine). */
export function parseTask(text: string, fileName: string): { task: TaskFile } | { errors: string[] } {
  const split = splitFile(text)
  if (typeof split === 'string') return { errors: [split] }
  let front: unknown
  try {
    front = parseYaml(split.frontMatter, { logLevel: 'error' })
  } catch (err) {
    return { errors: [`the front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (front === null || front === undefined) front = {}
  if (!isRecord(front)) return { errors: ['the front matter must be a YAML map of keys'] }
  const errors: string[] = []
  for (const key of ['description', 'journal']) {
    if (key in front) errors.push(`"${key}" is not a front-matter key: write it as the "## ${key[0].toUpperCase()}${key.slice(1)}" section`)
  }
  const fields: Record<string, unknown> = {}
  for (const key of FRONT_MATTER_KEYS) {
    if (key in front) fields[key] = front[key]
    else if (OPTIONAL_DEFAULTS[key]) fields[key] = OPTIONAL_DEFAULTS[key]!()
  }
  for (const key of Object.keys(front)) {
    if (!(key in fields) && key !== 'description' && key !== 'journal') fields[key] = front[key]
  }
  const body = parseBody(split.body, errors)
  const task = { ...fields, ...body }
  errors.push(...taskProblems(task, idFromFileName(fileName)))
  return errors.length ? { errors } : { task: task as unknown as TaskFile }
}

/** The file text of a task; `parseTask(serializeTask(t))` gives `t` back. */
export function serializeTask(task: TaskFile): string {
  const front: Record<string, unknown> = {}
  for (const key of FRONT_MATTER_KEYS) front[key] = task[key]
  const doc = new Document(front)
  // Lists of strings read best on one line, as in the spec's example.
  visit(doc, { Seq(_, node) { if (isSeq(node)) node.flow = true } })
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  const description = normalizeDescription(task.description)
  const journal = task.journal.map((entry) => entry ? `- ${entry}` : '-').join('\n')
  return `---\n${yaml}---\n\n${DESCRIPTION_HEADING}\n${description ? `${description}\n` : ''}\n${JOURNAL_HEADING}\n${journal ? `${journal}\n` : ''}`
}
