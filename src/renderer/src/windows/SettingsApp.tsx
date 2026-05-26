import React, { useEffect, useRef, useState } from 'react'
import type { SettingsField } from '../../../shared/settingsTypes'

interface ReasoningConfig {
  showPanel: boolean
}

interface UpdatesConfig {
  notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly'
}

interface RemoteCustomButton {
  label: string
  send: string
}

interface RemoteButtonRow {
  buttons: RemoteCustomButton[]
}

interface RemoteConfig {
  enabled: boolean
  remoteHost: string
  buttonSize: 'small' | 'medium' | 'large'
  buttonRows: RemoteButtonRow[]
}

interface ToolSettingsEntry {
  toolId: string
  name: string
  fields: SettingsField[]
  values: Record<string, unknown>
}

interface AccountToolEntry {
  id: string
  name: string
  hasAccount: boolean
}

const fieldsetStyle: React.CSSProperties = {
  border: '1px solid #444',
  borderRadius: 4,
  padding: '12px 16px',
  margin: '16px 0 0'
}

const legendStyle: React.CSSProperties = {
  color: '#aaa',
  fontSize: 12,
  padding: '0 6px'
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  background: '#2a2a2a',
  border: '1px solid #555',
  borderRadius: 3,
  color: '#ddd',
  fontSize: 13,
  outline: 'none'
}

function ToolSettingsSection({ entry, onChange }: {
  entry: ToolSettingsEntry
  onChange: (values: Record<string, unknown>) => void
}): React.ReactElement | null {
  if (entry.fields.length === 0) return null

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>{entry.name}</legend>
      {entry.fields.map((field) => {
        if (field.visibleWhen) {
          const condVal = entry.values[field.visibleWhen.key] ?? entry.fields.find(f => f.key === field.visibleWhen!.key)?.default
          if (condVal !== field.visibleWhen.value) return null
        }
        const val = entry.values[field.key] ?? field.default
        const update = (v: unknown): void => onChange({ ...entry.values, [field.key]: v })

        if (field.type === 'boolean') {
          return (
            <label key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
              <input type="checkbox" checked={!!val} onChange={(e) => update(e.target.checked)} />
              {field.label}
              {field.description && <span style={{ color: '#777', fontSize: 11 }}>{field.description}</span>}
            </label>
          )
        }

        return (
          <div key={field.key} style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', marginBottom: 4, color: '#999', fontSize: 12 }}>{field.label}</label>
            {field.type === 'select' ? (
              <select
                value={String(val ?? '')}
                onChange={(e) => update(e.target.value)}
                style={{ ...inputStyle }}
              >
                {field.options?.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                value={String(val ?? '')}
                onChange={(e) => update(field.type === 'number' ? Number(e.target.value) : e.target.value)}
                style={inputStyle}
              />
            )}
            {field.description && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: '#777' }}>{field.description}</p>
            )}
          </div>
        )
      })}
    </fieldset>
  )
}

