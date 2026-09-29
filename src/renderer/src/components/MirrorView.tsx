import { useEffect, useRef, useCallback, useState } from 'react'
import type { ControlCommand, KeymapBinding, KeymapConfig, MotionEventAction } from '@shared/types'
import { H264Player } from '../decoder/h264'
import type { DecoderAcceleration } from '../decoder/h264'
import { KEYCODE, META, BUTTON, keycodeFromEventCode, normalizeKeyCode } from '../keycodes'
import type { SessionInfo } from '../store'
import { KeymapEditor, Crosshair } from './KeymapEditor'

interface Props {
  session: SessionInfo | null
  send: (cmd: ControlCommand) => void
  onError: (message: string) => void
  decoderAcceleration: DecoderAcceleration
  onStats?: (s: { renderFps: number; hardware: boolean }) => void
  /** active keymap; null = no keymap (fallback to raw Android keycode mapping) */
  keymap: KeymapConfig | null
  /** whether the visual keymap editor is open over the video */
  editing?: boolean
  /** show the rolling input debug log overlay (off by default) */
  debug?: boolean
  /** 调试日志写入文件（设置「调试时写入日志文件」；仍需 debug 打开才生效） */
  fileLog?: boolean
  /** called when the editor requests to close (save or cancel) */
  onEditClose?: () => void
  onKeymapChange?: (k: KeymapConfig) => void
  /** 脚本录制模式：true 时把用户的指针手势转成脚本代码行回传 */
  recording?: boolean
  onRecordGesture?: (codeLine: string) => void
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
  decoderAcceleration,
  onStats,
  keymap,
  editing,
  debug,
  fileLog,
  onEditClose,
  onKeymapChange,
  recording,
  onRecordGesture
}: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<H264Player | null>(null)
  const mouseDownRef = useRef(false)
  /** 录制用：主键按下时的位置与时间（onPointerUp 时算手势） */
  const recordDownRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const metaRef = useRef(0)
  /** per-binding runtime state for `hold` / `repeat` / `view` */
  const bindingStateRef = useRef<Map<string, BindingState>>(new Map())
  /**
   * Per-group runtime state for stick bindings (WASD).
   *
   * The whole stick is ONE finger: a single pointerId, a single interval, and a target
   * position derived from the sum of all currently-pressed direction vectors. Running one
   * interval per binding made W+A fight each other (pointer ping-ponging between the two
   * direction points) instead of combining into a 45° diagonal.
   */
  const groupStateRef = useRef<Map<string, GroupStickState>>(new Map())
  /** synthetic pointer id allocator (negative to avoid colliding with mouse/finger) */
  const nextPointerIdRef = useRef(-1)
  /** mirror of the active keymap, kept in a ref so the keydown handler always reads the latest */
  const keymapRef = useRef<KeymapConfig | null>(keymap)
  keymapRef.current = keymap
  /** debug state: rolling log of the last key events / touch commands sent (only when `debug`) */
  const [debugLines, setDebugLines] = useState<string[]>([])
  // 调试日志落盘：debug && 设置「调试时写入日志文件」同时开时，缓冲调试行，~1s 批量发主进程写文件
  const fileLogBufRef = useRef<string[]>([])
  const fileLogActiveRef = useRef(false)
  fileLogActiveRef.current = !!(debug && fileLog && session)
  const serialRef = useRef('')
  serialRef.current = session?.serial ?? ''
  const pushDebug = useCallback(
    (line: string): void => {
      if (!debug) return
      if (fileLogActiveRef.current) {
        // 每行带 serial 前缀：多设备日志写进同一份按天文件时仍可区分来源
        fileLogBufRef.current.push(`[${serialRef.current}] ${line}`)
        // 上限保护：IPC 通道万一阻塞也不至于无限膨胀
        if (fileLogBufRef.current.length > 2000) {
          fileLogBufRef.current.splice(0, fileLogBufRef.current.length - 2000)
        }
      }
      setDebugLines((prev) => [...prev, line].slice(-6))
    },
    [debug]
  )
  // 定时批量落盘；开关关闭/视图卸载时把缓冲里剩余的行立即发走
  useEffect(() => {
    if (!(debug && fileLog)) return
    const flush = (): void => {
      if (fileLogBufRef.current.length === 0) return
      window.api.debugLog(fileLogBufRef.current.splice(0))
    }
    const t = window.setInterval(flush, 1000)
    return () => {
      window.clearInterval(t)
      flush()
    }
  }, [debug, fileLog])

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
    // debug surface
    const actionName = ['DOWN', 'UP', 'MOVE', 'CANCEL', 'OUTSIDE', 'POINTER_DOWN', 'POINTER_UP', 'HOVER_MOVE'][action] ?? String(action)
    pushDebug(`touch ${actionName} (${x.toFixed(0)},${y.toFixed(0)}) pid=${pid}`)
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

  /** All cleanup of binding + stick timers when the active session changes. */
  useEffect(() => {
    const m = bindingStateRef.current
    for (const st of m.values()) {
      if (st.tickTimer !== undefined) clearInterval(st.tickTimer)
      if (st.autoTimer !== undefined) clearTimeout(st.autoTimer)
    }
    m.clear()

    const g = groupStateRef.current
    for (const gs of g.values()) {
      if (gs.tickTimer !== undefined) clearInterval(gs.tickTimer)
    }
    g.clear()
  }, [session?.sessionId])

  /**
   * 激活方案被切换 / 取消激活时，把所有还按着的虚拟手指抬起（UP）并清掉定时器。
   * 否则取消激活后 hold/repeat/view 与 WASD 摇杆会永久卡在「按住」状态——
   * keyup 走的是按旧映射匹配，映射没了（或换了）就匹配不到任何 binding，手指永不抬起。
   * 用 ref 持有最新释放函数，effect 只依赖方案 id（编辑保存不触发，切换/取消才触发）。
   */
  const releaseKeymapStateRef = useRef<() => void>(() => {})
  releaseKeymapStateRef.current = () => {
    const canvas = canvasRef.current
    const dims = canvas && canvas.width ? { w: canvas.width, h: canvas.height } : { w: 1, h: 1 }
    const m = bindingStateRef.current
    for (const st of m.values()) {
      if (st.tickTimer !== undefined) clearInterval(st.tickTimer)
      if (st.autoTimer !== undefined) clearTimeout(st.autoTimer)
      // 手指抬到它当前所在的位置（view/repeat 的 curX/curY 会随 tick 移动）
      touch(1, st.curX, st.curY, dims.w, dims.h, st.pointerId, 0, 0)
    }
    m.clear()
    const g = groupStateRef.current
    for (const gs of g.values()) {
      if (gs.tickTimer !== undefined) clearInterval(gs.tickTimer)
      touch(1, gs.curX, gs.curY, dims.w, dims.h, gs.pointerId, 0, 0)
    }
    g.clear()
  }
  const activeKeymapId = keymap?.id ?? null
  useEffect(() => {
    // cleanup 在方案 id 变化 / 视图卸载时执行（含卸载：关投屏窗口时也把按住的手指放掉）
    return () => releaseKeymapStateRef.current()
  }, [activeKeymapId])

  /**
   * Compute the stick center (normalized) from a group of bindings.
   * For a classic WASD pad, this is the geometric center of the 4 keys.
   */
  const computeGroupCenter = useCallback((groupId: string): { x: number; y: number } => {
    const km = keymapRef.current
    const groupBindings = km ? km.bindings.filter((b) => b.groupId === groupId) : []
    if (groupBindings.length === 0) return { x: 0.5, y: 0.5 }
    const x = groupBindings.reduce((s, b) => s + b.x, 0) / groupBindings.length
    const y = groupBindings.reduce((s, b) => s + b.y, 0) / groupBindings.length
    return { x, y }
  }, [])

  /**
   * Stick radius for a group: max distance from the group center to any of its bindings.
   * Combined directions are clamped to this so W+A lands on the rim at 45°, not outside.
   */
  const computeGroupRadius = useCallback((groupId: string): number => {
    const km = keymapRef.current
    const groupBindings = km ? km.bindings.filter((b) => b.groupId === groupId) : []
    if (groupBindings.length === 0) return 0.06
    const cx = groupBindings.reduce((s, b) => s + b.x, 0) / groupBindings.length
    const cy = groupBindings.reduce((s, b) => s + b.y, 0) / groupBindings.length
    const r = Math.max(...groupBindings.map((b) => Math.hypot(b.x - cx, b.y - cy)))
    return Math.max(0.01, r)
  }, [])

  /** Recompute the combined direction vector from all currently pressed directions. */
  const updateStickVector = useCallback((gs: GroupStickState): void => {
    let vx = 0
    let vy = 0
    for (const v of gs.vectors.values()) {
      vx += v.dx
      vy += v.dy
    }
    // Clamp to the rim: W+A sums to (-R,-R) with length R·√2; normalize back to R
    // so the result is a true 45° direction that stays inside the stick circle.
    const len = Math.hypot(vx, vy)
    if (len > gs.maxRadius) {
      vx = (vx / len) * gs.maxRadius
      vy = (vy / len) * gs.maxRadius
    }
    gs.vx = vx
    gs.vy = vy
  }, [])

  /**
   * One tick for the whole stick: ease the single pointer toward the combined target
   * and emit a MOVE. Running this once per group (instead of once per binding) is what
   * stops W+A from ping-ponging between two direction points.
   */
  const tickStick = (gid: string): void => {
    const gs = groupStateRef.current.get(gid)
    if (!gs) return
    const target = normToVideo(clamp01(gs.centerX + gs.vx), clamp01(gs.centerY + gs.vy))
    gs.curX += (target.x - gs.curX) * 0.35
    gs.curY += (target.y - gs.curY) * 0.35
    touch(2, gs.curX, gs.curY, target.w, target.h, gs.pointerId, 0, 1)
  }

  /**
   * Dispatch a keydown through the active keymap.
   * Returns true if the key was handled by a binding.
   */
  const dispatchKeymapDown = (binding: KeymapBinding): boolean => {
    const stateKey = `${binding.key}|${binding.action}|${binding.x}|${binding.y}`
    const st = bindingStateRef.current.get(stateKey)
    if (st) return true // already active

    const px = normToVideo(binding.x, binding.y)

    // Group bindings (WASD stick): ONE finger for the whole pad.
    //   - First pressed direction: DOWN at the stick center, then a single interval eases
    //     the pointer out to that direction.
    //   - Additional directions: add their vector to the group; the same interval retargets
    //     to the combined (diagonal) point. W+A therefore moves up-left at 45°.
    if (binding.groupId) {
      const gid = binding.groupId
      let gs = groupStateRef.current.get(gid)

      if (!gs) {
        const center = computeGroupCenter(gid)
        const centerPx = normToVideo(center.x, center.y)
        const pid = nextPointerIdRef.current
        nextPointerIdRef.current -= 1
        gs = {
          pointerId: pid,
          centerX: center.x,
          centerY: center.y,
          maxRadius: computeGroupRadius(gid),
          vx: 0,
          vy: 0,
          curX: centerPx.x,
          curY: centerPx.y,
          vectors: new Map()
        }
        groupStateRef.current.set(gid, gs)
        // 手指在摇杆中心按下
        touch(0, centerPx.x, centerPx.y, centerPx.w, centerPx.h, pid, 0, 1)
        // 单一 interval 负责所有后续移动（每 33ms，约 30fps）
        gs.tickTimer = window.setInterval(() => tickStick(gid), 33)
      }

      gs.vectors.set(stateKey, { dx: binding.x - gs.centerX, dy: binding.y - gs.centerY })
      updateStickVector(gs)
      return true
    }

    // Non-group bindings use an independent pointerId.
    const pid = nextPointerIdRef.current
    nextPointerIdRef.current -= 1
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

    // Group stick: drop this direction's vector; if others remain, retarget; else lift at center.
    // MUST run before the bindingStateRef guard below — group state lives only in
    // groupStateRef (keydown never writes bindingStateRef for group bindings), so checking
    // bindingStateRef first would swallow every WASD keyup and the stick would never release.
    if (binding.groupId) {
      const gid = binding.groupId
      const gs = groupStateRef.current.get(gid)
      if (!gs) return
      gs.vectors.delete(stateKey)
      if (gs.vectors.size === 0) {
        // 所有方向都松开 → 手指在中心点抬起
        if (gs.tickTimer !== undefined) window.clearInterval(gs.tickTimer)
        const center = normToVideo(gs.centerX, gs.centerY)
        touch(1, center.x, center.y, center.w, center.h, gs.pointerId, 0, 0)
        groupStateRef.current.delete(gid)
      } else {
        updateStickVector(gs)
      }
      return
    }

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
      // Skip if focus is on an input/textarea — let native handlers deal with it
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.contentEditable === 'true') return
      // track modifiers for metastate
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') metaRef.current |= META.SHIFT_ON
      else if (e.code === 'ControlLeft' || e.code === 'ControlRight') metaRef.current |= META.CTRL_ON
      else if (e.code === 'AltLeft' || e.code === 'AltRight') metaRef.current |= META.ALT_ON

      const km = keymapRef.current
      if (km) {
        const matches = km.bindings.filter((b) => normalizeKeyCode(b.key) === e.code)
        const canvas = canvasRef.current
        const csize = canvas ? `${canvas.width}x${canvas.height}` : 'no-canvas'
        if (matches.length > 0) {
          e.preventDefault()
          const b0 = matches[0]
          const gid = b0.groupId ? ` group=${b0.groupId.slice(-4)}` : ''
          pushDebug(`HIT ${e.code} → ${b0.action}${gid} @ (${b0.x.toFixed(2)},${b0.y.toFixed(2)}) canvas=${csize}`)
          for (const b of matches) dispatchKeymapDown(b)
          return
        } else {
          pushDebug(`keydown ${e.code} | no match | ${km.name}(${km.bindings.length}) keys=${km.bindings.map((b) => normalizeKeyCode(b.key)).join(',')}`)
        }
      } else {
        pushDebug(`keydown ${e.code} | NO ACTIVE KEYMAP (勾选「激活」并保存映射)`)
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
        const matches = km.bindings.filter((b) => normalizeKeyCode(b.key) === e.code)
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
    // 录制：记录主键按下的起点（右键/中键的 BACK/HOME 不录——脚本里用 key('BACK') 更清晰）
    if (recording && e.button === 0) {
      recordDownRef.current = { x: p.x, y: p.y, time: Date.now() }
    }
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
    // 录制：按下手势分类（点击 / 长按 / 滑动）→ 转成一行脚本代码
    const down = recordDownRef.current
    recordDownRef.current = null
    if (recording && down && onRecordGesture) {
      const dx = p.x - down.x
      const dy = p.y - down.y
      const dist = Math.hypot(dx, dy)
      const dt = Math.max(30, Date.now() - down.time)
      const rx = (v: number): number => Math.round(v)
      if (dist < 24) {
        onRecordGesture(dt >= 500 ? `await tap(${rx(down.x)}, ${rx(down.y)}, ${dt})` : `await tap(${rx(down.x)}, ${rx(down.y)})`)
      } else {
        onRecordGesture(`await swipe(${rx(down.x)}, ${rx(down.y)}, ${rx(p.x)}, ${rx(p.y)}, ${dt})`)
      }
    }
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
      {debug && debugLines.length > 0 && (
        <div className="mirror-debug-overlay">
          {debugLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
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
 * Runtime state for one compound stick (WASD group).
 * The whole group behaves as a single finger: one pointerId, one interval, one target
 * derived from the vector sum of all currently pressed directions.
 */
interface GroupStickState {
  pointerId: number
  /** stick center in normalized coords */
  centerX: number
  centerY: number
  /** max deflection from center, in normalized units (clamps diagonals to the rim) */
  maxRadius: number
  /** combined direction offset from center, normalized coords */
  vx: number
  vy: number
  /** current pointer position in video pixels (eased toward the target) */
  curX: number
  curY: number
  /** per-binding (stateKey) offset vector relative to center */
  vectors: Map<string, { dx: number; dy: number }>
  tickTimer?: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

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
            width: `${o.radius * 200}%`,
            height: `${o.radius * 200}%`,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <Crosshair />
        </div>
      ))}
    </div>
  )
}