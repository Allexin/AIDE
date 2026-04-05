# AIDE Release Format

This document describes the format required for GitVerse releases so that the in-app
update checker can parse version information and changelogs automatically.

## Release title

Use the version tag as the release title, e.g. `v0.1.145`.

## Release tag

Must follow the pattern `v<major>.<minor>.<patch>`, e.g. `v0.1.145`.
The updater compares tags numerically, so all three parts must be integers.

## Release description format

The description must contain exactly one structured block in this form:

```
AIDE Stable Release <version>

<changelog — markdown>

AIDE Release Date <date>
```

### Fields

| Field | Format | Example |
|---|---|---|
| `<version>` | `major.minor.patch` (no `v` prefix) | `0.1.145` |
| `<changelog>` | Markdown (headings, bullet lists) | see below |
| `<date>` | `YYYY-MM-DD` | `2026-04-05` |

### Why this format

The two marker phrases (`AIDE Stable Release` and `AIDE Release Date`) look like natural
prose to a human reader. The update checker locates them via the regex:

```
/AIDE Stable Release\s+([\d.]+)\s*([\s\S]*?)AIDE Release Date[^\n]*/g
```

- Group 1 → version string
- Group 2 → changelog text (trimmed)

Everything between the version line and `AIDE Release Date` is treated as the changelog
and rendered verbatim (pre-wrap) in the update dialog.

## Full example

```
AIDE Stable Release 0.1.145

## What's new

- Update checker: in-app notifications with configurable frequency
- Status bar shows current version in red and available version in green

## Fixes

- Terminal tab titles no longer reset on project switch

AIDE Release Date 2026-04-05
```

The `AIDE Release Date` line acts as a natural-looking footer. The date is cosmetic —
the updater does not parse it and does not use it for comparison. Version ordering is
determined by semver comparison of the `<version>` field.

## Upload assets

Each release should include a portable archive built by the release script:

```
AIDE-<version>-portable.7z
```

The update dialog's "Go to download" button opens the GitVerse releases page directly:
`https://gitverse.ru/basovav/AIDE/releases`

## Release checklist

1. Bump `version` in `package.json`
2. Run `npm run build`
3. Create the release archive (`AIDE-<version>-portable.7z`)
4. On GitVerse: create a new release with tag `v<version>`
5. Set the release title to `v<version>`
6. Paste the description following the format above
7. Upload the archive as a release asset
8. Publish the release
