import React, { useEffect, useState } from 'react'

/**
 * Orchestration setup wizard (main menu → Orchestration): opens a terminal tab with a ready-made prompt
 * asking the chosen agent to connect AIDE's MCP server to itself, and closes. The rest happens in that
 * tab: the agent says when its session must be restarted, and confirms the connection via pipeline_hello.
 */

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
    '3. If your CLI loads MCP servers only when a session starts, tell me to restart this terminal tab and stop here. After the restart I will ask you to call pipeline_hello.',
    '4. Otherwise call the pipeline_hello tool and summarize what it returned.',
    ...(notes.trim() ? ['', 'Additional notes from the user:', notes.trim()] : [])
  ].join('\n')
}

export default function OrchestrationSetupDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [setup, setSetup] = useState<OrchestrationSetup | null | undefined>(undefined)
  const [tools, setTools] = useState<Array<{ id: string; name: string }>>([])
  const [toolId, setToolId] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    void window.editorApi.pipelineGetSetup().then(setSetup)
    void window.editorApi.getCliTools().then((list) => {
      setTools(list)
      setToolId((current) => current || list[0]?.id || '')
    })
  }, [])

  const start = (): void => {
    if (!setup || !toolId) return
    void window.editorApi.terminalCreateWithPrompt(toolId, buildPrompt(setup, notes))
    onClose()
  }

  const loading = setup === undefined
  const unavailable = setup === null || (setup !== undefined && !setup.available)

  return <div style={OVERLAY} onClick={onClose}>
    <div style={DIALOG} onClick={(e) => e.stopPropagation()}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0', marginBottom: 6 }}>Set Up Orchestration</div>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 14, lineHeight: 1.5 }}>
        An agent with MCP support connects AIDE&apos;s pipeline server to itself and becomes the orchestrator of pipeline runs in this project.
        The agent works in a new terminal tab and tells you there if the tab must be restarted.
      </div>

      {loading && <div style={MUTED}>Loading…</div>}
      {!loading && unavailable && <div style={{ ...MUTED, color: '#f48771' }}>The pipeline server is not running. Check the diagnostics log.</div>}

      {!loading && !unavailable && setup && <>
        {setup.connected.length > 0 && <div style={{ ...MUTED, marginBottom: 12 }}>
          Already connected: {setup.connected.map((c) => c.client?.name ?? 'unknown agent').join(', ')}
        </div>}

        <label style={LABEL}>Agent</label>
        <select value={toolId} onChange={(e) => setToolId(e.target.value)} style={INPUT}>
          {tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
        </select>
        <label style={{ ...LABEL, marginTop: 12 }}>Notes for the agent (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. register the server with user scope" style={{ ...INPUT, height: 60, resize: 'vertical', fontFamily: 'inherit' }} />
        <div style={BUTTONS}>
          <button style={SECONDARY} onClick={onClose}>Cancel</button>
          <button style={PRIMARY} disabled={!toolId} onClick={start}>Ask {tools.find((t) => t.id === toolId)?.name ?? 'agent'}</button>
        </div>
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
