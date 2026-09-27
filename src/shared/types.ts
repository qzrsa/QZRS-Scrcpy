// Shared type definitions used by both the main process and the renderer.

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'no-permissions' | 'unknown'

export interface DeviceInfo {
  serial: string
  state: DeviceState
  model: string | null
  device: string | null
  product: string | null
  transport: string | null // 'usb' | 'local' | 'tcpip'
  /**
   * true = 该条目仅来自历史记录（当前未连接，`adb devices` 里没有）。
   * 主进程 refreshDevices() 会把历史设备以 state='offline' 合并进列表，
   * 渲染层据此置灰显示并给出「历史」标记。
   */
  known?: boolean
}

/**
 * 历史连接过的设备，持久化在 `userData/data/devices.json`。
 * 目的是重启后列表不为空：tcpip 设备的 serial 本身带 IP:端口，可直接 adb connect 回连。
 */
export interface DeviceHistoryEntry {
  serial: string
  model: string | null
  transport: string | null
  /** 最近一次看到该设备在线的时间（epoch ms），用于「最近在前」排序 */
  lastSeen: number
}

export type VideoCodec = 'h264' | 'h265' | 'av1'

/** PC-side WebCodecs decoder hardware-acceleration strategy. */
export type DecoderAcceleration = 'auto' | 'hardware' | 'software'

export interface SessionOptions {
  /** video bit rate in bits/s, 0 = default (8 Mbps) */
  bitRate: number
  /** max fps, 0 = no limit */
  maxFps: number
  /** max resolution (long edge), 0 = device native */
  maxSize: number
  /** video codec */
  codec: VideoCodec
  /** explicit device-side MediaCodec encoder name; empty = auto select */
  videoEncoder: string
  /** enable control */
  control: boolean
  /** keep device screen awake */
  stayAwake: boolean
  /** show touch points on device */
  showTouches: boolean
  /** turn device screen off on close */
  powerOffOnClose: boolean
  /** keep clipboard in sync */
  clipboardAutosync: boolean
  /** audio is disabled in this build (roadmap) */
  audio: false
}

export interface StreamMeta {
  sessionId: string
  codec: VideoCodec
  width: number
  height: number
}

export interface FrameEvent {
  sessionId: string
  data: Uint8Array
  pts: number
  isKey: boolean
  isConfig: boolean
}

/** Per-session realtime video/network statistics (sampled ~1s). */
export interface SessionStats {
  sessionId: string
  /** video stream bitrate in bits/s */
  bitrate: number
  /** device-side capture (encoder output) frame rate in fps */
  captureFps: number
  /** client-side received frame rate in fps */
  recvFps: number
}

export type SessionStateEvent =
  | { sessionId: string; state: 'started'; serial: string; deviceName: string; width: number; height: number }
  | { sessionId: string; state: 'stopped'; serial: string }
  | { sessionId: string; state: 'error'; serial: string; message: string }
  | { sessionId: string; state: 'clipboard'; text: string }

export type KeyEventAction = 0 | 1 // 0 = DOWN, 1 = UP

export type MotionEventAction =
  | 0 // DOWN
  | 1 // UP
  | 2 // MOVE
  | 3 // CANCEL
  | 4 // OUTSIDE
  | 5 // POINTER_DOWN
  | 6 // POINTER_UP
  | 7 // HOVER_MOVE
  | 8 // SCROLL
  | 9 // HOVER_ENTER
  | 10 // HOVER_EXIT
  | 11 // BUTTON_PRESS
  | 12 // BUTTON_RELEASE

/** pointer id: special values are encoded as unsigned 64-bit two's complement in the main process */
export type PointerId = 'mouse' | 'finger' | number

