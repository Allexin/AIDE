import { createHash, randomUUID } from 'crypto'
import { spawn } from 'child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SmartCompactAnalysis, SmartCompactApplyResult, SmartCompactCapability, SmartCompactCandidate } from './types'

export interface JsonlRecord {
  line: number
  raw: string
  value: Record<string, unknown> | null
}

export interface RecordInfo {
  removable: boolean
  role: string
  preview: string
  links: string[]
}

interface AutonomousWorkspace {
  directory: string
  sessionFile: string
  reportFile: string
}

interface JsonlCapabilityOptions {
  locateSessionFile(projectPath: string, sessionId: string): string | null
  getStorageInstructions(sessionFile: string): string
  runAutonomous(options: {
    projectPath: string
    workspace: AutonomousWorkspace
    prompt: string
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  }): Promise<{ stdout: string; stderr: string }>
  describeRecord(record: JsonlRecord, records: JsonlRecord[]): RecordInfo
  prepareRetainedRecords?(retained: JsonlRecord[], original: JsonlRecord[]): JsonlRecord[]
}

interface StoredAnalysis {
  projectPath: string
  sessionId: string
  filePath: string
  fingerprint: string
  records: JsonlRecord[]
  candidates: Map<string, number[]>
}

const analyses = new Map<string, StoredAnalysis>()

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readRecords(filePath: string): { content: string; records: JsonlRecord[] } {
  if (!existsSync(filePath)) throw new Error('Session file not found')
  const content = readFileSync(filePath, 'utf-8')
  const records: JsonlRecord[] = []
  let line = 0
  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue
    line++
    let value: Record<string, unknown> | null = null
    try { value = JSON.parse(raw) as Record<string, unknown> } catch { /* retained, never removable */ }
    records.push({ line, raw, value })
  }
  return { content, records }
}

function parseReport(reportFile: string): Array<{ lines: number[]; reason: string }> {
  if (!existsSync(reportFile)) throw new Error('Analyzer did not create report.json')
  const parsed = JSON.parse(readFileSync(reportFile, 'utf-8')) as { groups?: unknown }
  if (!Array.isArray(parsed.groups)) throw new Error('Analyzer report has invalid JSON structure')
  return parsed.groups.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const obj = item as Record<string, unknown>
    if (!Array.isArray(obj.lines)) return []
    const lines = [...new Set(obj.lines.filter((v): v is number => Number.isInteger(v) && (v as number) > 0))]
    if (lines.length === 0) return []
    return [{ lines, reason: typeof obj.reason === 'string' ? obj.reason : 'Selected by analyzer' }]
  })
}

function buildLinkMap(records: JsonlRecord[], describe: (record: JsonlRecord, records: JsonlRecord[]) => RecordInfo): Map<number, Set<number>> {
  const byLink = new Map<string, number[]>()
  for (const record of records) {
    for (const link of describe(record, records).links) {
      const list = byLink.get(link) ?? []
      list.push(record.line)
      byLink.set(link, list)
    }
  }
  const map = new Map<number, Set<number>>()
  for (const lines of byLink.values()) {
    for (const line of lines) {
      const set = map.get(line) ?? new Set<number>()
      lines.forEach((linked) => set.add(linked))
      map.set(line, set)
    }
  }
  return map
}

function expandAtomic(lines: number[], links: Map<number, Set<number>>): number[] {
  const result = new Set(lines)
  const queue = [...lines]
  while (queue.length > 0) {
    const line = queue.pop()!
    for (const linked of links.get(line) ?? []) {
      if (result.has(linked)) continue
      result.add(linked)
      queue.push(linked)
    }
  }
  return [...result].sort((a, b) => a - b)
}

function buildPrompt(task: string, instructions: string): string {
  return `Analyze the conversation snapshot at session.jsonl and write the result to report.json.

User cleanup request:
${task}

Storage format:
${instructions}

Rules:
- Work only inside the current temporary directory.
- Do not modify session.jsonl.
- Be conservative. Keep a record whenever future relevance is uncertain.
- Keep architectural decisions, active requirements, and conclusions relevant to ongoing work.
- Select only completed or abandoned side investigations described by the cleanup request.
- Tool calls and their results must be selected together.
- Never select metadata or the trailing active exchange.
- Line numbers are 1-based non-empty JSONL records.
- report.json must have exactly this shape:
  {"groups":[{"lines":[5,6],"reason":"short explanation"}]}
- Use {"groups":[]} when nothing can be safely removed.
- After writing report.json, read it back. Validate its JSON syntax, line numbers, and atomic groups.
  Correct the file if any check fails. Your final response may be brief; AIDE reads report.json.`
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: Record<string, string>
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      options.onOutput?.('stdout', chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      options.onOutput?.('stderr', chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })
}

