import { useEffect, useRef, useCallback } from 'react'
import type { ControlCommand, KeymapBinding, KeymapConfig, MotionEventAction } from '@shared/types'
import { H264Player } from '../decoder/h264'
import type { DecoderAcceleration } from '../decoder/h264'
import { KEYCODE, META, BUTTON, keycodeFromEventCode } from '../keycodes'
import type { SessionInfo } from '../store'
import { KeymapEditor } from './KeymapEditor'

interface Props {
  session: SessionInfo | null
  send: (cmd: ControlCommand) => void
  onError: (message: string) => void
  onFullscreen: () => void
  decoderAcceleration: DecoderAcceleration
  onStats?: (s: { renderFps: number; hardware: boolean }) => void
  /** active keymap; null = no keymap (fallback to raw Android keycode mapping) */
  keymap: KeymapConfig | null
  /** whether the visual keymap editor is open over the video */
  editing?: boolean
  /** called when the editor requests to close (save or cancel) */
  onEditClose?: () => void
  onKeymapChange?: (k: KeymapConfig) => void
}

/**
 * Renders the scrcpy video stream and maps local input (mouse / touch / wheel /
 * keyboard) to scrcpy control messages.
 *
 * When a `keymap` is provided, keyboard events are dispatched through the
 * matching binding. Unbound keys fall back to the default Android keycode mapping.
 */
