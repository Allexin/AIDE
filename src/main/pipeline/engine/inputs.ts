import type { AgentInput } from '../../../shared/pipelineMachine'
import { resolveRef, stringifyValue, type Scope } from './expressions'

/**
 * Rendering of an agent step's declared inputs into its prompt (E2 of the
 * 2026-10-24 report): the `run.*` file refs can be filtered by path globs, and
 * an input too large for a prompt is saved to a file the agent reads instead —
 * a diff of regenerated golden files once made a 1.4M-character prompt that
 * the CLI refused.
 */

/** Inputs longer than this go to a file; the prompt gets the path and a summary. */
export const MAX_INPUT_CHARS = 100_000
/** Refs whose values are made of files and accept include/exclude globs. */
export const FILE_REFS = new Set(['run.diff', 'run.stagedDiff', 'run.changedFiles'])
const SUMMARY_FILES = 100

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * A glob over repo-relative paths: `*` and `?` stay within a path segment, `**`
 * crosses segments, `{a,b}` is an alternation, a trailing `/` matches everything
 * under the directory. A pattern without `/` matches a file name at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, '')
  if (pattern.endsWith('/')) pattern += '**'
  const anchored = pattern.includes('/')
  pattern = pattern.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{' && pattern.indexOf('}', i) > i) {
      const end = pattern.indexOf('}', i)
      re += `(?:${pattern.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`
      i = end
    } else re += escapeRegExp(c)
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`)
}

function pathFilter(input: AgentInput): ((path: string) => boolean) | null {
  if (!input.include?.length && !input.exclude?.length) return null
  const include = (input.include ?? []).map(globToRegExp)
  const exclude = (input.exclude ?? []).map(globToRegExp)
  return (path) => {
    const p = path.replace(/\\/g, '/')
    return (include.length === 0 || include.some((re) => re.test(p))) && !exclude.some((re) => re.test(p))
  }
}

export interface DiffSection { path: string; text: string; added: number; removed: number }

/** Split a unified git diff into per-file sections. */
export function splitDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = []
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index!)
  starts.forEach((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length).replace(/\n$/, '')
    const lines = text.split('\n')
    let added = 0
    let removed = 0
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) added++
      else if (line.startsWith('-') && !line.startsWith('--- ')) removed++
    }
    sections.push({ path: diffPath(lines), text, added, removed })
  })
  return sections
}

/** The path a diff section is about: the new path, or the old one for a deletion. */
function diffPath(lines: string[]): string {
  const find = (prefix: string): string | undefined => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length)
  const renamed = find('rename to ')
  if (renamed) return renamed
  const plus = find('+++ b/')
  if (plus) return plus
  const minus = find('--- a/')
  if (minus) return minus
  // No content lines (mode change, binary, omitted big file): "diff --git a/P b/P".
  const rest = lines[0].slice('diff --git a/'.length)
  const half = (rest.length - 3) / 2
  return Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' ? rest.slice(0, half) : rest
}

/** `path (kind, staged)` → `path`, the format of `run.changedFiles`. */
function changedFilePath(entry: string): string {
  return entry.replace(/ \([^()]*\)$/, '')
}

interface RenderedInput { text: string; files?: Array<{ path: string; detail?: string }>; filterNote?: string }

function renderValue(input: AgentInput, scope: Scope): RenderedInput {
  const value = resolveRef(input.ref, scope)
  const filter = FILE_REFS.has(input.ref) ? pathFilter(input) : null
  const globs = [input.include?.length ? `include ${input.include.join(', ')}` : '', input.exclude?.length ? `exclude ${input.exclude.join(', ')}` : ''].filter(Boolean).join('; ')
  if (input.ref === 'run.changedFiles' && Array.isArray(value)) {
    const all = value.map(String)
    const kept = filter ? all.filter((e) => filter(changedFilePath(e))) : all
    return {
      text: stringifyValue(kept),
      files: kept.map((e) => ({ path: e })),
      filterNote: filter ? `Filtered by the machine (${globs}): ${kept.length} of ${all.length} files.` : undefined
    }
  }
  if ((input.ref === 'run.diff' || input.ref === 'run.stagedDiff') && typeof value === 'string') {
    const all = splitDiff(value)
    const kept = filter ? all.filter((s) => filter(s.path)) : all
    return {
      text: filter ? kept.map((s) => s.text).join('\n') : value,
      files: kept.map((s) => ({ path: s.path, detail: `+${s.added} −${s.removed}` })),
      filterNote: filter ? `Filtered by the machine (${globs}): ${kept.length} of ${all.length} files.` : undefined
    }
  }
  return { text: stringifyValue(value) }
}

/**
 * The prompt sections for a step's inputs. `save(name, text)` writes an
 * oversized input to a file and returns its path.
 */
export function renderInputs(inputs: Array<string | AgentInput>, scope: Scope, save: (name: string, text: string) => string): string[] {
  return inputs.map((raw) => {
    const input: AgentInput = typeof raw === 'string' ? { ref: raw } : raw
    const { text, files, filterNote } = renderValue(input, scope)
    const head = filterNote ? `${filterNote}\n\n` : ''
    if (text.length <= MAX_INPUT_CHARS) return `## ${input.ref}\n\n${head}${text || '(empty)'}`
    const path = save(input.ref.replace(/[^\w.-]/g, '_'), text)
    const lines = [`## ${input.ref}`, '', `${head}Too large for the prompt (${text.length.toLocaleString('en-US')} characters${files ? `, ${files.length} files` : ''}). AIDE saved it to \`${path}\`; read what you need from that file.`]
    if (files) {
      lines.push('', 'Files in it:', ...files.slice(0, SUMMARY_FILES).map((f) => `- ${f.path}${f.detail ? ` (${f.detail})` : ''}`))
      if (files.length > SUMMARY_FILES) lines.push(`- … and ${files.length - SUMMARY_FILES} more`)
    } else {
      lines.push('', 'It begins:', '', text.slice(0, 2000))
    }
    return lines.join('\n')
  })
}