function writeAtomically(filePath: string, records: JsonlRecord[]): void {
  const next = records.length > 0 ? `${records.map((record) => record.raw).join('\n')}\n` : ''
  const tmp = `${filePath}.smart-compact.tmp`
  const backup = `${filePath}.smart-compact.bak`
  writeFileSync(tmp, next, 'utf-8')
  try {
    renameSync(filePath, backup)
    try {
      renameSync(tmp, filePath)
      unlinkSync(backup)
    } catch (error) {
      if (existsSync(filePath)) unlinkSync(filePath)
      renameSync(backup, filePath)
      throw error
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

function findForcedMatches(selected: JsonlRecord[], current: JsonlRecord[]): { lines: Set<number>; missing: number; ambiguous: number } {
  const available = new Map<string, number[]>()
  for (const record of current) {
    const list = available.get(record.raw) ?? []
    list.push(record.line)
    available.set(record.raw, list)
  }
  const lines = new Set<number>()
  let missing = 0
  let ambiguous = 0
  for (const record of selected) {
    const matches = (available.get(record.raw) ?? []).filter((line) => !lines.has(line))
    if (matches.length === 0) { missing++; continue }
    if (matches.length > 1) ambiguous++
    lines.add(matches[0])
  }
  return { lines, missing, ambiguous }
}

export function createJsonlSmartCompactCapability(options: JsonlCapabilityOptions): SmartCompactCapability {
  return {
    getStorageInstructions: options.getStorageInstructions,
    runAutonomous: options.runAutonomous,

    async analyzeSession({ projectPath, sessionId, task, onOutput }): Promise<SmartCompactAnalysis> {
      const filePath = options.locateSessionFile(projectPath, sessionId)
      if (!filePath) throw new Error('Session file not found')
      const snapshot = readRecords(filePath)
      const directory = mkdtempSync(join(tmpdir(), 'aide-smart-compact-'))
      const snapshotFile = join(directory, 'session.jsonl')
      const reportFile = join(directory, 'report.json')
      writeFileSync(snapshotFile, snapshot.content, 'utf-8')
      writeFileSync(reportFile, '{"status":"pending"}\n', 'utf-8')

      try {
        const processOutput = await options.runAutonomous({
          projectPath,
          workspace: { directory, sessionFile: snapshotFile, reportFile },
          prompt: buildPrompt(task, options.getStorageInstructions('session.jsonl')),
          onOutput
        })
        const proposed = parseReport(reportFile)
        const byLine = new Map(snapshot.records.map((record) => [record.line, record]))
        const links = buildLinkMap(snapshot.records, options.describeRecord)
        const removable = snapshot.records.filter((record) => options.describeRecord(record, snapshot.records).removable)
        const protectedTrailing = new Set(removable.slice(-4).map((record) => record.line))
        const validated: Array<{ lines: Set<number>; reasons: string[] }> = []
        const storedCandidates = new Map<string, number[]>()

        for (const group of proposed) {
          const lines = expandAtomic(group.lines, links)
          if (lines.some((line) => protectedTrailing.has(line))) continue
          if (lines.some((line) => !byLine.has(line) || !options.describeRecord(byLine.get(line)!, snapshot.records).removable)) continue
          const overlapping = validated.filter((candidate) => lines.some((line) => candidate.lines.has(line)))
          if (overlapping.length === 0) {
            validated.push({ lines: new Set(lines), reasons: [group.reason] })
            continue
          }
          const merged = overlapping[0]
          lines.forEach((line) => merged.lines.add(line))
          merged.reasons.push(group.reason)
          for (const extra of overlapping.slice(1)) {
            extra.lines.forEach((line) => merged.lines.add(line))
            merged.reasons.push(...extra.reasons)
            validated.splice(validated.indexOf(extra), 1)
          }
        }

        const candidates: SmartCompactCandidate[] = []
        for (const group of validated) {
          const lines = [...group.lines].sort((a, b) => a - b)
          const id = randomUUID()
          storedCandidates.set(id, lines)
          candidates.push({
            id,
            reason: [...new Set(group.reasons)].join('; '),
            selected: true,
            messages: lines.map((line) => {
              const info = options.describeRecord(byLine.get(line)!, snapshot.records)
              return { role: info.role, preview: info.preview }
            }).filter((message) => message.preview.length > 0)
          })
        }

        const analysisId = randomUUID()
        analyses.set(analysisId, {
          projectPath,
          sessionId,
          filePath,
          fingerprint: fingerprint(snapshot.content),
          records: snapshot.records,
          candidates: storedCandidates
        })
        return { analysisId, candidates, stdout: processOutput.stdout, stderr: processOutput.stderr }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },

    async applyDeletions({ projectPath, sessionId, analysisId, candidateIds, force }): Promise<SmartCompactApplyResult> {
      const analysis = analyses.get(analysisId)
      if (!analysis || analysis.projectPath !== projectPath || analysis.sessionId !== sessionId) {
        throw new Error('Smart Compact analysis expired')
      }
      const filePath = options.locateSessionFile(projectPath, sessionId)
      if (!filePath || filePath !== analysis.filePath) throw new Error('Session file not found')
      const selectedLines = new Set<number>()
      for (const id of candidateIds) {
        const lines = analysis.candidates.get(id)
        if (!lines) throw new Error('Invalid Smart Compact candidate')
        lines.forEach((line) => selectedLines.add(line))
      }
      if (selectedLines.size === 0) {
        analyses.delete(analysisId)
        return { status: 'applied', removed: 0 }
      }

      const current = readRecords(filePath)
      const changed = fingerprint(current.content) !== analysis.fingerprint
      if (changed && !force) {
        return {
          status: 'conflict',
          message: 'The session file changed after analysis. It may have been opened by another CLI process.'
        }
      }

      let linesToDelete: Set<number>
      let warning: string | undefined
      if (!changed) {
        linesToDelete = selectedLines
      } else {
        const selected = analysis.records.filter((record) => selectedLines.has(record.line))
        const matches = findForcedMatches(selected, current.records)
        linesToDelete = matches.lines
        const details: string[] = []
        if (matches.missing > 0) details.push(`${matches.missing} snapshot records were not found and were kept`)
        if (matches.ambiguous > 0) details.push(`${matches.ambiguous} records had duplicate matches; the first unused match was removed`)
        warning = details.length > 0 ? details.join('. ') : undefined
      }

      const retained = current.records.filter((record) => !linesToDelete.has(record.line))
      writeAtomically(filePath, options.prepareRetainedRecords?.(retained, current.records) ?? retained)
      analyses.delete(analysisId)
      return { status: 'applied', removed: linesToDelete.size, warning }
    },

    discardAnalysis(analysisId): void {
      analyses.delete(analysisId)
    }
  }
}