export function MirrorView({
  session,
  send,
  onError,
  onFullscreen,
  decoderAcceleration,
  onStats,
  keymap,
  editing,
  onEditClose,
  onKeymapChange
}: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<H264Player | null>(null)
  const mouseDownRef = useRef(false)
  const metaRef = useRef(0)
  /** per-binding runtime state for `hold` / `repeat` / `view` */
  const bindingStateRef = useRef<Map<string, BindingState>>(new Map())
  /** mirror of the active keymap, kept in a ref so the keydown handler always reads the latest */
  const keymapRef = useRef<KeymapConfig | null>(keymap)
  keymapRef.current = keymap

  // (Re)create the decoder whenever the active session changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new H264Player(canvas, { acceleration: decoderAcceleration })
    player.onError = (m) => onError(m)
    player.onStats = onStats
    playerRef.current = player

    const offFrame = window.api.onFrame((e) => {
      if (session && e.sessionId === session.sessionId) {
        player.feed(e.data, e.isConfig, e.isKey)
      }
    })

    // 切回一个已在推流的会话（或初次连接由 connecting→streaming 重建解码器）时，
    // 设备只在流启动时发一次 SPS/PPS config，新建的解码器收不到 config 会一直黑屏。
    // 主动 resetVideo 让设备立即重发 config + 关键帧（官方为"新增播放器"设计的机制）。
    // 直接 sendControl 而非走 send()，避免群控开启时被广播到所有会话。
    if (session && session.status === 'streaming') {
      window.api.sendControl(session.sessionId, { type: 'resetVideo' })
    }

    return () => {
      offFrame()
      player.dispose()
      playerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId])

  const toVideo = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width || !canvas.height) return { x: 0, y: 0, w: 1, h: 1 }
    const rect = canvas.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * canvas.width
    const y = ((clientY - rect.top) / rect.height) * canvas.height
    return { x, y, w: canvas.width, h: canvas.height }
  }, [])

  /**
   * Convert normalized [0..1] coordinates to absolute pixel coords of the underlying video.
   */
  const normToVideo = useCallback((nx: number, ny: number) => {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width || !canvas.height) return { x: 0, y: 0, w: 1, h: 1 }
    return { x: nx * canvas.width, y: ny * canvas.height, w: canvas.width, h: canvas.height }
  }, [])

  const pointerId = (type: string): 'mouse' | 'finger' => (type === 'mouse' ? 'mouse' : 'finger')

  /** Build a touch command using the canvas (video) coordinate space. */
  const touch = (action: MotionEventAction, x: number, y: number, w: number, h: number, pid: 'mouse' | 'finger' | number, buttons = 0, pressure = 1): void => {
    send({ type: 'touch', action, pointerId: pid, x, y, width: w, height: h, pressure, buttons })
  }

  /** Send an Android keycode event. */
  const keycode = (action: 0 | 1, kc: number, meta = 0): void => {
    send({ type: 'keycode', action, keycode: kc, repeat: 0, metastate: meta })
  }

  /**
   * Cancel any in-flight timers for a binding (called on keyup, or before starting a new binding).
   */
  const cancelBindingTimers = (bindingKey: string): void => {
    const st = bindingStateRef.current.get(bindingKey)
    if (!st) return
    if (st.tickTimer !== undefined) clearInterval(st.tickTimer)
    if (st.autoTimer !== undefined) clearTimeout(st.autoTimer)
    bindingStateRef.current.delete(bindingKey)
  }

  /** All cleanup of binding timers when the active session changes. */
  useEffect(() => {
    const m = bindingStateRef.current
    for (const st of m.values()) {
      if (st.tickTimer !== undefined) clearInterval(st.tickTimer)
      if (st.autoTimer !== undefined) clearTimeout(st.autoTimer)
    }
    m.clear()
  }, [session?.sessionId])

  /**
   * Dispatch a keydown through the active keymap.
   * Returns true if the key was handled by a binding.
   */
  const dispatchKeymapDown = (binding: KeymapBinding): boolean => {
    const stateKey = `${binding.key}|${binding.action}|${binding.x}|${binding.y}`
    const st = bindingStateRef.current.get(stateKey)
    if (st) return true // already active

    const px = normToVideo(binding.x, binding.y)
    // synthetic pointerId (negative to avoid colliding with mouse/finger)
    const pid = -(Math.floor(binding.x * 1e6) + Math.floor(binding.y * 1e6)) as unknown as number
    const newSt: BindingState = { pointerId: pid, curX: px.x, curY: px.y }

    switch (binding.action) {
      case 'tap': {
        touch(0, px.x, px.y, px.w, px.h, pid, 0, 1)
        const dur = Math.max(0, binding.duration)
        if (dur > 0) {
          newSt.autoTimer = window.setTimeout(() => {
            touch(1, px.x, px.y, px.w, px.h, pid, 0, 0)
            bindingStateRef.current.delete(stateKey)
          }, dur)
          bindingStateRef.current.set(stateKey, newSt)
        } else {
          touch(1, px.x, px.y, px.w, px.h, pid, 0, 0)
          return true // fire-and-forget
        }
        break
      }
      case 'hold': {
        touch(0, px.x, px.y, px.w, px.h, pid, 0, 1)
        bindingStateRef.current.set(stateKey, newSt)
        break
      }
      case 'repeat': {
        touch(0, px.x, px.y, px.w, px.h, pid, 0, 1)
        const interval = Math.max(20, binding.repeatMs || 100)
        newSt.tickTimer = window.setInterval(() => {
          const cur = bindingStateRef.current.get(stateKey)
          if (!cur) return
          touch(1, cur.curX, cur.curY, px.w, px.h, pid, 0, 0)
          window.setTimeout(() => {
            const cur2 = bindingStateRef.current.get(stateKey)
            if (cur2) touch(0, cur2.curX, cur2.curY, px.w, px.h, pid, 0, 1)
          }, 30)
        }, interval)
        bindingStateRef.current.set(stateKey, newSt)
        break
      }
      case 'view': {
        touch(0, px.x, px.y, px.w, px.h, pid, 0, 1)
        const interval = Math.max(16, binding.repeatMs || 50)
        newSt.tickN = 0
        newSt.tickTimer = window.setInterval(() => {
          const cur = bindingStateRef.current.get(stateKey)
          if (!cur) return
          // advance position by (dx, dy) per tick; dx,dy are normalized per tick
          cur.tickN = (cur.tickN ?? 0) + 1
          const nx = Math.min(1, Math.max(0, binding.x + binding.viewDx * cur.tickN))
          const ny = Math.min(1, Math.max(0, binding.y + binding.viewDy * cur.tickN))
          const next = normToVideo(nx, ny)
          cur.curX = next.x
          cur.curY = next.y
          touch(2, next.x, next.y, px.w, px.h, pid, 0, 1)
        }, interval)
        bindingStateRef.current.set(stateKey, newSt)
        break
      }
      case 'swipe': {
        touch(0, px.x, px.y, px.w, px.h, pid, 0, 1)
        const dur = Math.max(20, binding.duration || 200)
        const ex = binding.x2 * px.w
        const ey = binding.y2 * px.h
        const start = performance.now()
        const step = (): void => {
          const t = (performance.now() - start) / dur
          if (t >= 1) {
            touch(1, ex, ey, px.w, px.h, pid, 0, 0)
            bindingStateRef.current.delete(stateKey)
            return
          }
          const cx = px.x + (ex - px.x) * t
          const cy = px.y + (ey - px.y) * t
          touch(2, cx, cy, px.w, px.h, pid, 0, 1)
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
        return true // one-shot
      }
      case 'keycode': {
        keycode(0, binding.keycode)
        return true
      }
    }
    return true
  }

  /** Dispatch a keyup through the active keymap. */
  const dispatchKeymapUp = (binding: KeymapBinding): void => {
    if (binding.action === 'keycode') {
      keycode(1, binding.keycode)
      return
    }
    if (binding.action === 'tap') return // already self-released
    if (binding.action === 'swipe') return // already self-released
    const stateKey = `${binding.key}|${binding.action}|${binding.x}|${binding.y}`
    const st = bindingStateRef.current.get(stateKey)
    if (!st) return
    cancelBindingTimers(stateKey)
    const px = normToVideo(binding.x, binding.y)
    touch(1, st.curX, st.curY, px.w, px.h, st.pointerId, 0, 0)
  }

  // Keyboard listeners on the window (input works even when canvas not hovered).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!session) return
      // track modifiers for metastate
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') metaRef.current |= META.SHIFT_ON
      else if (e.code === 'ControlLeft' || e.code === 'ControlRight') metaRef.current |= META.CTRL_ON
      else if (e.code === 'AltLeft' || e.code === 'AltRight') metaRef.current |= META.ALT_ON

      const km = keymapRef.current
      if (km) {
        const matches = km.bindings.filter((b) => b.key === e.code)
        if (matches.length > 0) {
          e.preventDefault()
          for (const b of matches) dispatchKeymapDown(b)
          return
        }
      }

      // No keymap or no matching binding → fall back to raw Android keycode mapping.
      const kc = keycodeFromEventCode(e.code)
      if (kc == null) return
      e.preventDefault()
      send({ type: 'keycode', action: 0, keycode: kc, repeat: e.repeat ? 1 : 0, metastate: metaRef.current })
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!session) return
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') metaRef.current &= ~META.SHIFT_ON
      else if (e.code === 'ControlLeft' || e.code === 'ControlRight') metaRef.current &= ~META.CTRL_ON
      else if (e.code === 'AltLeft' || e.code === 'AltRight') metaRef.current &= ~META.ALT_ON

      const km = keymapRef.current
      if (km) {
        const matches = km.bindings.filter((b) => b.key === e.code)
        if (matches.length > 0) {
          e.preventDefault()
          for (const b of matches) dispatchKeymapUp(b)
          return
        }
      }

      const kc = keycodeFromEventCode(e.code)
      if (kc == null) return
      e.preventDefault()
      send({ type: 'keycode', action: 1, keycode: kc, repeat: 0, metastate: metaRef.current })
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId, send])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session) return
    if (e.pointerType === 'mouse') {
      if (e.button === 2) {
        // right click → BACK
        send({ type: 'keycode', action: 0, keycode: KEYCODE.BACK, repeat: 0, metastate: 0 })
        send({ type: 'keycode', action: 1, keycode: KEYCODE.BACK, repeat: 0, metastate: 0 })
        return
      }
      if (e.button === 1) {
        // middle click → HOME
        send({ type: 'keycode', action: 0, keycode: KEYCODE.HOME, repeat: 0, metastate: 0 })
        send({ type: 'keycode', action: 1, keycode: KEYCODE.HOME, repeat: 0, metastate: 0 })
        return
      }
    }
    const p = toVideo(e.clientX, e.clientY)
    mouseDownRef.current = true
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
    send({ type: 'touch', action: 0, pointerId: pointerId(e.pointerType), x: p.x, y: p.y, width: p.w, height: p.h, pressure: 1, buttons: BUTTON.PRIMARY })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session) return
    const p = toVideo(e.clientX, e.clientY)
    if (e.pointerType === 'mouse' && !mouseDownRef.current) {
      // hover move
      send({ type: 'touch', action: 7, pointerId: 'mouse', x: p.x, y: p.y, width: p.w, height: p.h, pressure: 0, buttons: 0 })
      return
    }
    send({ type: 'touch', action: 2, pointerId: pointerId(e.pointerType), x: p.x, y: p.y, width: p.w, height: p.h, pressure: 1, buttons: BUTTON.PRIMARY })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!session) return
    if (e.pointerType === 'mouse' && (e.button === 2 || e.button === 1)) return
    const p = toVideo(e.clientX, e.clientY)
    mouseDownRef.current = false
    send({ type: 'touch', action: 1, pointerId: pointerId(e.pointerType), x: p.x, y: p.y, width: p.w, height: p.h, pressure: 0, buttons: 0 })
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!session) return
    e.preventDefault()
    let dx = e.deltaX
    let dy = e.deltaY
    if (e.deltaMode === 0) {
      dx /= 100
      dy /= 100
    } else if (e.deltaMode === 2) {
      dx *= 16
      dy *= 16
    }
    const p = toVideo(e.clientX, e.clientY)
    send({
      type: 'scroll',
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      hScroll: dx,
      vScroll: -dy,
      buttons: mouseDownRef.current ? BUTTON.PRIMARY : 0
    })
  }

  const onContextMenu = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="mirror-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="mirror-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (mouseDownRef.current = false)}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
        onDoubleClick={onFullscreen}
      />
      {keymap && keymap.overlays.length > 0 && <KeymapOverlayLayer keymap={keymap} />}
      {editing && keymap && onKeymapChange && (
        <KeymapEditor
          keymap={keymap}
          containerRef={wrapRef}
          videoRef={canvasRef}
          onChange={onKeymapChange}
          onClose={onEditClose ?? (() => { /* noop */ })}
        />
      )}
    </div>
  )
}

interface BindingState {
  pointerId: 'mouse' | 'finger' | number
  tickTimer?: number
  autoTimer?: number
  curX: number
  curY: number
  /** view action: tick counter for accumulating viewDx/viewDy offset */
  tickN?: number
}

/**
 * Draws the passive overlay buttons (准星 etc.) on top of the video canvas.
 * Pure visual; does not consume pointer events.
 */
function KeymapOverlayLayer({ keymap }: { keymap: KeymapConfig }): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const parent = layer.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => {
      const r = parent.getBoundingClientRect()
      layer.style.width = `${r.width}px`
      layer.style.height = `${r.height}px`
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={layerRef} className="keymap-overlay-layer" aria-hidden="true">
      {keymap.overlays.map((o) => (
        <div
          key={o.id}
          className="keymap-overlay"
          style={{
            left: `${o.x * 100}%`,
            top: `${o.y * 100}%`,
            width: `${o.radius * 100}%`,
            height: `${o.radius * 100}%`,
            background: o.color,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <span className="keymap-overlay-label">{o.label}</span>
        </div>
      ))}
    </div>
  )
}