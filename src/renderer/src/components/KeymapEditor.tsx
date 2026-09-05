import { useEffect, useState, useCallback, useMemo } from 'react'
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

const emptyBinding = (key: string, action: KeymapAction): KeymapBinding => ({
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
  { icon: '◎', label: '准星', tool: { id: 'overlay', label: '准星' }, hint: '固定显示在画面上的准星/提示' }
]

function toolKey(t: ToolType): string {
  if (t.id === 'wasd') return 'wasd'
  if (t.id === 'overlay') return `overlay|${t.label}`
  return `binding|${t.action}|${t.label}`
}

/** Stable key for a binding within a config. */
function bindingKey(b: KeymapBinding): string {
  return `${b.key}|${b.groupId ?? ''}|${b.x.toFixed(5)}|${b.y.toFixed(5)}`
}

export function KeymapEditor({ keymap, containerRef, videoRef, onChange, onClose }: Props): JSX.Element {
  const [draft, setDraft] = useState<KeymapConfig>(keymap)
  const [selectedTool, setSelectedTool] = useState<ToolType | null>(null)
  const [dragging, setDragging] = useState<{
    groupId: string | null
    bindingKey: string
    startX: number
    startY: number
    initX: number
    initY: number
  } | null>(null)
  const [videoRect, setVideoRect] = useState<DOMRect | null>(null)
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null)

  // Keep draft in sync if the parent swaps the keymap while we are open.
  useEffect(() => {
    setDraft(keymap)
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
        x: Math.min(1, Math.max(0, (clientX - videoRect.left) / videoRect.width)),
        y: Math.min(1, Math.max(0, (clientY - videoRect.top) / videoRect.height))
      }
    },
    [videoRect]
  )

  /** Generate a fresh group id. */
  const newGroup = (): string => `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

  /** Add a WASD pad centered at (x, y). */
  const addWasd = (x: number, y: number): void => {
    const gid = newGroup()
    setDraft((prev) => {
      const additions: KeymapBinding[] = [
        { ...emptyBinding('KeyW', 'hold'), x, y: y - WASD_RADIUS, label: 'W', groupId: gid },
        { ...emptyBinding('KeyA', 'hold'), x: x - WASD_RADIUS, y, label: 'A', groupId: gid },
        { ...emptyBinding('KeyS', 'hold'), x, y: y + WASD_RADIUS, label: 'S', groupId: gid },
        { ...emptyBinding('KeyD', 'hold'), x: x + WASD_RADIUS, y, label: 'D', groupId: gid }
      ]
      return { ...prev, bindings: [...prev.bindings, ...additions] }
    })
  }

  /** Add a single binding at (x, y). */
  const addBinding = (tool: Extract<ToolType, { id: 'binding' }>, x: number, y: number): void => {
    let key = 'KeyA'
    if (tool.action === 'keycode') key = 'KeyK'
    if (tool.action === 'tap') key = 'KeyT'
    if (tool.action === 'hold') key = 'KeyH'
    if (tool.action === 'repeat') key = 'KeyR'
    if (tool.action === 'view') key = 'KeyV'
    setDraft((prev) => ({
      ...prev,
      bindings: [...prev.bindings, { ...emptyBinding(key, tool.action), x, y, label: tool.label }]
    }))
  }

  /** Add an overlay at (x, y). */
  const addOverlay = (tool: Extract<ToolType, { id: 'overlay' }>, x: number, y: number): void => {
    setDraft((prev) => ({
      ...prev,
      overlays: [
        ...prev.overlays,
        { id: `ov${Date.now().toString(36)}`, x, y, radius: 0.04, label: tool.label, color: 'rgba(255,255,255,0.25)' }
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

  const onControlMouseDown = (e: React.MouseEvent, b: KeymapBinding): void => {
    if (selectedTool) return // placement mode; ignore drag
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = toNorm(e.clientX, e.clientY)
    setDragging({
      groupId: b.groupId,
      bindingKey: bindingKey(b),
      startX: x,
      startY: y,
      initX: b.x,
      initY: b.y
    })
  }

  const onOverlayMouseDown = (e: React.MouseEvent, o: KeymapOverlay): void => {
    if (selectedTool) return
    e.preventDefault()
    e.stopPropagation()
    const { x, y } = toNorm(e.clientX, e.clientY)
    setDragging({
      groupId: null,
      bindingKey: `overlay|${o.id}`,
      startX: x,
      startY: y,
      initX: o.x,
      initY: o.y
    })
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      const { x, y } = toNorm(e.clientX, e.clientY)
      const dx = x - dragging.startX
      const dy = y - dragging.startY
      setDraft((prev) => {
        if (dragging.groupId) {
          // Move all bindings in the group together, preserving their relative offsets.
          return {
            ...prev,
            bindings: prev.bindings.map((b) => {
              if (b.groupId !== dragging.groupId) return b
              return { ...b, x: Math.min(1, Math.max(0, b.x + dx)), y: Math.min(1, Math.max(0, b.y + dy)) }
            })
          }
        }
        if (dragging.bindingKey.startsWith('overlay|')) {
          const oid = dragging.bindingKey.slice(8)
          return {
            ...prev,
            overlays: prev.overlays.map((o) =>
              o.id === oid ? { ...o, x: Math.min(1, Math.max(0, dragging.initX + dx)), y: Math.min(1, Math.max(0, dragging.initY + dy)) } : o
            )
          }
        }
        return {
          ...prev,
          bindings: prev.bindings.map((b) =>
            bindingKey(b) === dragging.bindingKey ? { ...b, x: Math.min(1, Math.max(0, dragging.initX + dx)), y: Math.min(1, Math.max(0, dragging.initY + dy)) } : b
          )
        }
      })
    }
    const onUp = (): void => setDragging(null)
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
                onMouseDown={(e) => onControlMouseDown(e, g.bindings[0])}
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
                <button className="keymap-editor-del" onClick={(e) => { e.stopPropagation(); removeBinding(g.bindings[0]) }}>×</button>
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
                  title="KeyboardEvent.code (例如 KeyW / Space / ArrowUp)"
                  placeholder="KeyW"
                  onMouseDown={(e) => e.stopPropagation()}
                />
                <button onClick={(e) => { e.stopPropagation(); removeBinding(b) }}>×</button>
              </div>
            </div>
          )
        })}

        {/* Overlays */}
        {draft.overlays.map((o) => (
          <div
            key={o.id}
            className="keymap-editor-overlay"
            style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.radius * 200}%`, height: `${o.radius * 200}%`, background: o.color }}
            onMouseDown={(e) => onOverlayMouseDown(e, o)}
          >
            <span>{o.label}</span>
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