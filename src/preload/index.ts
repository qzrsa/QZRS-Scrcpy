import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceInfo,
  SessionOptions,
  ControlCommand,
  AppSettings,
  KeymapConfig,
  FrameEvent,
  StreamMeta,
  SessionStateEvent,
  SessionStats,
  AdbShellResult,
  OpResult
} from '@shared/types'

const api = {
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:list'),
  refreshDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:refresh'),
  connectDevice: (hostPort: string): Promise<OpResult> => ipcRenderer.invoke('device:connect', hostPort),
  disconnectDevice: (hostPort: string): Promise<OpResult> => ipcRenderer.invoke('device:disconnect', hostPort),
  /** 从历史设备列表里删除（tcpip 设备会先 adb disconnect，避免轮询立刻写回） */
  forgetDevice: (serial: string): Promise<OpResult> => ipcRenderer.invoke('devices:forget', serial),
  setTcpip: (serial: string, port: number): Promise<OpResult> => ipcRenderer.invoke('device:tcpip', serial, port),
  scanLanDevices: (
    port?: number,
    allSubnets?: boolean
  ): Promise<{ ok: boolean; ips: string[]; subnets: string[]; message?: string }> =>
    ipcRenderer.invoke('devices:scan', port, allSubnets),

  startSession: (serial: string, opts: SessionOptions): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke('session:start', serial, opts),
  stopSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:stop', sessionId),
  sendControl: (sessionId: string, cmd: ControlCommand): void => {
    ipcRenderer.send('session:control', sessionId, cmd)
  },
  broadcastControl: (sessionIds: string[], cmd: ControlCommand): Promise<void> =>
    ipcRenderer.invoke('session:broadcast', sessionIds, cmd),

  runShell: (serial: string, command: string): Promise<AdbShellResult> =>
    ipcRenderer.invoke('device:shell', serial, command),
  pushFile: (serial: string, localPath: string, remotePath: string): Promise<OpResult> =>
    ipcRenderer.invoke('device:push', serial, localPath, remotePath),
  pullFile: (serial: string, remotePath: string): Promise<OpResult> =>
    ipcRenderer.invoke('device:pull', serial, remotePath),
  screenshot: (serial: string): Promise<{ ok: boolean; data?: string; message?: string }> =>
    ipcRenderer.invoke('device:screenshot', serial),
  startRecord: (serial: string, bitRate: number): Promise<OpResult> =>
    ipcRenderer.invoke('record:start', serial, bitRate),
  stopRecord: (serial: string): Promise<OpResult & { path?: string }> =>
    ipcRenderer.invoke('record:stop', serial),
  saveFile: (defaultName: string, base64: string): Promise<OpResult & { path?: string }> =>
    ipcRenderer.invoke('file:save', defaultName, base64),
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  openDirDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseDir'),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke('settings:set', s),
  enterFullscreen: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fullscreen:enter'),
  exitFullscreen: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fullscreen:exit'),
  minimizeWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:maximize'),
  closeWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:close'),
  resolvePaths: (): Promise<{ adbPath: string; serverPath: string; scrcpyPath: string }> =>
    ipcRenderer.invoke('settings:resolvePaths'),
  launchExternalScrcpy: (serial: string): Promise<OpResult> =>
    ipcRenderer.invoke('external-scrcpy:launch', serial),
  stopExternalScrcpy: (serial: string): Promise<void> =>
    ipcRenderer.invoke('external-scrcpy:stop', serial),
  getKeymaps: (): Promise<KeymapConfig[]> => ipcRenderer.invoke('keymaps:get'),
  setKeymaps: (k: KeymapConfig[]): Promise<void> => ipcRenderer.invoke('keymaps:set', k),
  exportKeymap: (
    id: string
  ): Promise<{ ok: boolean; path?: string; message?: string }> => ipcRenderer.invoke('keymaps:export', id),
  importKeymap: (): Promise<{
    ok: boolean
    keymaps?: KeymapConfig[]
    added?: number
    message?: string
  }> => ipcRenderer.invoke('keymaps:import'),
  openKeymapsDir: (): Promise<{ ok: boolean; dir?: string }> => ipcRenderer.invoke('keymaps:openDir'),
  /** 调试日志批量落盘（fire-and-forget；主进程在设置开启+调试打开时才会真正建目录写文件） */
  debugLog: (lines: string[]): void => ipcRenderer.send('debug:log', lines),
  /** 调试日志目录（设置面板展示用） */
  getDebugLogDir: (): Promise<string> => ipcRenderer.invoke('debug:logdir'),
  writeClipboard: (text: string): void => ipcRenderer.send('clipboard:write', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  onDevicesChanged: (cb: (devices: DeviceInfo[]) => void): (() => void) => {
    const l = (_e: unknown, d: DeviceInfo[]): void => cb(d)
    ipcRenderer.on('devices:changed', l)
    return () => ipcRenderer.removeListener('devices:changed', l)
  },
  onSessionState: (cb: (e: SessionStateEvent) => void): (() => void) => {
    const l = (_e: unknown, d: SessionStateEvent): void => cb(d)
    ipcRenderer.on('session:state', l)
    return () => ipcRenderer.removeListener('session:state', l)
  },
  onFrame: (cb: (e: FrameEvent) => void): (() => void) => {
    const l = (_e: unknown, d: FrameEvent): void => cb(d)
    ipcRenderer.on('session:frame', l)
    return () => ipcRenderer.removeListener('session:frame', l)
  },
  onStreamMeta: (cb: (e: StreamMeta) => void): (() => void) => {
    const l = (_e: unknown, d: StreamMeta): void => cb(d)
    ipcRenderer.on('session:meta', l)
    return () => ipcRenderer.removeListener('session:meta', l)
  },
  onSessionStats: (cb: (e: SessionStats) => void): (() => void) => {
    const l = (_e: unknown, d: SessionStats): void => cb(d)
    ipcRenderer.on('session:stats', l)
    return () => ipcRenderer.removeListener('session:stats', l)
  },
  onLog: (cb: (line: string) => void): (() => void) => {
    const l = (_e: unknown, d: string): void => cb(d)
    ipcRenderer.on('log', l)
    return () => ipcRenderer.removeListener('log', l)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
