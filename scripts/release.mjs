#!/usr/bin/env node
/**
 * AIDE Release Tool
 *
 * Usage: node scripts/release.mjs
 *
 * - Runs npm run build (bumps patch version + builds via electron-vite)
 * - Packages portable zip via electron-builder
 * - Creates git commit + tag
 * - Generates release notes via Claude Code (requires internet + claude in PATH)
 * - Prints files to upload to GitVerse
 */

import { readFileSync, writeFileSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

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

console.log('\n📦 AIDE Release Tool\n')

// Step 1: build (prebuild bumps patch version automatically)
console.log('🔨 Building...')
run('npm run build')
const version = readVersion()
console.log(`\n✓ Built v${version}`)

// Step 2: package portable zip
console.log('\n📦 Packaging portable zip...')
run('npm run pack')
console.log(`✓ Portable zip ready`)

// Step 3: git commit + tag
console.log('\n🔖 Committing and tagging...')
run(`git add package.json`)
run(`git commit -m "chore: release v${version}"`)
run(`git tag v${version}`)
console.log(`✓ Tag v${version} created`)

// Step 4: get previous stable release from GitVerse
console.log('\n🌐 Fetching previous stable release from GitVerse...')
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

// Step 5: collect commit log since previous stable release (exclude the release commit itself)
const commitLog = runCapture(
  `git log v${prevVersion}..HEAD~1 --oneline --no-merges`
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
  console.error('   Ensure `claude` is in PATH and you are authenticated.')
  console.error('   You can create release notes manually using docs/release-format.md')
  process.exit(1)
}

const notes = claudeResult.stdout.trim()
const notesPath = resolve(ROOT, `release/AIDE-${version}-release-notes.txt`)
writeFileSync(notesPath, notes, 'utf8')
console.log(`✓ Release notes written to release/AIDE-${version}-release-notes.txt`)

// Step 7: summary
console.log(`
╔══════════════════════════════════════════╗
║         Release v${version.padEnd(24)}║
╚══════════════════════════════════════════╝

📤 Upload to GitVerse release:
   release/AIDE-${version}-portable.7z

📋 Paste into release description:
   release/AIDE-${version}-release-notes.txt

🏷️  Push to remote:
   git push && git push --tags
`)
