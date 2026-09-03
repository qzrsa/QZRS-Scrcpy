import { ipcMain, dialog, clipboard, app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { AdbClient } from './adb'
import { ScrcpySession } from './session'
import { Store } from './stores'
import { findAdb, findServer } from './util'
import type {
  DeviceInfo,
  SessionOptions,
  ControlCommand,
  AppSettings,
  KeymapConfig,
  FrameEvent,
  StreamMeta,
  SessionStateEvent
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
  let adb: AdbClient | null = null
  let adbPath = ''
  let serverPath = ''
  let lastDevicesJson = ''
  let pollTimer: NodeJS.Timeout | null = null

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
  async function refreshDevices(): Promise<DeviceInfo[]> {
    try {
      const a = ensureAdb()
      const list = await a.devices()
      const json = JSON.stringify(list)
      if (json !== lastDevicesJson) {
        lastDevicesJson = json
        send('devices:changed', list)
      }
      return list
    } catch {
      return []
    }
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

  // ---- session management ----
  function startSession(serial: string, opts: SessionOptions): { sessionId: string } {
    const a = ensureAdb()
    const sessionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const session = new ScrcpySession(sessionId, a, serial, opts, serverPath, {
      onStarted: (info) => {
        sessions.set(sessionId, { session, serial })
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
        sessions.delete(sid)
        send('session:state', { sessionId: sid, state: 'stopped' } satisfies SessionStateEvent)
      },
      onError: (sid, message) => {
        sessions.delete(sid)
        send('session:state', { sessionId: sid, state: 'error', message } satisfies SessionStateEvent)
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

  ipcMain.handle('session:start', (_e, serial: string, opts: SessionOptions) => startSession(serial, opts))
  ipcMain.handle('session:stop', async (_e, sessionId: string) => {
    const h = sessions.get(sessionId)
    if (h) await h.session.stop()
    sessions.delete(sessionId)
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

  startPolling()
  log('应用已启动')

  return {
    async dispose() {
      stopPolling()
      for (const h of sessions.values()) {
        await h.session.stop()
      }
      sessions.clear()
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
