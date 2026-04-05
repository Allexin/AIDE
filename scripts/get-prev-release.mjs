#!/usr/bin/env node
/**
 * Fetches the latest stable release version from the GitVerse releases page.
 * Outputs the version string (e.g. "0.1.144") to stdout and exits 0.
 * Exits 1 with an error message if the page is unreachable or no release is found.
 */

import https from 'https'

const RELEASES_URL = 'https://gitverse.ru/basovav/AIDE/releases'
const RELEASE_PATTERN = /AIDE Stable Release\s+v?([\d.]+)/

function fetchPage(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) { reject(new Error('Too many redirects')); return }
    https.get(url, { headers: { 'User-Agent': 'AIDE-ReleaseScript/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(res.headers.location, redirects - 1).then(resolve, reject)
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
  let html
  try {
    html = await fetchPage(RELEASES_URL)
  } catch (err) {
    console.error(`ERROR: Cannot reach GitVerse releases page: ${err.message}`)
    console.error(`       Release notes generation requires internet access.`)
    console.error(`       Check your connection and retry.`)
    process.exit(1)
  }

  const match = RELEASE_PATTERN.exec(html)
  if (!match) {
    console.error(`ERROR: No stable release found on GitVerse releases page.`)
    console.error(`       Expected format: "AIDE Stable Release <version>"`)
    console.error(`       URL: ${RELEASES_URL}`)
    process.exit(1)
  }

  process.stdout.write(match[1])
}

main()
