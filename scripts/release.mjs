#!/usr/bin/env node
/**
 * AIDE Release Tool
 *
 * Usage: node scripts/release.mjs
 *
 * - Fetches previous stable release from GitHub (fail-fast internet check)
 * - Runs npm run build (bumps patch version + builds via electron-vite)
 * - Packages portable zip via electron-builder
 * - Creates git commit + tag
 * - Generates release notes via Claude Code
 * - Pushes the commit and tag, publishes the GitHub release with the zip attached
 *
 * Token: GITHUB_TOKEN, or `--token-file <path>` (the toolbar passes
 * `${aideUserDir}/github-token`).
 *
 * Re-running after a failed publish (HEAD is the release commit, its tag exists,
 * the GitHub release is missing or incomplete) skips the build and only publishes.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { checkAccess, findRelease, isComplete, publishRelease, resolveToken } from './github-release.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PKG_PATH = resolve(ROOT, 'package.json')

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts })
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function readVersion() {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8')).version
}

function fail(message) {
  console.error(`\n❌ ${message}`)
  process.exit(1)
}

console.log('\n📦 AIDE Release Tool\n')

// Step 0: GitHub access (fail fast before any heavy work)
console.log('🔑 Checking GitHub access...')
let token
try {
  token = resolveToken(process.argv.slice(2))
  await checkAccess(token)
} catch (err) {
  fail(err.message)
}
console.log('✓ GitHub token accepted')

// A previous run that built and tagged but did not finish publishing is resumed.
const headVersion = readVersion()
const headTag = `v${headVersion}`
const headIsRelease = runCapture('git log -1 --format=%s') === `chore: release ${headTag}` &&
  runCapture(`git tag --list ${headTag}`) === headTag
let resume = false
if (headIsRelease) {
  try {
    resume = !isComplete(await findRelease(token, headTag), [`AIDE-${headVersion}-portable.7z`, 'SHA256SUMS'])
  } catch (err) {
    fail(`Cannot read GitHub releases: ${err.message}`)
  }
}

// Step 1: fetch previous stable release from GitHub (fail fast before any heavy work)
console.log('🌐 Fetching previous stable release from GitHub...')
const prevResult = spawnSync('node', ['scripts/get-prev-release.mjs'], {
  cwd: ROOT,
  encoding: 'utf8'
})
if (prevResult.status !== 0) {
  process.stderr.write(prevResult.stderr || '')
  console.error('\n❌ Cannot generate release notes without the previous release version.')
  console.error('   Fix the issue above and re-run, or create release notes manually.')
  process.exit(1)
}
const prevVersion = prevResult.stdout.trim()
console.log(`✓ Previous stable release: v${prevVersion}`)

let version
if (resume) {
  version = headVersion
  console.log(`\n↻ v${version} is built and tagged but not published — resuming the publish`)
} else {
  // Step 2: build (prebuild bumps patch version automatically)
  console.log('\n🔨 Building...')
  run('npm run build')
  version = readVersion()
  console.log(`\n✓ Built v${version}`)

  // Step 3: package portable zip
  console.log('\n📦 Packaging portable zip...')
  run('npm run pack')
  console.log(`✓ Portable zip ready`)

  // Step 4: git commit + tag
  console.log('\n🔖 Committing and tagging...')
  run(`git add package.json package-lock.json`)
  run(`git commit -m "chore: release v${version}"`)
  run(`git tag v${version}`)
  console.log(`✓ Tag v${version} created`)
}

const assetPath = resolve(ROOT, `release/AIDE-${version}-portable.7z`)
if (!existsSync(assetPath)) {
  fail(`Portable zip not found: release/AIDE-${version}-portable.7z\n   Run "npm run pack" (no version bump) and retry.`)
}
const notesPath = resolve(ROOT, `release/AIDE-${version}-release-notes.txt`)
let notes = resume && existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : ''

if (notes) {
  console.log(`✓ Reusing release/AIDE-${version}-release-notes.txt`)
} else {
  // Step 5: collect commit log since previous stable release (exclude the release commit itself)
  const commitLog = runCapture(
    `git log v${prevVersion}..HEAD~1 --no-merges --format="--- %h %s%n%b"`
  )
  if (!commitLog) {
    console.warn('⚠  No commits found since previous release. Release notes will be empty.')
  }

  // Step 6: generate release notes via Claude Code
  console.log('\n🤖 Generating release notes via Claude Code...')
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `You are generating release notes for AIDE (a desktop code editor).

Version: ${version}
Date: ${today}
Previous release: ${prevVersion}

Commits since previous release:
${commitLog || '(none)'}

Output ONLY the release description text, nothing else — no explanation, no markdown fences.
Use this exact format:

AIDE Stable Release ${version}

## What's new

- <key changes, one per line>

## Fixes

- <bug fixes, one per line>

AIDE Release Date ${today}

Rules:
- Write in English
- Omit "chore: release" commits
- Group changes into "What's new" and "Fixes" sections; omit a section if empty
- Be concise — one line per change
- Use the commit messages as source material; rephrase for clarity`

  const claudeExe = resolve(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')
  // Proxy is required for Claude Code to reach Anthropic API.
  // Set HTTPS_PROXY in your environment to override the default.
  const proxyEnv = process.env.HTTPS_PROXY ? {} : {
    HTTPS_PROXY: 'http://192.168.1.99:7897',
    HTTP_PROXY:  'http://192.168.1.99:7897',
    NO_PROXY:    'localhost,127.0.0.1'
  }
  const claudeResult = spawnSync(claudeExe, ['-p', prompt], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...proxyEnv }
  })
  if (claudeResult.status !== 0 || !claudeResult.stdout.trim()) {
    const err = claudeResult.stderr || claudeResult.error?.message || 'unknown error'
    console.error(`\n❌ Claude Code failed: ${err}`)
    console.error('   Ensure claude.exe is at %USERPROFILE%\\.local\\bin\\claude.exe')
    console.error('   You can create release notes manually using docs/release-format.md')
    process.exit(1)
  }

  notes = claudeResult.stdout.trim()
  writeFileSync(notesPath, notes, 'utf8')
  console.log(`✓ Release notes written to release/AIDE-${version}-release-notes.txt`)
}

// Step 7: push commit + tag, publish the GitHub release
console.log('\n🏷️  Pushing to origin...')
run('git push origin HEAD')
run(`git push origin v${version}`)
console.log('✓ Pushed')

// The in-app updater only installs releases that have this file (docs/self-update.md).
const assetHash = createHash('sha256').update(readFileSync(assetPath)).digest('hex')
const checksumsPath = resolve(ROOT, 'release/SHA256SUMS')
writeFileSync(checksumsPath, `${assetHash}  AIDE-${version}-portable.7z\n`, 'utf8')

console.log('\n🚀 Publishing GitHub release...')
let releaseUrl
try {
  releaseUrl = await publishRelease(token, {
    tag: `v${version}`,
    name: `AIDE Stable ${version}`,
    body: notes,
    assetPaths: [assetPath, checksumsPath]
  })
} catch (err) {
  fail(`GitHub publish failed: ${err.message}\n   Press Release again to resume — it will not rebuild.`)
}

console.log(`
╔══════════════════════════════════════════╗
║         Released v${version.padEnd(23)}║
╚══════════════════════════════════════════╝

🔗 ${releaseUrl}
`)
