import { ipcMain, dialog, clipboard, app, BrowserWindow, shell, globalShortcut, type IpcMainInvokeEvent } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { AdbClient, deepScanSubnets, fastScanSubnets, normalizeRemotePath, scanLanAdb } from './adb'
import { mergeRanges, parseSubnets, subnetPrefixToRange, type IpRange, type ParsedSubnets } from '@shared/subnet'
import { mergeDeviceHistory } from './devices'
import { ScrcpySession } from './session'
import { Store, debugLogDirCandidates } from './stores'
import { DebugFileLogger } from './debuglog'
import { ScriptEngine } from './scriptengine'
import { PyScriptManager } from './pyscripts'
import { PythonBridge, BridgeHttpError } from './bridge'
import { writeBridgeClients } from './bridgeclients'
import { UpdateService } from './update-service'
import { detectForm } from './updater'
import { OcrModelDownloader, type OcrProgress } from './ocrdownload'
import { ocrStatus as ocrModelsStatus, OCR_MANUAL_URL, resolveOcrModelDir } from './ocrmodels'
import { OcrEngine, type OcrResult } from './ocr'
import { bgraToRgba, matchTemplate, toGray } from './templatematch'
import { themeBackground } from './theme'
import { findAdb, findServer, findScrcpy } from './util'
import type {
  DeviceInfo,
  SessionOptions,
  ControlCommand,
  AppSettings,
  KeymapConfig,
  ScriptInfo,
  ScriptRunEvent,
  FrameEvent,
  StreamMeta,
  SessionStateEvent,
  SessionStats,
  AudioMeta,
  AudioFrameEvent,
  SystemInfo,
  NetworkInfo,
  AppInfo,
  AppListResult,
  AppActionResult,
  AppAction,
  SysStorage
} from '@shared/types'

export interface AppManager {
  /** 自更新服务（启动时的静默检查由 index.ts 触发；IPC 面板直接用它） */
  update: UpdateService
  dispose(): Promise<void>
}

/** 快扫不涉及额外网段时用的空解析结果（复用同一个常量，保证与 parseSubnets 的结构一致） */
const EMPTY_EXTRA: ParsedSubnets = parseSubnets([])

interface SessionHandle {
  session: ScrcpySession
  serial: string
  /** 会话启动参数：断线自动重连（方案 B）时用它重建会话 */
  opts: SessionOptions
}

// ---- 设备系统 / 网络信息解析（「终端与文件」工具面板用）----

const EMPTY_SYSINFO: SystemInfo = {
  ok: true,
  model: '',
  brand: '',
  device: '',
  android: '',
  sdk: '',
  build: '',
  serial: '',
  cpu: '',
  cores: 0,
  memTotal: '',
  memAvail: '',
  uptime: '',
  resolution: '',
  density: '',
  battery: '',
  batteryStatus: '',
  batteryTemp: '',
  root: false,
  storage: []
}

/** dumpsys battery 的 status 数值 → 中文 */
function batteryStatusText(s: string): string {
  switch (s.trim()) {
    case '2':
      return '充电中'
    case '3':
      return '放电中'
    case '4':
      return '未充电'
    case '5':
      return '已充满'
    default:
      return s || '未知'
  }
}

/** dumpsys battery 的 temperature（0.1°C）→ 可读字符串 */
function batteryTempText(s: string): string {
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return `${(n / 10).toFixed(1)}°C`
  return s || '未知'
}

/** 秒 → 可读时长 */
function uptimeText(s: string): string {
  const sec = Number(s)
  if (!Number.isFinite(sec) || sec < 0) return '未知'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

/** kB → 可读大小 */
function memText(s: string): string {
  const kb = Number(s)
  if (!Number.isFinite(kb) || kb <= 0) return '未知'
  const mb = kb / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

/** 解析 df -h 的一行输出 → 分区信息 */
function parseDfLine(line: string): SysStorage | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 6) return null
  return {
    mount: parts[parts.length - 1],
    usePercent: parts[parts.length - 2],
    avail: parts[parts.length - 3],
    used: parts[parts.length - 4],
    total: parts[parts.length - 5]
  }
}

/** 解析系统信息命令的原始输出 */
function parseSystemInfo(raw: string): SystemInfo {
  const kv: Record<string, string> = {}
  const dfLines: string[] = []
  let inDf = false
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t.includes('QZRS_DF_BEGIN')) {
      inDf = true
      continue
    }
    if (t.includes('QZRS_DF_END')) {
      inDf = false
      continue
    }
    if (inDf) {
      if (t) dfLines.push(t)
      continue
    }
    const m = t.match(/^QZRS_(\w+)=(.*)$/)
    if (m) kv[m[1]] = m[2].trim()
  }
  const storage = dfLines.map(parseDfLine).filter((x): x is SysStorage => x !== null)
  return {
    ...EMPTY_SYSINFO,
    model: kv.MODEL ?? '',
    brand: kv.BRAND ?? '',
    device: kv.DEVICE ?? '',
    android: kv.ANDROID ?? '',
    sdk: kv.SDK ?? '',
    build: kv.BUILD ?? '',
    serial: kv.SERIAL ?? '',
    cpu: kv.CPU ?? '',
    cores: Number(kv.CORES) || 0,
    memTotal: memText(kv.MEMTOTAL ?? ''),
    memAvail: memText(kv.MEMAVAIL ?? ''),
    uptime: uptimeText(kv.UPTIME ?? ''),
    resolution: kv.RES ?? '',
    density: kv.DENSITY ?? '',
    battery: kv.BATT ? `${kv.BATT}%` : '',
    batteryStatus: batteryStatusText(kv.BATTSTATUS ?? ''),
    batteryTemp: batteryTempText(kv.BATTTEMP ?? ''),
    root: kv.ROOT === 'yes',
    storage
  }
}

/** 解析网络信息命令的原始输出 */
function parseNetworkInfo(raw: string): NetworkInfo {
  const kv: Record<string, string> = {}
  const ifLines: string[] = []
  let inIf = false
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t.includes('QZRS_IF_BEGIN')) {
      inIf = true
      continue
    }
    if (t.includes('QZRS_IF_END')) {
      inIf = false
      continue
    }
    if (inIf) {
      if (t) ifLines.push(t)
      continue
    }
    const m = t.match(/^QZRS_(\w+)=(.*)$/)
    if (m) kv[m[1]] = m[2].trim()
  }
  const interfaces = ifLines
    .map((l) => {
      const parts = l.split(/\s+/)
      const name = parts[0]?.replace(/:$/, '') ?? ''
      const ip = (parts[1] ?? '').split('/')[0]
      return name && ip ? { name, ip } : null
    })
    .filter((x): x is { name: string; ip: string } => x !== null)
  const dns = [kv.DNS1, kv.DNS2].filter((d) => d && d !== '0.0.0.0' && d !== 'undefined')
  return {
    ok: true,
    interfaces,
    wifiSsid: kv.SSID ?? '',
    wifiBssid: kv.BSSID ?? '',
    wifiRssi: kv.RSSI ?? '',
    gateway: kv.GW ?? '',
    dns,
    carrier: kv.CARRIER ?? ''
  }
}

