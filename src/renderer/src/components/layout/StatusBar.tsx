import React from 'react'

// Status bar — thin bar at the bottom with sensor array.
// Sensor implementations added in Stage 8.
export default function StatusBar(): React.ReactElement {
  return (
    <div
      style={{
        height: 22,
        flexShrink: 0,
        background: '#007acc',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 10,
        paddingRight: 10,
        gap: 12
      }}
    >
      {/* Left sensors */}
      <div style={{ display: 'flex', gap: 12, flex: 1 }}>
        {/* Git branch sensor — Stage 8 */}
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>main</span>
      </div>

      {/* Right sensors — Stage 8 */}
    </div>
  )
}
