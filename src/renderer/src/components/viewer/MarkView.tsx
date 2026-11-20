import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { moveMark, nextUserId, type Mark, type MarkType } from '../../../../shared/viewer/marks'

/**
 * An image with a marks layer (docs/file-viewer-spec.md, "Marks on images"). Marks are kept
 * in image units (natural pixels, or viewBox units of an SVG); the layer is an SVG with the
 * same viewBox laid exactly over the image.
 */

export type MarkTool = 'select' | MarkType

export interface MarkViewHandle {
  /** A PNG data URL of the image with the marks drawn on it (raster images), or null. */
  snapshot: () => Promise<string | null>
  units: () => string
}

interface Box { x: number; y: number; w: number; h: number }

const COLORS = { user: '#ff9f1a', agent: '#4fc1ff' }

/** The SVG text of a data URL, when the image is an SVG. */
function svgText(src: string): string | null {
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(src)
  if (!m) return null
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** viewBox of an SVG (or 0 0 width height); null when it has neither. */
function svgBox(text: string): Box | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.tagName.toLowerCase() !== 'svg') return null
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }
  const w = parseFloat(root.getAttribute('width') ?? '')
  const h = parseFloat(root.getAttribute('height') ?? '')
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null
}

function MarkShape({ m, unit, selected }: { m: Mark; unit: number; selected: boolean }): React.ReactElement {
  const color = COLORS[m.by]
  const sw = (selected ? 3.5 : 2.5) * unit
  const hit = { stroke: 'transparent', strokeWidth: 12 * unit, fill: 'none', pointerEvents: 'stroke' as const }
  const common = { 'data-mark-id': m.id, style: { cursor: 'move' } }
  const label = (x: number, y: number, text: string | undefined, size = 13): React.ReactElement | null =>
    text ? (
      <text x={x} y={y} fill={color} fontSize={size * unit} fontFamily="Segoe UI, sans-serif" fontWeight={600}
        stroke="#000" strokeWidth={3 * unit} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{text}</text>
    ) : null
  switch (m.type) {
    case 'text':
      return (
        <g {...common}>
          <text x={m.x} y={m.y} fill={color} fontSize={16 * unit} fontFamily="Segoe UI, sans-serif" fontWeight={600}
            stroke="#000" strokeWidth={3 * unit} paintOrder="stroke" dominantBaseline="hanging"
            textDecoration={selected ? 'underline' : undefined}>
            {/* SVG text does not wrap: one tspan per line. */}
            {(m.text || 'Text…').split('\n').map((line, i) => (
              <tspan key={i} x={m.x} dy={i === 0 ? 0 : 20 * unit}>{line || ' '}</tspan>
            ))}
          </text>
        </g>
      )
    case 'arrow':
    case 'line':
      return (
        <g {...common}>
          <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} {...hit} />
          <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={color} strokeWidth={sw} strokeLinecap="round"
            markerEnd={m.type === 'arrow' ? `url(#vm-arrow-${m.by})` : undefined} />
          {label(m.x2 + 6 * unit, m.y2 + 4 * unit, m.note)}
        </g>
      )
    case 'rect':
      return (
        <g {...common}>
          <rect x={m.x} y={m.y} width={m.w} height={m.h} {...hit} />
          <rect x={m.x} y={m.y} width={m.w} height={m.h} fill="none" stroke={color} strokeWidth={sw} />
          {label(m.x, m.y - 5 * unit, m.note)}
        </g>
      )
    case 'ellipse':
      return (
        <g {...common}>
          <ellipse cx={m.x + m.w / 2} cy={m.y + m.h / 2} rx={Math.abs(m.w / 2)} ry={Math.abs(m.h / 2)} {...hit} />
          <ellipse cx={m.x + m.w / 2} cy={m.y + m.h / 2} rx={Math.abs(m.w / 2)} ry={Math.abs(m.h / 2)} fill="none" stroke={color} strokeWidth={sw} />
          {label(m.x, m.y - 5 * unit, m.note)}
        </g>
      )
  }
}

interface Props {
  src: string
  alt: string
  marks: Mark[]
  tool: MarkTool
  selectedId: string | null
  onChange: (marks: Mark[]) => void
  onSelect: (id: string | null) => void
}

type Drag =
  | { kind: 'draw'; id: string; x0: number; y0: number }
  | { kind: 'move'; id: string; x0: number; y0: number; start: Mark }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }

interface Pt { x: number; y: number }

const r2 = (v: number): number => Math.round(v * 100) / 100

