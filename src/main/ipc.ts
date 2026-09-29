import { ipcMain, dialog, clipboard, app, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { AdbClient, deepScanSubnets, fastScanSubnets, scanLanAdb } from './adb'
import { mergeDeviceHistory } from './devices'
import { ScrcpySession } from './session'
import { Store, debugLogDirCandidates } from './stores'
import { DebugFileLogger } from './debuglog'
import { themeBackground } from './theme'
import { findAdb, findServer, findScrcpy } from './util'
import type {
  DeviceInfo,
  SessionOptions,
  ControlCommand,
  AppSettings,
  KeymapConfig,
  FrameEvent,
  StreamMeta,
  SessionStateEvent,
  SessionStats
} from '@shared/types'

export interface AppManager {
  dispose(): Promise<void>
}

interface SessionHandle {
  session: ScrcpySession
  serial: string
}

export function registerIpc(store: Store): AppManager {
  const sessions = new Map<string, SessionHandle>()
  const records = new Map<string, string>() // serial -> remote record path
  // 外部 scrcpy.exe 子进程（serial -> ChildProcess），用于在 WebCodecs 渲染异常时
  // 临时回退到官方 scrcpy 自己的 SDL 窗口看画面（不嵌入，独立窗口）。
  const externalScrcpys = new Map<string, ChildProcess>()
  let adb: AdbClient | null = null
  let adbPath = ''
  let serverPath = ''
  let lastDevicesJson = ''
  let pollTimer: NodeJS.Timeout | null = null
  let statsTimer: NodeJS.Timeout | null = null
  // 调试日志落盘器（设置「调试时写入日志文件」+ 调试开关同时打开才会真正写入）
  const debugLogger = new DebugFileLogger(debugLogDirCandidates())
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

  // ---- session management ----
  function startSession(serial: string, opts: SessionOptions): { sessionId: string } {
    const a = ensureAdb()
    const sessionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const session = new ScrcpySession(sessionId, a, serial, opts, serverPath, {
      onStarted: (info) => {
        sessions.set(sessionId, { session, serial })
        startStatsPolling()
        send('session:state', { sessionId, state: 'started', serial, deviceName: info.deviceName, width: info.width, height: info.height } satisfies SessionStateEvent)
        log(`[${info.deviceName}] 已连接，视频 ${info.width}x${info.height}`)
      },
      onFrame: (sid, data, pts, isKey, isConfig) => {
        const evt: FrameEvent = { sessionId: sid, data, pts, isKey, isConfig }
        send('session:frame', evt)
      },
      onStreamMeta: (meta: StreamMeta) => {
        send('session:meta', meta)
      },
      onStopped: (sid) => {
        const serial = sessions.get(sid)?.serial ?? ''
        sessions.delete(sid)
        if (sessions.size === 0) stopStatsPolling()
        send('session:state', { sessionId: sid, serial, state: 'stopped' } satisfies SessionStateEvent)
      },
      onError: (sid, message) => {
        const serial = sessions.get(sid)?.serial ?? ''
        sessions.delete(sid)
        if (sessions.size === 0) stopStatsPolling()
        send('session:state', { sessionId: sid, serial, state: 'error', message } satisfies SessionStateEvent)
        log(`[错误] ${message}`)
      },
      onClipboard: (sid, text) => {
        clipboard.writeText(text)
        send('session:state', { sessionId: sid, state: 'clipboard', text } satisfies SessionStateEvent)
      },
      onLog: (_sid, line) => {
        if (line) log(line)
      }
    })
    sessions.set(sessionId, { session, serial })
    void session.start()
    return { sessionId }
  }

  // ---- IPC handlers ----
  ipcMain.handle('devices:list', () => refreshDevices())
  ipcMain.handle('devices:refresh', () => refreshDevices())

  // 扫描局域网内开放 adb 端口的设备（adb tcpip 模式不发 mDNS 广播，只能扫端口）
  // allSubnets=true 时额外连虚拟机/虚拟网卡网段一起扫（慢很多，按需开启）；回环两种模式都会扫
  ipcMain.handle('devices:scan', async (_e, port?: number, allSubnets?: boolean) => {
    try {
      const subnets = allSubnets ? deepScanSubnets() : fastScanSubnets()
      let found = await scanLanAdb(port ?? 5555, { allSubnets: !!allSubnets })
      // 一台都没扫到时自动重试一次：设备偶发无响应会导致误报"未发现"
      if (found.length === 0) {
        found = await scanLanAdb(port ?? 5555, { allSubnets: !!allSubnets, timeoutMs: 700, concurrency: 96 })
      }
      return { ok: true, ips: found, subnets }
    } catch (err) {
      return { ok: false, ips: [], subnets: [], message: err instanceof Error ? err.message : String(err) }
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
  })
  ipcMain.handle('settings:resolvePaths', () => {
    try {
      ensureAdb()
      return { adbPath, serverPath }
    } catch {
      return { adbPath: findAdb(store.getSettings().adbPath) ?? '', serverPath: findServer(store.getSettings().serverPath) ?? '' }
    }
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
  log('应用已启动')

  return {
    async dispose() {
      debugLogger.flushSync()
      killWatcher()
      stopPolling()
      if (reconnectTimer) {
        clearInterval(reconnectTimer)
        reconnectTimer = null
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
