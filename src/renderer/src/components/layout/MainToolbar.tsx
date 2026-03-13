import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useToolbarStore } from '../../store/useToolbarStore'
import { logManager } from '../../store/useLogStore'
import { playMelody } from '../../utils/sound'
import type { SoundNote } from '../../utils/sound'

// Helper to check if an item is a splitter
function isSplitter(item: ToolbarItem): item is ToolbarSplitter {
  return (item as ToolbarSplitter).type === 'splitter'
}

// Inject keyframes once into document head
let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
@keyframes aide-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
@keyframes aide-jiggle {
  0%   { transform: translate(0px, 0px) rotate(-4deg); }
  20%  { transform: translate(1px, -1px) rotate(4deg); }
  40%  { transform: translate(-1px, 1px) rotate(-3deg); }
  60%  { transform: translate(1px, 0px) rotate(3deg); }
  80%  { transform: translate(-1px, -1px) rotate(-4deg); }
  100% { transform: translate(0px, 0px) rotate(4deg); }
}
`
  document.head.appendChild(style)
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner(): React.ReactElement {
  return (
    <div
      style={{
        width: 14,
        height: 14,
        border: '2px solid rgba(255,255,255,0.2)',
        borderTopColor: '#ffffff',
        borderRadius: '50%',
        animation: 'aide-spin 0.8s linear infinite',
        flexShrink: 0
      }}
    />
  )
}

// ── Dialog button ─────────────────────────────────────────────────────────────

function DialogButton({
  label,
  onClick,
  primary,
  danger
}: {
  label: string
  onClick: () => void
  primary?: boolean
  danger?: boolean
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  let bg = hovered ? '#3d3d3d' : '#2d2d2d'
  if (primary) bg = hovered ? '#1177bb' : '#0e639c'
  if (danger) bg = hovered ? '#c0392b' : '#a93226'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '5px 14px',
        fontSize: 12,
        borderRadius: 3,
        cursor: 'pointer',
        border: '1px solid #555',
        background: bg,
        color: '#cccccc',
        flexShrink: 0
      }}
    >
      {label}
    </button>
  )
}

// ── Modal overlay wrapper ─────────────────────────────────────────────────────

function ModalOverlay({
  onBackdropClick,
  children
}: {
  onBackdropClick: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.55)'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdropClick()
      }}
    >
      {children}
    </div>
  )
}

// ── Splitter visual ───────────────────────────────────────────────────────────

function SplitterItem({ jiggle }: { jiggle: boolean }): React.ReactElement {
  return (
    <div
      style={{
        width: 1,
        height: 20,
        background: '#555',
        flexShrink: 0,
        margin: '0 4px',
        animation: jiggle ? 'aide-jiggle 0.5s ease-in-out infinite' : 'none'
      }}
    />
  )
}

// ── Single toolbar button ─────────────────────────────────────────────────────

interface ToolbarButtonItemProps {
  button: ToolbarButton
  running: boolean
  jiggle: boolean
  draggable?: boolean
  onClick: (btn: ToolbarButton) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}

function ToolbarButtonItem({
  button,
  running,
  jiggle,
  draggable: isDraggable,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: ToolbarButtonItemProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)

  const isImage =
    button.icon.startsWith('.') ||
    button.icon.startsWith('/') ||
    button.icon.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(button.icon)

  return (
    <button
      title={button.tooltip}
      onClick={() => onClick(button)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        width: 32,
        height: 32,
        background: hovered ? '#3d3d3d' : 'none',
        border: '1px solid transparent',
        borderRadius: 4,
        cursor: isDraggable ? 'grab' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        fontSize: 18,
        lineHeight: 1,
        flexShrink: 0,
        padding: 0,
        color: '#cccccc',
        transition: 'background 0.1s',
        animation: jiggle ? 'aide-jiggle 0.5s ease-in-out infinite' : 'none'
      }}
    >
      {isImage ? (
        <img src={button.icon} width={20} height={20} alt="" style={{ display: 'block' }} />
      ) : (
        <span style={{ userSelect: 'none' }}>{button.icon}</span>
      )}

      {running && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(30, 30, 30, 0.75)',
            borderRadius: 4
          }}
        >
          <Spinner />
        </div>
      )}
    </button>
  )
}

// ── Running process dialog ────────────────────────────────────────────────────

interface RunningDialogProps {
  button: ToolbarButton
  onKill: () => void
  onKillRestart: () => void
  onCancel: () => void
}

function RunningDialog({
  button,
  onKill,
  onKillRestart,
  onCancel
}: RunningDialogProps): React.ReactElement {
  return (
    <ModalOverlay onBackdropClick={onCancel}>
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          padding: '20px 24px',
          minWidth: 320,
          maxWidth: 420,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ color: '#cccccc', fontSize: 13, marginBottom: 20 }}>
          <strong style={{ color: '#ffffff' }}>&ldquo;{button.tooltip}&rdquo;</strong> is already
          running.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <DialogButton onClick={onKill} label="Kill" danger />
          <DialogButton onClick={onKillRestart} label="Kill & Restart" primary />
          <DialogButton onClick={onCancel} label="Cancel" />
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Scroll button ─────────────────────────────────────────────────────────────

function ScrollButton({
  direction,
  onClick
}: {
  direction: 'left' | 'right'
  onClick: () => void
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 22,
        height: 32,
        flexShrink: 0,
        background: hovered ? '#3d3d3d' : 'none',
        border: 'none',
        color: '#cccccc',
        cursor: 'pointer',
        fontSize: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        borderRadius: 3
      }}
    >
      {direction === 'left' ? '‹' : '›'}
    </button>
  )
}

// ── Button row used in dialogs ────────────────────────────────────────────────

function ButtonRow({
  button,
  checked,
  onChange
}: {
  button: ToolbarButton
  checked: boolean
  onChange: (id: string, checked: boolean) => void
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <label
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 8px',
        borderRadius: 4,
        cursor: 'pointer',
        background: hovered ? '#2a2a2a' : 'transparent',
        userSelect: 'none'
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(button.id, e.target.checked)}
        style={{ flexShrink: 0, accentColor: '#0e639c', width: 14, height: 14 }}
      />
      <span style={{ fontSize: 16, flexShrink: 0, width: 22, textAlign: 'center' }}>
        {button.icon}
      </span>
      <span style={{ color: '#cccccc', fontSize: 12, flex: 1, minWidth: 0 }}>
        {button.tooltip}
      </span>
      <span
        style={{
          color: '#555',
          fontSize: 11,
          fontFamily: 'monospace',
          flexShrink: 0,
          maxWidth: 160,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
        title={button.command}
      >
        {button.command}
      </span>
    </label>
  )
}

// ── Auto-detect dialog ────────────────────────────────────────────────────────

interface AutoDetectDialogProps {
  suggestedType: string
  presetGroups: ToolbarPresetGroup[]
  currentButtonIds: Set<string>
  onAddSelected: (buttons: ToolbarButton[]) => void
  onSkip: () => void
  onConfigureManually: () => void
}

function AutoDetectDialog({
  suggestedType,
  presetGroups,
  currentButtonIds,
  onAddSelected,
  onSkip,
  onConfigureManually
}: AutoDetectDialogProps): React.ReactElement {
  const group = presetGroups.find((g) => g.type === suggestedType)
  const label = group?.label ?? suggestedType
  const groupButtons = group?.buttons ?? []

  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(groupButtons.map((b) => b.id))
  )

  const toggle = (id: string, val: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      val ? next.add(id) : next.delete(id)
      return next
    })
  }

  const handleAdd = (): void => {
    // Keep existing buttons that are already in the toolbar, add newly checked ones
    const toAdd = groupButtons.filter((b) => checked.has(b.id) && !currentButtonIds.has(b.id))
    onAddSelected(toAdd)
  }

  return (
    <ModalOverlay onBackdropClick={onSkip}>
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          padding: '20px 24px',
          minWidth: 360,
          maxWidth: 480,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ color: '#ffffff', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          Detected {label} project
        </div>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>
          Add these buttons to your toolbar?
        </div>

        <div style={{ marginBottom: 16 }}>
          {groupButtons.map((btn) => (
            <ButtonRow
              key={btn.id}
              button={btn}
              checked={checked.has(btn.id)}
              onChange={toggle}
            />
          ))}
          {groupButtons.length === 0 && (
            <div style={{ color: '#666', fontSize: 12 }}>No buttons in this preset.</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          {/* Left: configure manually link */}
          <button
            onClick={onConfigureManually}
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              flex: 1,
              textAlign: 'left'
            }}
          >
            Configure manually…
          </button>
          {/* Right: action buttons */}
          <DialogButton onClick={handleAdd} label="Add Selected" primary />
          <DialogButton onClick={onSkip} label="Skip (don't ask again)" />
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Preset manager dialog ─────────────────────────────────────────────────────

interface CliToolInfo {
  id: string
  name: string
}

interface PresetDialogProps {
  presetGroups: ToolbarPresetGroup[]
  currentButtons: ToolbarItem[]
  onSave: (buttons: ToolbarItem[]) => void
  onCancel: () => void
}

function PresetDialog({
  presetGroups,
  currentButtons,
  onSave,
  onCancel
}: PresetDialogProps): React.ReactElement {
  const [cliTools, setCliTools] = useState<CliToolInfo[]>([])
  const [aiPrompt, setAiPrompt] = useState('')
  const [selectedToolIdx, setSelectedToolIdx] = useState(0)
  const [showToolDropdown, setShowToolDropdown] = useState(false)


  useEffect(() => {
    window.editorApi.getCliTools().then((tools) => {
      setCliTools(tools)
    })
  }, [])

  const handleAskTool = (): void => {
    const tool = cliTools[selectedToolIdx]
    if (!tool || !aiPrompt.trim()) return
    const prompt = `Please read .aide/docs/toolbar.md to understand the toolbar configuration format, then help with:\n\n${aiPrompt.trim()}`
    window.editorApi.terminalCreateWithPrompt(tool.id, prompt)
    onCancel()
  }

  // Only actual buttons (not splitters) for preset matching
  const currentRealButtons = currentButtons.filter(
    (item): item is ToolbarButton => !isSplitter(item)
  )

  // Build the full list: preset buttons + any current buttons not in any preset
  const presetButtonIds = new Set(presetGroups.flatMap((g) => g.buttons.map((b) => b.id)))

  // Buttons currently in the toolbar that aren't covered by any preset group
  const extraButtons = currentRealButtons.filter((b) => !presetButtonIds.has(b.id))

  // Start checked: all buttons currently in toolbar
  const currentIds = new Set(currentRealButtons.map((b) => b.id))
  const [checked, setChecked] = useState<Set<string>>(() => new Set(currentIds))

  const toggle = (id: string, val: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      val ? next.add(id) : next.delete(id)
      return next
    })
  }

  const handleSave = (): void => {
    // Build result preserving existing order (including splitters)
    const result: ToolbarItem[] = []
    const added = new Set<string>()

    // Walk current items: keep checked buttons and splitters in their positions
    for (const item of currentButtons) {
      if (isSplitter(item)) {
        result.push(item)
      } else if (checked.has(item.id)) {
        result.push(item)
        added.add(item.id)
      }
    }
    // Newly checked preset buttons (not already added)
    for (const g of presetGroups) {
      for (const b of g.buttons) {
        if (checked.has(b.id) && !added.has(b.id)) {
          result.push(b)
          added.add(b.id)
        }
      }
    }

    onSave(result)
  }

  return (
    <ModalOverlay onBackdropClick={onCancel}>
      <div
        style={{
          background: '#252526',
          border: '1px solid #454545',
          borderRadius: 6,
          padding: '20px 24px',
          width: 520,
          maxHeight: '75vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ color: '#ffffff', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          Toolbar Buttons
        </div>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>
          Check the buttons you want in the toolbar. Uncheck to remove.
        </div>

        {/* Scrollable list */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* Extra (non-preset) buttons that are already installed */}
          {extraButtons.length > 0 && (
            <>
              <div
                style={{
                  color: '#888',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  padding: '6px 8px 4px',
                  borderBottom: '1px solid #333',
                  marginBottom: 4
                }}
              >
                Other
              </div>
              {extraButtons.map((btn) => (
                <ButtonRow
                  key={btn.id}
                  button={btn}
                  checked={checked.has(btn.id)}
                  onChange={toggle}
                />
              ))}
            </>
          )}

          {/* Preset groups */}
          {presetGroups.map((group) => (
            <div key={group.type}>
              <div
                style={{
                  color: '#888',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  padding: '6px 8px 4px',
                  borderBottom: '1px solid #333',
                  marginBottom: 4,
                  marginTop: 8
                }}
              >
                {group.label}
              </div>
              {group.buttons.map((btn) => (
                <ButtonRow
                  key={btn.id}
                  button={btn}
                  checked={checked.has(btn.id)}
                  onChange={toggle}
                />
              ))}
            </div>
          ))}
        </div>

        {/* AI helper section */}
        {cliTools.length > 0 && (
          <div
            style={{
              borderTop: '1px solid #333',
              marginTop: 16,
              paddingTop: 12
            }}
          >
            <div style={{ color: '#888', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              AI Helper
            </div>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Describe what you want to add or change in the toolbar..."
              style={{
                width: '100%',
                height: 60,
                background: '#1e1e1e',
                border: '1px solid #444',
                borderRadius: 4,
                color: '#cccccc',
                fontSize: 12,
                padding: '6px 8px',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box'
              }}
            />
            <div style={{ display: 'flex', gap: 0, marginTop: 8, position: 'relative' }}>
              {/* Main button */}
              <button
                onClick={handleAskTool}
                disabled={!aiPrompt.trim()}
                style={{
                  padding: '5px 14px',
                  fontSize: 12,
                  borderRadius: cliTools.length > 1 ? '3px 0 0 3px' : 3,
                  cursor: aiPrompt.trim() ? 'pointer' : 'default',
                  border: '1px solid #555',
                  background: aiPrompt.trim() ? '#0e639c' : '#2d2d2d',
                  color: aiPrompt.trim() ? '#ffffff' : '#666',
                  flexShrink: 0
                }}
              >
                Ask {cliTools[selectedToolIdx]?.name ?? 'AI'}
              </button>
              {/* Dropdown arrow (only if multiple tools) */}
              {cliTools.length > 1 && (
                <button
                  onClick={() => setShowToolDropdown(!showToolDropdown)}
                  style={{
                    padding: '5px 6px',
                    fontSize: 10,
                    borderRadius: '0 3px 3px 0',
                    cursor: 'pointer',
                    border: '1px solid #555',
                    borderLeft: 'none',
                    background: showToolDropdown ? '#1177bb' : '#0e639c',
                    color: '#ffffff',
                    flexShrink: 0
                  }}
                >
                  ▾
                </button>
              )}
              {/* Dropdown menu */}
              {showToolDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 2,
                    background: '#252526',
                    border: '1px solid #454545',
                    borderRadius: 4,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                    zIndex: 10,
                    minWidth: 140
                  }}
                >
                  {cliTools.map((tool, idx) => (
                    <button
                      key={tool.id}
                      onClick={() => {
                        setSelectedToolIdx(idx)
                        setShowToolDropdown(false)
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '6px 12px',
                        fontSize: 12,
                        background: idx === selectedToolIdx ? '#0e639c' : 'transparent',
                        color: '#cccccc',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      {tool.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 16 }}>
          <button
            onClick={() => { onSave([...currentButtons, { type: 'splitter' as const }]); }}
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              marginRight: 'auto'
            }}
          >
            Add splitter
          </button>
          <DialogButton onClick={handleSave} label="Save" primary />
          <DialogButton onClick={onCancel} label="Cancel" />
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Main toolbar ──────────────────────────────────────────────────────────────

export default function MainToolbar(): React.ReactElement {
  const {
    buttons,
    runningButtonIds,
    suggestedType,
    showAutoDetectDialog,
    showPresetDialog,
    editMode,
    setButtons,
    markRunning,
    markStopped,
    setProjectType,
    setSuggestedType,
    setShowAutoDetectDialog,
    setShowPresetDialog,
    setEditMode
  } = useToolbarStore()

  const [runningDialog, setRunningDialog] = useState<ToolbarButton | null>(null)
  const [presetGroups, setPresetGroups] = useState<ToolbarPresetGroup[]>([])
  const stripRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const dragIndexRef = useRef<number | null>(null)
  const buttonsRef = useRef<ToolbarItem[]>(buttons)
  const completeSoundsRef = useRef<SoundNote[]>([])
  const errorSoundsRef = useRef<SoundNote[]>([])

  // Keep buttonsRef current for use inside stable useEffect callbacks
  useEffect(() => {
    buttonsRef.current = buttons
  }, [buttons])

  // ── Style injection ──
  useEffect(() => {
    injectStyles()
  }, [])

  // ── Escape exits edit mode ──
  useEffect(() => {
    if (!editMode) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditMode(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editMode, setEditMode])

  // ── Load toolbar info + presets + IPC subscriptions ──
  useEffect(() => {
    window.editorApi.getToolbarInfo().then((info) => {
      setButtons(info.buttons)
      setProjectType(info.projectType)
      setSuggestedType(info.suggestedType)
      if (info.suggestedType !== null) {
        setShowAutoDetectDialog(true)
      }
    })

    window.editorApi.getConfig().then((cfg) => {
      completeSoundsRef.current = cfg.toolbar?.sounds?.complete ?? []
      errorSoundsRef.current = cfg.toolbar?.sounds?.error ?? []
    })

    window.editorApi.getToolbarPresets().then(setPresetGroups)

    const unsubConfigUpdated = window.editorApi.onToolbarConfigUpdated((newButtons) => {
      setButtons(newButtons)
    })

    const unsubOutput = window.editorApi.onToolbarOutput(({ channelName, line, attention, flash }) => {
      logManager.append(channelName, line, attention, flash)
    })
    const unsubStarted = window.editorApi.onToolbarProcessStarted(({ buttonId, clearChannels }) => {
      markRunning(buttonId)
      if (clearChannels) {
        for (const ch of clearChannels) logManager.clear(ch)
      }
    })
    const unsubExited = window.editorApi.onToolbarProcessExited(({ buttonId, exitCode }) => {
      markStopped(buttonId)
      const btn = buttonsRef.current.find(
        (item): item is ToolbarButton => !isSplitter(item) && item.id === buttonId
      )
      if (btn?.sound) {
        const failed = exitCode !== null && exitCode !== 0
        const notes = failed ? errorSoundsRef.current : completeSoundsRef.current
        if (notes.length > 0) playMelody(notes)
      }
    })

    return () => {
      unsubConfigUpdated()
      unsubOutput()
      unsubStarted()
      unsubExited()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Overflow detection ──
  const updateOverflow = useCallback(() => {
    const el = stripRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateOverflow()
    const el = stripRef.current
    if (!el) return
    el.addEventListener('scroll', updateOverflow)
    const ro = new ResizeObserver(updateOverflow)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateOverflow)
      ro.disconnect()
    }
  }, [buttons, updateOverflow])

  // ── Button click handler ──
  const handleButtonClick = async (button: ToolbarButton): Promise<void> => {
    if (editMode) return // In edit mode, clicks don't run commands
    if (runningButtonIds.has(button.id)) {
      setRunningDialog(button)
    } else {
      await window.editorApi.toolbarRunButton(button.id)
    }
  }

  const handleKill = async (): Promise<void> => {
    if (!runningDialog) return
    await window.editorApi.toolbarKillButton(runningDialog.id)
    setRunningDialog(null)
  }

  const handleKillRestart = async (): Promise<void> => {
    if (!runningDialog) return
    await window.editorApi.toolbarKillRestartButton(runningDialog.id)
    setRunningDialog(null)
  }

  // ── Drag & drop reorder ──
  const handleDragStart = (index: number, e: React.DragEvent): void => {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    // Use a transparent drag image to avoid the default ghost
    const el = e.currentTarget as HTMLElement
    e.dataTransfer.setDragImage(el, 16, 16)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = async (targetIndex: number): Promise<void> => {
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (fromIndex === null || fromIndex === targetIndex) return

    const newItems = [...buttons]
    const [moved] = newItems.splice(fromIndex, 1)
    newItems.splice(targetIndex, 0, moved)

    setButtons(newItems)
    await window.editorApi.toolbarSaveButtons(newItems)
  }

  const handleDragEnd = (): void => {
    dragIndexRef.current = null
  }

  const handleDropToTrash = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    const fromIndex = dragIndexRef.current
    dragIndexRef.current = null
    if (fromIndex === null) return
    const newItems = [...buttons]
    newItems.splice(fromIndex, 1)
    setButtons(newItems)
    await window.editorApi.toolbarSaveButtons(newItems)
  }

  // ── Auto-detect: user clicks "Add Selected" ──
  const handleAutoDetectAdd = async (newButtons: ToolbarButton[]): Promise<void> => {
    const merged = [...buttons, ...newButtons]
    const updated = await window.editorApi.toolbarSaveButtons(merged)
    setButtons(updated)
    await window.editorApi.toolbarSetProjectType(suggestedType ?? '')
    setProjectType(suggestedType ?? '')
    setSuggestedType(null)
    setShowAutoDetectDialog(false)
  }

  // ── Auto-detect: user skips ──
  const handleAutoDetectSkip = async (): Promise<void> => {
    await window.editorApi.toolbarSetProjectType('dismissed')
    setProjectType('dismissed')
    setSuggestedType(null)
    setShowAutoDetectDialog(false)
  }

  // ── Auto-detect: user wants manual configuration ──
  const handleAutoDetectConfigureManually = async (): Promise<void> => {
    await window.editorApi.toolbarSetProjectType('dismissed')
    setProjectType('dismissed')
    setSuggestedType(null)
    setShowAutoDetectDialog(false)
    setShowPresetDialog(true)
  }

  // ── Preset dialog: save ──
  const handlePresetSave = async (selectedButtons: ToolbarItem[]): Promise<void> => {
    const updated = await window.editorApi.toolbarSaveButtons(selectedButtons)
    setButtons(updated)
    setShowPresetDialog(false)
  }

  // ── Edit mode: open preset dialog + exit edit mode ──
  const handleAddInEditMode = (): void => {
    setEditMode(false)
    setShowPresetDialog(true)
  }

  // Collect button IDs for auto-detect
  const currentButtonIds = new Set(
    buttons.filter((b): b is ToolbarButton => !isSplitter(b)).map((b) => b.id)
  )

  return (
    <>
      <div
        style={{
          height: 36,
          flexShrink: 0,
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d',
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          paddingLeft: canScrollLeft ? 0 : 4,
          paddingRight: 4,
          gap: 0
        }}
      >
        {canScrollLeft && (
          <ScrollButton
            direction="left"
            onClick={() => stripRef.current?.scrollBy({ left: -120 })}
          />
        )}

        {/* Scrollable button strip */}
        <div
          ref={stripRef}
          style={{
            display: 'flex',
            flex: 1,
            overflow: 'hidden',
            gap: 4,
            alignItems: 'center',
            paddingLeft: canScrollLeft ? 4 : 0,
            paddingRight: canScrollRight ? 4 : 0
          }}
        >
          {buttons.map((item, index) => {
            if (isSplitter(item)) {
              return (
                <div
                  key={`splitter-${index}`}
                  draggable={editMode}
                  onDragStart={(e) => handleDragStart(index, e)}
                  onDragOver={handleDragOver}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  style={{ display: 'flex', alignItems: 'center', cursor: editMode ? 'grab' : 'default' }}
                >
                  <SplitterItem jiggle={editMode} />
                </div>
              )
            }
            return (
              <ToolbarButtonItem
                key={item.id}
                button={item}
                running={runningButtonIds.has(item.id)}
                jiggle={editMode}
                draggable={editMode}
                onClick={handleButtonClick}
                onDragStart={(e) => handleDragStart(index, e)}
                onDragOver={handleDragOver}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
              />
            )
          })}

          {/* "+" button appears inside the strip only in edit mode */}
          {editMode && <AddButton onClick={handleAddInEditMode} />}
        </div>

        {canScrollRight && (
          <ScrollButton
            direction="right"
            onClick={() => stripRef.current?.scrollBy({ left: 120 })}
          />
        )}

        {/* Trash drop zone — only in edit mode, next to edit button */}
        {editMode && (
          <TrashDropZone
            onDragOver={handleDragOver}
            onDrop={handleDropToTrash}
          />
        )}

        {/* Edit mode toggle — always at the right end, outside scroll strip */}
        <EditModeButton
          active={editMode}
          onClick={() => setEditMode(!editMode)}
        />
      </div>

      {/* Running process dialog */}
      {runningDialog && (
        <RunningDialog
          button={runningDialog}
          onKill={handleKill}
          onKillRestart={handleKillRestart}
          onCancel={() => setRunningDialog(null)}
        />
      )}

      {/* Auto-detect dialog */}
      {showAutoDetectDialog && suggestedType !== null && (
        <AutoDetectDialog
          suggestedType={suggestedType}
          presetGroups={presetGroups}
          currentButtonIds={currentButtonIds}
          onAddSelected={handleAutoDetectAdd}
          onSkip={handleAutoDetectSkip}
          onConfigureManually={handleAutoDetectConfigureManually}
        />
      )}

      {/* Preset manager dialog */}
      {showPresetDialog && (
        <PresetDialog
          presetGroups={presetGroups}
          currentButtons={buttons}
          onSave={handlePresetSave}
          onCancel={() => setShowPresetDialog(false)}
        />
      )}
    </>
  )
}

// ── Edit mode button (replaces the old "+" button) ───────────────────────────

function EditModeButton({
  active,
  onClick
}: {
  active: boolean
  onClick: () => void
}): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title={active ? 'Exit edit mode' : 'Edit toolbar'}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        background: active ? '#0e639c' : hovered ? '#3d3d3d' : 'none',
        border: '1px solid',
        borderColor: active ? '#0e639c' : hovered ? '#555' : '#444',
        borderRadius: 4,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        color: active ? '#ffffff' : '#888',
        padding: 0,
        marginLeft: 2,
        transition: 'background 0.1s, color 0.1s'
      }}
    >
      ✏
    </button>
  )
}

// ── Add button (shown in edit mode inside the strip) ─────────────────────────

function AddButton({ onClick }: { onClick: () => void }): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      title="Add toolbar buttons"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        background: hovered ? '#3d3d3d' : 'none',
        border: '1px solid',
        borderColor: hovered ? '#555' : '#444',
        borderRadius: 4,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 16,
        color: '#888',
        padding: 0,
        marginLeft: 2,
        transition: 'background 0.1s, color 0.1s'
      }}
    >
      +
    </button>
  )
}

// ── Trash drop zone (shown in edit mode next to edit button) ─────────────────

function TrashDropZone({
  onDragOver,
  onDrop
}: {
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}): React.ReactElement {
  const [dragOver, setDragOver] = useState(false)
  return (
    <div
      title="Drop here to remove"
      onDragOver={(e) => { onDragOver(e); setDragOver(true) }}
      onDragEnter={() => setDragOver(true)}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { setDragOver(false); onDrop(e) }}
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        background: dragOver ? '#a93226' : '#3d3d3d',
        border: '1px solid',
        borderColor: dragOver ? '#c0392b' : '#555',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        color: dragOver ? '#ffffff' : '#888',
        marginLeft: 2,
        transition: 'background 0.15s, border-color 0.15s, color 0.15s'
      }}
    >
      🗑
    </div>
  )
}
