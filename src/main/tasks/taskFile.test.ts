import { describe, expect, it } from 'vitest'
import type { TaskFile } from '../../shared/task'
import { frontMatterId, parseTask, revisionOf, serializeTask, taskProblems } from './taskFile'

function sampleTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: 'terminal-tab-titles',
    title: 'Add titles to terminal tabs',
    status: 'done',
    rank: null,
    tags: ['terminal', 'sessions'],
    docs: ['docs/session-binding-and-lifecycle-events-spec.md#titles'],
    code: ['src/main/pty/titles.ts', 'src/renderer/src/components/terminal/*.tsx'],
    reason: null,
    blockedFrom: null,
    label: 'Terminal tab titles',
    claim: 'Terminal tab titles are stored in .aide/Titles/{sessionId}.txt; the default is\n"Claude Code"; the session picker shows the saved title.',
    decidedAgainst: null,
    reopened: false,
    history: null,
    confirmed: { at: '2026-11-21T15:00:00Z', by: 'close', files: { 'src/main/pty/titles.ts': '3f9a01', 'src/b.ts': '0123' } },
    acknowledged: null,
    check: null,
    source: null,
    activeBy: [],
    created: '2026-11-20T10:00:00Z',
    closed: '2026-11-21T15:00:00Z',
    description: 'Why and what.\n\n## Notes inside\n\n```ts\nconst x = 1\n```\n\n## Journal\nnot the journal: a heading inside the description',
    journal: ['2026-11-20 allex/tab 3: decided to keep titles out of JSONL.', '2026-11-21 close: claim; supersedes session-slug-labels.'],
    ...overrides
  }
}

function parsed(text: string, fileName = 'terminal-tab-titles.md'): TaskFile {
  const result = parseTask(text, fileName)
  if ('errors' in result) throw new Error(result.errors.join('\n'))
  return result.task
}

function errorsOf(text: string, fileName = 'terminal-tab-titles.md'): string[] {
  const result = parseTask(text, fileName)
  return 'errors' in result ? result.errors : []
}

/** The serialized sample with one front-matter line replaced (`key: value`), or removed when `line` is null. */
function withLine(key: string, line: string | null, task = sampleTask()): string {
  const text = serializeTask(task)
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (at < 0) throw new Error(`no ${key}`)
  let end = at + 1
  while (end < lines.length && lines[end].startsWith('  ')) end++
  lines.splice(at, end - at, ...(line === null ? [] : [line]))
  return lines.join('\n')
}

describe('task file round trip', () => {
  it('parseTask(serializeTask(t)) gives t back exactly', () => {
    const tasks: TaskFile[] = [
      sampleTask(),
      sampleTask({ id: 'a', status: 'planned', rank: 0.30000000000000004, label: null, claim: null, confirmed: null, closed: null, description: '', journal: [] }),
      sampleTask({ status: 'blocked', blockedFrom: 'active', reason: 'waits for: the "API" #3', rank: null, activeBy: ['allex', 'bob'] }),
      sampleTask({ status: 'cancelled', label: null, claim: null, decidedAgainst: 'We do not do X because Y.', history: { at: '2026-11-22T00:00:00Z', by: 'other-task', reason: 'superseded' } }),
      sampleTask({
        title: 'null',
        tags: ['yes', '123', 'a: b', '#hash', '[x]'],
        source: 'STAGES.md',
        reopened: true,
        acknowledged: { at: '2026-11-22T00:00:00Z', by: 'allex/tab 2', kind: 'keep', note: 'trailing  ' },
        check: { at: '2026-11-22T00:00:00Z', result: 'suspect', note: '' },
        journal: ['', '  indented', 'trailing  ', '- dash'],
        description: '  indented first line\n---\nnot front matter'
      })
    ]
    for (const task of tasks) {
      const text = serializeTask(task)
      expect(parsed(text, `${task.id}.md`)).toEqual(task)
      expect(serializeTask(parsed(text, `${task.id}.md`))).toBe(text)
    }
  })

  it('writes the keys in TaskFile order and the body as two sections', () => {
    const text = serializeTask(sampleTask())
    const keys = text.split('\n---\n')[0].split('\n').filter((l) => /^[a-zA-Z]+:/.test(l)).map((l) => l.split(':')[0])
    expect(keys).toEqual(['id', 'title', 'status', 'rank', 'tags', 'docs', 'code', 'reason', 'blockedFrom', 'label', 'claim', 'decidedAgainst', 'reopened', 'history', 'confirmed', 'acknowledged', 'check', 'source', 'activeBy', 'created', 'closed'])
    expect(text.startsWith('---\nid: terminal-tab-titles\n')).toBe(true)
    expect(text).toContain('tags: [terminal, sessions]\n')
    expect(text).toContain('\n---\n\n## Description\nWhy and what.\n')
    expect(text.endsWith('\n## Journal\n- 2026-11-20 allex/tab 3: decided to keep titles out of JSONL.\n- 2026-11-21 close: claim; supersedes session-slug-labels.\n')).toBe(true)
  })

  it('stores the description without surrounding blank lines', () => {
    const task = sampleTask({ description: '\n\nBody\n\n' })
    expect(parsed(serializeTask(task)).description).toBe('Body')
  })

  it('parses CRLF input', () => {
    const text = serializeTask(sampleTask())
    expect(parsed(text.replace(/\n/g, '\r\n'))).toEqual(sampleTask())
  })

  it('parses a hand-edited file with extra blank lines, comments and left-out optional keys', () => {
    const text = [
      '---',
      'id: hand-made',
      'title: Written by hand   # a comment',
      'status: backlog',
      'created: 2026-11-20T10:00:00Z',
      '',
      'tags: [x]',
      '---',
      '',
      '',
      '## Description',
      '',
      '',
      'The body.',
      '',
      'More.',
      '',
      '',
      '',
      '## Journal',
      '',
      '- first',
      '',
      '- second',
      '',
      ''
    ].join('\n')
    expect(parsed(text, 'hand-made.md')).toEqual({
      id: 'hand-made', title: 'Written by hand', status: 'backlog', rank: null, tags: ['x'], docs: [], code: [], reason: null,
      blockedFrom: null, label: null, claim: null, decidedAgainst: null, reopened: false, history: null, confirmed: null,
      acknowledged: null, check: null, source: null, activeBy: [], created: '2026-11-20T10:00:00Z', closed: null,
      description: 'The body.\n\nMore.', journal: ['first', 'second']
    })
  })

  it('reads a file without body sections as an empty description and journal', () => {
    expect(parsed('---\nid: a\ntitle: A\nstatus: backlog\ncreated: 2026-11-20T10:00:00Z\n---\n', 'a.md')).toMatchObject({ description: '', journal: [] })
  })
})

