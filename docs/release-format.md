# AIDE Release Format

This document describes the format used for GitHub releases so that the in-app update
checker can display version information and changelogs automatically.

## Release title

Use the version tag as the release title, e.g. `v0.1.145`.

## Release tag

Must follow the pattern `v<major>.<minor>.<patch>`, e.g. `v0.1.145`.
The updater compares tags numerically, so all three parts must be integers.

## Release description format

The Git tag is the authoritative source for the version. The description should contain
one structured block in this form:

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

The updater reads published releases from the GitHub Releases API and gets the version
from `tag_name`. Drafts and prereleases are ignored. The two marker phrases let it show
only the changelog portion of the release body:

```
/AIDE Stable Release\s+v?[\d.]+\s*([\s\S]*?)AIDE Release Date[^\n]*/
```

- Group 1 → changelog text (trimmed)

Everything between the version line and `AIDE Release Date` is rendered verbatim
(pre-wrap) in the update dialog. If the markers are absent, the full release body is
shown instead.

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
determined by numeric comparison of the Git tag.

## Upload assets

Each release should include a portable archive built by the release script:

```
AIDE-<version>-portable.7z
```

and a checksum file, in `sha256sum` format, with this exact name:

```
SHA256SUMS
```

The update dialog installs a release in place only when it has both
([`self-update.md`](self-update.md)). Otherwise its "Download Update" button opens the
GitHub releases page: `https://github.com/Allexin/AIDE/releases`

## Release checklist

1. Bump `version` in `package.json`
2. Run `npm run build`
3. Create the release archive (`AIDE-<version>-portable.7z`)
4. On GitHub: create a new release with tag `v<version>`
5. Set the release title to `v<version>`
6. Paste the description following the format above
7. Upload the archive and `SHA256SUMS` as release assets
8. Publish the release
