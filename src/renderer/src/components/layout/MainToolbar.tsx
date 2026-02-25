import React from 'react'

// Main toolbar — full application width, below native menu bar.
// Stage 9 will populate this with config-driven icon buttons.
export default function MainToolbar(): React.ReactElement {
  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        background: '#2d2d2d',
        borderBottom: '1px solid #3d3d3d',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 8,
        gap: 4
      }}
    >
      {/* Toolbar buttons rendered in Stage 9 */}
    </div>
  )
}
