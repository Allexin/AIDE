#!/usr/bin/env node
/**
 * Fetches the latest stable release version from the GitHub Releases API.
 * Outputs the version string (e.g. "0.1.144") to stdout and exits 0.
 * Exits 1 with an error message if the page is unreachable or no release is found.
 */

import https from 'https'

const RELEASES_API_URL = 'https://api.github.com/repos/Allexin/AIDE/releases?per_page=100'

function fetchPage(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) { reject(new Error('Too many redirects')); return }
    https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AIDE-ReleaseScript/1.0'
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject)
        res.resume()
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  let releases
  try {
    const json = await fetchPage(RELEASES_API_URL)
    releases = JSON.parse(json)
    if (!Array.isArray(releases)) throw new Error('Unexpected GitHub releases response')
  } catch (err) {
    console.error(`ERROR: Cannot read GitHub releases: ${err.message}`)
    console.error(`       Release notes generation requires internet access.`)
    console.error(`       Check your connection and retry.`)
    process.exit(1)
  }

  const versions = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => /^v?(\d+(?:\.\d+)+)$/.exec(String(release.tag_name ?? '').trim())?.[1])
    .filter(Boolean)
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
        if (diff !== 0) return diff
      }
      return 0
    })

  if (versions.length === 0) {
    console.error(`ERROR: No stable semver release found on GitHub.`)
    console.error(`       Expected tag format: "v<major>.<minor>.<patch>"`)
    console.error(`       URL: ${RELEASES_API_URL}`)
    process.exit(1)
  }

  process.stdout.write(versions[0])
}

main()