export type ControlCommand =
  | { type: 'keycode'; action: KeyEventAction; keycode: number; repeat: number; metastate: number }
  | { type: 'text'; text: string }
  | { type: 'touch'; action: MotionEventAction; pointerId: PointerId; x: number; y: number; width: number; height: number; pressure: number; buttons: number }
  | { type: 'scroll'; x: number; y: number; width: number; height: number; hScroll: number; vScroll: number; buttons: number }
  | { type: 'backOrScreenOn'; action: KeyEventAction }
  | { type: 'expandNotificationPanel' }
  | { type: 'expandSettingsPanel' }
  | { type: 'collapsePanels' }
  | { type: 'getClipboard'; copyKey: 0 | 1 | 2 }
  | { type: 'setClipboard'; text: string; paste: boolean }
  | { type: 'setDisplayPower'; on: boolean }
  | { type: 'rotateDevice' }
  | { type: 'resetVideo' }
  | { type: 'startApp'; name: string }

export interface AppSettings {
  adbPath: string
  serverPath: string
  /** Path to official scrcpy.exe (fallback renderer when built-in WebCodecs glitches) */
  scrcpyPath: string
  theme: 'dark' | 'light' | 'system'
  /** PC-side WebCodecs decoder acceleration strategy */
  decoderAcceleration: DecoderAcceleration
  /** default session options */
  session: Omit<SessionOptions, 'audio'>
  /** whether to enable group control (broadcast input to all sessions) */
  groupControl: boolean
  /** id of the active keymap; null = no keymap active (every key → Android keycode) */
  activeKeymapId: string | null
  /** fullscreen mode: 'overlay' = CSS overlay (sidebar+toolbar hidden, window stays);
   *  'window' = system-level fullscreen (requestFullscreen) or maximize via IPC. */
  fullscreenMode: 'overlay' | 'window'
}

/**
 * Keyboard → on-screen action types.
 *
 * - `tap`    : keydown → DOWN, keyup → UP. If `duration > 0`, auto UP after N ms (long-press tap).
 * - `hold`   : keydown → DOWN, keyup → UP. Held while key pressed (WASD walking, sustained fire).
 * - `repeat` : keydown → DOWN, then DOWN+UP every `repeatMs` ms (auto-fire / combo). keyup → UP.
 * - `view`   : keydown → DOWN at (x, y), then MOVE in direction (viewDx, viewDy) every `repeatMs` ms.
 *              keyup → UP. Used for keyboard-driven view rotation.
 * - `swipe`  : keydown → DOWN at (x, y), animate MOVE to (x2, y2) over `duration` ms, then UP.
 *              One-shot per keydown.
 * - `keycode`: keydown → Android keycode DOWN, keyup → keycode UP.
 */
export type KeymapAction = 'tap' | 'hold' | 'repeat' | 'view' | 'swipe' | 'keycode'

export interface KeymapBinding {
  /** stable unique id within the keymap; survives coordinate edits (drag) */
  id: string
  /** physical key identifier (KeyboardEvent.code) */
  key: string
  /** action type */
  action: KeymapAction
  /** for tap/hold/repeat/view: normalized coordinate [0..1] relative to video */
  x: number
  y: number
  /** for swipe only: end coordinate */
  x2: number
  y2: number
  /** swipe duration (ms); tap auto-release duration (ms); view/hold unused */
  duration: number
  /** view: direction vector per tick, normalized [-1..1]. dx=0,dy=-1 = look up */
  viewDx: number
  viewDy: number
  /** repeat: tap interval ms; view: tick interval ms; others unused */
  repeatMs: number
  /** for keycode action */
  keycode: number
  /** optional human-readable label shown on the canvas overlay */
  label: string
  /** compound control group id; WASD pad shares one groupId */
  groupId: string | null
}

export interface KeymapConfig {
  id: string
  name: string
  bindings: KeymapBinding[]
  /** passive overlay buttons drawn on the video canvas (准星 etc.) */
  overlays: KeymapOverlay[]
}

/** A single floating overlay button drawn on the video canvas (准星 / crosshair). */
export interface KeymapOverlay {
  /** unique id within the active keymap */
  id: string
  /** normalized center [0..1] */
  x: number
  y: number
  /** normalized radius [0..1] of the longer video edge */
  radius: number
  /** icon symbol or short label shown at the center */
  label: string
  /** semi-transparent fill color */
  color: string
}

export interface AdbShellResult {
  code: number
  stdout: string
  stderr: string
}

export interface OpResult {
  ok: boolean
  message?: string
}