export default function SettingsApp(): React.ReactElement {
  const [reasoning, setReasoning] = useState<ReasoningConfig>({ showPanel: false })
  const [updates, setUpdates] = useState<UpdatesConfig>({ notifyFrequency: 'daily' })
  const [remote, setRemote] = useState<RemoteConfig>({ enabled: false, remoteHost: '', buttonSize: 'medium', buttonRows: [] })
  const [initialRemoteEnabled, setInitialRemoteEnabled] = useState(false)
  const [activatedTools, setActivatedTools] = useState<{ id: string; name: string }[]>([])
  const [selectedToolId, setSelectedToolId] = useState('')
  const [toolSettings, setToolSettings] = useState<ToolSettingsEntry[]>([])
  const [accountTools, setAccountTools] = useState<AccountToolEntry[]>([])
  const [accountIdentifiers, setAccountIdentifiers] = useState<Record<string, string | null>>({})
  const [saved, setSaved] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.settingsApi.getReasoningConfig().then(setReasoning)
    window.settingsApi.getUpdatesConfig().then(setUpdates)
    window.settingsApi.getRemoteConfig().then((cfg) => {
      setRemote(cfg)
      setInitialRemoteEnabled(cfg.enabled)
    })
    window.settingsApi.getActivatedTools().then((tools) => {
      setActivatedTools(tools)
      if (tools.length > 0) setSelectedToolId(tools[0].id)
    })
    window.settingsApi.getToolSettings().then(setToolSettings)
    window.settingsApi.getAccountTools().then(async (tools) => {
      setAccountTools(tools)
      const ids: Record<string, string | null> = {}
      for (const t of tools) {
        if (t.hasAccount) {
          ids[t.id] = await window.settingsApi.getLoginIdentifier(t.id)
        }
      }
      setAccountIdentifiers(ids)
    })
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      window.settingsApi.resizeWindow(el.offsetHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleSave = async (): Promise<void> => {
    const saves: Promise<void>[] = [
      window.settingsApi.saveReasoningConfig(reasoning),
      window.settingsApi.saveUpdatesConfig(updates),
      window.settingsApi.saveRemoteConfig(remote)
    ]
    for (const entry of toolSettings) {
      saves.push(window.settingsApi.updateToolSettings(entry.toolId, entry.values))
    }
    await Promise.all(saves)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleAskAiRemote = (): void => {
    if (!selectedToolId) return
    void window.settingsApi.askAiAboutRemote(selectedToolId)
  }

  const updateToolValues = (toolId: string, values: Record<string, unknown>): void => {
    setToolSettings((prev) =>
      prev.map((e) => (e.toolId === toolId ? { ...e, values } : e))
    )
  }

  return (
    <div ref={rootRef} style={{ padding: 24, color: '#ccc', fontFamily: 'Segoe UI, sans-serif', fontSize: 13 }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 16, color: '#e0e0e0' }}>Settings</h2>

      {/* Accounts section */}
      {accountTools.length > 0 && (
        <fieldset style={{ ...fieldsetStyle, margin: '0 0 0' }}>
          <legend style={legendStyle}>Accounts</legend>
          {accountTools.map((tool) => (
            <div key={tool.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 600, color: '#d4d4d4' }}>{tool.name}</span>
              <span style={{ fontSize: 12, color: '#999' }}>
                {accountIdentifiers[tool.id] ?? 'Not logged in'}
              </span>
            </div>
          ))}
        </fieldset>
      )}

      {/* Per-tool settings */}
      {toolSettings.map((entry) => (
        <ToolSettingsSection
          key={entry.toolId}
          entry={entry}
          onChange={(values) => updateToolValues(entry.toolId, values)}
        />
      ))}

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Updates</legend>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'block', marginBottom: 4, color: '#999', fontSize: 12 }}>
            Notify about new versions
          </label>
          <select
            value={updates.notifyFrequency}
            onChange={(e) => setUpdates({ ...updates, notifyFrequency: e.target.value as UpdatesConfig['notifyFrequency'] })}
            style={{ ...inputStyle }}
          >
            <option value="never">Never</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#777', lineHeight: 1.5 }}>
            Updates are always checked daily. This controls how often a notification dialog appears.
          </p>
        </div>
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Remote Access</legend>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={remote.enabled}
            onChange={(e) => setRemote({ ...remote, enabled: e.target.checked })}
          />
          Allow remote connect
        </label>

        {remote.enabled !== initialRemoteEnabled && (
          <p style={{ margin: '0 0 10px 24px', fontSize: 11, color: '#f5a623', lineHeight: 1.5 }}>
            Restart all AIDE instances for this change to take effect.
          </p>
        )}

        <div style={{ marginTop: 12, marginBottom: 10 }}>
          <label style={{ display: 'block', marginBottom: 4, color: '#999', fontSize: 12 }}>
            Remote host (optional)
          </label>
          <input
            type="text"
            placeholder="e.g. 100.64.1.5:3847 or abc123.trycloudflare.com"
            value={remote.remoteHost}
            onChange={(e) => setRemote({ ...remote, remoteHost: e.target.value })}
            style={inputStyle}
          />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#777', lineHeight: 1.5 }}>
            External address shown as an extra QR code in the Remote Connect dialog.<br />
            Leave blank to show local network URLs only.
          </p>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'block', marginBottom: 8, color: '#999', fontSize: 12 }}>Button size</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['small', 'medium', 'large'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setRemote({ ...remote, buttonSize: s })}
                style={{
                  padding: '4px 12px', border: '1px solid #555', borderRadius: 3,
                  background: remote.buttonSize === s ? '#0e639c' : '#2a2a2a',
                  color: remote.buttonSize === s ? '#fff' : '#ccc', fontSize: 12, cursor: 'pointer'
                }}
              >
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'block', marginBottom: 8, color: '#999', fontSize: 12 }}>Button rows</label>
          <p style={{ margin: '0 0 8px', fontSize: 11, color: '#777', lineHeight: 1.5 }}>
            Row 1 is always visible. Additional rows appear in the shutter above the log.<br />
            Use escape notation in Send: <code style={{ color: '#aaa' }}>\r</code> = Enter, <code style={{ color: '#aaa' }}>\x03</code> = Ctrl+C, <code style={{ color: '#aaa' }}>\x1b</code> = Esc.
          </p>
          {(remote.buttonRows ?? []).map((row, rowIdx) => (
            <div key={rowIdx} style={{ border: '1px solid #333', borderRadius: 3, padding: '8px 10px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#777' }}>
                  {rowIdx === 0 ? 'Row 1 — always visible' : `Row ${rowIdx + 1} — in shutter`}
                </span>
                {rowIdx > 0 && (
                  <button
                    onClick={() => {
                      const rows = [...(remote.buttonRows ?? [])]
                      rows.splice(rowIdx, 1)
                      setRemote({ ...remote, buttonRows: rows })
                    }}
                    style={{ background: 'none', border: 'none', color: '#888', fontSize: 12, cursor: 'pointer', padding: 0 }}
                  >
                    Remove row
                  </button>
                )}
              </div>
              {row.buttons.map((btn, btnIdx) => (
                <div key={btnIdx} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <input
                    value={btn.label}
                    onChange={(e) => {
                      const rows = (remote.buttonRows ?? []).map((r, ri) =>
                        ri !== rowIdx ? r : { ...r, buttons: r.buttons.map((b, bi) => bi !== btnIdx ? b : { ...b, label: e.target.value }) }
                      )
                      setRemote({ ...remote, buttonRows: rows })
                    }}
                    placeholder="Label"
                    style={{ ...inputStyle, width: 80, flex: '0 0 auto' }}
                  />
                  <input
                    value={btn.send}
                    onChange={(e) => {
                      const rows = (remote.buttonRows ?? []).map((r, ri) =>
                        ri !== rowIdx ? r : { ...r, buttons: r.buttons.map((b, bi) => bi !== btnIdx ? b : { ...b, send: e.target.value }) }
                      )
                      setRemote({ ...remote, buttonRows: rows })
                    }}
                    placeholder="\r  \x03  text…"
                    style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                  <button
                    onClick={() => {
                      const rows = (remote.buttonRows ?? []).map((r, ri) =>
                        ri !== rowIdx ? r : { ...r, buttons: r.buttons.filter((_, bi) => bi !== btnIdx) }
                      )
                      setRemote({ ...remote, buttonRows: rows })
                    }}
                    style={{ background: 'none', border: 'none', color: '#888', fontSize: 16, cursor: 'pointer', padding: '0 4px', flex: '0 0 auto', lineHeight: 1 }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const rows = (remote.buttonRows ?? []).map((r, ri) =>
                    ri !== rowIdx ? r : { ...r, buttons: [...r.buttons, { label: '', send: '' }] }
                  )
                  setRemote({ ...remote, buttonRows: rows })
                }}
                style={{ fontSize: 11, color: '#4fc3f7', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
              >
                + Add button
              </button>
            </div>
          ))}
          <button
            onClick={() => setRemote({ ...remote, buttonRows: [...(remote.buttonRows ?? []), { buttons: [] }] })}
            style={{ fontSize: 11, color: '#4fc3f7', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
          >
            + Add row
          </button>
        </div>

        {activatedTools.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <select
              value={selectedToolId}
              onChange={(e) => setSelectedToolId(e.target.value)}
              style={{ ...inputStyle, width: 'auto', flex: '0 0 auto' }}
            >
              {activatedTools.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button
              onClick={handleAskAiRemote}
              style={{
                padding: '6px 14px', background: '#0e639c', border: 'none',
                borderRadius: 3, color: '#fff', fontSize: 13, cursor: 'pointer', flexShrink: 0
              }}
            >
              Ask AI
            </button>
            <span style={{ fontSize: 11, color: '#777' }}>
              Help me set up secure internet access
            </span>
          </div>
        )}
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Reasoning</legend>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={reasoning.showPanel}
            onChange={(e) => setReasoning({ ...reasoning, showPanel: e.target.checked })}
          />
          Show reasoning panel
        </label>

        <p style={{ margin: 0, fontSize: 11, color: '#777', lineHeight: 1.5 }}>
          Displays AI reasoning blocks above the log panel.<br />
          Data may be absent if your client requests responses with reasoning disabled.
        </p>
      </fieldset>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSave}
          style={{
            padding: '6px 20px',
            background: '#0e639c',
            border: 'none',
            borderRadius: 3,
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer'
          }}
        >
          Save
        </button>
        {saved && <span style={{ color: '#4ec9b0', fontSize: 12 }}>Saved</span>}
      </div>
    </div>
  )
}
