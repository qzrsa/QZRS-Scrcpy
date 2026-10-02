import { contextBridge, ipcRenderer } from 'electron'
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
  AdbShellResult,
  OpResult,
  AudioMeta,
  AudioFrameEvent
} from '@shared/types'

const api = {
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:list'),
  refreshDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:refresh'),
  connectDevice: (hostPort: string): Promise<OpResult> => ipcRenderer.invoke('device:connect', hostPort),
  disconnectDevice: (hostPort: string): Promise<OpResult> => ipcRenderer.invoke('device:disconnect', hostPort),
  /** 从历史设备列表里删除（tcpip 设备会先 adb disconnect，避免轮询立刻写回） */
  forgetDevice: (serial: string): Promise<OpResult> => ipcRenderer.invoke('devices:forget', serial),
  /** 重命名设备（用户别名；空串 = 清除别名） */
  renameDevice: (serial: string, alias: string): Promise<OpResult> =>
    ipcRenderer.invoke('devices:rename', serial, alias),
  /** 设备列表拖动排序：把拖完后的完整 serial 顺序发回主进程持久化 */
  reorderDevices: (orderedSerials: string[]): Promise<OpResult> =>
    ipcRenderer.invoke('devices:reorder', orderedSerials),
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
  /** ---- 用户脚本（JS 自动化）---- */
  listScripts: (): Promise<ScriptInfo[]> => ipcRenderer.invoke('scripts:list'),
  /** 保存脚本；id 为空 = 新建。返回 ok/id/最新列表 */
  saveScript: (id: string, name: string, code: string): Promise<{ ok: boolean; id?: string; scripts?: ScriptInfo[]; message?: string }> =>
    ipcRenderer.invoke('scripts:save', id, name, code),
  deleteScript: (id: string): Promise<{ ok: boolean; scripts?: ScriptInfo[]; message?: string }> =>
    ipcRenderer.invoke('scripts:delete', id),
  /** 运行脚本：传目标会话 sessionId（投屏开着才有会话） */
  runScript: (scriptId: string, sessionId: string): Promise<{ ok: boolean; runId?: string; message?: string }> =>
    ipcRenderer.invoke('scripts:run', scriptId, sessionId),
  stopScript: (runId: string): Promise<OpResult> => ipcRenderer.invoke('scripts:stop', runId),
  runningScripts: (): Promise<Array<{ runId: string; scriptId: string; name: string; sessionId: string }>> =>
    ipcRenderer.invoke('scripts:running'),
  openScriptsDir: (): Promise<{ ok: boolean; dir?: string }> => ipcRenderer.invoke('scripts:openDir'),
  /** waitImage 模板：保存（渲染层从截图框选裁出 PNG base64）/ 列表 / 删除 */
  saveTemplate: (name: string, base64Png: string): Promise<{ ok: boolean; path?: string; templates?: { name: string; png: string }[]; message?: string }> =>
    ipcRenderer.invoke('scripts:saveTemplate', name, base64Png),
  listTemplates: (): Promise<{ name: string; png: string }[]> => ipcRenderer.invoke('scripts:listTemplates'),
  deleteTemplate: (name: string): Promise<{ ok: boolean; templates?: { name: string; png: string }[] }> => ipcRenderer.invoke('scripts:deleteTemplate', name),
  onScriptEvent: (cb: (e: ScriptRunEvent) => void): (() => void) => {
    const l = (_e: unknown, d: ScriptRunEvent): void => cb(d)
    ipcRenderer.on('script:event', l)
    return () => ipcRenderer.removeListener('script:event', l)
  },
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
  onAudioMeta: (cb: (e: AudioMeta) => void): (() => void) => {
    const l = (_e: unknown, d: AudioMeta): void => cb(d)
    ipcRenderer.on('session:audio-meta', l)
    return () => ipcRenderer.removeListener('session:audio-meta', l)
  },
  onAudioFrame: (cb: (e: AudioFrameEvent) => void): (() => void) => {
    const l = (_e: unknown, d: AudioFrameEvent): void => cb(d)
    ipcRenderer.on('session:audio', l)
    return () => ipcRenderer.removeListener('session:audio', l)
  },
  onAudioDisabled: (cb: (e: { sessionId: string; reason: string }) => void): (() => void) => {
    const l = (_e: unknown, d: { sessionId: string; reason: string }): void => cb(d)
    ipcRenderer.on('session:audio-disabled', l)
    return () => ipcRenderer.removeListener('session:audio-disabled', l)
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
