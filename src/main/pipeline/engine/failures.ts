/**
 * Reading failures out of tool output: the lines of a check log that say what
 * failed, and when a CLI usage limit resets.
 */

/** Markers of a failure line in test runners, compilers and panics (Rust, JS, Python, .NET, generic). */
const FAILURE_LINE = /\bFAILED\b|\bFAIL\b|panicked at|error\[E?\d*\]|^\s*error(:|\s*\[)|\bError:|AssertionError|Traceback \(most recent call last\)|^\s*(✗|×|✕)\s|\bfailed:|^failures:|test result: FAILED/

const MAX_FAILURE_LINES = 40
const MAX_LINE = 300

/** Failure lines of a log, in order, without duplicates; a later failure summary is kept over noise. */
export function checkFailureLines(log: string): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    if (!line.trim() || !FAILURE_LINE.test(line)) continue
    const key = line.trim()
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)
  }
  // The end of a log usually holds the summary (failing test names); keep it when trimming.
  if (lines.length > MAX_FAILURE_LINES) return [...lines.slice(0, 10), `… ${lines.length - MAX_FAILURE_LINES} more failure lines …`, ...lines.slice(-(MAX_FAILURE_LINES - 10))]
  return lines
}

const MAX_WAIT_MS = 7 * 24 * 3600_000

/**
 * When a usage limit resets, from the CLI's message, or null when it does not say.
 * Understands a Unix timestamp after `|` (Claude Code's "usage limit reached|<epoch>"),
 * "try again in 2 hours 5 minutes", and a clock time after "try again at" / "resets"
 * ("3:45 PM", "3pm", "15:45"), read as local time — today, or tomorrow if already past.
 */
export function limitResetTime(message: string, now: Date): Date | null {
  const accept = (date: Date): Date | null => {
    const delta = date.getTime() - now.getTime()
    return Number.isFinite(delta) && delta > -60_000 && delta < MAX_WAIT_MS ? date : null
  }

  const epoch = /\|\s*(\d{10})\b/.exec(message)
  if (epoch) return accept(new Date(Number(epoch[1]) * 1000))

  const relative = /\bin\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,and]*)+)/i.exec(message)
  if (relative) {
    let ms = 0
    for (const part of relative[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
      const unit = part[2].toLowerCase()
      const n = Number(part[1])
      ms += unit.startsWith('d') ? n * 86_400_000 : unit.startsWith('h') ? n * 3_600_000 : n * 60_000
    }
    if (ms > 0) return accept(new Date(now.getTime() + ms))
  }

  const clock = /\b(?:try again at|resets?(?: at)?|available (?:again )?at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(message)
  if (clock) {
    let hour = Number(clock[1])
    const minute = Number(clock[2] ?? 0)
    const meridiem = clock[3]?.toLowerCase().replace(/\./g, '')
    if (!meridiem && clock[2] === undefined) return null // a bare number is not a time
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return null
    const date = new Date(now)
    date.setHours(hour, minute, 0, 0)
    if (date.getTime() <= now.getTime() - 60_000) date.setDate(date.getDate() + 1)
    return accept(date)
  }
  return null
}
