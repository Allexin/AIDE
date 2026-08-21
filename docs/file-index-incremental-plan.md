# File Index — Incremental Update Plan

Status: **planned, not implemented.** This is the "B" item from the watcher
optimization work of 2026-08-04. A, C and D shipped; this one was deliberately
deferred because it carries real correctness risk and deserves its own change.

## The problem

Every filesystem change in a project triggers a **full re-walk of the entire
tree**. There is no path from a change to the index that does less work than
rebuilding it from scratch.

Measured on 2026-08-04:

| Project | Files | Full walk | Index size |
|---|---|---|---|
| `E:\Projects\ValeraAudioOS` | 135,255 | 1359 ms cold, ~3000 ms under memory pressure | ~19 MB |
| `E:\Projects\AIDE` | 64,301 | 460–650 ms | ~9 MB |
| `E:\Projects\AIDE\AIDE` | 13,613 | 168 ms | ~3 MB |

The shipped mitigation (A) sets the debounce floor to the duration of the last
walk, so rebuilds no longer overlap. But that only bounds the damage — it does
not remove the work. Observed in a live session on the 64k-file project:
generations 1 through 6 completed inside seven seconds, a walk of the whole tree
roughly every 1.3 seconds, sustained. A 460 ms walk behind a 500 ms debounce is
close to a 100% duty cycle, and on the 135k-file project the same pattern costs
three seconds per cycle.

None of this depends on *what* changed. Touching one file re-walks everything.

## The insight that does most of the work

`fs.watch` reports an event type alongside the filename, and the current
`onFsEvent` in `src/main/filetree/watcher.ts` discards it:

```ts
const onFsEvent = (_event: string, rawFilename: string | Buffer | null): void => {
```

On Windows, `ReadDirectoryChangesW` maps `FILE_ACTION_ADDED`, `REMOVED` and
`RENAMED_*` to `'rename'`, and `FILE_ACTION_MODIFIED` to `'change'`.

**A `'change'` event cannot affect the index.** The set of paths is unchanged;
only file contents moved. During a build, an npm install, or an agent editing
files, `'change'` events dominate — and every one of them currently triggers a
full re-walk that is guaranteed to produce a byte-identical result.

Filtering the index trigger down to `'rename'` alone is a few lines and removes
most rebuilds before any of the design below is needed. **Do this first**, even
if the rest is postponed — it is cheap, safe, and independently valuable.

## Target design

### 1. Change records instead of bare paths

`addFsChangeObserver` currently receives `(projectPath, fullPath)`. Add the
event type as a third argument so the index can discriminate. Existing consumers
(`src/main/remote/index.ts`) ignore extra arguments, so this is additive.

```ts
type FsChangeKind = 'rename' | 'change'
addFsChangeObserver((projectPath: string, fullPath: string, kind: FsChangeKind) => void)
```

### 2. Apply a delta per renamed path

For each `'rename'` event on path `P` (dot-segment filtering unchanged):

- `statSync(P)` succeeds and it is a **file** → add `P` to the index.
- `statSync(P)` succeeds and it is a **directory** → walk *only that subtree* and
  merge its files in. A newly created directory can arrive with contents already
  in place, and the watcher may not report the children individually.
- `statSync(P)` throws `ENOENT` → the entry is gone. Remove `P`, and also remove
  every entry under the prefix `P + '/'` — a deleted directory reports only
  itself, not its former contents.

Deltas arrive already coalesced: the watcher batches into a 50 ms window with
per-path dedupe (item D), so apply them in batches and emit one
`filetree:index-updated` per batch.

### 3. Change the data structure to a Set

The index is currently a sorted `string[]`. Under incremental updates that makes
every insert and delete an O(n) memmove.

Search already scans the whole collection — the base-name substring match in
`searchProjectFileIndex` cannot use sort order — so sortedness buys nothing
except the ordering of results. Store a `Set<string>` for O(1) membership and
mutation, and sort the *matches* at query time. Match counts are small relative
to the index (a broad two-character query returned 5,451 hits against 135,255
files), so the sort moves from 135k entries per rebuild to a few thousand per
query.

Prefix removal for deleted directories is the one operation a Set does not serve
well; it becomes a full iteration. Directory deletions are rare enough that this
is acceptable. If it ever is not, a prefix tree is the escalation, not a sorted
array.

### 4. Reconciliation, because the deltas will be wrong eventually

Incremental state drifts. Three known sources:

- **Windows drops events.** `ReadDirectoryChangesW` has a fixed internal buffer;
  a large enough burst overflows it and the excess is silently lost.
- **The watcher can die.** `entry.watcher.on('error', ...)` currently removes the
  watcher from the registry without closing or restarting it, so the project
  stops receiving events permanently and nothing reports it. **This is a
  separate open bug** and must be fixed as part of this work — incremental
  updates on a dead watcher mean an index that is silently, permanently stale.
- **Races.** A file created and deleted between the event and the `stat` leaves
  no trace either way.

So keep a full rebuild as a *reconciliation* pass, not as the update mechanism:

- On watcher error, after restarting the watcher.
- On a long idle period ending (window focus after N minutes without events) —
  a moment when a walk costs the user nothing.
- Never on a timer while the user is active.

In development, run the reconciliation walk and compare it against the
incremental index, logging a `index-drift` diagnostic event with the symmetric
difference. That converts "incremental updates are probably correct" into a
measurement.

## Verification

The index must stay byte-identical to a full walk. The A+C+D work used a harness
that compared worker output against a reference implementation on both real
projects; extend it to drive random churn:

1. Build an index over a scratch tree.
2. Apply a randomized script of creates, deletes, renames and directory
   operations, feeding the resulting events through the delta path.
3. Compare the incremental index against a fresh full walk after every batch.
4. Include: deleting a non-empty directory, renaming a directory with contents,
   creating a directory that already has children, a file replaced by a
   directory of the same name, and paths differing only by case.

Baselines to beat, on `ValeraAudioOS` (135,255 files), during sustained file
activity:

| Metric | Now | Target |
|---|---|---|
| Full walks per minute | ~10 | 0 while active |
| Main-heap churn from index work | ~19 MB per rebuild | ~0 |
| Latency from write to index visibility | up to 3 s | < 100 ms |

## Risks

- **Silent staleness is worse than slowness.** Today the index is always correct
  because it is always rebuilt. The failure mode of this change is a file that
  does not appear in search, with no error anywhere. The reconciliation pass and
  the dev-mode drift check exist specifically to make that failure visible.
- **Directory renames are the hard case.** A rename of a directory containing
  thousands of files arrives as a single event on the directory. Both the prefix
  removal and the subtree walk must happen, in that order.
- **Case sensitivity.** Windows paths are case-insensitive but case-preserving.
  A rename that only changes case must not leave both spellings in the index.

## Related

- Crash diagnostics and the measurements behind this plan:
  [`crash-diagnostics.md`](./crash-diagnostics.md)
- Still open and adjacent: `searchProjectFileIndex` returns every match, and the
  whole array crosses IPC to the renderer. Capping it is a separate decision.
