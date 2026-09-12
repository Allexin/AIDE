# AIDE Toolbar Configuration

The toolbar is configured via JSON files that define buttons appearing in the editor toolbar.

## Config Files

| File | Tracked | Purpose |
|------|---------|---------|
| `aide/toolbar.json` | Yes (shared) | Team-shared buttons committed to the repo |
| `.aide/users/<user>/toolbar.json` | No (local) | Personal buttons, isolated by OS user and ignored by git |

When both files exist, buttons are merged. If a button `id` appears in both files, the current user's version wins.

## File Format

```json
{
  "projectType": "npm",
  "buttons": [
    {
      "id": "my-button",
      "icon": "🔨",
      "tooltip": "Build project",
      "command": "npm run build",
      "cwd": "${projectRoot}",
      "channels": {
        "stdout": { "name": "Build Output" },
        "stderr": { "name": "Build Errors", "attention": true }
      }
    }
  ]
}
```

## Button Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for the button |
| `icon` | string | Yes | Emoji character or file path to an image |
| `tooltip` | string | Yes | Text shown on hover |
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | Working directory for the command |
| `autoClear` | boolean | No | Clear log channels on each run (default: `true`) |
| `sound` | boolean | No | Play a completion sound when the process exits (default: `true`) |
| `channels` | object | No | Log channel configuration (see below) |

## Variables

These placeholders are expanded at runtime in `command` and `cwd`:

| Variable | Description |
|----------|-------------|
| `${projectRoot}` | Absolute path to the project directory |
| `${aideUserDir}` | Absolute path to the current user's private `.aide` directory |
| `${unrealEngine}` | Path to the Unreal Engine installation (Unreal projects only) |
| `${unrealVersionSelector}` | Path to UnrealVersionSelector.exe (Unreal projects only) |

## Paths in Commands

Paths in `command` and `cwd` can be **relative to the project root**. The working directory for button processes defaults to the project root, so relative paths work naturally:

```json
{
  "id": "lint",
  "icon": "✓",
  "tooltip": "Lint",
  "command": "node ./scripts/lint.js",
  "cwd": "${projectRoot}"
}
```

You can also use `${projectRoot}` variable explicitly (see Variables section below).

## External Scripts

When a button command is too complex to fit in a JSON string, move it to an external script file. Scripts should be placed in a `scripts/` directory next to the corresponding config file:

| Config file | Scripts directory |
|-------------|-------------------|
| `aide/toolbar.json` (shared) | `aide/scripts/` |
| `.aide/users/<user>/toolbar.json` (local) | `${aideUserDir}/scripts/` |

This way shared scripts are committed to the repo alongside the shared config, and personal scripts stay local alongside the local config.

**Example:** a complex build script

`aide/scripts/full-build.ps1`:
```powershell
# Clean, restore, build, test
Remove-Item -Recurse -Force ./dist -ErrorAction SilentlyContinue
npm ci
npm run build
npm test
```

`aide/toolbar.json`:
```json
{
  "buttons": [
    {
      "id": "full-build",
      "icon": "🔨",
      "tooltip": "Full Build",
      "command": "powershell -NoProfile -File aide/scripts/full-build.ps1",
      "cwd": "${projectRoot}",
      "channels": {
        "stdout": { "name": "Full Build" },
        "stderr": { "name": "Build Errors", "attention": true }
      }
    }
  ]
}
```

For personal buttons, place scripts in `${aideUserDir}/scripts/` and reference them with the same variable, for example `${aideUserDir}/scripts/my-script.ps1`.

## Splitters

Splitters are visual separators that group buttons. Add a splitter to the `buttons` array:

```json
{
  "buttons": [
    { "id": "build", "icon": "🔨", "tooltip": "Build", "command": "npm run build" },
    { "type": "splitter" },
    { "id": "test", "icon": "🧪", "tooltip": "Test", "command": "npm test" }
  ]
}
```

