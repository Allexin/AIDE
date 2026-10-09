import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { MachineDefinition, ParamDefinition } from './types'

/**
 * The per-project machine library (plan §2.1):
 *   aide/pipelines/*.json                — shared, committed
 *   .aide/users/<user>/pipelines/*.json  — personal; wins on duplicate id
 * Role paths in a machine are relative to the directory of its file.
 */

export interface LibraryEntry {
  machine: MachineDefinition
  machineDir: string
  file: string
  source: 'shared' | 'personal'
}

export interface Library {
  machines: LibraryEntry[]
  /** Files that could not be parsed. */
  errors: Array<{ file: string; error: string }>
}

export function sharedPipelinesDir(projectPath: string): string {
  return join(projectPath, 'aide', 'pipelines')
}

export function loadLibrary(dirs: Array<{ dir: string; source: 'shared' | 'personal' }>): Library {
  const byId = new Map<string, LibraryEntry>()
  const errors: Library['errors'] = []
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = join(dir, name)
      try {
        const machine = JSON.parse(readFileSync(file, 'utf8')) as MachineDefinition
        if (!machine || typeof machine.id !== 'string') throw new Error('missing "id"')
        byId.set(machine.id, { machine, machineDir: dir, file, source })
      } catch (err) {
        errors.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { machines: [...byId.values()], errors }
}

/** Resolve a role path inside the machine directory; refuses paths that escape it. */
export function rolePath(machineDir: string, role: string): string | null {
  const base = resolve(machineDir)
  const full = resolve(base, role)
  return full === base || full.startsWith(base + sep) ? full : null
}

export function roleExists(machineDir: string, role: string): boolean {
  const full = rolePath(machineDir, role)
  return full !== null && existsSync(full)
}

export function readRole(machineDir: string, role: string): string {
  const full = rolePath(machineDir, role)
  if (!full) throw new Error(`Role path "${role}" leaves the pipelines directory.`)
  return readFileSync(full, 'utf8')
}

/** Check run parameters against the machine's declaration. */
export function validateParams(definitions: Record<string, ParamDefinition> | undefined, params: Record<string, unknown>): string[] {
  const errors: string[] = []
  const defs = definitions ?? {}
  for (const [name, def] of Object.entries(defs)) {
    const value = params[name]
    if (value === undefined || value === null || value === '') {
      if (def.required !== false) errors.push(`Missing required param "${name}"${def.description ? ` (${def.description})` : ''}.`)
      continue
    }
    const isStringArray = Array.isArray(value) && value.every((v) => typeof v === 'string')
    const ok = def.type === 'string' || def.type === 'path' ? typeof value === 'string'
      : def.type === 'string[]' || def.type === 'glob[]' ? isStringArray
        : def.type === 'number' ? typeof value === 'number'
          : def.type === 'boolean' ? typeof value === 'boolean'
            : false
    if (!ok) errors.push(`Param "${name}" must be ${def.type}.`)
  }
  for (const name of Object.keys(params)) if (!defs[name]) errors.push(`Unknown param "${name}".`)
  return errors
}
