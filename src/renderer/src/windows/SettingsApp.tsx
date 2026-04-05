import React, { useEffect, useRef, useState } from 'react'
import type { SettingsField } from '../../../shared/settingsTypes'

interface ReasoningConfig {
  showPanel: boolean
}

interface UpdatesConfig {
  notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly'
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
  const [toolSettings, setToolSettings] = useState<ToolSettingsEntry[]>([])
  const [accountTools, setAccountTools] = useState<AccountToolEntry[]>([])
  const [accountIdentifiers, setAccountIdentifiers] = useState<Record<string, string | null>>({})
  const [saved, setSaved] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.settingsApi.getReasoningConfig().then(setReasoning)
    window.settingsApi.getUpdatesConfig().then(setUpdates)
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
      window.settingsApi.saveUpdatesConfig(updates)
    ]
    for (const entry of toolSettings) {
      saves.push(window.settingsApi.updateToolSettings(entry.toolId, entry.values))
    }
    await Promise.all(saves)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