/** Normalized rect from two corners. */
function corners(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  return { x: r2(Math.min(x0, x1)), y: r2(Math.min(y0, y1)), w: r2(Math.abs(x1 - x0)), h: r2(Math.abs(y1 - y0)) }
}

/** Points other marks and the image offer to snap to. */
function snapPoints(marks: Mark[], skip: string, box: Box): Pt[] {
  const pts: Pt[] = [
    { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x, y: box.y + box.h }, { x: box.x + box.w, y: box.y + box.h },
    { x: box.x + box.w / 2, y: box.y }, { x: box.x + box.w / 2, y: box.y + box.h }, { x: box.x, y: box.y + box.h / 2 }, { x: box.x + box.w, y: box.y + box.h / 2 },
    { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  ]
  for (const m of marks) {
    if (m.id === skip) continue
    if (m.type === 'text') pts.push({ x: m.x, y: m.y })
    else if (m.type === 'arrow' || m.type === 'line') pts.push({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 })
    else if (m.type === 'rect' || m.type === 'ellipse') {
      const xs = [m.x, m.x + m.w / 2, m.x + m.w]
      const ys = [m.y, m.y + m.h / 2, m.y + m.h]
      for (const x of xs) for (const y of ys) pts.push({ x, y })
    }
  }
  return pts
}

/** The point snapped to the nearest snap point within `radius`, or as it is. */
function snapTo(p: Pt, pts: Pt[], radius: number): { p: Pt; hit: boolean } {
  let best: Pt | null = null
  let bestD = radius
  for (const q of pts) {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= bestD) { best = q; bestD = d }
  }
  return best ? { p: { x: r2(best.x), y: r2(best.y) }, hit: true } : { p, hit: false }
}

/** Shift: a line keeps to 45° steps. */
function constrainAngle(x0: number, y0: number, p: Pt): Pt {
  const dx = p.x - x0
  const dy = p.y - y0
  const len = Math.hypot(dx, dy)
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: r2(x0 + Math.cos(a) * len), y: r2(y0 + Math.sin(a) * len) }
}

/** Shift: a rectangle or ellipse becomes a square or circle. */
function constrainSquare(x0: number, y0: number, p: Pt): Pt {
  const s = Math.max(Math.abs(p.x - x0), Math.abs(p.y - y0))
  return { x: x0 + Math.sign(p.x - x0 || 1) * s, y: y0 + Math.sign(p.y - y0 || 1) * s }
}

/** The anchor of a mark that snaps while it is moved. */
function anchorOf(m: Mark): Pt {
  return 'x1' in m ? { x: m.x1, y: m.y1 } : { x: m.x, y: m.y }
}

const MIN_ZOOM = 0.2
const MAX_ZOOM = 40
const SNAP_PX = 8

