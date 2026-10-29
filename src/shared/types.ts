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
  /**
   * 在画面上叠加「按键调试日志」（最近 6 条按键/触控命中记录，默认关）。
   *
   * 以前是工具栏上一个独立的「D」按钮，但那排查时才用一次、平时一直是关的开关，
   * 占着工具栏一格不划算 —— 挪进设置当一个选项。
   * 它同时是 `debugLogToFile` 的总闸：本项关着时一个字都不会写文件。
   */
  debugLog: boolean
  /** 上面那条调试日志是否**再**追加写入 安装目录/logs/<日期>.log（默认关） */
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
  /**
   * Python 外挂桥：是否开放本地 HTTP 接口给外部 Python 脚本控制当前投屏会话。
   * 仅监听 127.0.0.1，Bearer Token 鉴权，复用 scrcpy 控制链路（与 JS 脚本引擎同构）。
   * 默认关；getSettings() 深合并保证老配置缺字段时走默认值。
   */
  bridgeEnabled: boolean
  /** Python 桥监听端口（1024~65535），仅 127.0.0.1 */
  bridgePort: number
  /** Python 解释器（脚本面板运行 scripts/python/*.py 用）；空串 = 用 PATH 里的 python */
  pythonPath: string
  /**
   * 启动时自动检查一次更新（默认开）。
   * ★ 只检查、不下载：发现新版本只在侧栏/设置页提示，**下载与安装永远等用户点**。
   */
  autoUpdate: boolean
  /**
   * 更新源基址。空串 = 默认 GitHub 的 `releases/latest/download`。
   * 国内直连 GitHub 资产常常断流，允许换成镜像/代理（必须 http(s):// 开头）。
   */
  updateBase: string
  /**
   * 上一次更新结果的去重键（`applied|1.4.0|<时间>`）。
   * 用于"成功/失败提示只报一次"，跨重启也不会重复弹。
   */
  lastUpdateNotice: string
  /**
   * 脚本运行日志是否追加写入本地文件（默认关）。
   * 开启后脚本面板的「运行日志」（开始/日志/完成/停止/报错）逐行落到
   * `logs/scripts/<日期>.log`，方便事后排查脚本为什么没跑/报错。
   */
  scriptLogToFile: boolean
  /**
   * 全局「停止全部脚本」热键（Electron accelerator 格式，如 `F9`、`CommandOrControl+Shift+K`）。
   * 空串 = 不注册。按一下立即停掉所有运行中的 JS 脚本与 Python 脚本，面板关着、
   * 窗口没焦点也生效——给"脚本停不下来"兜底。
   */
  scriptStopHotkey: string
}

/** 自更新状态（与主进程 update-service 的状态机一一对应） */
export type UpdateStatus =
  | 'unsupported' // 便携版 / 开发模式
  | 'idle' // 还没查过
  | 'checking'
  | 'uptodate'
  | 'available' // 有新版本，等用户点「下载」
  | 'downloading'
  | 'staged' // 已下载校验完，等用户点「重启并更新」
  | 'nothing' // 下下来了，但本机逐字节已与目标一致
  | 'failed'

export interface UpdateProgress {
  got: number
  total: number
  /** 0~100；总大小未知时为 null */
  pct: number | null
  /** 形如 `12.3 MiB / 130.5 MiB（9%）` */
  text: string
}

/** 启动时一次性提示（更新成功 / 上次更新失败） */
export interface UpdateNotice {
  kind: 'applied' | 'failed'
  title: string
  text: string
  key: string
}