export function registerIpc(store: Store): AppManager {
  const sessions = new Map<string, SessionHandle>()
  // 会话当前视频尺寸（脚本引擎把像素坐标换算成协议参数用）：onStarted/onStreamMeta 更新，会话结束清理
  const videoSizes = new Map<string, { width: number; height: number }>()
  const records = new Map<string, string>() // serial -> remote record path
  // 外部 scrcpy.exe 子进程（serial -> ChildProcess），用于在 WebCodecs 渲染异常时
  // 临时回退到官方 scrcpy 自己的 SDL 窗口看画面（不嵌入，独立窗口）。
  const externalScrcpys = new Map<string, ChildProcess>()
  /** 当前流式 logcat 子进程（serial -> ChildProcess）；重新 start 前先杀掉旧的 */
  const logcatProcs = new Map<string, ChildProcess>()
  let adb: AdbClient | null = null
  let adbPath = ''
  let serverPath = ''
  let lastDevicesJson = ''
  let pollTimer: NodeJS.Timeout | null = null
  let statsTimer: NodeJS.Timeout | null = null
  // 调试日志落盘器（设置「调试时写入日志文件」+ 调试开关同时打开才会真正写入）
  const debugLogger = new DebugFileLogger(debugLogDirCandidates())
  // 脚本运行日志落盘器：独立子目录 logs/scripts/，避免和按键调试日志混在一个文件里。
  // 文件名与 debugLogger 一样按日期切（<日期>.log）。
  const scriptLogDirCandidates = (): string[] => debugLogDirCandidates().map((d) => join(d, 'scripts'))
  const scriptLogger = new DebugFileLogger(scriptLogDirCandidates())
  // 脚本日志是否落盘（内存镜像 settings.scriptLogToFile，settings:set 时同步）。
  // 脚本 log 事件非常高频，不能每次都去读 settings.json。
  let scriptLogToFile = store.getSettings().scriptLogToFile === true
  // 当前已注册成功的停止热键（空 = 未注册），applyScriptHotkey 用它对账避免重复注册
  let scriptHotkeyActive = ''
  // ---- adb track-devices 长连接监听（替代 3s 轮询）----
  let deviceWatcher: ChildProcess | null = null
  let watcherRestartTimer: NodeJS.Timeout | null = null
  let watcherHealthTimer: NodeJS.Timeout | null = null
  let watcherFails = 0
  // 连接建立后 adb 会立刻推一次当前设备列表；等不到就视为监听失败
  let watcherGotData = false
  const statsPrev = new Map<string, { bytes: number; time: number }>()

  function ensureAdb(): AdbClient {
    if (adb) return adb
    const settings = store.getSettings()
    const resolvedAdb = findAdb(settings.adbPath)
    const resolvedServer = findServer(settings.serverPath)
    if (!resolvedAdb) throw new Error('未找到 adb，请在设置中指定 adb.exe 路径')
    if (!resolvedServer) throw new Error('未找到 scrcpy-server，请确认 resources/scrcpy-server 存在')
    adbPath = resolvedAdb
    serverPath = resolvedServer
    adb = new AdbClient(resolvedAdb)
    return adb
  }

  function getWin(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null
  }

  function send(channel: string, ...args: unknown[]): void {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function log(line: string): void {
    send('log', line)
  }

  /**
   * 自更新服务。
   * ★ 形态判定：打包后且没有 PORTABLE_EXECUTABLE_DIR → 目录版（绿色版/安装版目录形状相同）。
   *   便携版是单文件 exe，运行中无法替换自己，直接判"不支持"。
   * ★ programDir 用 exe 所在目录（不是 resourcesPath 的上一级也无所谓，两者等价）。
   */
  const updateService = new UpdateService({
    version: () => app.getVersion(),
    form: () => detectForm(app.isPackaged, process.env),
    programDir: () => (app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()),
    exePath: () => app.getPath('exe'),
    getSettings: () => store.getSettings(),
    patchSettings: (patch) => store.setSettings({ ...store.getSettings(), ...patch }),
    send,
    quit: () => app.quit()
  })

  // ---- device polling ----
  /**
   * 合并 adb 在线设备与历史记录（见 devices.ts）。
   * 这样重启后（tcpip 设备不会再自动出现）列表里仍留有设备，可右键重连或删除。
   */
  function refreshWithHistory(live: DeviceInfo[]): DeviceInfo[] {
    return mergeDeviceHistory(live, store.rememberDevices(live))
  }

  // 当前 adb 在线的 serial 集合（自动重连用来判断哪些历史设备真的离线）
  let lastLiveSerials = new Set<string>()

  async function refreshDevices(): Promise<DeviceInfo[]> {
    let live: DeviceInfo[] = []
    try {
      live = await ensureAdb().devices()
    } catch {
      /* adb 不可用时至少把历史设备列出来 */
    }
    lastLiveSerials = new Set(live.map((d) => d.serial))
    const list = refreshWithHistory(live)
    const json = JSON.stringify(list)
    if (json !== lastDevicesJson) {
      lastDevicesJson = json
      send('devices:changed', list)
    }
    return list
  }

  // ---- 历史 tcpip 设备自动重连 ----
  // 历史设备在应用重启后 adb 不会自动连回，列表里一直是灰色（state=offline），
  // 用户每次都得右键「重新连接」。这里自动补：启动时连一次 + 每 30s 对仍离线的
  // tcpip 历史设备静默重试（手机后上线/换网也能自动恢复）。USB 设备插上即在线，不参与。
  let reconnectBusy = false
  let reconnectTimer: NodeJS.Timeout | null = null

  async function autoReconnectHistory(): Promise<void> {
    if (reconnectBusy) return
    reconnectBusy = true
    try {
      let a: AdbClient
      try {
        a = ensureAdb()
      } catch {
        return // adb 路径没配好，等下次
      }
      // 只补 tcpip 历史（serial 形如 10.126.126.111:5555）且当前不在线的
      const targets = store
        .getDeviceHistory()
        .filter((h) => /^[0-9.]+:\d+$/.test(h.serial) && !lastLiveSerials.has(h.serial))
      if (targets.length === 0) return
      // 并发 connect；单次 10s 上限，避免不可达 IP 长时间挂住
      await Promise.all(targets.map((h) => a.connect(h.serial, 10000).catch(() => null)))
      await refreshDevices() // connect 是幂等的（已连接立即返回），刷新走 diff，不会惊动 UI
    } finally {
      reconnectBusy = false
    }
  }

  function startAutoReconnect(): void {
    if (reconnectTimer) return
    void autoReconnectHistory()
    reconnectTimer = setInterval(() => void autoReconnectHistory(), 30000)
  }

  function startPolling(): void {
    if (pollTimer) return
    pollTimer = setInterval(() => void refreshDevices(), 3000)
    void refreshDevices()
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // ---- device watcher (adb track-devices) ----
  /** 监听推送节流：状态剧变（如 tcpip 切换）时 adb 会连发多条消息，合并成一次刷新。 */
  let watcherRefreshTimer: NodeJS.Timeout | null = null

  function startDeviceWatcher(): void {
    if (deviceWatcher || watcherRestartTimer || pollTimer) return
    let a: AdbClient
    try {
      a = ensureAdb()
    } catch {
      // adb 路径没配好：退回 3s 轮询（refreshDevices 的 catch 会把历史设备列出来）
      startPolling()
      return
    }
    watcherGotData = false
    try {
      deviceWatcher = a.trackDevices(
        () => {
          if (!watcherGotData) {
            watcherGotData = true
            watcherFails = 0
            if (watcherHealthTimer) {
              clearTimeout(watcherHealthTimer)
              watcherHealthTimer = null
            }
          }
          // 100ms 节流：把连续多条推送合并成一次 refreshDevices
          if (watcherRefreshTimer) return
          watcherRefreshTimer = setTimeout(() => {
            watcherRefreshTimer = null
            void refreshDevices()
          }, 100)
        },
        () => scheduleWatcherRestart()
      )
    } catch {
      deviceWatcher = null
      startPolling()
      return
    }
    // 进程退出（adb server 被杀等）→ 自动重启监听
    deviceWatcher.once('close', () => {
      if (deviceWatcher) {
        deviceWatcher = null
        scheduleWatcherRestart()
      }
    })
    // 5 秒内一条消息都没收到（连接建立时必推当前列表）→ 判定失败
    watcherHealthTimer = setTimeout(() => {
      watcherHealthTimer = null
      if (!watcherGotData) {
        killWatcher()
        watcherFails += 1
        if (watcherFails >= 3) {
          startPolling() // 连续 3 次起不来，永久退回轮询
        } else {
          scheduleWatcherRestart()
        }
      }
    }, 5000)
    void refreshDevices()
  }

  function killWatcher(): void {
    if (watcherHealthTimer) {
      clearTimeout(watcherHealthTimer)
      watcherHealthTimer = null
    }
    if (deviceWatcher) {
      const w = deviceWatcher
      deviceWatcher = null
      w.removeAllListeners()
      try {
        w.kill()
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleWatcherRestart(): void {
    if (watcherRestartTimer || pollTimer) return
    watcherRestartTimer = setTimeout(() => {
      watcherRestartTimer = null
      startDeviceWatcher()
    }, 2000)
  }

  /** 停止监听并重启（adb 路径变了等场景），监听失败则退回轮询。 */
  function restartDeviceWatcher(): void {
    killWatcher()
    stopPolling()
    startDeviceWatcher()
  }

  // ---- realtime stats sampling ----
  // 只在有活跃会话时运行：0 会话时空转没有意义（此前是启动即常驻每秒 tick）。
  function startStatsPolling(): void {
    if (statsTimer) return
    statsTimer = setInterval(() => {
      if (sessions.size === 0) {
        // 兜底：会话全没了就把自己停掉
        stopStatsPolling()
        return
      }
      for (const [sid, h] of sessions) {
        const s = h.session.getStats()
        const prev = statsPrev.get(sid)
        const now = Date.now()
        const dt = prev ? Math.max(0.001, (now - prev.time) / 1000) : 1
        const bitrate = prev ? Math.max(0, ((s.bytes - prev.bytes) * 8) / dt) : 0
        const recvFps = Math.max(0, s.frames / dt)
        // 采集帧率用设备端 pts 跨度估算（(帧数-1) / pts跨度）
        let captureFps = 0
        if (s.ptsEnd > s.ptsStart && s.frames > 1) {
          captureFps = ((s.frames - 1) * 1e6) / (s.ptsEnd - s.ptsStart)
        }
        send('session:stats', {
          sessionId: sid,
          bitrate: Math.round(bitrate),
          recvFps,
          captureFps
        } satisfies SessionStats)
        statsPrev.set(sid, { bytes: s.bytes, time: now })
        h.session.resetStats()
      }
      for (const sid of statsPrev.keys()) {
        if (!sessions.has(sid)) statsPrev.delete(sid)
      }
    }, 1000)
  }

  function stopStatsPolling(): void {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
    statsPrev.clear()
  }

  // ---- script engine ----
  // 用户 JS 脚本在主进程沙箱里跑，设备操作走与手动控制同一条 sendControl 链路。
  //
  // waitImage 的 findTemplate：截屏（设备原始分辨率）+ nativeImage 解 PNG（不引新依赖）
  // → 灰度 NCC 匹配 → 返回截屏坐标系下的匹配中心。坐标换算（截屏→视频像素）由引擎做。
  const findTemplate = async (
    sessionId: string,
    tplName: string,
    threshold: number
  ): Promise<{ found: boolean; x: number; y: number; score: number; screenW: number; screenH: number } | null> => {
    const { nativeImage } = await import('electron')
    const tplPng = store.readTemplate(tplName)
    if (!tplPng) return null
    const tplImg = nativeImage.createFromBuffer(tplPng)
    if (tplImg.isEmpty()) return null
    const tplSize = tplImg.getSize()
    const h = sessions.get(sessionId)
    if (!h) return { found: false, x: 0, y: 0, score: 0, screenW: 0, screenH: 0 }
    const shot = await ensureAdb().screencap(h.serial)
    const shotImg = nativeImage.createFromBuffer(shot)
    if (shotImg.isEmpty()) return { found: false, x: 0, y: 0, score: 0, screenW: 0, screenH: 0 }
    const shotSize = shotImg.getSize()
    const screen = toGray(bgraToRgba(new Uint8Array(shotImg.toBitmap())), shotSize.width, shotSize.height)
    const tpl = toGray(bgraToRgba(new Uint8Array(tplImg.toBitmap())), tplSize.width, tplSize.height)
    const m = matchTemplate(screen, tpl, threshold)
    if (!m) return { found: false, x: 0, y: 0, score: 0, screenW: shotSize.width, screenH: shotSize.height }
    return { found: true, x: m.x, y: m.y, score: m.score, screenW: shotSize.width, screenH: shotSize.height }
  }

  // 找色/读色共用：截屏 → BGRA 位图 + 尺寸（会话不存在/截屏失败返回 null）
  const captureBitmap = async (sessionId: string): Promise<{ bmp: Uint8Array; width: number; height: number } | null> => {
    const { nativeImage } = await import('electron')
    const h = sessions.get(sessionId)
    if (!h) return null
    const shot = await ensureAdb().screencap(h.serial)
    const img = nativeImage.createFromBuffer(shot)
    if (img.isEmpty()) return null
    const size = img.getSize()
    return { bmp: new Uint8Array(img.toBitmap()), width: size.width, height: size.height }
  }

  // 读「视频像素坐标」处的颜色（视频坐标 → 截屏坐标换算，截屏原始分辨率 vs 视频 maxSize 缩放）
  const getPixelColor = async (
    sessionId: string,
    videoX: number,
    videoY: number
  ): Promise<{ r: number; g: number; b: number; hex: string } | null> => {
    const vid = videoSizes.get(sessionId)
    const cap = await captureBitmap(sessionId)
    if (!vid || !cap || cap.width <= 0 || cap.height <= 0) return null
    const sx = Math.min(cap.width - 1, Math.max(0, Math.round((videoX * cap.width) / vid.width)))
    const sy = Math.min(cap.height - 1, Math.max(0, Math.round((videoY * cap.height) / vid.height)))
    const i = (sy * cap.width + sx) * 4
    const b = cap.bmp[i]
    const g = cap.bmp[i + 1]
    const r = cap.bmp[i + 2] // toBitmap 是 BGRA 顺序
    const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
    return { r, g, b, hex }
  }

  // 在（视频坐标系）region 里找第一个容差内命中；返回命中点视频坐标
  const findColor = async (
    sessionId: string,
    rgb: { r: number; g: number; b: number },
    tolerance: number,
    region: { x: number; y: number; w: number; h: number } | null
  ): Promise<{ found: boolean; x: number; y: number } | null> => {
    const vid = videoSizes.get(sessionId)
    const cap = await captureBitmap(sessionId)
    if (!vid || !cap || cap.width <= 0 || cap.height <= 0) return null
    const sx = (vx: number): number => Math.min(cap.width, Math.max(0, Math.round((vx * cap.width) / vid.width)))
    const sy = (vy: number): number => Math.min(cap.height, Math.max(0, Math.round((vy * cap.height) / vid.height)))
    let x0 = 0
    let y0 = 0
    let x1 = cap.width
    let y1 = cap.height
    if (region) {
      x0 = sx(region.x)
      y0 = sy(region.y)
      x1 = sx(region.x + region.w)
      y1 = sy(region.y + region.h)
    }
    const tol = Math.max(0, Math.trunc(tolerance))
    const { bmp, width } = cap
    for (let y = y0; y < y1; y++) {
      const row = y * width * 4
      for (let x = x0; x < x1; x++) {
        const i = row + x * 4
        if (Math.abs(bmp[i] - rgb.b) <= tol && Math.abs(bmp[i + 1] - rgb.g) <= tol && Math.abs(bmp[i + 2] - rgb.r) <= tol) {
          return { found: true, x: Math.round((x * vid.width) / cap.width), y: Math.round((y * vid.height) / cap.height) }
        }
      }
    }
    return { found: false, x: -1, y: -1 }
  }

  // OCR：截屏 → 视频坐标 region 换算成截屏坐标 → 按需 crop → OcrEngine 推理 → 坐标换算回视频。
  // 会话不存在/截屏失败返回 null（引擎转成「OCR 失败」）；模型未就绪/推理失败抛错（脚本看到具体原因）。
  const ocrText = async (
    sessionId: string,
    region: { x: number; y: number; w: number; h: number } | null
  ): Promise<OcrResult | null> => {
    const vid = videoSizes.get(sessionId)
    const cap = await captureBitmap(sessionId)
    if (!vid || !cap || cap.width <= 0 || cap.height <= 0) return null
    const sx = (vx: number): number => Math.min(cap.width, Math.max(0, Math.round((vx * cap.width) / vid.width)))
    const sy = (vy: number): number => Math.min(cap.height, Math.max(0, Math.round((vy * cap.height) / vid.height)))
    let bgra = cap.bmp
    let bw = cap.width
    let bh = cap.height
    let ox = 0
    let oy = 0
    if (region) {
      const x0 = sx(region.x)
      const y0 = sy(region.y)
      const x1 = sx(region.x + region.w)
      const y1 = sy(region.y + region.h)
      const cw = Math.max(1, x1 - x0)
      const ch = Math.max(1, y1 - y0)
      const sub = new Uint8Array(cw * ch * 4)
      for (let y = 0; y < ch; y++) {
        const srcRow = (y0 + y) * cap.width * 4 + x0 * 4
        sub.set(cap.bmp.subarray(srcRow, srcRow + cw * 4), y * cw * 4)
      }
      bgra = sub
      bw = cw
      bh = ch
      ox = x0
      oy = y0
    }
    const r = await ocrEngine.recognize(bgra, bw, bh)
    const tx = (px: number): number => Math.round(((ox + px) * vid.width) / cap.width)
    const ty = (py: number): number => Math.round(((oy + py) * vid.height) / cap.height)
    const tw = (pw: number): number => Math.round((pw * vid.width) / cap.width)
    const th = (ph: number): number => Math.round((ph * vid.height) / cap.height)
    return {
      text: r.text,
      lines: r.lines.map((l) => ({
        text: l.text,
        score: l.score,
        box: { x: tx(l.box.x), y: ty(l.box.y), w: tw(l.box.w), h: th(l.box.h) }
      }))
    }
  }

  /** 把脚本运行事件转成一行可读文本（文案与脚本面板日志区一致，方便对着看） */
  const formatScriptEvent = (evt: ScriptRunEvent): string => {
    switch (evt.state) {
      case 'started':
        return `▶ 开始运行「${evt.name}」（会话 ${evt.sessionId}）`
      case 'log':
        return evt.line
      case 'done':
        return `✔ 运行完成（${evt.elapsedMs}ms）`
      case 'stopped':
        return '■ 已停止'
      case 'error':
        return `✘ ${evt.message}${evt.line ? `（第 ${evt.line} 行）` : ''}`
    }
  }

  const scriptEngine = new ScriptEngine({
    sendControl: (sessionId, cmd) => {
      const h = sessions.get(sessionId)
      if (h) h.session.sendControl(cmd)
    },
    getVideoSize: (sessionId) => videoSizes.get(sessionId) ?? null,
    isSessionAlive: (sessionId) => sessions.has(sessionId),
    onEvent: (evt) => {
      // debug 级日志只落盘、不推面板（stick 心跳这类高频日志刷屏无意义，且会拖慢渲染层）
      if (evt.state === 'log' && evt.debug) {
        if (scriptLogToFile) scriptLogger.write(formatScriptEvent(evt))
        return
      }
      send('script:event', evt)
      if (scriptLogToFile) scriptLogger.write(formatScriptEvent(evt))
      // 断线重跑状态机：清理已结束的运行记录；断线中止 → 进待重跑队列
      if (evt.state === 'done' || evt.state === 'stopped') {
        runningScriptsMeta.delete(evt.scriptId)
        pendingRerun.delete(evt.scriptId)
      } else if (evt.state === 'error') {
        const meta = runningScriptsMeta.get(evt.scriptId)
        runningScriptsMeta.delete(evt.scriptId)
        // 断线中止 + 会话已进入自动重连流程（reconnectItems 有该会话）→ 才进待重跑队列。
        // 用户主动停投屏走 session:stop，不触发 onStopped，reconnectItems 不会有该会话，
        // 这里也就不进队列（避免日志说"加入重跑"却永远不重跑）。
        if (meta && isDisconnectError(evt.message) && reconnectItems.has(meta.sessionId)) {
          pendingRerun.set(evt.scriptId, meta)
          sysScriptLog(`⚠ 脚本「${evt.name}」因会话断开中止，已加入待重跑队列`)
          // 会话可能比脚本 error 更早重建好 → 立即尝试重跑
          if (sessions.has(meta.sessionId)) maybeRerunScripts(meta.sessionId)
        }
      }
    },
    findTemplate,
    getPixelColor,
    findColor,
    ocrText
  })

  // ---- Python 外挂桥 ----
  // 与 JS 脚本引擎同构：设备操作走同一条 sendControl 链路（scrcpy 控制协议），
  // 截屏复用 adb screencap。桥自己不碰 adb / ScrcpySession。
  const bridge = new PythonBridge({
    appVersion: () => app.getVersion(),
    listSessions: () =>
      [...sessions.entries()].map(([sessionId, h]) => ({
        sessionId,
        serial: h.serial,
        width: videoSizes.get(sessionId)?.width ?? 0,
        height: videoSizes.get(sessionId)?.height ?? 0
      })),
    sendControl: (sessionId, cmd) => {
      const h = sessions.get(sessionId)
      if (h) h.session.sendControl(cmd)
    },
    screenshot: async (serial) => ensureAdb().screencap(serial),
    // 取帧：渲染层 MirrorView 按 sessionId 注册了帧提供器（canvas 直出最后一帧）。
    // 主进程经 executeJavaScript 调用（返回 base64，~MB 级，IPC 开销可忽略）。
    frame: async (sessionId) => {
      const win = getWin()
      if (!win || win.isDestroyed()) throw new BridgeHttpError(503, '主窗口不可用，无法取帧')
      const sid = JSON.stringify(sessionId)
      try {
        const res = (await win.webContents.executeJavaScript(
          `(window.__qzrsFrameProviders && window.__qzrsFrameProviders[${sid}])` +
            ` ? window.__qzrsFrameProviders[${sid}]()` +
            ` : Promise.reject(new Error('该会话的投屏组件未挂载（MirrorView 未显示）'))`,
          true
        )) as { width: number; height: number; png: string }
        return { png: Buffer.from(res.png, 'base64'), width: res.width, height: res.height }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new BridgeHttpError(503, `取帧失败（${msg}）；注意 frame 需要该会话的投屏画面已渲染`)
      }
    }
  })

  /** Python 桥客户端目录（qzrs.py / example.py 所在） */
  function bridgeClientDir(): string {
    return join(app.getPath('userData'), 'data', 'bridge')
  }

  // ---- Python 脚本（scripts/python/*.py，独立进程运行）----
  // 目录按需创建；脚本与 JS 脚本分开存放（JS 是 json、Python 是 .py 源文件）。
  function pyScriptsDir(): string {
    const d = join(store.getScriptsDir(), 'python')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  const pyManager = new PyScriptManager({
    onEvent: (evt) => send('pyscript:event', evt),
    // Python 进程退出后释放桥上悬挂的手指（脚本可能死在 touch_down 之后）
    releasePointers: () => bridge.releaseAllPointers()
  })

  /** 按设置启停 Python 桥；客户端文件无论开关与否都写（设置面板要展示目录） */
  function applyBridge(): void {
    writeBridgeClients(bridgeClientDir())
    const s = store.getSettings()
    if (s.bridgeEnabled) {
      bridge
        .start(Math.trunc(s.bridgePort) || 17399)
        .then(() => log(`[Python桥] 已监听 127.0.0.1:${s.bridgePort}（Token 见设置面板）`))
        .catch((err) => log(`[Python桥] 启动失败: ${err instanceof Error ? err.message : String(err)}`))
    } else {
      void bridge.stop()
    }
  }

  /**
   * 按设置注册/注销「停止全部脚本」全局热键（Electron globalShortcut）。
   * 热键是系统级的：脚本面板关着、投屏窗口没焦点、甚至切到别的应用都能触发，
   * 给"脚本停不下来"兜底。注册失败只记日志，不打断启动。
   */
  function applyScriptHotkey(): void {
    const wanted = String(store.getSettings().scriptStopHotkey || '').trim()
    if (wanted === scriptHotkeyActive) return
    if (scriptHotkeyActive) {
      try {
        globalShortcut.unregister(scriptHotkeyActive)
      } catch {
        /* ignore */
      }
      scriptHotkeyActive = ''
    }
    if (!wanted) return
    try {
      const ok = globalShortcut.register(wanted, () => {
        scriptEngine.stopAll()
        pyManager.stopAll()
        log(`[全局热键] ${wanted} 已停止全部脚本`)
      })
      if (ok) {
        scriptHotkeyActive = wanted
        log(`[全局热键] 已注册「${wanted}」→ 停止全部脚本`)
      } else {
        log(`[全局热键] 注册失败：${wanted} 可能已被其他程序占用或格式不对`)
      }
    } catch (err) {
      log(`[全局热键] 注册异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- 断线自动重连 + 脚本自动重跑（方案 B）----
  // 脚本运行期间会话意外断开 → 主进程自动重建会话（复用原 sessionId），脚本因断线
  // 中止后，等会话重建成功再自动从头重跑同一个脚本。全程写详细日志（面板运行日志 +
  // logs/scripts 落盘），排查问题时能对得上完整时间线。
  const RECONNECT_ATTEMPTS = 20 // 每 3s 一次，最多约 60s 放弃
  const RECONNECT_INTERVAL_MS = 3000

  /** 正在运行的脚本 → 断线重跑所需完整参数（scripts:run 与重跑时登记） */
  const runningScriptsMeta = new Map<
    string,
    { sessionId: string; serial: string; opts: SessionOptions; loopMs: number; maxRounds: number; name: string }
  >()
  /** 因断线中止、等会话重建后自动重跑的脚本（key = scriptId） */
  const pendingRerun = new Map<
    string,
    { sessionId: string; serial: string; opts: SessionOptions; loopMs: number; maxRounds: number; name: string }
  >()
  /** 待重建的会话（key = sessionId） */
  const reconnectItems = new Map<string, { serial: string; opts: SessionOptions; attempts: number }>()
  let reconnectLoopTimer: NodeJS.Timeout | null = null
  let reconnectLoopBusy = false

  /** 把断线/重连/重跑这类系统级日志打进脚本面板运行日志 + 落盘（用户要求"详细记录"） */
  function sysScriptLog(line: string): void {
    send('script:event', { runId: 'sys', scriptId: '', name: '', state: 'log', line } satisfies ScriptRunEvent)
    if (scriptLogToFile) scriptLogger.write(line)
  }

  /** 脚本引擎断线报错的文案特征（checkStop 抛「会话已断开，脚本中止」） */
  function isDisconnectError(message: string): boolean {
    return message.includes('会话已断开') || message.includes('会话不存在或已断开')
  }

  /** 登记一个正在运行的脚本（断线后据此判断要不要重连、重跑时还原循环参数） */
  function rememberRunningScript(
    scriptId: string,
    sessionId: string,
    serial: string,
    opts: SessionOptions | undefined,
    loopMs: number,
    maxRounds: number,
    name: string
  ): void {
    if (!opts) return
    runningScriptsMeta.set(scriptId, { sessionId, serial, opts, loopMs, maxRounds, name })
  }

  /** 会话断开时调用：有脚本在跑才登记待重建并启动重建循环（幂等，重复触发无副作用） */
  function scheduleReconnect(sid: string, serial: string, opts: SessionOptions | undefined): void {
    if (!opts) return
    const needed =
      [...runningScriptsMeta.values()].some((m) => m.sessionId === sid) ||
      [...pendingRerun.values()].some((m) => m.sessionId === sid)
    if (!needed) return
    if (reconnectItems.has(sid)) return
    reconnectItems.set(sid, { serial, opts, attempts: 0 })
    sysScriptLog(`⚠ 会话断开（${serial}），检测到脚本正在运行，将自动重连并重跑`)
    ensureReconnectLoop()
  }

  function ensureReconnectLoop(): void {
    if (reconnectLoopTimer) return
    reconnectLoopTimer = setInterval(() => void reconnectAllTick(), RECONNECT_INTERVAL_MS)
  }

  /** 每 3s 一轮：设备上线就重建会话；超上限就放弃并清理待重跑 */
  async function reconnectAllTick(): Promise<void> {
    if (reconnectLoopBusy) return
    reconnectLoopBusy = true
    try {
      for (const [sid, item] of [...reconnectItems]) {
        // 用户已经手动停了脚本 → 不再需要重建
        const stillNeeded =
          [...runningScriptsMeta.values()].some((m) => m.sessionId === sid) ||
          [...pendingRerun.values()].some((m) => m.sessionId === sid)
        if (!stillNeeded) {
          reconnectItems.delete(sid)
          continue
        }
        if (sessions.has(sid)) {
          reconnectItems.delete(sid)
          continue
        }
        item.attempts++
        if (item.attempts > RECONNECT_ATTEMPTS) {
          reconnectItems.delete(sid)
          sysScriptLog(`✘ 会话 ${item.serial} 自动重连失败（重试 ${RECONNECT_ATTEMPTS} 次），放弃自动重跑`)
          for (const [k, m] of pendingRerun) if (m.sessionId === sid) pendingRerun.delete(k)
          continue
        }
        try {
          // tcpip 设备先 adb connect（幂等，设备没上线会失败）；USB 设备直接重建
          if (/^[0-9.]+:\d+$/.test(item.serial)) {
            await ensureAdb().connect(item.serial, 10000)
          }
          sysScriptLog(`⏳ 尝试重连设备 ${item.serial} 并重建会话（第 ${item.attempts} 次）…`)
          startSession(item.serial, item.opts, sid)
        } catch (err) {
          sysScriptLog(`⏳ 重连尝试 ${item.attempts} 失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (reconnectItems.size === 0 && reconnectLoopTimer) {
        clearInterval(reconnectLoopTimer)
        reconnectLoopTimer = null
      }
    } finally {
      reconnectLoopBusy = false
    }
  }

  /** 会话重建成功（onStarted）后：把等这个会话的脚本自动重跑 */
  function maybeRerunScripts(sessionId: string): void {
    reconnectItems.delete(sessionId)
    for (const [scriptId, m] of [...pendingRerun]) {
      if (m.sessionId !== sessionId) continue
      pendingRerun.delete(scriptId)
      sysScriptLog(`✔ 会话已重建，自动重跑脚本「${m.name}」`)
      const script = store.getScripts().find((s) => s.id === scriptId)
      if (!script) {
        sysScriptLog(`✘ 自动重跑失败：脚本「${m.name}」已不存在`)
        continue
      }
      try {
        scriptEngine.run(script, sessionId, { loopMs: m.loopMs, maxRounds: m.maxRounds })
        rememberRunningScript(scriptId, sessionId, m.serial, m.opts, m.loopMs, m.maxRounds, m.name)
      } catch (err) {
        sysScriptLog(`✘ 自动重跑脚本「${m.name}」失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ---- OCR 模型下载 ----
  // 模型不进安装包，设置里按需下载（GitHub Release 默认源，electron.net 走系统代理）。
  const ocrDownloader = new OcrModelDownloader()
  ocrDownloader.onProgress((p: OcrProgress) => send('ocr:progress', p))

  // ---- OCR 推理引擎 ----
  // 单例懒加载：模型文件由上面的下载器拉到本地模型目录，引擎用 onnxruntime-node 推理。
  // 模型加载慢（det ~400ms），首次 ocrText 调用时才加载，之后常驻复用。
  const ocrEngine = new OcrEngine(resolveOcrModelDir())

  // ---- session management ----
  function startSession(serial: string, opts: SessionOptions, reuseId?: string): { sessionId: string } {
    const a = ensureAdb()
    // 断线自动重连时复用原 sessionId：脚本/渲染层都不需要感知会话换了个 id
    const sessionId = reuseId || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const session = new ScrcpySession(sessionId, a, serial, opts, serverPath, {
      onStarted: (info) => {
        sessions.set(sessionId, { session, serial, opts })
        videoSizes.set(sessionId, { width: info.width, height: info.height })
        startStatsPolling()
        send('session:state', { sessionId, state: 'started', serial, deviceName: info.deviceName, width: info.width, height: info.height } satisfies SessionStateEvent)
        log(`[${info.deviceName}] 已连接，视频 ${info.width}x${info.height}`)
        // 断线重连成功 → 把等待这个会话的脚本自动重跑
        maybeRerunScripts(sessionId)
      },
      onFrame: (sid, data, pts, isKey, isConfig) => {
        const evt: FrameEvent = { sessionId: sid, data, pts, isKey, isConfig }
        send('session:frame', evt)
      },
      onStreamMeta: (meta: StreamMeta) => {
        videoSizes.set(meta.sessionId, { width: meta.width, height: meta.height })
        send('session:meta', meta)
      },
      onAudioMeta: (meta: AudioMeta) => {
        send('session:audio-meta', meta)
      },
      onAudioFrame: (sid, data, pts, isConfig) => {
        const evt: AudioFrameEvent = { sessionId: sid, data, pts, isConfig }
        send('session:audio', evt)
      },
      onAudioDisabled: (sid, reason) => {
        // 音频是可选能力：Android < 11、采集被占用、配置错误都会走这里，视频不受影响
        log(`[音频] ${reason}`)
        send('session:audio-disabled', { sessionId: sid, reason })
      },
      onStopped: (sid) => {
        const h = sessions.get(sid)
        const serial = h?.serial ?? ''
        const opts = h?.opts
        sessions.delete(sid)
        videoSizes.delete(sid)
        if (sessions.size === 0) stopStatsPolling()
        send('session:state', { sessionId: sid, serial, state: 'stopped' } satisfies SessionStateEvent)
        // 意外断开（用户主动停投屏会先置 disposed，不会走到这里）→ 尝试自动重连
        scheduleReconnect(sid, serial, opts)
      },
      onError: (sid, message) => {
        const h = sessions.get(sid)
        const serial = h?.serial ?? ''
        const opts = h?.opts
        sessions.delete(sid)
        videoSizes.delete(sid)
        if (sessions.size === 0) stopStatsPolling()
        send('session:state', { sessionId: sid, serial, state: 'error', message } satisfies SessionStateEvent)
        log(`[错误] ${message}`)
        // 启动失败/协议错误也走同一条重连逻辑（有脚本在跑才真正重连）
        scheduleReconnect(sid, serial, opts)
      },
      onClipboard: (sid, text) => {
        clipboard.writeText(text)
        send('session:state', { sessionId: sid, state: 'clipboard', text } satisfies SessionStateEvent)
      },
      onLog: (_sid, line) => {
        if (line) log(line)
      }
    })
    sessions.set(sessionId, { session, serial, opts })
    void session.start()
    return { sessionId }
  }

  // ---- IPC handlers ----
  ipcMain.handle('devices:list', () => refreshDevices())
  ipcMain.handle('devices:refresh', () => refreshDevices())

  // 重命名设备（用户别名；空串 = 清除）。立即写盘并刷新列表。
  ipcMain.handle('devices:rename', async (_e, serial: string, alias: string) => {
    try {
      store.renameDevice(String(serial), String(alias ?? ''))
      await refreshDevices()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 拖动排序：渲染层把拖完的完整 serial 顺序发过来，主进程写 order 并刷新
  ipcMain.handle('devices:reorder', async (_e, orderedSerials: unknown) => {
    try {
      if (!Array.isArray(orderedSerials)) return { ok: false, message: '参数错误' }
      store.setDeviceOrder(orderedSerials.map(String))
      await refreshDevices()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 扫描局域网内开放 adb 端口的设备（adb tcpip 模式不发 mDNS 广播，只能扫端口）
  // allSubnets=true 时额外连虚拟机/虚拟网卡网段一起扫（慢很多，按需开启）；回环两种模式都会扫。
  // 深度扫描还会带上设置里手填的「额外扫描网段」——那是给设备挂在别的 VLAN、
  // 本机网卡上根本没这个地址的场景兜底的。
  ipcMain.handle('devices:scan', async (_e, port?: number, allSubnets?: boolean) => {
    try {
      const p = port ?? 5555
      const prefixes = allSubnets ? deepScanSubnets() : fastScanSubnets()
      const extras = allSubnets ? parseSubnets(store.getSettings().extraScanSubnets) : EMPTY_EXTRA

      const autoRanges = prefixes
        .map(subnetPrefixToRange)
        .filter((r): r is IpRange => r !== null)
      // 合并重叠/相邻区间：用户的额外网段可能正好落在本机网卡网段内，
      // mergeRanges 会把它们并成一段，避免同一批地址被扫两遍。
      const ranges = allSubnets ? mergeRanges([...autoRanges, ...extras.ranges]) : autoRanges

      // 展示用：自动网段按习惯显示成 x.y.z.0/24，用户条目显示其归一化后的串
      const scanned = [
        ...prefixes.map((s) => `${s}.0/24`),
        ...(allSubnets ? extras.display : [])
      ]

      let found = await scanLanAdb(p, { ranges })
      // 一台都没扫到时自动重试一次：设备偶发无响应会导致误报"未发现"
      if (found.length === 0) {
        found = await scanLanAdb(p, { ranges, timeoutMs: 700, concurrency: 96 })
      }
      return {
        ok: true,
        ips: found,
        subnets: scanned,
        // settings.json 被手改坏时能在这里告诉用户，而不是静默少扫一段
        extraErrors: allSubnets ? extras.errors : []
      }
    } catch (err) {
      return {
        ok: false,
        ips: [],
        subnets: [],
        extraErrors: [],
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('device:connect', async (_e, hostPort: string) => {
    try {
      const a = ensureAdb()
      const r = await a.connect(hostPort)
      await refreshDevices()
      return { ok: r.code === 0 || r.stdout.includes('connected'), message: (r.stdout || r.stderr).trim() }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:disconnect', async (_e, hostPort: string) => {
    try {
      const a = ensureAdb()
      await a.disconnect(hostPort)
      await refreshDevices()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 从历史列表里删除设备。tcpip 设备（serial 形如 host:port）需先 adb disconnect，
  // 否则下一次 3s 轮询会立刻把它当成在线设备重新写回历史，表现为「删不掉」。
  // USB 设备拔不掉，若仍插着会在下次轮询时重新出现（菜单里已提示）。
  ipcMain.handle('devices:forget', async (_e, serial: string) => {
    try {
      if (/^.+:\d+$/.test(serial)) {
        try {
          await ensureAdb().disconnect(serial)
        } catch {
          /* adb 不可用时也允许从历史里删掉 */
        }
      }
      store.forgetDevice(serial)
      await refreshDevices()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:tcpip', async (_e, serial: string, port: number) => {
    try {
      const a = ensureAdb()
      const ip = await a.getDeviceIp(serial)
      if (!ip) return { ok: false, message: '无法获取设备 IP' }
      const r = await a.tcpip(serial, port)
      if (r.code !== 0) return { ok: false, message: r.stdout || r.stderr }
      // wait a moment then connect
      await new Promise((res) => setTimeout(res, 1000))
      const c = await a.connect(`${ip}:${port}`)
      await refreshDevices()
      return { ok: c.code === 0 || c.stdout.includes('connected'), message: `${ip}:${port}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('session:start', (_e, serial: string, opts: SessionOptions) => {
    try {
      return { sessionId: startSession(serial, opts).sessionId }
    } catch (err) {
      // 同步失败（如未找到 adb / scrcpy-server）：startSession 里 ensureAdb() 会 throw，
      // 这里转为 error 事件，让渲染层按 serial 清理占位并弹错误提示，而非静默卡在 connecting。
      const msg = err instanceof Error ? err.message : String(err)
      send('session:state', { sessionId: '', serial, state: 'error', message: msg } satisfies SessionStateEvent)
      return { sessionId: '' }
    }
  })
  ipcMain.handle('session:stop', async (_e, sessionId: string) => {
    const h = sessions.get(sessionId)
    if (h) await h.session.stop()
    sessions.delete(sessionId)
    videoSizes.delete(sessionId)
    if (sessions.size === 0) stopStatsPolling()
  })

  // ---- external scrcpy fallback ----
  // 当内置 WebCodecs 渲染异常（绿屏 / 竖屏裁切）时，作为临时回退方案启动官方
  // scrcpy.exe 独立窗口；不嵌入到 Electron 窗口（嵌入需要 Win32 SetParent/native module），
  // 后续再做。后端不接管视频流，控制指令继续走原来的 session:control（如果已起会话）。
  ipcMain.handle('external-scrcpy:launch', async (_e, serial: string) => {
    if (externalScrcpys.has(serial)) {
      return { ok: true, message: '已存在 scrcpy 窗口' }
    }
    const settings = store.getSettings()
    const exe = findScrcpy(settings.scrcpyPath)
    if (!exe) {
      return {
        ok: false,
        message: '未找到 scrcpy.exe，请在设置里指定 scrcpy 路径或安装官方 scrcpy 后加入 PATH'
      }
    }
    try {
      // 注意：scrcpy 的 --no-control 是布尔开关（不接受参数），默认就启用控制，
      // 不要传 --no-control=false（会报 "option doesn't take an argument" 导致秒退）。
      // 打包版裁掉了 scrcpy/ 里重复的 adb.exe（省 8.2MB），所以把自带 adb 的目录
      // 注入 PATH 并设置 ADB 环境变量，让 scrcpy.exe 能找到 adb。
      const selfAdb = findAdb(settings.adbPath)
      const adbDir = selfAdb ? dirname(selfAdb) : ''
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (selfAdb) {
        env['ADB'] = selfAdb
        env['PATH'] = `${dirname(selfAdb)};${process.env['PATH'] ?? ''}`
      }
      const proc = spawn(
        exe,
        ['-s', serial, '--window-title', `QZRS Scrcpy - ${serial}`],
        {
          windowsHide: false,
          stdio: 'ignore',
          detached: false,
          cwd: dirname(exe),
          env
        }
      )
      externalScrcpys.set(serial, proc)
      proc.on('exit', () => {
        externalScrcpys.delete(serial)
        log(`[scrcpy] 窗口已关闭 serial=${serial}`)
      })
      proc.on('error', (e) => {
        externalScrcpys.delete(serial)
        log(`[scrcpy] 启动失败: ${e.message}`)
      })
      log(`[scrcpy] 已启动 external-scrcpy serial=${serial}`)
      return { ok: true, path: exe }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, message: msg }
    }
  })
  ipcMain.handle('external-scrcpy:stop', async (_e, serial: string) => {
    const proc = externalScrcpys.get(serial)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      externalScrcpys.delete(serial)
    }
  })
  ipcMain.handle('external-scrcpy:resolve', () => {
    const settings = store.getSettings()
    return findScrcpy(settings.scrcpyPath) ?? ''
  })

  ipcMain.on('session:control', (_e, sessionId: string, cmd: ControlCommand) => {
    const h = sessions.get(sessionId)
    if (h) h.session.sendControl(cmd)
  })

  ipcMain.handle('session:broadcast', (_e, sessionIds: string[], cmd: ControlCommand) => {
    for (const id of sessionIds) {
      const h = sessions.get(id)
      if (h) h.session.sendControl(cmd)
    }
  })

  ipcMain.handle('device:shell', async (_e, serial: string, command: string) => {
    try {
      const a = ensureAdb()
      return await a.shell(serial, command, 120000)
    } catch (err) {
      return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 系统信息（一条组合命令 + 主进程解析成结构化对象）----
  ipcMain.handle('device:sysinfo', async (_e, serial: string) => {
    try {
      const a = ensureAdb()
      const cmd = [
        'echo "QZRS_MODEL=$(getprop ro.product.model)"',
        'echo "QZRS_BRAND=$(getprop ro.product.brand)"',
        'echo "QZRS_DEVICE=$(getprop ro.product.device)"',
        'echo "QZRS_ANDROID=$(getprop ro.build.version.release)"',
        'echo "QZRS_SDK=$(getprop ro.build.version.sdk)"',
        'echo "QZRS_BUILD=$(getprop ro.build.display.id)"',
        'echo "QZRS_SERIAL=$(getprop ro.serialno)"',
        'echo "QZRS_CPU=$(grep -m1 Hardware /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs)"',
        'echo "QZRS_CORES=$(grep -c ^processor /proc/cpuinfo 2>/dev/null)"',
        'echo "QZRS_MEMTOTAL=$(grep MemTotal /proc/meminfo | tr -s " " | cut -d" " -f2)"',
        'echo "QZRS_MEMAVAIL=$(grep MemAvailable /proc/meminfo | tr -s " " | cut -d" " -f2)"',
        'echo "QZRS_UPTIME=$(cut -d" " -f1 /proc/uptime)"',
        'echo "QZRS_RES=$(wm size 2>/dev/null | grep -i physical | head -1 | sed "s/.*: *//")"',
        'echo "QZRS_DENSITY=$(wm density 2>/dev/null | grep -i physical | head -1 | sed "s/.*: *//")"',
        'echo "QZRS_BATT=$(dumpsys battery 2>/dev/null | grep -m1 level | tr -d "\r" | sed "s/.*: *//")"',
        'echo "QZRS_BATTSTATUS=$(dumpsys battery 2>/dev/null | grep -m1 status | tr -d "\r" | sed "s/.*: *//")"',
        'echo "QZRS_BATTTEMP=$(dumpsys battery 2>/dev/null | grep -m1 temperature | tr -d "\r" | sed "s/.*: *//")"',
        'echo "QZRS_ROOT=$(which su >/dev/null 2>&1 && echo yes || echo no)"',
        'echo QZRS_DF_BEGIN',
        'df -h /data /sdcard /system 2>/dev/null | tail -n +2',
        'echo QZRS_DF_END'
      ].join('\n')
      const r = await a.shell(serial, cmd, 30000)
      if (r.code !== 0 && !r.stdout) {
        return { ok: false, message: (r.stderr || '获取系统信息失败').trim() }
      }
      return parseSystemInfo(r.stdout)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 网络信息 ----
  ipcMain.handle('device:netinfo', async (_e, serial: string) => {
    try {
      const a = ensureAdb()
      const cmd = [
        'echo "QZRS_SSID=$(dumpsys wifi 2>/dev/null | grep -m1 "mWifiInfo" | sed "s/.*SSID: //; s/,.*//")"',
        'echo "QZRS_BSSID=$(dumpsys wifi 2>/dev/null | grep -m1 "mWifiInfo" | sed "s/.*BSSID: //; s/,.*//")"',
        'echo "QZRS_RSSI=$(dumpsys wifi 2>/dev/null | grep -m1 "mWifiInfo" | sed "s/.*RSSI: //; s/,.*//")"',
        'echo "QZRS_GW=$(ip route 2>/dev/null | grep default | head -1 | tr -s " " | cut -d" " -f3)"',
        'echo "QZRS_DNS1=$(getprop net.dns1)"',
        'echo "QZRS_DNS2=$(getprop net.dns2)"',
        'echo "QZRS_CARRIER=$(getprop gsm.operator.alpha)"',
        'echo QZRS_IF_BEGIN',
        'ip -o -4 addr show 2>/dev/null | tr -s " " | cut -d" " -f2,4',
        'echo QZRS_IF_END'
      ].join('\n')
      const r = await a.shell(serial, cmd, 30000)
      if (r.code !== 0 && !r.stdout) {
        return { ok: false, message: (r.stderr || '获取网络信息失败').trim() }
      }
      return parseNetworkInfo(r.stdout)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 应用管理：列表（包名 + 应用名；第三方应用顺带解析 label）----
  ipcMain.handle('device:apps:list', async (_e, serial: string, includeSystem: boolean) => {
    try {
      const a = ensureAdb()
      // 第三方应用：用一次 shell 循环把每个包的 label 一起解析出来（循环跑在设备端，只有一次 adb 往返）。
      // 系统应用数量多（300+），逐个 resolve 会拖十几秒，且用户基本只关心第三方 → 系统视图只给包名。
      const listCmd = includeSystem
        ? "pm list packages 2>/dev/null | sed 's/package://'"
        : [
            "pm list packages -3 2>/dev/null | sed 's/package://' | while read -r p; do",
            "  printf '%s|' \"$p\"",
            '  cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$p" 2>/dev/null | grep -m1 "^label=" | sed "s/^label=//"',
            'done'
          ].join('\n')
      const r = await a.shell(serial, listCmd, 60000)
      if (r.code !== 0 && !r.stdout) {
        return { ok: false, message: (r.stderr || '获取应用列表失败').trim(), apps: [] }
      }
      const apps: AppInfo[] = r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf('|')
          const pkg = i >= 0 ? line.slice(0, i).trim() : line.trim()
          const label = i >= 0 ? line.slice(i + 1).trim() : ''
          return { pkg, label, versionName: '', versionCode: '' }
        })
        .filter((x) => x.pkg)
      return { ok: true, apps }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), apps: [] }
    }
  })

  // ---- 应用管理：操作（启动/停止/卸载/清数据/详情）----
  ipcMain.handle('device:apps:action', async (_e, serial: string, action: AppAction, pkg: string) => {
    try {
      const a = ensureAdb()
      const p = String(pkg || '').trim()
      if (!p) return { ok: false, message: '缺少包名' }
      let cmd = ''
      let timeout = 30000
      switch (action) {
        case 'launch':
          cmd = `monkey -p ${p} -c android.intent.category.LAUNCHER 1`
          break
        case 'stop':
          cmd = `am force-stop ${p}`
          break
        case 'uninstall':
          cmd = `pm uninstall ${p}`
          timeout = 60000
          break
        case 'clear':
          cmd = `pm clear ${p}`
          timeout = 60000
          break
        case 'info':
          cmd = [
            `echo "label=$(cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${p} 2>/dev/null | grep -m1 '^label=' | sed 's/^label=//')"`,
            `dumpsys package ${p} | grep -E 'versionName=|versionCode=|userId=|firstInstallTime=|lastUpdateTime='`
          ].join('\n')
          break
        default:
          return { ok: false, message: '未知操作' }
      }
      const r = await a.shell(serial, cmd, timeout)
      const out = (r.stdout || '').trim()
      const err = (r.stderr || '').trim()
      const detail = action === 'info' ? out : undefined
      const ok = r.code === 0 && !/(Error|Failure|Exception)/i.test(err)
      return { ok, message: ok ? (out || '成功') : (err || out || `执行失败（exit ${r.code}）`), detail }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 系统日志（logcat 流式）----
  ipcMain.handle('device:logcat:start', (_e, serial: string, filter: string) => {
    try {
      const a = ensureAdb()
      // 过滤串白名单：只允许 tag:level 语法里的字符，避免命令注入
      const f = /^[a-zA-Z0-9:* ._\-]+$/.test(String(filter || '')) ? String(filter).trim() : ''
      const old = logcatProcs.get(serial)
      if (old) {
        try {
          old.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      const proc = a.streamShell(
        serial,
        f ? `logcat -v time ${f}` : 'logcat -v time',
        (line) => send('logcat:line', { serial, line }),
        () => logcatProcs.delete(serial)
      )
      logcatProcs.set(serial, proc)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:logcat:stop', (_e, serial: string) => {
    const proc = logcatProcs.get(serial)
    if (proc) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      logcatProcs.delete(serial)
    }
    return { ok: true }
  })

  ipcMain.handle('device:logcat:clear', async (_e, serial: string) => {
    try {
      const a = ensureAdb()
      await a.shell(serial, 'logcat -c', 30000)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:push', async (_e, serial: string, localPath: string, remotePath: string) => {
    try {
      const a = ensureAdb()
      const r = await a.push(serial, localPath, remotePath)
      return { ok: r.code === 0, message: (r.stdout || r.stderr).trim() }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('dialog:openFile', async (_e: IpcMainInvokeEvent) => {
    const win = getWin()
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, s: AppSettings) => {
    store.setSettings(s)
    // 脚本日志落盘开关 / 全局停止热键都可能变了，同步内存镜像并重注册
    scriptLogToFile = s.scriptLogToFile === true
    applyScriptHotkey()
    // re-resolve adb/server if path changed
    adb = null
    adbPath = ''
    // 窗口底色跟随主题（浅色模式下不能还是深色）
    const bg = themeBackground(s.theme)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.setBackgroundColor(bg)
    }
    // adb 路径可能变了：按新路径重启 track-devices 监听（失败自动退回轮询）
    restartDeviceWatcher()
    // Python 桥开关/端口可能变了
    applyBridge()
  })
  ipcMain.handle('settings:resolvePaths', () => {
    try {
      ensureAdb()
      return { adbPath, serverPath }
    } catch {
      return { adbPath: findAdb(store.getSettings().adbPath) ?? '', serverPath: findServer(store.getSettings().serverPath) ?? '' }
    }
  })
  // ---- 自更新（软件更新）----
  // 状态是主进程的一份快照，渲染层只读不拼：checking/available/downloading/staged 的
  // 语义都在 update-service 里，界面上任何一处自己推断都会出现两份真相。
  ipcMain.handle('update:state', () => updateService.snapshot())
  ipcMain.handle('update:check', () => updateService.check())
  ipcMain.handle('update:download', () => updateService.download())
  ipcMain.handle('update:apply', () => updateService.applyAndRestart())
  ipcMain.handle('update:openDir', async () => {
    const dir = updateService.ensureDir()
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err, dir } : { ok: true, dir }
  })

  ipcMain.handle('keymaps:get', () => store.getKeymaps())
  ipcMain.handle('keymaps:set', (_e, k: KeymapConfig[]) => store.setKeymaps(k))

  // 导出单个方案为 json 文件（默认落在方案文件夹里，文件名取方案名）
  ipcMain.handle('keymaps:export', async (_e, id: string) => {
    const cfg = store.getKeymaps().find((c) => c.id === id)
    if (!cfg) return { ok: false, message: '方案不存在' }
    const safe = (cfg.name || 'keymap').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const win = getWin()
    const saveOpts: SaveDialogOptions = {
      title: '导出按键方案',
      defaultPath: join(store.getKeymapsDir(), `${safe}.json`),
      filters: [{ name: '按键方案', extensions: ['json'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts)
    if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }
    try {
      writeFileSync(res.filePath, JSON.stringify(cfg, null, 2), 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 从 json 导入方案，兼容单方案文件和方案数组；id/名称冲突自动改名
  ipcMain.handle('keymaps:import', async () => {
    const win = getWin()
    const openOpts: OpenDialogOptions = {
      title: '导入按键方案',
      filters: [{ name: '按键方案', extensions: ['json'] }],
      properties: ['openFile']
    }
    const res = win ? await dialog.showOpenDialog(win, openOpts) : await dialog.showOpenDialog(openOpts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, message: '已取消' }
    try {
      const raw: unknown = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
      const incoming = (Array.isArray(raw) ? raw : [raw]) as KeymapConfig[]
      const list = store.getKeymaps()
      const ids = new Set(list.map((c) => c.id))
      const names = new Set(list.map((c) => c.name))
      const added: KeymapConfig[] = []
      for (const cfg of incoming) {
        if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.bindings)) continue
        let id = cfg.id || `km${Date.now().toString(36)}`
        if (ids.has(id)) id = `km${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
        let name = cfg.name || '导入的方案'
        if (names.has(name)) name = `${name} (导入)`
        ids.add(id)
        names.add(name)
        added.push({
          ...cfg,
          id,
          name,
          bindings: cfg.bindings,
          overlays: Array.isArray(cfg.overlays) ? cfg.overlays : []
        })
      }
      if (added.length === 0) return { ok: false, message: '文件中没有有效的按键方案' }
      const next = [...list, ...added]
      store.setKeymaps(next)
      return { ok: true, keymaps: next, added: added.length }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('keymaps:openDir', () => {
    const dir = store.getKeymapsDir()
    void shell.openPath(dir)
    return { ok: true, dir }
  })

  // ---- user scripts（JS 自动化）----
  ipcMain.handle('scripts:list', () => store.getScripts())

  // 保存脚本（id 为空 = 新建）。name trim + 40 字上限，code 100k 上限（与引擎一致）。
  ipcMain.handle('scripts:save', (_e, id: string, name: string, code: string) => {
    try {
      const trimmedName = String(name ?? '').trim().slice(0, 40) || '未命名脚本'
      const trimmedCode = String(code ?? '')
      if (trimmedCode.trim().length === 0) return { ok: false, message: '脚本内容为空' }
      if (trimmedCode.length > 100_000) return { ok: false, message: '脚本过长（>100000 字符）' }
      let list = store.getScripts()
      let scriptId = String(id ?? '').trim()
      if (scriptId) {
        if (!list.some((s) => s.id === scriptId)) return { ok: false, message: '脚本不存在（可能已被删除）' }
        list = list.map((s) => (s.id === scriptId ? { ...s, name: trimmedName, code: trimmedCode, updatedAt: Date.now() } : s))
      } else {
        scriptId = `sc${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
        list = [...list, { id: scriptId, name: trimmedName, code: trimmedCode, updatedAt: Date.now() }]
      }
      const next = store.setScripts(list)
      return { ok: true, id: scriptId, scripts: next }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('scripts:delete', (_e, id: string) => {
    try {
      const next = store.setScripts(store.getScripts().filter((s) => s.id !== String(id)))
      return { ok: true, scripts: next }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 运行脚本：渲染层把目标会话 sessionId 发过来（一个脚本同一时间只跑一份）。
  // 引擎把 started/log/done/stopped/error 通过 'script:event' 推给渲染层。
  ipcMain.handle('scripts:run', (_e, scriptId: string, sessionId: string, loopMs?: number, maxRounds?: number) => {
    try {
      const script = store.getScripts().find((s) => s.id === String(scriptId))
      if (!script) return { ok: false, message: '脚本不存在' }
      const sid = String(sessionId)
      const loop = Number(loopMs) || 0
      const rounds = Number(maxRounds) || 0
      // loopMs > 0 = 录制宏的「每 N 秒重播一遍」；loopMs < 0 = 连续循环（跑完立即重跑）；都由引擎包成 while 循环
      const { runId } = scriptEngine.run(script, sid, { loopMs: loop, maxRounds: rounds })
      // 登记运行参数：断线自动重连（方案 B）时据此判断要不要重建会话、重跑时还原参数
      const h = sessions.get(sid)
      rememberRunningScript(String(scriptId), sid, h?.serial ?? '', h?.opts, loop, rounds, script.name)
      return { ok: true, runId }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('scripts:stop', (_e, runId: string) => {
    scriptEngine.stop(String(runId))
    return { ok: true }
  })

  ipcMain.handle('scripts:running', () => scriptEngine.running())

  ipcMain.handle('scripts:openDir', () => {
    void shell.openPath(store.getScriptsDir())
    return { ok: true, dir: store.getScriptsDir() }
  })

  // 脚本运行日志目录（logs/scripts；展示 + 打开用）
  ipcMain.handle('scripts:logDir', () => scriptLogger.dir ?? scriptLogDirCandidates()[0])
  ipcMain.handle('scripts:openLogDir', () => {
    void shell.openPath(scriptLogger.dir ?? scriptLogDirCandidates()[0])
    return { ok: true, dir: scriptLogger.dir ?? scriptLogDirCandidates()[0] }
  })

  // 导出单个脚本为 json 文件（默认落在「文档」目录，文件名取脚本名）。
  // ⚠️ 不要把默认路径放进 scripts/ 目录：那里每脚本一个文件，setScripts 保存时会
  //    清掉目录里不在 keep 集合中的 json，导出的备份文件会被误删。
  ipcMain.handle('scripts:export', async (_e, id: string) => {
    const script = store.getScripts().find((s) => s.id === String(id))
    if (!script) return { ok: false, message: '脚本不存在' }
    const safe = (script.name || 'script').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const win = getWin()
    const saveOpts: SaveDialogOptions = {
      title: '导出脚本',
      defaultPath: join(app.getPath('documents'), `${safe}.json`),
      filters: [{ name: '脚本', extensions: ['json'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts)
    if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }
    try {
      writeFileSync(
        res.filePath,
        JSON.stringify({ type: 'qzrs-script', version: 1, name: script.name, code: script.code, updatedAt: script.updatedAt }, null, 2),
        'utf8'
      )
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 从 json 导入脚本：兼容单脚本对象和脚本数组；id 一律重新生成、同名自动改名。
  ipcMain.handle('scripts:import', async () => {
    const win = getWin()
    const openOpts: OpenDialogOptions = {
      title: '导入脚本',
      filters: [{ name: '脚本', extensions: ['json'] }],
      properties: ['openFile']
    }
    const res = win ? await dialog.showOpenDialog(win, openOpts) : await dialog.showOpenDialog(openOpts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, message: '已取消' }
    try {
      const raw: unknown = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
      const incoming = (Array.isArray(raw) ? raw : [raw]) as Array<{ name?: unknown; code?: unknown }>
      const list = store.getScripts()
      const names = new Set(list.map((s) => s.name))
      const added: ScriptInfo[] = []
      const now = Date.now()
      for (const item of incoming) {
        if (!item || typeof item !== 'object') continue
        const code = typeof item.code === 'string' ? item.code : ''
        if (code.trim().length === 0 || code.length > 100_000) continue
        const baseName = (typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '导入的脚本').slice(0, 40)
        let unique = baseName
        if (names.has(baseName)) {
          unique = `${baseName} (导入)`
          let n = 2
          while (names.has(unique)) {
            unique = `${baseName} (导入${n})`
            n += 1
          }
        }
        names.add(unique)
        added.push({
          id: `sc${now.toString(36)}${added.length.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          name: unique,
          code,
          updatedAt: now
        })
      }
      if (added.length === 0) return { ok: false, message: '文件中没有有效的脚本' }
      const next = store.setScripts([...list, ...added])
      return { ok: true, scripts: next, added: added.length }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- Python 脚本（scripts/python/*.py，独立进程运行）----
  ipcMain.handle('pyscripts:list', () => {
    const dir = pyScriptsDir()
    return { dir, scripts: pyManager.list(dir) }
  })
  ipcMain.handle('pyscripts:run', (_e, file: string) => {
    const s = store.getSettings()
    // 注入桥 Token + 桥客户端目录（qzrs.py）：脚本无需手动配置即可 import qzrs 并连桥
    const info = bridge.info()
    const env: Record<string, string> = {}
    if (info.running && info.token) env.QZRS_TOKEN = info.token
    return pyManager.run(pyScriptsDir(), file, s.pythonPath, bridgeClientDir(), env)
  })
  ipcMain.handle('pyscripts:stop', (_e, runId: string) => ({ ok: pyManager.stop(String(runId ?? '')) }))
  ipcMain.handle('pyscripts:running', () => pyManager.running())
  ipcMain.handle('pyscripts:openDir', () => {
    const dir = pyScriptsDir()
    void shell.openPath(dir)
    return { ok: true, dir }
  })

  // waitImage 模板：渲染层从截图上框选裁出 PNG（base64），主进程落盘到 scripts/templates/
  ipcMain.handle('scripts:saveTemplate', (_e, name: string, base64Png: string) => {
    try {
      const trimmed = String(name ?? '').trim()
      if (!trimmed) return { ok: false, message: '模板名不能为空' }
      const buf = Buffer.from(String(base64Png), 'base64')
      if (buf.length === 0) return { ok: false, message: '模板内容为空' }
      const path = store.saveTemplate(trimmed, buf)
      return { ok: true, path, templates: store.getTemplates() }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('scripts:listTemplates', () => store.getTemplates())
  ipcMain.handle('scripts:deleteTemplate', (_e, name: string) => {
    store.deleteTemplate(String(name))
    return { ok: true, templates: store.getTemplates() }
  })

  // ---- Python 外挂桥 ----
  ipcMain.handle('bridge:status', () => ({
    enabled: store.getSettings().bridgeEnabled === true,
    ...bridge.info(),
    clientDir: bridgeClientDir()
  }))
  ipcMain.handle('bridge:openDir', () => {
    const dir = writeBridgeClients(bridgeClientDir())
    void shell.openPath(dir)
    return { ok: true, dir }
  })

  // ---- OCR 模型 ----
  ipcMain.handle('ocr:status', async () => ({
    ...(await ocrModelsStatus()),
    manualUrl: OCR_MANUAL_URL,
    downloading: ocrDownloader.running
  }))
  ipcMain.handle('ocr:download', () => {
    if (ocrDownloader.running) return { ok: false, message: '已有下载在进行中' }
    // 异步开跑，进度通过 'ocr:progress' 事件推给渲染层
    void ocrDownloader.downloadAll()
    return { ok: true }
  })
  ipcMain.handle('ocr:openDir', () => {
    const dir = resolveOcrModelDir()
    void shell.openPath(dir)
    return { ok: true, dir }
  })
  ipcMain.handle('ocr:openManual', () => {
    if (!OCR_MANUAL_URL) return { ok: false, message: '未配置手动下载地址' }
    void shell.openExternal(OCR_MANUAL_URL)
    return { ok: true }
  })
  ipcMain.handle('ocr:test', async () => {
    // 找第一个活动会话做一次真实识别（供设置面板「测试识别」验证模型是否可用）
    const entry = [...sessions.entries()][0]
    if (!entry) return { ok: false, message: '请先连接设备并开始投屏' }
    const [sessionId] = entry
    try {
      const cap = await captureBitmap(sessionId)
      if (!cap) return { ok: false, message: '截屏失败（会话可能已断开）' }
      const t0 = Date.now()
      const r = await ocrEngine.recognize(cap.bmp, cap.width, cap.height)
      return {
        ok: true,
        text: r.text,
        lines: r.lines.length,
        elapsedMs: Date.now() - t0,
        width: cap.width,
        height: cap.height
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- fullscreen ----
  ipcMain.handle('fullscreen:enter', async () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
    try {
      log(`enterFullscreen: kiosk=${win.isKiosk()}, frame=${win.isFullScreen()} frameless=${win.isFullScreen()}`)
      win.setFullScreen(false)
      win.setKiosk(true)
      log(`enterFullscreen: done, kiosk=${win.isKiosk()}`)
      return { ok: true }
    } catch (err) {
      log(`enterFullscreen error: ${err}`)
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle('fullscreen:exit', async () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
    try {
      log(`exitFullscreen: kiosk=${win.isKiosk()}`)
      win.setKiosk(false)
      log(`exitFullscreen: done`)
      return { ok: true }
    } catch (err) {
      log(`exitFullscreen error: ${err}`)
      return { ok: false, error: String(err) }
    }
  })

  // ---- window controls ----
  ipcMain.handle('window:minimize', () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false }
    win.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:maximize', () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false }
    win.maximize()
    return { ok: true }
  })
  ipcMain.handle('window:close', () => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false }
    win.close()
    return { ok: true }
  })

  ipcMain.on('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('dialog:chooseDir', async (_e: IpcMainInvokeEvent) => {
    const win = getWin()
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- capture & file transfer ----
  ipcMain.handle('device:screenshot', async (_e, serial: string) => {
    try {
      const a = ensureAdb()
      const buf = await a.screencap(serial)
      return { ok: true, data: buf.toString('base64') }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('record:start', async (_e, serial: string, bitRate: number) => {
    try {
      const a = ensureAdb()
      if (records.has(serial)) return { ok: false, message: '该设备正在录制中' }
      const remote = `/sdcard/scrcpy_rec_${Date.now()}.mp4`
      const r = await a.shell(serial, `screenrecord --bit-rate ${bitRate || 8000000} ${remote} >/dev/null 2>&1 & echo started`)
      if (r.code !== 0) return { ok: false, message: r.stdout || r.stderr }
      records.set(serial, remote)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('record:stop', async (_e, serial: string) => {
    const remote = records.get(serial)
    if (!remote) return { ok: false, message: '该设备未在录制' }
    records.delete(serial)
    try {
      const a = ensureAdb()
      // send SIGINT so screenrecord finalizes the mp4
      await a.shell(serial, 'pkill -2 screenrecord || pkill -INT screenrecord')
      await new Promise((res) => setTimeout(res, 1500))
      const local = join(app.getPath('temp'), basename(remote))
      const p = await a.pull(serial, remote, local)
      await a.shell(serial, `rm -f ${remote}`)
      if (p.code !== 0) return { ok: false, message: p.stderr || p.stdout || '拉取录屏失败' }
      const win = getWin()
      const save = await dialog.showSaveDialog(win!, {
        defaultPath: 'scrcpy_recording.mp4',
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
      })
      if (!save.canceled && save.filePath) {
        copyFileSync(local, save.filePath)
        return { ok: true, path: save.filePath }
      }
      return { ok: true, path: local }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:pull', async (_e, serial: string, remotePath: string) => {
    try {
      const a = ensureAdb()
      const win = getWin()
      const save = await dialog.showSaveDialog(win!, { defaultPath: basename(remotePath) })
      if (save.canceled || !save.filePath) return { ok: false, message: '已取消' }
      const p = await a.pull(serial, remotePath, save.filePath)
      return { ok: p.code === 0, message: p.code === 0 ? save.filePath : (p.stderr || p.stdout) }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 设备文件管理器 ----
  ipcMain.handle('device:listDir', async (_e, serial: string, remotePath: string) => {
    try {
      const a = ensureAdb()
      return await a.listDir(serial, remotePath)
    } catch (err) {
      const p = normalizeRemotePath(remotePath)
      return { ok: false, path: p, parent: null, entries: [], message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('device:delete', async (_e, serial: string, remotePath: string) => {
    try {
      const a = ensureAdb()
      const r = await a.removePath(serial, remotePath)
      if (r.code === 0) return { ok: true, message: remotePath }
      return { ok: false, message: (r.stderr || r.stdout).trim() || `删除失败（exit ${r.code}）` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 移动 / 复制（批量）：返回逐条结果，UI 负责二次确认覆盖
  ipcMain.handle(
    'device:transfer',
    async (_e, serial: string, mode: 'move' | 'copy', sources: string[], destDir: string, overwrite: boolean) => {
      try {
        if (!Array.isArray(sources) || sources.length === 0) {
          return { ok: false, message: '没有选中任何文件', okNames: [], conflicts: [], failed: [] }
        }
        const a = ensureAdb()
        return await a.transferPaths(serial, mode, sources, destDir, overwrite === true)
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          okNames: [],
          conflicts: [],
          failed: []
        }
      }
    }
  )

  // 下载到用户选择的本地文件夹（文件/目录都适用；目录会被整个拉取）
  ipcMain.handle('device:pullTo', async (_e, serial: string, remotePath: string) => {
    try {
      const win = getWin()
      const pick = await dialog.showOpenDialog(win!, {
        title: '选择保存到的文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      if (pick.canceled || !pick.filePaths[0]) return { ok: false, message: '已取消' }
      const target = pick.filePaths[0]
      const a = ensureAdb()
      const r = await a.pull(serial, remotePath, target)
      return r.code === 0
        ? { ok: true, message: target }
        : { ok: false, message: (r.stderr || r.stdout).trim() || '下载失败' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 多选文件（上传用）
  ipcMain.handle('dialog:openFiles', async (_e: IpcMainInvokeEvent) => {
    const win = getWin()
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('file:save', async (_e, defaultName: string, base64: string) => {
    try {
      const win = getWin()
      const save = await dialog.showSaveDialog(win!, { defaultPath: defaultName })
      if (save.canceled || !save.filePath) return { ok: false, message: '已取消' }
      writeFileSync(save.filePath, Buffer.from(base64, 'base64'))
      return { ok: true, path: save.filePath }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- debug log to file ----
  // 渲染层每 ~1s 批量推一批调试行（MirrorView 的 pushDebug 缓冲）；目录在首次写入时按需创建。
  ipcMain.on('debug:log', (_e, lines: unknown) => {
    if (!Array.isArray(lines)) return
    for (const l of lines) {
      if (typeof l === 'string' && l.length > 0) debugLogger.write(l)
    }
  })
  // 设置面板展示日志目录用：优先返回已确定/首选候选
  ipcMain.handle('debug:logdir', () => debugLogger.dir ?? debugLogDirCandidates()[0])

  // ---- debug log to file (end) ----

  startDeviceWatcher()
  startAutoReconnect()
  applyBridge()
  applyScriptHotkey()
  log('应用已启动')

  return {
    update: updateService,
    async dispose() {
      debugLogger.flushSync()
      scriptLogger.flushSync()
      try {
        globalShortcut.unregisterAll()
      } catch {
        /* ignore */
      }
      scriptEngine.stopAll() // 停掉所有运行中的脚本（等价于抬起手指，防止退出后虚拟手指悬挂）
      pyManager.stopAll() // Python 脚本子进程一并杀掉（taskkill /T 连树杀）
      await bridge.stop() // Python 桥一并关闭（手势中途退出最多丢一次 UP，scrcpy 会话本身随进程结束）
      killWatcher()
      stopPolling()
      if (reconnectTimer) {
        clearInterval(reconnectTimer)
        reconnectTimer = null
      }
      if (reconnectLoopTimer) {
        clearInterval(reconnectLoopTimer)
        reconnectLoopTimer = null
      }
      if (watcherRestartTimer) {
        clearTimeout(watcherRestartTimer)
        watcherRestartTimer = null
      }
      if (watcherRefreshTimer) {
        clearTimeout(watcherRefreshTimer)
        watcherRefreshTimer = null
      }
      stopStatsPolling()
      for (const h of sessions.values()) {
        await h.session.stop()
      }
      sessions.clear()
      // 关闭所有外部 scrcpy 子进程，避免退出后 scrcpy.exe 残留
      for (const proc of externalScrcpys.values()) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      externalScrcpys.clear()
      // 关闭流式 logcat 子进程
      for (const proc of logcatProcs.values()) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      logcatProcs.clear()
      // 停止仍在录屏的设备，避免退出后 screenrecord 进程残留占满存储
      if (adb) {
        for (const [serial, remote] of records) {
          await adb.shell(serial, 'pkill -2 screenrecord || pkill -INT screenrecord').catch(() => undefined)
          await adb.shell(serial, `rm -f ${remote}`).catch(() => undefined)
        }
      }
      records.clear()
    }
  }
}
