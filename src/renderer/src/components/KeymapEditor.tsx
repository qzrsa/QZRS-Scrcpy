import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { KeymapBinding, KeymapConfig, KeymapOverlay, KeymapAction } from '@shared/types'
import { normalizeKeyCode } from '../keycodes'

interface Props {
  keymap: KeymapConfig
  /** .mirror-wrap element used as the coordinate reference */
  containerRef: React.RefObject<HTMLElement | null>
  /** the actual video canvas element whose rendered rect we align to */
  videoRef: React.RefObject<HTMLElement | null>
  onChange: (k: KeymapConfig) => void
  onClose: () => void
}

/** Radius of the WASD pad from center to each direction key. */
const WASD_RADIUS = 0.06

const newId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const emptyBinding = (key: string, action: KeymapAction): KeymapBinding => ({
  id: newId('b'),
  key,
  action,
  x: 0.5,
  y: 0.5,
  x2: 0.5,
  y2: 0.5,
  duration: 0,
  viewDx: 0,
  viewDy: 0,
  repeatMs: 100,
  keycode: 0,
  label: '',
  groupId: null
})

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

type ToolType =
  | { id: 'wasd' }
  | { id: 'binding'; action: KeymapAction; label: string }
  | { id: 'overlay'; label: string }

const PALETTE: { icon: string; label: string; tool: ToolType; hint: string }[] = [
  { icon: '◈', label: 'WASD 摇杆', tool: { id: 'wasd' }, hint: '拖动控制行走' },
  { icon: 'A', label: '普通点击', tool: { id: 'binding', action: 'tap', label: '点击' }, hint: '点击按键/位置' },
  { icon: 'H', label: '扳机长按', tool: { id: 'binding', action: 'hold', label: '长按' }, hint: '按住持续触摸（开火/扳机）' },
  { icon: 'R', label: '连击', tool: { id: 'binding', action: 'repeat', label: '连击' }, hint: '按住后周期重复点击' },
  { icon: 'V', label: '键盘视角', tool: { id: 'binding', action: 'view', label: '视角' }, hint: '按住后缓慢滑动视角' },
  { icon: 'K', label: 'Android 按键', tool: { id: 'binding', action: 'keycode', label: '键' }, hint: '发送 Android keycode' },
  { icon: '✛', label: '准星', tool: { id: 'overlay', label: '准星' }, hint: '固定显示在画面上的准星/提示' }
]

function toolKey(t: ToolType): string {
  if (t.id === 'wasd') return 'wasd'
  if (t.id === 'overlay') return `overlay|${t.label}`
  return `binding|${t.action}|${t.label}`
}

/**
 * Stable identity for a binding. Must NOT include x/y — otherwise the key changes
 * mid-drag and the item can no longer be matched (the old code dragged exactly once).
 */
function bindingKey(b: KeymapBinding): string {
  return b.id || `${b.key}|${b.action}|${b.groupId ?? ''}`
}

/** Crosshair marker (准星): four ticks + a small circle, not text. Exported for runtime overlay use. */
export function Crosshair(): JSX.Element {
  return (
    <svg className="crosshair" viewBox="0 0 100 100" aria-hidden="true">
      <line x1="50" y1="2" x2="50" y2="34" />
      <line x1="50" y1="66" x2="50" y2="98" />
      <line x1="2" y1="50" x2="34" y2="50" />
      <line x1="66" y1="50" x2="98" y2="50" />
      <circle cx="50" cy="50" r="17" />
      <circle className="dot" cx="50" cy="50" r="3" />
    </svg>
  )
}

