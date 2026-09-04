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
  setTcpip: (serial: string, port: number): Promise<OpResult> => ipcRenderer.invoke('device:tcpip', serial, port),

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
  resolvePaths: (): Promise<{ adbPath: string; serverPath: string; scrcpyPath: string }> =>
    ipcRenderer.invoke('settings:resolvePaths'),
  resolveScrcpy: (): Promise<string> => ipcRenderer.invoke('external-scrcpy:resolve'),
  launchExternalScrcpy: (serial: string): Promise<OpResult> =>
    ipcRenderer.invoke('external-scrcpy:launch', serial),
  stopExternalScrcpy: (serial: string): Promise<void> =>
    ipcRenderer.invoke('external-scrcpy:stop', serial),
  launchEmbeddedScrcpy: (serial: string): Promise<OpResult> =>
    ipcRenderer.invoke('scrcpy-embed:launch', serial),
  moveEmbeddedScrcpy: (serial: string, rect: { x: number; y: number; w: number; h: number }): void => {
    ipcRenderer.send('scrcpy-embed:move', serial, rect)
  },
  stopEmbeddedScrcpy: (serial: string): Promise<void> =>
    ipcRenderer.invoke('scrcpy-embed:stop', serial),
  getKeymaps: (): Promise<KeymapConfig[]> => ipcRenderer.invoke('keymaps:get'),
  setKeymaps: (k: KeymapConfig[]): Promise<void> => ipcRenderer.invoke('keymaps:set', k),
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
