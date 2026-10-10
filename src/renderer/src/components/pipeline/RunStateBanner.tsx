import React from 'react'
import { usePipelineStore } from '../../store/usePipelineStore'

/**
 * Warning above the terminal tabs while a pipeline run executes (plan §5.6).
 * Nothing is blocked — the user is only warned.
 */
export default function RunStateBanner(): React.ReactElement | null {
  const status = usePipelineStore((s) => s.run?.state.status)
  const open = (): void => usePipelineStore.getState().setViewActive(true)
  if (status === 'running' || status === 'pausing') {
    return <div onClick={open} title="Show the pipeline run" style={{ ...BASE, background: '#4d3f00', color: '#ffd866', borderBottom: '1px solid #6b5900' }}>
      Orchestrator is running — editing files may cause conflicts.
    </div>
  }
  if (status === 'waiting') {
    return <div onClick={open} title="Show the pipeline run" style={{ ...BASE, background: '#5a1d1d', color: '#ffb3b3', borderBottom: '1px solid #7a2a2a' }}>
      Orchestrator is waiting for a decision — answer in the pipeline tab or in the orchestrator terminal.
    </div>
  }
  return null
}

const BASE: React.CSSProperties = {
  flexShrink: 0,
  padding: '4px 10px',
  fontSize: 12,
  fontFamily: 'Segoe UI, sans-serif',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}