export function KeymapEditor({ keymap, containerRef, videoRef, onChange, onClose }: Props): JSX.Element {
  const [draft, setDraft] = useState<KeymapConfig>(keymap)
  const [selectedTool, setSelectedTool] = useState<ToolType | null>(null)
  const [dragging, setDragging] = useState(false)
  const [videoRect, setVideoRect] = useState<DOMRect | null>(null)
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null)

  /**
   * Drag snapshot. Positions are captured once at drag start and the move handler
   * always computes `init + totalDelta` from this snapshot — never `current + delta`,
   * which used to compound on every mousemove and made the drag wildly over-sensitive.
   */
  const dragRef = useRef<{
    startX: number
    startY: number
    init: Map<string, { x: number; y: number }>
    keys: Set<string>
  } | null>(null)

  // Keep draft in sync if the parent swaps the keymap while we are open.
  useEffect(() => {
    setDraft(keymap)
  }, [keymap.id])

  // Backfill ids on keymaps created before `KeymapBinding.id` existed.
  useEffect(() => {
    setDraft((prev) => {
      let changed = false
      const bindings = prev.bindings.map((b) => {
        if (b.id) return b
        changed = true
        return { ...b, id: newId('b') }
      })
      return changed ? { ...prev, bindings } : prev
    })
  }, [keymap.id])

  // Track the canvas rendered rect and container rect.
  useEffect(() => {
    const container = containerRef.current
    const video = videoRef.current
    if (!container || !video) return

    const update = (): void => {
      setVideoRect(video.getBoundingClientRect())
      setContainerRect(container.getBoundingClientRect())
    }
    update()

    const ro = new ResizeObserver(update)
    ro.observe(container)
    ro.observe(video)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef, videoRef])

  const proxyStyle = useMemo((): React.CSSProperties => {
    if (!videoRect || !containerRect) return { display: 'none' }
    return {
      position: 'absolute',
      left: videoRect.left - containerRect.left,
      top: videoRect.top - containerRect.top,
      width: videoRect.width,
      height: videoRect.height,
      pointerEvents: selectedTool ? 'auto' : 'none'
    }
  }, [videoRect, containerRect, selectedTool])

  /** Convert a client mouse coordinate into normalized [0..1] coords inside the video. */
  const toNorm = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      if (!videoRect) return { x: 0.5, y: 0.5 }
      return {
        x: clamp01((clientX - videoRect.left) / videoRect.width),
        y: clamp01((clientY - videoRect.top) / videoRect.height)
      }
    },
    [videoRect]
  )

  /** Add a WASD pad centered at (x, y). */
  const addWasd = (x: number, y: number): void => {
    const gid = newId('g')
    setDraft((prev) => {
      const additions: KeymapBinding[] = [
        { ...emptyBinding('KeyW', 'hold'), x, y: clamp01(y - WASD_RADIUS), label: 'W', groupId: gid },
        { ...emptyBinding('KeyA', 'hold'), x: clamp01(x - WASD_RADIUS), y, label: 'A', groupId: gid },
        { ...emptyBinding('KeyS', 'hold'), x, y: clamp01(y + WASD_RADIUS), label: 'S', groupId: gid },
        { ...emptyBinding('KeyD', 'hold'), x: clamp01(x + WASD_RADIUS), y, label: 'D', groupId: gid }
      ]
      return { ...prev, bindings: [...prev.bindings, ...additions] }
    })
  }

  /** Add a single binding at (x, y). */
  const addBinding = (tool: Extract<ToolType, { id: 'binding' }>, x: number, y: number): void => {
    /** Default key for each binding type. Empty = user must type their own key (avoids pre-filling a
     * hardcoded key that cannot be changed — e.g. tap was 'KeyT', holding would lock the user into T). */
    const keyFor: Record<KeymapAction, string> = {
      tap: '',
      hold: '',
      repeat: '',
      view: '',
      swipe: '',
      keycode: 'KeyK'
    }
    setDraft((prev) => ({
      ...prev,
      bindings: [...prev.bindings, { ...emptyBinding(keyFor[tool.action] ?? 'KeyA', tool.action), x, y, label: tool.label }]
    }))
  }

  /** Add an overlay at (x, y). */
  const addOverlay = (tool: Extract<ToolType, { id: 'overlay' }>, x: number, y: number): void => {
    setDraft((prev) => ({
      ...prev,
      overlays: [
        ...prev.overlays,
        { id: newId('ov'), x, y, radius: 0.04, label: tool.label, color: 'rgba(255,255,255,0.25)' }
      ]
    }))
  }

  const onProxyClick = (e: React.MouseEvent): void => {
    if (!selectedTool) return
    e.stopPropagation()
    const { x, y } = toNorm(e.clientX, e.clientY)
    if (selectedTool.id === 'wasd') addWasd(x, y)
    else if (selectedTool.id === 'binding') addBinding(selectedTool, x, y)
    else if (selectedTool.id === 'overlay') addOverlay(selectedTool, x, y)
    setSelectedTool(null)
  }

  const removeBinding = (b: KeymapBinding): void => {
    const gid = b.groupId
    const key = bindingKey(b)
    setDraft((prev) => ({
      ...prev,
      bindings: prev.bindings.filter((x) => {
        if (gid && x.groupId === gid) return false // remove whole group
        if (!gid) return bindingKey(x) !== key
        return true
      })
    }))
  }

  const removeOverlay = (id: string): void => {
    setDraft((prev) => ({ ...prev, overlays: prev.overlays.filter((o) => o.id !== id) }))
  }

  /** Begin a drag. Captures a snapshot so movement stays 1:1 with the cursor. */
  const beginDrag = (startX: number, startY: number, items: { key: string; x: number; y: number }[]): void => {
    const init = new Map<string, { x: number; y: number }>()
    const keys = new Set<string>()
    for (const it of items) {
      keys.add(it.key)
      init.set(it.key, { x: it.x, y: it.y })
    }
    dragRef.current = { startX, startY, init, keys }
    setDragging(true)
  }

  const onControlMouseDown = (e: React.MouseEvent, b: KeymapBinding): void => {
    if (selectedTool) return // placement mode; ignore drag
    // Don't intercept mousedown on interactive controls (input / select / button) — let them
    // get focus normally so the user can type / paste. These elements also call
    // e.stopPropagation() on their own mousedown to prevent accidental drag.
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON') return
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = toNorm(e.clientX, e.clientY)
    const items = b.groupId
      ? draft.bindings.filter((o) => o.groupId === b.groupId).map((o) => ({ key: bindingKey(o), x: o.x, y: o.y }))
      : [{ key: bindingKey(b), x: b.x, y: b.y }]
    beginDrag(x, y, items)
  }

  const onOverlayMouseDown = (e: React.MouseEvent, o: KeymapOverlay): void => {
    if (selectedTool) return
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = toNorm(e.clientX, e.clientY)
    beginDrag(x, y, [{ key: `overlay|${o.id}`, x: o.x, y: o.y }])
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const { x, y } = toNorm(e.clientX, e.clientY)
      const dx = x - d.startX
      const dy = y - d.startY
      setDraft((prev) => ({
        ...prev,
        bindings: prev.bindings.map((b) => {
          const k = bindingKey(b)
          const init = d.init.get(k)
          return d.keys.has(k) && init ? { ...b, x: clamp01(init.x + dx), y: clamp01(init.y + dy) } : b
        }),
        overlays: prev.overlays.map((o) => {
          const k = `overlay|${o.id}`
          const init = d.init.get(k)
          return d.keys.has(k) && init ? { ...o, x: clamp01(init.x + dx), y: clamp01(init.y + dy) } : o
        })
      }))
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, toNorm])

  /** Group bindings by groupId; WASD pad is one visual group. */
  const groups = useMemo((): { groupId: string | null; bindings: KeymapBinding[] }[] => {
    const map = new Map<string, KeymapBinding[]>()
    for (const b of draft.bindings) {
      const gid = b.groupId ?? bindingKey(b)
      if (!map.has(gid)) map.set(gid, [])
      map.get(gid)!.push(b)
    }
    return Array.from(map.entries()).map(([groupId, bindings]) => ({
      groupId: bindings[0]?.groupId ?? null,
      bindings
    }))
  }, [draft.bindings])

  const onKeyChange = (b: KeymapBinding, newKey: string): void => {
    const old = bindingKey(b)
    setDraft((prev) => ({
      ...prev,
      bindings: prev.bindings.map((x) => (bindingKey(x) === old ? { ...x, key: newKey } : x))
    }))
  }

  const onActionChange = (b: KeymapBinding, action: KeymapAction): void => {
    const old = bindingKey(b)
    setDraft((prev) => ({
      ...prev,
      bindings: prev.bindings.map((x) => (bindingKey(x) === old ? { ...x, action } : x))
    }))
  }

  const selectedToolLabel = selectedTool ? PALETTE.find((p) => toolKey(p.tool) === toolKey(selectedTool))?.label ?? '' : ''

  return (
    <div className="keymap-editor">
      {/* Transparent proxy that matches the actual video display area. */}
      <div className="keymap-editor-proxy" style={proxyStyle} onClick={onProxyClick}>
        {selectedTool && <div className="keymap-editor-cursor-hint">点击画面放置：{selectedToolLabel}</div>}

        {/* Render grouped controls. */}
        {groups.map((g) => {
          if (g.groupId && g.bindings.length > 1) {
            // WASD pad: visual center is average of the 4 keys.
            const centerX = g.bindings.reduce((s, b) => s + b.x, 0) / g.bindings.length
            const centerY = g.bindings.reduce((s, b) => s + b.y, 0) / g.bindings.length
            return (
              <div
                key={g.groupId}
                className="keymap-editor-wasd"
                style={{ left: `${centerX * 100}%`, top: `${centerY * 100}%` }}
                onMouseDown={(e) => onControlMouseDown(e, g.bindings[0]!)}
              >
                <div className="wasd-ring" />
                <div className="wasd-dot" />
                {g.bindings.map((b) => (
                  <div
                    key={bindingKey(b)}
                    className="wasd-key"
                    style={{
                      left: `${(b.x - centerX) * 100}%`,
                      top: `${(b.y - centerY) * 100}%`,
                      transform: 'translate(-50%, -50%)'
                    }}
                  >
                    {b.label || b.key.replace('Key', '').replace('Arrow', '')}
                  </div>
                ))}
                <button className="keymap-editor-del" onClick={(e) => { e.stopPropagation(); removeBinding(g.bindings[0]!) }}>×</button>
              </div>
            )
          }
          // Single binding
          const b = g.bindings[0]!
          const label = b.label || b.key.replace('Key', '').replace('Arrow', '')
          return (
            <div
              key={bindingKey(b)}
              className="keymap-editor-control"
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }}
              onMouseDown={(e) => onControlMouseDown(e, b)}
            >
              <span className="control-label">{label}</span>
              <div className="control-actions" onClick={(e) => e.stopPropagation()}>
                <select value={b.action} onChange={(e) => onActionChange(b, e.target.value as KeymapAction)} title="动作类型">
                  <option value="tap">点击</option>
                  <option value="hold">长按</option>
                  <option value="repeat">连击</option>
                  <option value="view">视角</option>
                  <option value="swipe">滑动</option>
                  <option value="keycode">键码</option>
                </select>
                <input
                  type="text"
                  value={b.key}
                  onChange={(e) => onKeyChange(b, normalizeKeyCode(e.target.value))}
                  title="输入键名，支持中文/拼音/英文（例如：W / A / S / D / 空格 / 开火 / shoot / Space）"
                  placeholder="输入键名（例如 W / 空格 / 开火）"
                  onMouseDown={(e) => e.stopPropagation()}
                />
                <button onClick={(e) => { e.stopPropagation(); removeBinding(b) }}>×</button>
              </div>
            </div>
          )
        })}

        {/* Overlays (crosshair markers) */}
        {draft.overlays.map((o) => (
          <div
            key={o.id}
            className="keymap-editor-overlay"
            style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.radius * 200}%`, height: `${o.radius * 200}%` }}
            onMouseDown={(e) => onOverlayMouseDown(e, o)}
          >
            <Crosshair />
            <button className="keymap-editor-del" onClick={(e) => { e.stopPropagation(); removeOverlay(o.id) }}>×</button>
          </div>
        ))}
      </div>

      {/* Floating palette */}
      <div className="keymap-editor-palette">
        <div className="palette-title">辅助键</div>
        <div className="palette-grid">
          {PALETTE.map((p) => (
            <button
              key={toolKey(p.tool)}
              className={`palette-item ${selectedTool && toolKey(selectedTool) === toolKey(p.tool) ? 'active' : ''}`}
              title={p.hint}
              onClick={() => setSelectedTool((prev) => (prev && toolKey(prev) === toolKey(p.tool) ? null : p.tool))}
            >
              <span className="palette-icon">{p.icon}</span>
              <span className="palette-label">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="keymap-editor-actions">
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => { onChange(draft); onClose() }}>保存</button>
      </div>
    </div>
  )
}
