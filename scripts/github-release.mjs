/**
 * Minimal GitHub Releases client for the release script.
 *
 * Authenticates with a token taken from GITHUB_TOKEN or from a file passed via
 * `--token-file <path>` (the toolbar button passes the per-user
 * `.aide/users/<user>/github-token`, which is never committed).
 */

import https from 'https'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { basename } from 'path'

const OWNER = 'Allexin'
const REPO = 'AIDE'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const UPLOADS = `https://uploads.github.com/repos/${OWNER}/${REPO}`

/** Resolve the token from GITHUB_TOKEN or `--token-file`; throws with a fix-it message. */
export function resolveToken(argv) {
  const envToken = process.env.GITHUB_TOKEN?.trim()
  if (envToken) return envToken

  const idx = argv.indexOf('--token-file')
  const tokenFile = idx >= 0 ? argv[idx + 1] : undefined
  if (!tokenFile) {
    throw new Error('No GitHub token: set GITHUB_TOKEN or pass --token-file <path>.')
  }
  if (!existsSync(tokenFile)) {
    throw new Error(`GitHub token file not found: ${tokenFile}`)
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!token) {
    throw new Error(`GitHub token file is empty: ${tokenFile}\n` +
      `       Put a fine-grained token with "Contents: read and write" on ${OWNER}/${REPO} there.`)
  }
  return token
}

function request(token, method, url, { json, file, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'AIDE-ReleaseScript/1.0',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    let body
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json), 'utf8')
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = body.length
    } else if (file) {
      headers['Content-Type'] = contentType
      headers['Content-Length'] = statSync(file).size
    }

    // A fresh connection per request: the build blocks the event loop for minutes
    // (execSync), so a pooled keep-alive socket is dead by the time it is reused
    // and the next write fails with ECONNABORTED.
    const req = https.request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${url} → HTTP ${res.statusCode}: ${text.slice(0, 500)}`))
          return
        }
        resolve(text ? JSON.parse(text) : null)
      })
      res.on('error', reject)
    })
    req.on('error', reject)

    if (file) {
      const total = statSync(file).size
      let sent = 0
      let nextReport = 10
      const stream = createReadStream(file)
      stream.on('data', (chunk) => {
        sent += chunk.length
        const pct = Math.floor((sent / total) * 100)
        if (pct >= nextReport) {
          console.log(`   uploaded ${pct}%`)
          nextReport = pct - (pct % 10) + 10
        }
      })
      stream.on('error', (err) => req.destroy(err))
      stream.pipe(req)
    } else {
      req.end(body)
    }
  })
}

/** Fail fast on a bad token before any heavy work. */
export async function checkAccess(token) {
  const repo = await request(token, 'GET', API)
  if (repo.permissions && !repo.permissions.push) {
    throw new Error(`The GitHub token has no write access to ${OWNER}/${REPO}.`)
  }
}

/** Find a release (drafts included) by tag, or null. */
export async function findRelease(token, tag) {
  for (let page = 1; ; page++) {
    const releases = await request(token, 'GET', `${API}/releases?per_page=100&page=${page}`)
    const found = releases.find((r) => r.tag_name === tag)
    if (found) return found
    if (releases.length < 100) return null
  }
}

/** True when the release for `tag` is published and carries all `assetNames` fully uploaded. */
export function isComplete(release, assetNames) {
  return !!release && !release.draft && assetNames.every((name) =>
    release.assets.some((a) => a.name === name && a.state === 'uploaded'))
}

/**
 * Create (or resume) the release for `tag`: a draft is created first, the assets
 * are uploaded into it, and only then is it published, so a half-uploaded release
 * is never visible as the latest stable one.
 */
export async function publishRelease(token, { tag, name, body, assetPaths }) {
  let release = await findRelease(token, tag)
  if (!release) {
    console.log(`   creating draft release ${tag}`)
    release = await request(token, 'POST', `${API}/releases`, {
      json: { tag_name: tag, name, body, draft: true, prerelease: false }
    })
  } else {
    console.log(`   resuming existing release ${tag}`)
  }

  for (const assetPath of assetPaths) {
    const assetName = basename(assetPath)
    const asset = release.assets.find((a) => a.name === assetName)
    const size = statSync(assetPath).size
    if (asset && (asset.state !== 'uploaded' || asset.size !== size)) {
      console.log(`   removing incomplete asset ${assetName}`)
      await request(token, 'DELETE', `${API}/releases/assets/${asset.id}`)
    }
    if (!asset || asset.state !== 'uploaded' || asset.size !== size) {
      console.log(`   uploading ${assetName} (${(size / 1024 / 1024).toFixed(1)} MB)`)
      await request(token, 'POST',
        `${UPLOADS}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
        { file: assetPath, contentType: assetName.endsWith('.7z') ? 'application/x-7z-compressed' : 'text/plain' })
    }
  }

  if (release.draft) {
    release = await request(token, 'PATCH', `${API}/releases/${release.id}`, {
      json: { draft: false }
    })
  }
  return release.html_url
}