export const MarkView = forwardRef<MarkViewHandle, Props>(function MarkView({ src, alt, marks, tool, selectedId, onChange, onSelect }, ref) {
  const svg = useMemo(() => svgText(src), [src])
  const svgViewBox = useMemo(() => (svg ? svgBox(svg) : null), [svg])
  const [natural, setNatural] = useState<Box | null>(null)
  const box = svgViewBox ?? natural

  const frameRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<SVGSVGElement>(null)
  const marksLayerRef = useRef<SVGGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [frame, setFrame] = useState({ w: 0, h: 0 })
  /** Zoom relative to "fit", and the pan offset in screen px. */
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 })
  const [snapMark, setSnapMark] = useState<Pt | null>(null)
  const drag = useRef<Drag | null>(null)
  const spaceDown = useRef(false)
  const marksRef = useRef(marks)
  marksRef.current = marks

  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFrame({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setFrame({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setNatural(null)
    setView({ zoom: 1, panX: 0, panY: 0 })
  }, [src])

  const pad = 16
  const fit = box && frame.w > 0 ? Math.min((frame.w - 2 * pad) / box.w, (frame.h - 2 * pad) / box.h) : 0
  const scale = fit * view.zoom
  const dw = box ? box.w * scale : 0
  const dh = box ? box.h * scale : 0
  /** Where the image's top-left corner is in the frame. */
  const ox = (frame.w - dw) / 2 + view.panX
  const oy = (frame.h - dh) / 2 + view.panY
  /** Image units per screen pixel: strokes and fonts keep their screen size. */
  const unit = scale > 0 ? 1 / scale : 1

  const setZoomAround = (zoom: number, cx: number, cy: number): void => {
    if (!box || fit <= 0) return
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    const s1 = fit * z
    // Keep the image point under (cx, cy) where it is.
    const ux = (cx - ox) / scale
    const uy = (cy - oy) / scale
    const nox = cx - ux * s1
    const noy = cy - uy * s1
    setView({ zoom: z, panX: nox - (frame.w - box.w * s1) / 2, panY: noy - (frame.h - box.h * s1) / 2 })
  }
  const fitView = (): void => setView({ zoom: 1, panX: 0, panY: 0 })
  const actualSize = (): void => { if (fit > 0) setZoomAround(1 / fit, frame.w / 2, frame.h / 2) }

  const toUnits = (e: { clientX: number; clientY: number }): Pt => {
    const ctm = overlayRef.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: r2(p.x), y: r2(p.y) }
  }

  const update = (id: string, f: (m: Mark) => Mark): void => {
    onChange(marksRef.current.map((m) => (m.id === id ? f(m) : m)))
  }

  // Space held: drag pans. 0: fit, 1: actual size.
  useEffect(() => {
    const typing = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement
      return t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'
    }
    const down = (e: KeyboardEvent): void => {
      if (typing(e) || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.code === 'Space') { spaceDown.current = true; e.preventDefault() }
      if (e.key === '0') fitView()
      if (e.key === '1') actualSize()
    }
    const up = (e: KeyboardEvent): void => { if (e.code === 'Space') spaceDown.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  })

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return
    setZoomAround(view.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
  }

  /** A point while drawing or moving: snapped unless Alt, constrained with Shift. */
  const placed = (raw: Pt, e: { altKey: boolean }, skip: string): Pt => {
    if (e.altKey || !box) { setSnapMark(null); return raw }
    const s = snapTo(raw, snapPoints(marksRef.current, skip, box), SNAP_PX * unit)
    setSnapMark(s.hit ? s.p : null)
    return s.p
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!box) return
    const pan = e.button === 1 || (e.button === 0 && spaceDown.current)
    const markEl = (e.target as Element).closest('[data-mark-id]')
    if (pan || (e.button === 0 && tool === 'select' && !markEl)) {
      if (!pan) onSelect(null)
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view.panX, py: view.panY }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    const p = toUnits(e)
    if (tool === 'select' || markEl) {
      const id = markEl?.getAttribute('data-mark-id') ?? null
      onSelect(id)
      const start = id ? marksRef.current.find((m) => m.id === id) : undefined
      if (start) {
        drag.current = { kind: 'move', id: start.id, x0: p.x, y0: p.y, start }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      return
    }
    const id = nextUserId(marksRef.current)
    const q = placed(p, e, id)
    let mark: Mark
    if (tool === 'text') mark = { id, by: 'user', type: 'text', x: q.x, y: q.y, text: '' }
    else if (tool === 'arrow' || tool === 'line') mark = { id, by: 'user', type: tool, x1: q.x, y1: q.y, x2: q.x, y2: q.y }
    else mark = { id, by: 'user', type: tool, x: q.x, y: q.y, w: 0, h: 0 }
    onChange([...marksRef.current, mark])
    onSelect(id)
    if (tool !== 'text') {
      drag.current = { kind: 'draw', id, x0: q.x, y0: q.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    } else setSnapMark(null)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, panX: d.px + e.clientX - d.sx, panY: d.py + e.clientY - d.sy }))
      return
    }
    const p = toUnits(e)
    if (d.kind === 'move') {
      // The mark's anchor snaps; the rest moves with it.
      const a = anchorOf(d.start)
      const target = placed({ x: a.x + p.x - d.x0, y: a.y + p.y - d.y0 }, e, d.id)
      const moved = moveMark(d.start, target.x - a.x, target.y - a.y)
      update(d.id, () => (d.start.by === 'user' ? { ...moved, moved: undefined } : moved))
      return
    }
    update(d.id, (m) => {
      if (m.type === 'arrow' || m.type === 'line') {
        const q = e.shiftKey ? constrainAngle(d.x0, d.y0, p) : placed(p, e, d.id)
        if (e.shiftKey) setSnapMark(null)
        return { ...m, x2: r2(q.x), y2: r2(q.y) }
      }
      if (m.type === 'rect' || m.type === 'ellipse') {
        const q = e.shiftKey ? constrainSquare(d.x0, d.y0, p) : placed(p, e, d.id)
        if (e.shiftKey) setSnapMark(null)
        return { ...m, ...corners(d.x0, d.y0, q.x, q.y) }
      }
      return m
    })
  }

  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    setSnapMark(null)
    if (!d || d.kind !== 'draw') return
    // A click without a drag draws nothing.
    const m = marksRef.current.find((x) => x.id === d.id)
    if (!m) return
    const tiny = 4 * unit
    const small = m.type === 'arrow' || m.type === 'line'
      ? Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < tiny
      : m.type === 'rect' || m.type === 'ellipse' ? m.w < tiny || m.h < tiny : false
    if (small) {
      onChange(marksRef.current.filter((x) => x.id !== d.id))
      onSelect(null)
    }
  }

  useImperativeHandle(ref, () => ({
    units: () => (svgViewBox ? 'viewBox units' : 'image pixels'),
    snapshot: async () => {
      if (svgViewBox || !box || !overlayRef.current || !imgRef.current || !marksLayerRef.current) return null
      // The picture covers the image and every mark, labels included.
      const bb = marksLayerRef.current.getBBox()
      const margin = 8 * unit
      const minX = Math.floor(Math.min(box.x, bb.width ? bb.x - margin : box.x))
      const minY = Math.floor(Math.min(box.y, bb.height ? bb.y - margin : box.y))
      const maxX = Math.ceil(Math.max(box.x + box.w, bb.width ? bb.x + bb.width + margin : 0))
      const maxY = Math.ceil(Math.max(box.y + box.h, bb.height ? bb.y + bb.height + margin : 0))
      const W = maxX - minX
      const H = maxY - minY
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.fillStyle = '#1e1e1e'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(imgRef.current, box.x - minX, box.y - minY, box.w, box.h)
      const layer = overlayRef.current.cloneNode(true) as SVGSVGElement
      layer.querySelectorAll('.vm-ground, .vm-snap').forEach((el) => el.remove())
      layer.setAttribute('viewBox', `${minX} ${minY} ${W} ${H}`)
      layer.setAttribute('width', String(W))
      layer.setAttribute('height', String(H))
      layer.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      layer.removeAttribute('style')
      const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(layer))))}`
      const img = new Image()
      await new Promise<void>((done, fail) => { img.onload = () => done(); img.onerror = () => fail(new Error('marks layer')); img.src = url })
      ctx.drawImage(img, 0, 0, W, H)
      return canvas.toDataURL('image/png')
    }
  }), [svgViewBox, box, unit])

  const zoomPct = box ? Math.round(scale * 100) : 0

  return (
    <div ref={frameRef} className="vm-frame" onWheel={onWheel}>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="vm-measure"
        draggable={false}
        onLoad={(e) => {
          const im = e.currentTarget
          if (!svgViewBox) setNatural({ x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight })
        }}
        style={box ? { left: ox, top: oy, width: dw, height: dh } : { visibility: 'hidden' }}
      />
      {box && frame.w > 0 && (
        <svg
          ref={overlayRef}
          className={`vm-overlay tool-${tool}`}
          viewBox={`${box.x - ox * unit} ${box.y - oy * unit} ${frame.w * unit} ${frame.h * unit}`}
          style={{ left: 0, top: 0, width: frame.w, height: frame.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <defs>
            {(['user', 'agent'] as const).map((by) => (
              <marker key={by} id={`vm-arrow-${by}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={COLORS[by]} />
              </marker>
            ))}
          </defs>
          {/* Transparent ground over the whole frame: marks may go beyond the image. */}
          <rect className="vm-ground" x={box.x - ox * unit} y={box.y - oy * unit} width={frame.w * unit} height={frame.h * unit} fill="transparent" />
          <g ref={marksLayerRef}>
            {marks.map((m) => <MarkShape key={m.id} m={m} unit={unit} selected={m.id === selectedId} />)}
          </g>
          {snapMark && (
            <circle className="vm-snap" cx={snapMark.x} cy={snapMark.y} r={5 * unit} fill="none" stroke="#fff" strokeWidth={1.5 * unit} style={{ pointerEvents: 'none' }} />
          )}
        </svg>
      )}
      <div className="vm-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button title="Zoom out" onClick={() => setZoomAround(view.zoom / 1.25, frame.w / 2, frame.h / 2)}>−</button>
        <button title="Actual size (1)" onClick={actualSize}>{zoomPct}%</button>
        <button title="Zoom in" onClick={() => setZoomAround(view.zoom * 1.25, frame.w / 2, frame.h / 2)}>+</button>
        <button title="Fit to window (0)" onClick={fitView}>Fit</button>
      </div>
    </div>
  )
})

export const MARK_TOOLS: Array<{ tool: MarkTool; label: string; key: string }> = [
  { tool: 'select', label: 'Select', key: 'v' },
  { tool: 'text', label: 'Text', key: 't' },
  { tool: 'arrow', label: 'Arrow', key: 'a' },
  { tool: 'line', label: 'Line', key: 'l' },
  { tool: 'rect', label: 'Rectangle', key: 'r' },
  { tool: 'ellipse', label: 'Ellipse', key: 'e' }
]
