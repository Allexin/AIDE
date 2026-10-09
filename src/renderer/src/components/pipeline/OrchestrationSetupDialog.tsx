import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../../store/useSessionStore'

/**
 * "Set Up Orchestration…" wizard: opens a terminal tab with a ready-made prompt
 * asking the chosen agent to connect AIDE's MCP server to itself, then waits
 * for the agent's `pipeline_hello` handshake. Opened from the CLI menu.
 */

type Phase = 'choose' | 'waiting' | 'connected'

function buildPrompt(setup: OrchestrationSetup, notes: string): string {
  const env = Object.entries(setup.mcp.env).map(([key, value]) => `${key}=${value}`).join('\n     ')
  return [
    'You are being set up as the orchestrator of AIDE pipelines for this project.',
    '',
    `1. Read ${setup.docPath}.`,
    '2. Register AIDE\'s MCP server in your own MCP configuration (project scope if your CLI supports it):',
    '   name: aide',
    '   transport: stdio',
    `   command: ${setup.mcp.command}`,
    `   args: ${JSON.stringify(setup.mcp.args)}`,
    `   env: ${env}`,
    '3. If your CLI loads MCP servers only when a session starts, tell me that this session must be restarted and stop here.',
    '4. Otherwise call the pipeline_hello tool and summarize what it returned.',
    ...(notes.trim() ? ['', 'Additional notes from the user:', notes.trim()] : [])
  ].join('\n')
}

