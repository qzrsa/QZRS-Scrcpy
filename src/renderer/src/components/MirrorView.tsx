import { useEffect, useRef, useCallback } from 'react'
import type { ControlCommand } from '@shared/types'
import { H264Player } from '../decoder/h264'
import { KEYCODE, META, BUTTON, keycodeFromEventCode } from '../keycodes'
import type { SessionInfo } from '../store'

interface Props {
  session: SessionInfo | null
  send: (cmd: ControlCommand) => void
  onError: (message: string) => void
  onFullscreen: () => void
}

/**
 * Renders the scrcpy video stream and maps local input (mouse / touch / wheel /
 * keyboard) to scrcpy control messages.
 */
export function MirrorView({ session, send, onError, onFullscreen }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<H264Player | null>(null)
  const mouseDownRef = useRef(false)
  const metaRef = useRef(0)

  // (Re)create the decoder whenever the active session changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new H264Player(canvas)
    player.onError = (m) => onError(m)
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

  // Keyboard listeners on the window (input works even when canvas not hovered).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!session) return
      // track modifiers for metastate
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') metaRef.current |= META.SHIFT_ON
      else if (e.code === 'ControlLeft' || e.code === 'ControlRight') metaRef.current |= META.CTRL_ON
      else if (e.code === 'AltLeft' || e.code === 'AltRight') metaRef.current |= META.ALT_ON

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
      const kc = keycodeFromEventCode(e.code)
      if (kc == null) return
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

  const toVideo = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas || !canvas.width || !canvas.height) return { x: 0, y: 0, w: 1, h: 1 }
    const rect = canvas.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * canvas.width
    const y = ((clientY - rect.top) / rect.height) * canvas.height
    return { x, y, w: canvas.width, h: canvas.height }
  }, [])

  const pointerId = (type: string): 'mouse' | 'finger' => (type === 'mouse' ? 'mouse' : 'finger')

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
    <div className="mirror-wrap">
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
    </div>
  )
}