describe('task file validation', () => {
  it('reports unknown keys, so a typo is not lost', () => {
    expect(errorsOf(withLine('label', 'lable: Terminal tab titles'))).toEqual(['unknown key "lable"'])
    expect(errorsOf(withLine('history', 'history: { at: 2026-11-22T00:00:00Z, by: null, reason: r, extra: 1 }', sampleTask()))).toEqual(['unknown key "history.extra"'])
    expect(errorsOf(withLine('source', 'description: x'))).toEqual([expect.stringContaining('"description" is not a front-matter key')])
  })

  it('reports missing required keys', () => {
    for (const key of ['id', 'title', 'status', 'created']) {
      expect(errorsOf(withLine(key, null))).toContain(`"${key}" is missing`)
    }
  })

  it('reports every invalid field, all at once', () => {
    const cases: [string, string, string][] = [
      ['id', 'id: Not_A_Slug', '"id" must be a slug'],
      ['id', 'id: other', '"id" is "other" but the file is terminal-tab-titles.md'],
      ['title', 'title: ""', '"title" must be a non-empty string'],
      ['title', 'title: 12', '"title" must be a non-empty string'],
      ['status', 'status: finished', '"status" must be one of'],
      ['rank', 'rank: high', '"rank" must be a number or null'],
      ['tags', 'tags: terminal', '"tags" must be a list'],
      ['tags', 'tags: [""]', '"tags[0]" must be a non-empty string'],
      ['docs', 'docs: [/etc/passwd]', '"docs[0]" must be relative to the project root'],
      ['code', 'code: ["../outside/*.ts"]', '"code[0]" must be relative to the project root'],
      ['code', 'code: ["C:\\\\x.ts"]', '"code[0]" must be relative to the project root'],
      ['reason', 'reason: 5', '"reason" must be a string'],
      ['blockedFrom', 'blockedFrom: done', '"blockedFrom" must be one of backlog, planned, active'],
      ['claim', 'claim: ""', '"claim" must be a non-empty string or null'],
      ['decidedAgainst', 'decidedAgainst: [x]', '"decidedAgainst" must be a string'],
      ['reopened', 'reopened: "no"', '"reopened" must be true or false'],
      ['history', 'history: yes', '"history" must be null or an object'],
      ['history', 'history: { at: 2026-11-22T00:00:00Z, by: Bad, reason: r }', '"history.by" must be a slug'],
      ['history', 'history: { at: yesterday, by: null, reason: r }', '"history.at" must be an ISO time'],
      ['history', 'history: { at: 2026-11-22T00:00:00Z, by: null }', '"history.reason" is missing'],
      ['confirmed', 'confirmed: { at: 2026-11-22T00:00:00Z, by: robot, files: {} }', '"confirmed.by" must be one of close, documenter, user, migration'],
      ['confirmed', 'confirmed: { at: 2026-11-22T00:00:00Z, by: user, files: { a.ts: 1 } }', '"confirmed.files.a.ts" must be a string'],
      ['acknowledged', 'acknowledged: { at: 2026-11-22T00:00:00Z, by: x, kind: maybe, note: n }', '"acknowledged.kind" must be one of keep, restore'],
      ['check', 'check: { at: 2026-11-22T00:00:00Z, result: fine, note: n }', '"check.result" must be one of ok, suspect'],
      ['source', 'source: 1', '"source" must be a string'],
      ['activeBy', 'activeBy: allex', '"activeBy" must be a list'],
      ['created', 'created: 2026', '"created" must be an ISO time'],
      ['closed', 'closed: soon', '"closed" must be an ISO time']
    ]
    for (const [key, line, error] of cases) {
      expect(errorsOf(withLine(key, line)), line).toEqual(expect.arrayContaining([expect.stringContaining(error)]))
    }
  })

  it('reports rules between fields', () => {
    const rule = (task: TaskFile): string[] => errorsOf(serializeTask(task), `${task.id}.md`)
    expect(rule(sampleTask({ rank: 2 }))).toEqual(['"rank" is only for backlog and planned tasks, this one is done'])
    expect(rule(sampleTask({ claim: null }))).toEqual(['"label" and "claim" go together: set both or neither'])
    expect(rule(sampleTask({ status: 'active', closed: null, history: { at: '2026-11-22T00:00:00Z', by: null, reason: 'r' } }))).toEqual(['"history" is only for done and cancelled tasks, this one is active'])
    expect(rule(sampleTask({ status: 'blocked', reason: 'x' }))).toEqual(['a blocked task needs "blockedFrom", the status it returns to'])
    expect(rule(sampleTask({ blockedFrom: 'planned' }))).toEqual(['"blockedFrom" is only for blocked tasks, this one is done'])
    expect(rule(sampleTask({ status: 'planned', rank: 1.5, label: null, claim: null }))).toEqual([])
  })

  it('reports several invalid fields of one file together', () => {
    const text = withLine('rank', 'rank: high', sampleTask()).replace('status: done', 'status: finished').replace('title: Add titles to terminal tabs', 'title: [x]')
    const errors = errorsOf(text)
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('"rank"'), expect.stringContaining('"status"'), expect.stringContaining('"title"')]))
  })

  it('reports a broken file shape', () => {
    expect(errorsOf('id: a\n')).toEqual([expect.stringContaining('must start with a "---" line')])
    expect(errorsOf('---\nid: a\n')).toEqual([expect.stringContaining('no closing "---"')])
    expect(errorsOf('---\nid: [a\n---\n')).toEqual([expect.stringContaining('not valid YAML')])
    expect(errorsOf('---\nid: a\nid: b\n---\n')).toEqual([expect.stringContaining('not valid YAML')])
    expect(errorsOf('---\n- a\n---\n')).toEqual(['the front matter must be a YAML map of keys'])
    const text = serializeTask(sampleTask())
    expect(errorsOf(text.replace('\n## Description\n', '\nstray text\n## Description\n'))).toEqual([expect.stringContaining('text before "## Description"')])
    expect(errorsOf(text + 'not a journal line\n')).toEqual([expect.stringContaining('does not start with "- "')])
  })

  it('validates task objects before they are written', () => {
    expect(taskProblems(sampleTask())).toEqual([])
    expect(taskProblems({ ...sampleTask(), extra: 1 })).toEqual(['unknown key "extra"'])
    expect(taskProblems(sampleTask({ journal: ['two\nlines'] }))).toEqual(['journal line 1 must be one line'])
    expect(taskProblems(sampleTask(), 'other')).toEqual(['"id" is "terminal-tab-titles" but the file is other.md'])
  })
})

describe('revisionOf and frontMatterId', () => {
  it('is a content hash: 12 hex chars that change with any edit', () => {
    const text = serializeTask(sampleTask())
    expect(revisionOf(text)).toMatch(/^[0-9a-f]{12}$/)
    expect(revisionOf(text)).toBe(revisionOf(Buffer.from(text, 'utf8')))
    expect(revisionOf(text + '\n')).not.toBe(revisionOf(text))
    expect(revisionOf(text.replace(/\n/g, '\r\n'))).not.toBe(revisionOf(text))
  })

  it('reads the id of an invalid file', () => {
    expect(frontMatterId('---\nid: a\nstatus: nope\n---\n')).toBe('a')
    expect(frontMatterId('no front matter')).toBeNull()
  })
})
