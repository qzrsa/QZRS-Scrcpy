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
   * 用户自定义别名（右键「重命名」设置）。UI 显示优先级：alias > model > serial。
   */
  alias?: string | null
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
  /** 用户自定义别名（右键重命名）；空/缺省 = 未命名 */
  alias?: string | null
  /** 用户拖动排序的序号（0 起）；缺省 = 未排序，排在有 order 的设备之后 */
  order?: number
}

export type VideoCodec = 'h264' | 'h265' | 'av1'

/**
 * 设备端音频来源（scrcpy `audio_source`）。
 * - `output`  ：转发整个音频输出，**同时关闭设备端外放**（Android 11+ 才有此源）
 * - `mic`     ：采集麦克风，不影响外放
 */
export type AudioSource = 'output' | 'mic'

/** 设备端音频编码（scrcpy `audio_codec`）。内置播放器目前只解 opus。 */
export type AudioCodec = 'opus' | 'aac' | 'flac' | 'raw'

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
  /**
   * 转发设备音频到 PC（scrcpy `audio`）。需要 **Android 11 及以上**：
   * 低版本服务端会回写「本流禁用」，视频照常，不报错。
   */
  audio: boolean
  /** 音频来源；`output` 会同时关掉设备外放 */
  audioSource: AudioSource
  /** 音频编码（内置播放器目前只解 opus） */
  audioCodec: AudioCodec
  /** 音频码率 bits/s，0 = 服务端默认（128 kbps） */
  audioBitRate: number
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

/**
 * 音频流元信息。scrcpy 的音频流头只带 4 字节 codecId（不带分辨率那类 session meta），
 * 采样率/声道数由服务端写死（AudioConfig：48000 Hz / 2 声道）。
 */
export interface AudioMeta {
  sessionId: string
  codec: AudioCodec
  sampleRate: number
  channels: number
}

/** 单个音频包。config 包（OpusHead / fLaC extradata）用来 configure 解码器，不送 decode。 */
export interface AudioFrameEvent {
  sessionId: string
  data: Uint8Array
  pts: number
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
  session: SessionOptions
  /** whether to enable group control (broadcast input to all sessions) */
  groupControl: boolean
  /** id of the active keymap; null = no keymap active (every key → Android keycode) */
  activeKeymapId: string | null
  /** fullscreen mode: 'overlay' = CSS overlay (sidebar+toolbar hidden, window stays);
   *  'window' = system-level fullscreen (requestFullscreen) or maximize via IPC. */
  fullscreenMode: 'overlay' | 'window'
  /** 调试模式开启时是否把调试日志写入安装目录/logs/<日期>.log（默认关） */
  debugLogToFile: boolean
  /**
   * 画面是否随窗口大小自适应缩放（默认开）。
   *
   * 开启后画布不再以「解码缓冲尺寸」为基准（那样只能压小、不能放大，窗口拖大画面不动），
   * 而是按「等比缩放 + 完整可见」算出显示尺寸写成显式像素，窗口一变就跟着变。
   * **窗口模式和全屏都生效，且画面永远不会被拉长/拉宽**（盒子宽高比 == 流宽高比）：
   * 全屏原来是 CSS 铺满整个窗口，会把竖屏流横向拉宽约 2.6 倍，开启本项后改为同样的等比 contain。
   * 因为 getSettings() 是深合并，缺字段的老配置会走这里的默认值（开启）。
   */
  mirrorAutoFit: boolean
  /**
   * 额外扫描网段：深度扫描时除本机网卡网段之外**再**扫的地址段。
   *
   * 用在设备挂在别的 VLAN / 另一台路由器下、本机网卡上没有那个地址的场景——
   * 自动枚举永远看不到它，只能手填。元素是用户原始输入的每一条
   * （`192.168.50` / `192.168.50.0/24` / `192.168.50.7` …），
   * 解析与归一化交给 @shared/subnet 的 parseSubnets()。
   */
  extraScanSubnets: string[]
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

/** `devices:scan` 的返回：局域网 5555 端口扫描结果 */
export interface LanScanResult {
  ok: boolean
  /** 端口开放、可 adb connect 的主机 IP（按数值升序） */
  ips: string[]
  /**
   * 本次实际扫描的网段，展示串。自动检测网段按习惯写成 `x.y.z.0/24`；
   * 设置里手填的条目则是归一化后的形态（`10.0.0.0/22`、单台设备 `192.168.50.7`）。
   */
  subnets: string[]
  /** 手填额外网段里解析失败的条目（只有 settings.json 被手改坏时才会非空） */
  extraErrors: { raw: string; message: string }[]
  message?: string
}

/**
 * 用户脚本（JS 自动化）。持久化在安装目录/scripts/ 下，每个脚本一个 json 文件。
 * 代码在主进程 node:vm 沙箱里以 async IIFE 执行，顶层可直接 await。
 */
export interface ScriptInfo {
  id: string
  name: string
  code: string
  updatedAt: number
}

/** 脚本运行事件（主进程 → 渲染层 'script:event' 通道） */
export type ScriptRunEvent =
  | { runId: string; scriptId: string; name: string; state: 'started'; sessionId: string }
  | { runId: string; scriptId: string; name: string; state: 'log'; line: string }
  | { runId: string; scriptId: string; name: string; state: 'done'; elapsedMs: number }
  | { runId: string; scriptId: string; name: string; state: 'stopped' }
  | { runId: string; scriptId: string; name: string; state: 'error'; message: string; /** 出错的用户脚本行号（1 起，解析不出为 undefined） */ line?: number }

/** waitImage(name, opts) 的返回值：坐标为视频像素坐标（与 tap 一致）；未找到 found=false */
export interface WaitImageResult {
  found: boolean
  x: number
  y: number
  /** 匹配置信度 0..1（越高越像） */
  score?: number
}
