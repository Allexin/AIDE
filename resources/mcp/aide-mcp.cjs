#!/usr/bin/env node
'use strict'
/**
 * AIDE pipeline shim — the stable entry point agents use to reach a running AIDE.
 *
 * Launched by an agent CLI as a stdio MCP server, or from a shell for the
 * pipeline event feed. It finds the AIDE instance that has the current project
 * open through a discovery file and forwards everything to AIDE's local HTTP
 * server. Agent configs therefore never contain a port or a secret.
 *
 * Usage (normally via the AIDE executable with ELECTRON_RUN_AS_NODE=1):
 *   aide-mcp.cjs [mcp]                                   stdio MCP server
 *   aide-mcp.cjs events --run <id> [--since <eventId>] [--all]
 *                                                        stream the run's events that need the
 *                                                        orchestrator as NDJSON (--all: every event)
 *   aide-mcp.cjs wait --run <id> [--since <eventId>] [--timeout <sec>]
 *                                                        print the next event and exit
 *
 * Discovery: AIDE writes <runtimeDir>/projects/*.json = { projectPath, port, token, pid }.
 * The runtime dir comes from AIDE_RUNTIME_DIR (set in the generated config), with a
 * platform default as fallback. The project is the longest registered projectPath
 * that contains the current working directory (AIDE_PROJECT overrides it).
 *
 * Only protocol messages go to stdout; diagnostics go to stderr.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const readline = require('readline')

const SERVER_NAME = 'aide'

function defaultRuntimeDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'aide', 'runtime')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'aide', 'runtime')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aide', 'runtime')
}

function normalize(p) {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err && err.code === 'EPERM' }
}

/** Locate the AIDE instance serving the current project, or null. Re-read on every call. */
function discover() {
  const dir = path.join(process.env.AIDE_RUNTIME_DIR || defaultRuntimeDir(), 'projects')
  const target = normalize(process.env.AIDE_PROJECT || process.cwd())
  let best = null
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    let info
    try { info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch { continue }
    if (!info || typeof info.projectPath !== 'string' || !info.port || !info.token) continue
    if (info.pid && !isAlive(info.pid)) continue
    const root = normalize(info.projectPath)
    const inside = target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    if (inside && (!best || root.length > normalize(best.projectPath).length)) best = info
  }
  return best
}

const connectionId = crypto.randomUUID()

function headers(info) {
  const h = { 'x-aide-token': info.token, 'x-aide-project': info.projectPath, 'x-aide-conn': connectionId }
  if (process.env.AIDE_TAB_ID) h['x-aide-tab'] = process.env.AIDE_TAB_ID
  return h
}

function post(info, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8')
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: '/mcp', method: 'POST',
      headers: { ...headers(info), 'content-type': 'application/json', 'content-length': data.length }
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode || 0, text }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

function rpcError(id, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })
}

const NOT_RUNNING = 'AIDE is not running for this project. Open the project in AIDE and try again.'

/** Answer locally when AIDE is unreachable, so the client registers the server instead of failing. */
function offlineResponse(message) {
  if (message.id === undefined || message.id === null) return null
  if (message.method === 'initialize') {
    const version = (message.params && message.params.protocolVersion) || '2025-06-18'
    return JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: 'offline' }, instructions: NOT_RUNNING } })
  }
  if (message.method === 'ping') return JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })
  if (message.method === 'tools/list') return JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
  return rpcError(message.id, NOT_RUNNING)
}

function writeLine(line) {
  if (line) process.stdout.write(line + '\n')
}

async function handleLine(line) {
  let message
  try { message = JSON.parse(line) } catch {
    writeLine(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  const info = discover()
  if (!info) { writeLine(offlineResponse(message)); return }
  try {
    const res = await post(info, line)
    if (res.status === 200 && res.text.trim()) writeLine(res.text.trim())
    else if (res.status !== 200 && res.status !== 202 && message.id !== undefined) writeLine(rpcError(message.id, `AIDE returned HTTP ${res.status}: ${res.text.slice(0, 300)}`))
  } catch (err) {
    process.stderr.write(`aide-mcp: ${err && err.message}\n`)
    writeLine(offlineResponse(message))
  }
}

function runMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set()
  rl.on('line', (line) => {
    if (!line.trim()) return
    const task = handleLine(line).finally(() => pending.delete(task))
    pending.add(task)
  })
  rl.on('close', () => { Promise.allSettled([...pending]).then(() => process.exit(0)) })
}

function argValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function feed(kind, args) {
  const run = argValue(args, '--run')
  if (!run) { process.stderr.write(`aide-mcp ${kind}: --run <id> is required\n`); process.exit(2) }
  const info = discover()
  if (!info) { process.stderr.write(NOT_RUNNING + '\n'); process.exit(3) }
  const query = new URLSearchParams({ run })
  const since = argValue(args, '--since')
  if (since) query.set('since', since)
  const timeout = argValue(args, '--timeout')
  if (timeout) query.set('timeout', timeout)
  if (args.includes('--all')) query.set('all', '1')
  const req = http.request({ host: '127.0.0.1', port: info.port, path: `/${kind}?${query}`, method: 'GET', headers: headers(info) }, (res) => {
    if (res.statusCode !== 200) {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => { process.stderr.write(`AIDE returned HTTP ${res.statusCode}: ${text}\n`); process.exit(4) })
      return
    }
    res.setEncoding('utf8')
    // The server's keep-alive heartbeats are blank lines; a monitor would turn each into a notification.
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) if (line.trim()) process.stdout.write(line + '\n')
    })
    res.on('end', () => {
      if (buffer.trim()) process.stdout.write(buffer + '\n')
      process.exit(0)
    })
  })
  req.on('error', (err) => { process.stderr.write(`aide-mcp ${kind}: ${err.message}\n`); process.exit(3) })
  req.end()
}

const [mode = 'mcp', ...rest] = process.argv.slice(2)
if (mode === 'mcp') runMcp()
else if (mode === 'events' || mode === 'wait') feed(mode, rest)
else { process.stderr.write(`aide-mcp: unknown mode "${mode}"\n`); process.exit(2) }
