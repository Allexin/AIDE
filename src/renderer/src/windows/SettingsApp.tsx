import React, { useEffect, useState } from 'react'

interface ProxyConfig {
  enabled: boolean
  address: string
  useForCliTools: boolean
}

export default function SettingsApp(): React.ReactElement {
  const [config, setConfig] = useState<ProxyConfig>({ enabled: false, address: '', useForCliTools: true })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.settingsApi.getProxyConfig().then(setConfig)
  }, [])

  const handleSave = async (): Promise<void> => {
    await window.settingsApi.saveProxyConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ padding: 24, color: '#ccc', fontFamily: 'Segoe UI, sans-serif', fontSize: 13 }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 16, color: '#e0e0e0' }}>Settings</h2>

      <fieldset style={{ border: '1px solid #444', borderRadius: 4, padding: '12px 16px', margin: 0 }}>
        <legend style={{ color: '#aaa', fontSize: 12, padding: '0 6px' }}>Proxy</legend>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          Enable proxy
        </label>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4, color: '#999', fontSize: 12 }}>Proxy address</label>
          <input
            type="text"
            value={config.address}
            placeholder="http://127.0.0.1:1080"
            onChange={(e) => setConfig({ ...config, address: e.target.value })}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              background: '#2a2a2a',
              border: '1px solid #555',
              borderRadius: 3,
              color: '#ddd',
              fontSize: 13,
              outline: 'none'
            }}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.useForCliTools}
            onChange={(e) => setConfig({ ...config, useForCliTools: e.target.checked })}
          />
          Use for CLI tools (Claude Code)
        </label>
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
