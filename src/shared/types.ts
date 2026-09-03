// Shared type definitions used by both the main process and the renderer.

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'no-permissions' | 'unknown'

export interface DeviceInfo {
  serial: string
  state: DeviceState
  model: string | null
  device: string | null
  product: string | null
  transport: string | null // 'usb' | 'local' | 'tcpip'
}

export type VideoCodec = 'h264' | 'h265' | 'av1'

export interface SessionOptions {
  /** video bit rate in bits/s, 0 = default (8 Mbps) */
  bitRate: number
  /** max fps, 0 = no limit */
  maxFps: number
  /** max resolution (long edge), 0 = device native */
  maxSize: number
  /** video codec */
  codec: VideoCodec
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

export type SessionStateEvent =
  | { sessionId: string; state: 'started'; serial: string; deviceName: string; width: number; height: number }
  | { sessionId: string; state: 'stopped' }
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
  theme: 'dark' | 'light' | 'system'
  /** default session options */
  session: Omit<SessionOptions, 'audio'>
  /** whether to enable group control (broadcast input to all sessions) */
  groupControl: boolean
}

export interface KeymapBinding {
  /** physical key identifier (KeyboardEvent.code) */
  key: string
  /** action type */
  action: 'tap' | 'swipe' | 'keycode'
  /** for tap/swipe: normalized coordinate [0..1] relative to video */
  x: number
  y: number
  /** for swipe only */
  x2: number
  y2: number
  /** swipe duration in ms */
  duration: number
  /** for keycode action */
  keycode: number
}

export interface KeymapConfig {
  id: string
  name: string
  bindings: KeymapBinding[]
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
