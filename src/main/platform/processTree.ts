import type { ProcInfo } from './index'

/**
 * Given a process snapshot, a set of candidate PTY PIDs, and a predicate that
 * matches a CLI tool's process name, find which candidate PTY owns the running
 * CLI process.
 *
 * Walks each matching process up its ancestor chain until it hits one of the
 * candidate PIDs — handling multi-hop shims (e.g. powershell → cmd.exe → claude.exe,
 * or bash → node → claude on Linux). When several tabs are waiting, the most
 * recently started match (highest PID) wins, so each new session file binds to
 * the tab that just launched it.
 *
 * This is OS-agnostic: only the `procs` data source differs per platform.
 */
export function resolveOwnerPidFromSnapshot(
  procs: ProcInfo[],
  candidatePids: number[],
  namePredicate: (lowerName: string) => boolean
): number | null {
  if (candidatePids.length === 0) return null

  const parentMap = new Map<number, number>()
  for (const proc of procs) parentMap.set(proc.pid, proc.ppid)

  const pidSet = new Set(candidatePids)

  const findAncestorInSet = (startPid: number): number | null => {
    let pid = startPid
    const visited = new Set<number>()
    while (pid && pid !== 0 && !visited.has(pid)) {
      if (pidSet.has(pid)) return pid
      visited.add(pid)
      pid = parentMap.get(pid) ?? 0
    }
    return null
  }

  const matches: Array<{ pid: number; ancestor: number }> = []
  for (const proc of procs) {
    if (!namePredicate((proc.name ?? '').toLowerCase())) continue
    const ancestor = findAncestorInSet(proc.ppid)
    if (ancestor !== null) matches.push({ pid: proc.pid, ancestor })
  }

  if (matches.length === 0) return null
  matches.sort((a, b) => b.pid - a.pid)
  return matches[0].ancestor
}