/** 自更新快照：渲染层只认这一份，不自己拼状态 */
export interface UpdateSnapshot {
  supported: boolean
  unsupportedReason: string
  /** green = 目录版（含安装版，两者目录形状相同）；portable = 单文件；dev = 开发模式 */
  form: 'green' | 'portable' | 'dev'
  myVersion: string
  autoUpdate: boolean
  base: string
  baseError: string
  /**
   * 程序目录（其实是 `安装目录/.update` 暂存区）能不能写。
   *
   * ★ 为什么单独一个字段而不是并进 `supported`：
   *   安装版的 NSIS 允许用户自选目录，装到 `C:\Program Files\...` 时普通权限写不进去，
   *   而"检查更新"是纯只读、完全能用的。把两件事混成一个布尔值会让用户连查都查不了。
   *   所以：`supported=false` → 形态不支持（便携版/开发模式）；
   *        `dirWritable=false` → 能查、不能装，并说清为什么。
   */
  dirWritable: boolean
  dirWritableReason: string
  status: UpdateStatus
  statusText: string
  latest: string
  /** 状态说明（为什么不可用 / 为什么走全量 / 失败原因） */
  reason: string
  /**
   * 本次更新会下多少东西。`delta` = 有可用差量包且划算（只下变了的块）；
   * `full` = 下绿色版整包。两种都最终摊进同一个暂存区，对用户的意义只差"流量"。
   */
  plan: {
    mode: 'full' | 'delta'
    size: number
    sizeText: string
    /** 全量包的字节数（差量模式下用来对比"省了多少"） */
    fullSize: number
    fullSizeText: string
    /** 差量的基准版本（mode==='delta' 时等于当前运行的版本） */
    from: string
  } | null
  progress: UpdateProgress | null
  checkedAt: number
  checkedAtText: string
  /** 更新目录（含 apply.json / apply.log / 暂存区） */
  dir: string
  busy: boolean
  canCheck: boolean
  canDownload: boolean
  canApply: boolean
  notice: UpdateNotice | null
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

/** 设备端目录项（`device:listDir` 返回） */
export interface RemoteEntry {
  /** 文件名（不含路径） */
  name: string
  /** 设备端完整路径（如 /sdcard/Download/a.txt） */
  path: string
  /** dir = 目录（可进入）；link = 符号链接（也允许尝试进入）；file = 普通文件；other = 设备/管道等 */
  kind: 'dir' | 'file' | 'link' | 'other'
  /** 字节数；目录或未知为 null */
  size: number | null
  /** 修改时间（epoch ms）；解析不出为 null */
  mtime: number | null
  /** 权限串（如 drwxrws---） */
  mode: string
}

/** `device:listDir` 的返回 */
export interface ListDirResult {
  ok: boolean
  /** 规范化后的目录路径 */
  path: string
  /** 上级目录；根目录为 null */
  parent: string | null
  entries: RemoteEntry[]
  message?: string
}

/**
 * 设备端「移动 / 复制」的结果。
 *
 * 一次可以带多个源，所以标准结果不是一个布尔值：
 *   - `ok=false`  → 整体没能执行（目标不是目录 / 不可写 / adb 通信失败），看 `message`
 *   - `conflicts` → 目标已有同名项（只在 overwrite=false 时出现，UI 要二次确认再重试）
 *   - `failed`    → 单个条目失败（权限、跨分区、源消失…），其余条目照常处理
 */
export interface FileTransferResult {
  ok: boolean
  message?: string
  okNames: string[]
  conflicts: string[]
  failed: { name: string; message: string }[]
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
  | { runId: string; scriptId: string; name: string; state: 'log'; line: string; /** 仅落盘、不推面板的高频调试日志（如 stick 心跳） */ debug?: boolean }
  | { runId: string; scriptId: string; name: string; state: 'done'; elapsedMs: number }
  | { runId: string; scriptId: string; name: string; state: 'stopped' }
  | { runId: string; scriptId: string; name: string; state: 'error'; message: string; /** 出错的用户脚本行号（1 起，解析不出为 undefined） */ line?: number }

/**
 * Python 脚本（scripts/python/*.py）。面板只负责「扫描列出 + 独立进程运行/停止」，
 * 不在 app 内编辑；脚本自身通过 Python 桥（qzrs.py）控制投屏会话。
 */
export interface PyScriptFile {
  /** 文件名（含 .py），目录内的唯一键 */
  file: string
  /** 展示名（去 .py） */
  name: string
  sizeBytes: number
  updatedAt: number
}

/** Python 脚本运行事件（主进程 → 渲染层 'pyscript:event' 通道） */
export type PyRunEvent =
  | { runId: string; file: string; name: string; state: 'started' }
  | { runId: string; file: string; name: string; state: 'log'; line: string; stream: 'out' | 'err' }
  | { runId: string; file: string; name: string; state: 'done'; /** 进程退出码（null = 被信号终止） */ code: number | null; elapsedMs: number }
  | { runId: string; file: string; name: string; state: 'stopped' }
  | { runId: string; file: string; name: string; state: 'error'; message: string }

/** waitImage(name, opts) 的返回值：坐标为视频像素坐标（与 tap 一致）；未找到 found=false */
export interface WaitImageResult {
  found: boolean
  x: number
  y: number
  /** 匹配置信度 0..1（越高越像） */
  score?: number
}

/** 设备存储分区（device:sysinfo 返回的单项） */
export interface SysStorage {
  /** 挂载点，如 /data、/sdcard */
  mount: string
  total: string
  used: string
  avail: string
  usePercent: string
}

/** 设备系统信息（device:sysinfo 返回） */
export interface SystemInfo {
  ok: boolean
  message?: string
  model: string
  brand: string
  device: string
  android: string
  sdk: string
  build: string
  serial: string
  cpu: string
  cores: number
  memTotal: string
  memAvail: string
  uptime: string
  resolution: string
  density: string
  battery: string
  batteryStatus: string
  batteryTemp: string
  root: boolean
  storage: SysStorage[]
}

/** 网络接口（device:netinfo 返回的单项） */
export interface NetInterface {
  name: string
  ip: string
}

/** 设备网络信息（device:netinfo 返回） */
export interface NetworkInfo {
  ok: boolean
  message?: string
  interfaces: NetInterface[]
  wifiSsid: string
  wifiBssid: string
  wifiRssi: string
  gateway: string
  dns: string[]
  carrier: string
}

/** 已安装应用（device:apps:list 返回的单项） */
export interface AppInfo {
  pkg: string
  label: string
  versionName: string
  versionCode: string
}

/** 应用列表结果（device:apps:list 返回） */
export interface AppListResult {
  ok: boolean
  message?: string
  apps: AppInfo[]
}

/** 应用操作（device:apps:action） */
export type AppAction = 'launch' | 'stop' | 'uninstall' | 'clear' | 'info'

/** 应用操作结果（device:apps:action 返回） */
export interface AppActionResult {
  ok: boolean
  message?: string
  /** info 操作返回的详情多行文本 */
  detail?: string
}

/** 应用图标（device:app:icon 返回，懒加载用） */
export interface AppIconResult {
  ok: boolean
  pkg: string
  message?: string
  /** data URI 的 mime，如 image/png */
  mime?: string
  /** 图标二进制转 base64 */
  data?: string
}
