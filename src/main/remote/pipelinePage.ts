import { HISTORY_STYLE } from './historyRender'
import { safeJsJson } from './pageUtil'

/**
 * The remote pipeline page: the project's run as `RemoteRunView` draws it (run
 * header and controls, the pending escalation with its answers, the step list,
 * the report of a finished run). Served by the aggregator like the terminal
 * page; its WebSocket goes through the aggregator to the instance. `tab` in the
 * URL is the terminal tab the "Agent" button goes back to.
 * The script is inside a template literal: no backticks, no backslashes.
 */

export function makePipelineHtml(port: number, projectId: string, projectName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>AIDE Pipeline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; background: #1e1e1e; color: #cccccc; font: 13px/1.45 system-ui, sans-serif; }
    button { font: inherit; }
    #bar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #252526; border-bottom: 1px solid #3d3d3d; }
    .nav { flex-shrink: 0; padding: 5px 10px; color: #4fc3f7; background: #3c3c3c; border: 1px solid #4fc3f7; border-radius: 4px; font: 12px/1 monospace; text-decoration: none; cursor: pointer; touch-action: manipulation; }
    #title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; }
    #name { overflow: hidden; text-overflow: ellipsis; color: #e0e0e0; font-weight: 600; }
    #project { color: #777; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
    #elapsed { flex-shrink: 0; color: #888; font: 11px/1 monospace; }
    #sub { padding: 6px 12px; color: #999; font-size: 12px; border-bottom: 1px solid #2d2d2d; overflow-wrap: anywhere; }
    #sub b { font-weight: 600; }
    #controls { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px; }
    #controls:empty { display: none; }
    .btn { padding: 7px 12px; color: #cccccc; background: #2d2d2d; border: 1px solid #555; border-radius: 4px; cursor: pointer; touch-action: manipulation; }
    .btn:active { background: #505050; }
    .btn:disabled { opacity: 0.5; }
    .btn.primary { color: #ffffff; background: #0e639c; border-color: #0e639c; }
    .note { margin: 6px 12px; padding: 7px 10px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .note.error { color: #f48771; background: #3a1f1f; }
    .note.info { color: #dcdcaa; background: #2f2f22; }
    .note.muted { color: #888; background: #252526; }
    #escalation:empty, #report:empty { display: none; }
    .esc-card { margin: 8px 12px; padding: 10px 12px; background: #2b1d1d; border: 1px solid #a33; border-radius: 6px; animation: attention 1.2s ease-in-out infinite alternate; }
    @keyframes attention { from { border-color: #a33; } to { border-color: #f0a500; } }
    .esc-title { color: #ffb3b3; font-weight: 600; }
    .esc-meta { margin-top: 2px; color: #888; font-size: 11px; }
    .esc-message { margin: 8px 0; color: #dddddd; white-space: pre-wrap; overflow-wrap: anywhere; }
    .esc-text { width: 100%; min-height: 64px; padding: 7px; color: #d4d4d4; background: #1e1e1e; border: 1px solid #555; border-radius: 4px; font: 13px/1.4 system-ui, sans-serif; resize: vertical; outline: none; }
    .esc-text:focus { border-color: #4fc3f7; }
    .esc-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .esc-status { margin-top: 6px; font-size: 12px; }
    .esc-status.error { color: #f48771; }
    .esc-status.sent { color: #4ec9b0; }
    .report { margin: 8px 12px; padding: 8px 10px; background: #252526; border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
    .report h3 { font-size: 13px; margin-bottom: 4px; }
    .report ul { margin: 2px 0 4px 18px; }
    .section { padding: 8px 12px 4px; color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    #steps { padding-bottom: 24px; }
    .row { padding: 4px 12px 4px calc(12px + var(--depth) * 14px); border-left: 2px solid transparent; }
    .row.heading { color: #9cdcfe; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding-top: 8px; }
    .row.heading.branch { color: #c586c0; text-transform: none; letter-spacing: 0; }
    .row.block { display: flex; gap: 8px; align-items: baseline; color: #999; font-size: 12px; }
    .row.block.active { color: #dcdcaa; }
    .row.block .progress { margin-left: auto; font-size: 11px; }
    .row.leaf.current { background: #2a2d2e; border-left-color: #4ec9b0; }
    .row.leaf.waiting { border-left-color: #f48771; }
    .leaf-head { display: flex; align-items: baseline; gap: 8px; }
    .leaf-icon { width: 14px; flex-shrink: 0; text-align: center; }
    .leaf-id { color: #cccccc; }
    .row.leaf.current .leaf-id { color: #ffffff; font-weight: 600; }
    .leaf-type { color: #666; font-size: 11px; }
    .leaf-count { margin-left: auto; color: #888; font-size: 11px; }
    .leaf-summary { margin-left: 22px; color: #777; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .leaf-error { margin-left: 22px; color: #f48771; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pulse { animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .empty { padding: 24px 16px; color: #858585; text-align: center; }
${HISTORY_STYLE}
  </style>
</head>
<body>
  <header id="bar">
    <a id="back" class="nav">&#x2039; Agent</a>
    <div id="title"><span id="dot"></span><span id="name">Pipeline</span><span id="project"></span></div>
    <span id="elapsed"></span>
  </header>
  <div id="sub">Connecting...</div>
  <div id="controls"></div>
  <div id="notices"></div>
  <section id="escalation"></section>
  <section id="report"></section>
  <main id="steps"></main>
  <script src="/static/marked.js"></script>
  <script src="/static/purify.js"></script>
  <script>
    var port = ${port}
    var projectId = ${safeJsJson(projectId)}
    var projectName = ${safeJsJson(projectName)}
    var params = new URLSearchParams(location.search)
    var returnTab = params.get('tab') || ''
    var STATUS_LABEL = { running: 'Running', pausing: 'Pausing...', paused: 'Paused', waiting: 'Waiting for a decision', stopped: 'Stopped', finished: 'Finished', failed: 'Failed' }
    var STATUS_COLOR = { running: '#4ec9b0', pausing: '#dcdcaa', paused: '#dcdcaa', waiting: '#f48771', stopped: '#dcdcaa', finished: '#4ec9b0', failed: '#f48771' }
    var LEAF_ICON = { pending: '○', running: '●', waiting: '!', held: '❚❚', ok: '✓', fail: '✗', interrupted: '⏸', other: '·' }
    var LEAF_COLOR = { pending: '#555', running: '#4ec9b0', waiting: '#f48771', held: '#4ec9b0', ok: '#4ec9b0', fail: '#f48771', interrupted: '#dcdcaa', other: '#dcdcaa' }

    var run = null
    var controlError = null
    var shownEscalationId = null
    var reportRunId = null
    var report = null
    var ws = null
    var wsReady = false
    var reconnectTimer = null
    var reconnectDelay = 1000

    document.getElementById('project').textContent = projectName
    var back = document.getElementById('back')
    back.href = returnTab
      ? '/terminal?port=' + port + '&project=' + encodeURIComponent(projectId) + '&tab=' + encodeURIComponent(returnTab)
      : '/tabs?port=' + port + '&project=' + encodeURIComponent(projectId)
    if (!returnTab) back.textContent = '‹ Tabs'

    function el(tag, className, text) {
      var node = document.createElement(tag)
      if (className) node.className = className
      if (text != null) node.textContent = text
      return node
    }
    function clock(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    function elapsed(fromIso, toIso) {
      var ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)
      var minutes = Math.floor(ms / 60000)
      if (minutes < 1) return Math.max(0, Math.floor(ms / 1000)) + ' s'
      return minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min'
    }
    function sendWs(msg) {
      if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(msg))
      return true
    }

    // --- Header, controls, notices ---
    function renderHeader() {
      var dot = document.getElementById('dot')
      var sub = document.getElementById('sub')
      if (!run) {
        dot.textContent = ''
        document.getElementById('name').textContent = 'Pipeline'
        document.getElementById('elapsed').textContent = ''
        sub.textContent = wsReady ? 'No pipeline run in this project.' : sub.textContent
        return
      }
      dot.textContent = '●'
      dot.style.color = STATUS_COLOR[run.status] || '#888'
      dot.className = run.status === 'running' ? 'pulse' : ''
      document.getElementById('name').textContent = run.machineName
      renderElapsed()
      sub.innerHTML = ''
      var status = el('b', '', STATUS_LABEL[run.status] || run.status)
      status.style.color = STATUS_COLOR[run.status] || '#ccc'
      sub.appendChild(status)
      if (run.active && run.current) sub.appendChild(document.createTextNode(' · ' + run.current))
      if (run.active && run.loopLabel) sub.appendChild(document.createTextNode(' · ↺ ' + run.loopLabel))
      sub.appendChild(document.createTextNode(' · ' + run.runId))
    }
    function renderElapsed() {
      document.getElementById('elapsed').textContent = run ? elapsed(run.startedAt, run.finishedAt) : ''
    }
    function controlButton(action, label, primary) {
      var b = el('button', 'btn' + (primary ? ' primary' : ''), label)
      b.addEventListener('click', function() {
        if (action === 'abandon' && !confirm('End this run for good?')) return
        controlError = null
        if (!sendWs({ type: 'pipeline-control', action: action })) controlError = 'Not connected.'
        renderNotices()
      })
      return b
    }
    function renderControls() {
      var box = document.getElementById('controls')
      box.innerHTML = ''
      if (!run) return
      var s = run.status
      if (s === 'running') box.appendChild(controlButton('pause', 'Pause'))
      if (s === 'running' || s === 'pausing') box.appendChild(controlButton('stop', 'Stop now'))
      if (s === 'paused' || s === 'stopped') box.appendChild(controlButton('resume', 'Resume', true))
      if (s === 'paused' || s === 'stopped') box.appendChild(controlButton('abandon', 'Abandon'))
    }
    function renderNotices() {
      var box = document.getElementById('notices')
      box.innerHTML = ''
      if (controlError) box.appendChild(el('div', 'note error', controlError))
      if (!run) return
      if (run.unavailable && run.active) {
        var u = run.unavailable
        box.appendChild(el('div', 'note info', u.node + ': ' + u.cli + ' is unavailable since ' + clock(u.since) + ', retrying every minute (attempt ' + u.attempts + '). ' + u.lastError))
      }
      if (run.limitResumeAt && run.active) {
        box.appendChild(el('div', 'note info', 'Waiting for the ' + (run.limitCli || 'CLI') + ' usage limit; the run resumes by itself at ' + clock(run.limitResumeAt) + '.'))
      }
      if (run.lastAnswer && !run.pending) {
        var a = run.lastAnswer
        box.appendChild(el('div', 'note muted', 'Last decision at ' + a.node + ': ' + a.action + ' by the ' + a.by + ' at ' + clock(a.at) + (a.text ? ' — ' + a.text : '')))
      }
    }

    // --- Escalation ---
    function renderEscalation() {
      var box = document.getElementById('escalation')
      var pending = run && run.pending
      if (!pending) { box.innerHTML = ''; shownEscalationId = null; return }
      // Redrawn only for a new escalation, so a state change does not wipe the answer being typed.
      if (shownEscalationId === pending.id) return
      shownEscalationId = pending.id
      box.innerHTML = ''
      var card = el('div', 'esc-card')
      card.appendChild(el('div', 'esc-title', pending.title + ' — ' + pending.node))
      card.appendChild(el('div', 'esc-meta', 'For the ' + pending.to + ', whoever answers first · ' + clock(pending.raisedAt)))
      card.appendChild(el('div', 'esc-message', pending.message))
      var text = el('textarea', 'esc-text')
      text.placeholder = 'Answer (available to the next steps)'
      card.appendChild(text)
      var actions = el('div', 'esc-actions')
      var status = el('div', 'esc-status')
      var buttons = []
      pending.actions.forEach(function(item, index) {
        var b = el('button', 'btn' + (index === 0 ? ' primary' : ''), item.label)
        b.addEventListener('click', function() {
          if (item.action === 'stop' && !confirm('Stop the run?')) return
          if (!sendWs({ type: 'pipeline-answer', escalationId: pending.id, action: item.action, text: text.value })) {
            status.className = 'esc-status error'
            status.textContent = 'Not connected.'
            return
          }
          buttons.forEach(function(other) { other.disabled = true })
          status.className = 'esc-status'
          status.textContent = 'Sending...'
        })
        buttons.push(b)
        actions.appendChild(b)
      })
      card.appendChild(actions)
      card.appendChild(status)
      card.answerResult = function(error) {
        buttons.forEach(function(other) { other.disabled = !!error ? false : true })
        status.className = 'esc-status ' + (error ? 'error' : 'sent')
        status.textContent = error || 'Answered.'
      }
      box.appendChild(card)
    }

    // --- Report of a finished run ---
    function renderReport() {
      var box = document.getElementById('report')
      box.innerHTML = ''
      if (!run || run.active) return
      if (reportRunId !== run.runId) {
        reportRunId = run.runId
        report = null
        sendWs({ type: 'pipeline-report', runId: run.runId })
      }
      if (!report) return
      var card = el('div', 'report')
      var head = el('h3', '', 'Run ' + report.result + (report.reason ? ' — ' + report.reason : ''))
      head.style.color = report.result === 'success' ? '#4ec9b0' : '#f48771'
      card.appendChild(head)
      var commits = report.commits || []
      if (commits.length) {
        card.appendChild(el('div', '', 'Commits:'))
        var ul = el('ul')
        commits.forEach(function(c) { ul.appendChild(el('li', '', String(c.sha).slice(0, 8) + ' ' + String(c.message).split(String.fromCharCode(10))[0])) })
        card.appendChild(ul)
      }
      var checks = report.checks || []
      if (checks.length) {
        card.appendChild(el('div', '', 'Checks:'))
        var cl = el('ul')
        checks.forEach(function(c) { cl.appendChild(el('li', '', (c.passed ? '✓ ' : '✗ ') + c.command + (c.runs > 1 ? ' (' + c.runs + ' runs)' : ''))) })
        card.appendChild(cl)
      }
      var findings = report.nonBlockingFindings || []
      if (findings.length) {
        card.appendChild(el('div', '', 'Non-blocking findings: ' + findings.length))
        var fl = el('ul')
        findings.slice(0, 8).forEach(function(f) { fl.appendChild(el('li', '', String(f))) })
        card.appendChild(fl)
      }
      if (typeof report.costUsd === 'number' && report.costUsd > 0) card.appendChild(el('div', '', 'Cost: $' + report.costUsd.toFixed(2)))
      box.appendChild(card)
    }

    // --- Steps ---
    function leafRow(row) {
      var node = el('div', 'row leaf' + (row.current ? ' current' : '') + (row.state === 'waiting' ? ' waiting' : ''))
      node.style.setProperty('--depth', row.depth)
      var head = el('div', 'leaf-head')
      var icon = el('span', 'leaf-icon' + (row.state === 'running' ? ' pulse' : ''), LEAF_ICON[row.state] || '·')
      icon.style.color = LEAF_COLOR[row.state] || '#888'
      head.appendChild(icon)
      head.appendChild(el('span', 'leaf-id', row.id))
      head.appendChild(el('span', 'leaf-type', row.type + (row.cli ? ' · ' + row.cli : '')))
      if (row.visits.length > 1) head.appendChild(el('span', 'leaf-count', '×' + row.visits.length))
      node.appendChild(head)
      if (row.summary) node.appendChild(el('div', 'leaf-summary', row.summary))
      var last = row.visits[row.visits.length - 1]
      if (last && last.error) node.appendChild(el('div', 'leaf-error', last.error))
      return node
    }
    function renderSteps() {
      var box = document.getElementById('steps')
      box.innerHTML = ''
      if (!run) {
        if (wsReady) box.appendChild(el('div', 'empty', 'Nothing to show: the orchestrator has not started a run in this project yet.'))
        return
      }
      box.appendChild(el('div', 'section', 'Flow'))
      ;(run.rows || []).forEach(function(row) {
        if (row.kind === 'leaf') { box.appendChild(leafRow(row)); return }
        var node
        if (row.kind === 'heading') {
          node = el('div', 'row heading' + (row.tone === 'branch' ? ' branch' : ''), row.label)
        } else {
          node = el('div', 'row block' + (row.active ? ' active' : ''))
          node.appendChild(el('span', '', row.type === 'commit' ? '⎇' : '↺'))
          node.appendChild(el('span', '', row.label))
          node.appendChild(el('span', 'progress', row.progress))
        }
        if (row.summary) node.title = row.summary
        node.style.setProperty('--depth', row.depth)
        box.appendChild(node)
      })
    }

    function render() {
      renderHeader()
      renderControls()
      renderNotices()
      renderEscalation()
      renderReport()
      renderSteps()
    }
    setInterval(function() { if (run && run.active) renderElapsed() }, 1000)

    // --- WebSocket (through the aggregator) ---
    var proto = location.protocol === 'https:' ? 'wss' : 'ws'
    var wsUrl = proto + '://' + location.host + '/ws?port=' + port + '&project=' + encodeURIComponent(projectId)
    function setSub(text) { document.getElementById('sub').textContent = text }
    function connectWs() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      wsReady = false
      ws = new WebSocket(wsUrl)
      ws.onopen = function() { ws.send(JSON.stringify({ type: 'auth', token: '' })) }
      ws.onmessage = handleWsMessage
      ws.onclose = function() { wsReady = false; scheduleReconnect() }
      ws.onerror = function() { wsReady = false }
    }
    function scheduleReconnect() {
      if (reconnectTimer) return
      setSub('Disconnected — reconnecting in ' + Math.round(reconnectDelay / 1000) + 's')
      reconnectTimer = setTimeout(function() {
        reconnectTimer = null
        reconnectDelay = Math.min(reconnectDelay * 2, 10000)
        connectWs()
      }, reconnectDelay)
    }
    function handleWsMessage(e) {
      var msg = JSON.parse(e.data)
      if (msg.type === 'auth-ok') {
        wsReady = true
        reconnectDelay = 1000
        reportRunId = null
        sendWs({ type: 'pipeline-subscribe' })
      } else if (msg.type === 'auth-fail') {
        setSub('Auth failed — session expired, reload the page')
      } else if (msg.type === 'pipeline-run') {
        var previous = run ? run.runId : null
        run = msg.run
        if (!run || run.runId !== previous) shownEscalationId = null
        render()
      } else if (msg.type === 'pipeline-control-result') {
        controlError = msg.error || null
        renderNotices()
      } else if (msg.type === 'pipeline-answer-result') {
        var card = document.querySelector('.esc-card')
        if (card && card.answerResult && msg.escalationId === shownEscalationId) card.answerResult(msg.error)
      } else if (msg.type === 'pipeline-report') {
        if (run && msg.runId === run.runId) { report = msg.report; renderReport() }
      }
    }
    connectWs()
  </script>
</body>
</html>`
}
