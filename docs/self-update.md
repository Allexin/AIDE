# Self-update

AIDE updates its portable folder in place, on a click. Windows only: a dev run and the
Linux packages keep the "Download Update" button, which opens the releases page.

## Decisions

- **Portable.** No installer; the folder can live anywhere the user can write.
- **On click only.** Nothing is downloaded until "Update" is pressed in the update dialog.
  The dialog opens from the reminder and from a click on the version in the status bar.
- **Work blocks the update.** A pipeline run (running, pausing, waiting) or a plan autopilot
  (running, deciding) shows "Stop all pipeline runs first", at "Update" and again at
  "Restart to Update". A paused run does not block: it resumes as paused after any restart.
- **No code signing.** `SHA256SUMS` comes from the same release as the archive, over HTTPS.
  It catches a corrupted download, not a compromised release; anyone who can publish a
  release on the repository can reach every user who presses "Update".

## Flow

1. **Find.** `updater.ts` keeps the release assets. `canInstall` needs the portable archive
   of the latest version and `SHA256SUMS`, both from the repository's release URL. Releases
   without them stay manual.
2. **Download** (`selfUpdate.ts`). Into `<install>\.update\staging-<pid>\`, with progress
   and cancel: the checksum file first, then the archive, hashed as it arrives.
3. **Unpack.** With the bundled `resources\7za.exe` (from `7zip-bin`); `findBuildRoot` checks
   the result is a build. The dialog then offers "Restart to Update"; it can wait for days.
4. **Gate.** At restart: work, toolbar processes, and other AIDE instances from the same
   folder (their window titles are listed; the user closes them, then "Check Again").
5. **Quit.** On `will-quit`, past the point where a window can refuse to close, AIDE writes
   `.update\apply.json`, copies `apply-update.ps1` out of the asar and starts it detached.
6. **Swap** (`resources\updater\apply-update.ps1`). See below.
7. **Settle.** Every start calls `settleUpdateFolder`, see below.

## The helper

A running AIDE holds its exe, asar and `.node` files, so the helper:

1. Waits for every process running from the install folder to exit (`Wait-Process`, 120 s).
   If some are still there, it starts AIDE again and reports; nothing has been touched.
2. Stops the remaining MCP shims. These are `AIDE.exe` in Node mode, and one started by an
   agent outside AIDE outlives AIDE. It is useless without AIDE and only holds the files;
   that agent loses its AIDE tools until its next start.
3. Moves each entry of the new build into place, the old one into `.update\old\`. Only names
   the new build has are replaced, so files the user keeps in the folder stay. A file removed
   from a later build stays behind too, which is harmless.
4. Starts the new `AIDE.exe` with the original arguments and working directory, and waits
   for it to report in. If it exits first, every move is undone and the old version starts.
   A slow start is not a failure: after 60 s the new version is kept.

## `.update` protocol

| File | Written by | Meaning |
|---|---|---|
| `staging-<pid>\` | AIDE | A download; kept at start while that process lives |
| `apply.json` | AIDE, at quit | The helper's input; its presence means an update was applied |
| `started` | New version, at start | The helper may stop waiting |
| `result.json` | Helper | The outcome; on failure it exists before the old version starts |
| `old\`, `helper.log` | Helper | The replaced build; the log goes to the diagnostics trail on failure |

At start, `settleUpdateFolder` writes `started` when `apply.json` has neither marker. When
`result.json` exists it reads the outcome and removes the folder. With `started` but no
result the helper died, and the folder is removed as well. A failed update reopens the
dialog with its error.

## Release

`scripts/release.mjs` writes `release/SHA256SUMS` and uploads it with the archive. See
[`release-format.md`](release-format.md).

## Tests

`installer.test.ts` covers the pure logic. `applyUpdateScript.test.ts` runs the real helper
against a fake install folder, where a copy of `cmd.exe` stands in for `AIDE.exe`: swap,
rollback, a process that does not exit, a shim. The Electron side (`selfUpdate.ts`, the
dialog) is tested by hand on a packaged build; only a release that carries `SHA256SUMS` can
be the target, so the first real update needs two such releases.