export default function OrchestrationSetupDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [setup, setSetup] = useState<OrchestrationSetup | null | undefined>(undefined)
  const [tools, setTools] = useState<Array<{ id: string; name: string }>>([])
  const [toolId, setToolId] = useState('')
  const [notes, setNotes] = useState('')
  const [phase, setPhase] = useState<Phase>('choose')
  const [tabId, setTabId] = useState<string | null>(null)
  const [connection, setConnection] = useState<OrchestratorConnection | null>(null)
  const [restartMessage, setRestartMessage] = useState<string | null>(null)
  const tab = useSessionStore((s) => s.tabs.find((t) => t.tabId === tabId) ?? null)

  useEffect(() => {
    void window.editorApi.pipelineGetSetup().then(setSetup)
    void window.editorApi.getCliTools().then((list) => {
      setTools(list)
      setToolId((current) => current || list[0]?.id || '')
    })
  }, [])

  useEffect(() => window.editorApi.onOrchestratorConnected((c) => {
    // Accept the tab we opened; an unknown tab id still means some agent here connected.
    if (phase === 'waiting' && (c.tabId === null || c.tabId === tabId)) {
      setConnection(c)
      setPhase('connected')
    }
  }), [phase, tabId])

  const start = async (): Promise<void> => {
    if (!setup || !toolId) return
    const info = await window.editorApi.terminalCreateWithPrompt(toolId, buildPrompt(setup, notes))
    if (!info) return
    setTabId(info.tabId)
    setPhase('waiting')
  }

  // Close the tab and resume the same CLI session in a new one, so the CLI reloads its MCP servers.
  const restartTab = async (): Promise<void> => {
    if (!tab) return
    if (!tab.sessionId) {
      setRestartMessage('The session id of this tab is not known yet. Restart the session in the tab manually.')
      return
    }
    const resumed = await window.editorApi.terminalResumeSession(tab.sessionId, tab.toolId)
    if (!resumed) {
      setRestartMessage('Could not resume the session. Restart it in the tab manually.')
      return
    }
    useSessionStore.getState().addTab(resumed)
    window.editorApi.terminalCloseTab(tab.tabId)
    useSessionStore.getState().closeTab(tab.tabId)
    setTabId(resumed.tabId)
    setRestartMessage('Session restarted. Ask the agent to call pipeline_hello.')
  }

  const loading = setup === undefined
  const unavailable = setup === null || (setup !== undefined && !setup.available)

  return <div style={OVERLAY} onClick={onClose}>
    <div style={DIALOG} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0', marginBottom: 6 }}>Set Up Orchestration</div>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 14, lineHeight: 1.5 }}>
        An agent with MCP support connects AIDE&apos;s pipeline server to itself and becomes the orchestrator of pipeline runs in this project.
      </div>

      {loading && <div style={MUTED}>Loading…</div>}
      {!loading && unavailable && <div style={{ ...MUTED, color: '#f48771' }}>The pipeline server is not running. Check the diagnostics log.</div>}

      {!loading && !unavailable && setup && <>
        {setup.connected.length > 0 && phase === 'choose' && <div style={{ ...MUTED, marginBottom: 12 }}>
          Already connected: {setup.connected.map((c) => c.client?.name ?? 'unknown agent').join(', ')}
        </div>}

        {phase === 'choose' && <>
          <label style={LABEL}>Agent</label>
          <select value={toolId} onChange={(e) => setToolId(e.target.value)} style={INPUT}>
            {tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
          </select>
          <label style={{ ...LABEL, marginTop: 12 }}>Notes for the agent (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. register the server with user scope" style={{ ...INPUT, height: 60, resize: 'vertical', fontFamily: 'inherit' }} />
          <div style={BUTTONS}>
            <button style={SECONDARY} onClick={onClose}>Cancel</button>
            <button style={PRIMARY} disabled={!toolId} onClick={() => void start()}>Ask {tools.find((t) => t.id === toolId)?.name ?? 'agent'}</button>
          </div>
        </>}

        {phase === 'waiting' && <>
          <div style={{ fontSize: 12, color: '#cccccc', lineHeight: 1.6 }}>
            <div>⏳ Waiting for the agent to connect…</div>
            <div style={MUTED}>The agent is configuring the MCP server in its terminal tab. If it says the session must be restarted, use <b>Restart tab</b>, then ask it to call <code>pipeline_hello</code>.</div>
          </div>
          {restartMessage && <div style={{ ...MUTED, marginTop: 8, color: '#dcdcaa' }}>{restartMessage}</div>}
          <div style={BUTTONS}>
            <button style={SECONDARY} onClick={onClose}>Close</button>
            <button style={SECONDARY} disabled={!tab} onClick={() => void restartTab()}>Restart tab</button>
          </div>
        </>}

        {phase === 'connected' && connection && <>
          <div style={{ fontSize: 12, color: '#4ec9b0', lineHeight: 1.6 }}>
            ✓ Connected: {connection.client ? `${connection.client.name} ${connection.client.version}` : 'agent'}
          </div>
          <div style={{ ...MUTED, marginTop: 6 }}>This agent can now orchestrate pipelines in this project. Next step: ask it to prepare pipelines for the project.</div>
          <div style={BUTTONS}>
            <button style={PRIMARY} onClick={onClose}>Done</button>
          </div>
        </>}
      </>}
    </div>
  </div>
}

const OVERLAY: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }
const DIALOG: React.CSSProperties = { width: 460, maxWidth: 'calc(100vw - 32px)', background: '#252526', border: '1px solid #454545', borderRadius: 6, padding: '16px 18px', fontFamily: 'Segoe UI, sans-serif', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)' }
const LABEL: React.CSSProperties = { display: 'block', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }
const INPUT: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#1e1e1e', color: '#cccccc', border: '1px solid #444', borderRadius: 4, padding: '5px 8px', fontSize: 12 }
const MUTED: React.CSSProperties = { fontSize: 12, color: '#888', lineHeight: 1.5 }
const BUTTONS: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }
const PRIMARY: React.CSSProperties = { padding: '5px 14px', fontSize: 12, borderRadius: 3, border: '1px solid #0e639c', background: '#0e639c', color: '#fff', cursor: 'pointer' }
const SECONDARY: React.CSSProperties = { padding: '5px 14px', fontSize: 12, borderRadius: 3, border: '1px solid #555', background: '#2d2d2d', color: '#ccc', cursor: 'pointer' }