A splitter has only one field: `"type": "splitter"`. It renders as a vertical line between button groups. Splitters can also be added and removed via the toolbar edit mode UI.

## Icon Formats

- **Emoji:** Any emoji character, e.g. `"🔨"`, `"▶"`, `"🧪"`
- **Absolute path:** e.g. `"C:/icons/my-icon.png"`
- **Relative path:** Starts with `.`, resolved from project root, e.g. `"./assets/icon.png"`

## Channels

The `channels` object controls how process output appears in the log panel:

```json
"channels": {
  "stdout": { "name": "Build Output" },
  "stderr": { "name": "Build Errors", "attention": true }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name of the log channel |
| `attention` | boolean | If true, the log panel auto-expands when output arrives |
| `flash` | boolean | If true, the log tab briefly flashes when new output arrives (default: `false`) |

If `channels` is omitted, output is not routed to the log panel.

## Auto-Clear

By default (`autoClear: true`), both stdout and stderr log channels are cleared each time a button process starts. This keeps the log panel showing only the output from the latest run.

To keep previous output and append new runs below, set `autoClear` to `false`:

```json
{
  "id": "dev-server",
  "icon": "▶",
  "tooltip": "Dev Server",
  "command": "npm run dev",
  "autoClear": false,
  "channels": {
    "stdout": { "name": "Dev Server" },
    "stderr": { "name": "Dev Errors", "attention": true }
  }
}
```

## Sound Notification

> **Strongly recommended** for operations where the user actively waits for completion — builds, compilations, test runs, deployments, code generation. Lets you switch focus to another window and get notified the moment the process finishes, without having to watch the log.

Set `"sound": true` on any button to play a short chime when the process exits:

```json
{
  "id": "build",
  "icon": "🔨",
  "tooltip": "Build",
  "command": "npm run build",
  "sound": true
}
```

The melody is defined globally in the AIDE app config (`aide-config.json` in the user's app data folder) and applies to all projects. This makes the notification sound consistent across projects.

### Customizing the Melody

Edit the `toolbar.sounds.complete` array in the AIDE global config file:

```
%APPDATA%\AIDE\aide-config.json
```

Each entry is a note:

| Field | Type | Description |
|-------|------|-------------|
| `freq` | number | Frequency in Hz (e.g. `523` = C5, `659` = E5, `784` = G5) |
| `dur` | number | Note duration in milliseconds |
| `delay` | number | Offset from playback start in milliseconds |

Two melodies are defined — one for success (exit code 0) and one for failure (non-zero exit code):

| Key | When played |
|-----|-------------|
| `complete` | Process exited with code `0` |
| `error` | Process exited with non-zero code or was killed |

Default melodies:

```json
"toolbar": {
  "sounds": {
    "complete": [
      { "freq": 1047, "dur": 120, "delay": 0   },
      { "freq": 1319, "dur": 120, "delay": 150 },
      { "freq": 1568, "dur": 220, "delay": 300 }
    ],
    "error": [
      { "freq": 880, "dur": 180, "delay": 0   },
      { "freq": 698, "dur": 300, "delay": 200 }
    ]
  }
}
```

Notes can overlap (set same `delay`) for chords, or be staggered for an arpeggio.

> **Note for AI assistants:** After editing `aide-config.json`, always tell the user that **AIDE must be restarted** for the new melody to take effect — the sound config is loaded once on startup and is not watched for changes.

> **Requires restart:** Changes to `aide-config.json` are loaded once at startup. Restart AIDE after editing the melody.

## Project Type

The `projectType` field controls auto-detection behavior:

- Empty string `""`: Auto-detection will run on next project open
- `"dismissed"`: User skipped auto-detection; won't be asked again
- Any preset type (e.g. `"npm"`, `"unreal"`, `"python"`): Auto-detection won't run

## Hot Reload

Both toolbar config files are watched for changes. Edits are reflected in the toolbar within ~300ms without restarting AIDE.
