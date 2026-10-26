import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DeviceInfo,
  SessionOptions,
  ControlCommand,
  AppSettings,
  KeymapConfig,
  ScriptInfo,
  ScriptRunEvent,
  PyScriptFile,
  PyRunEvent,
  FrameEvent,
  StreamMeta,
  SessionStateEvent,
  SessionStats,
  AdbShellResult,
  OpResult,
  ListDirResult,
  FileTransferResult,
  LanScanResult,
  UpdateSnapshot,
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
  scanLanDevices: (port?: number, allSubnets?: boolean): Promise<LanScanResult> =>
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
  /**
   * 把「拖进窗口的 File 对象」解析成本地绝对路径（拖拽上传用）。
   *
   * ⚠️ Electron 32 起 `File.path` 已被移除，旧写法拿到 undefined，只能走 webUtils。
   * 这个函数必须定义在 preload：contextBridge 支持把 File 对象递过来，而渲染层
   * 在 contextIsolation 下拿不到 electron 模块。
   * 参数类型用 Parameters<…> 而不是裸的 File —— preload 的 tsconfig 没有加载 DOM lib。
   */
  getPathForFile: (file: unknown): string =>
    webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  pullFile: (serial: string, remotePath: string): Promise<OpResult> =>
    ipcRenderer.invoke('device:pull', serial, remotePath),
  /** ---- 设备文件管理器 ---- */
  /** 列出设备端目录（返回结构化条目：名称/类型/大小/修改时间） */
  listDir: (serial: string, remotePath: string): Promise<ListDirResult> =>
    ipcRenderer.invoke('device:listDir', serial, remotePath),
  /** 删除设备端文件或目录（目录递归删除；受保护路径由主进程拒绝） */
  deleteRemote: (serial: string, remotePath: string): Promise<OpResult> =>
    ipcRenderer.invoke('device:delete', serial, remotePath),
  /** 批量移动 / 复制到目标目录（overwrite=false 时同名会进 conflicts，由 UI 二次确认） */
  transferFiles: (
    serial: string,
    mode: 'move' | 'copy',
    sources: string[],
    destDir: string,
    overwrite = false
  ): Promise<FileTransferResult> => ipcRenderer.invoke('device:transfer', serial, mode, sources, destDir, overwrite),
  /** 下载到用户选择的本地文件夹（文件与目录都适用） */
  pullRemoteTo: (serial: string, remotePath: string): Promise<OpResult> =>
    ipcRenderer.invoke('device:pullTo', serial, remotePath),
  /** 多选本地文件（上传用） */
  openFilesDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFiles'),
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
  /**
   * 运行脚本：传目标会话 sessionId（投屏开着才有会话）。
   * `loopMs > 0` = 跑完一轮后等这么久再从头跑，直到停止（录制宏用）。
   */
  runScript: (scriptId: string, sessionId: string, loopMs = 0): Promise<{ ok: boolean; runId?: string; message?: string }> =>
    ipcRenderer.invoke('scripts:run', scriptId, sessionId, loopMs),
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
  /** ---- Python 脚本（scripts/python/*.py，独立进程运行）---- */
  /** 扫描 scripts/python 目录下的 .py（每次调用都重新扫，放进去即出现） */
  listPyScripts: (): Promise<{ dir: string; scripts: PyScriptFile[] }> => ipcRenderer.invoke('pyscripts:list'),
  /** 运行 .py：主进程 spawn 设置里的 Python 解释器；环境自动注入 QZRS_TOKEN 与桥客户端 PYTHONPATH */
  runPyScript: (file: string): Promise<{ ok: boolean; runId?: string; message?: string }> =>
    ipcRenderer.invoke('pyscripts:run', file),
  stopPyScript: (runId: string): Promise<OpResult> => ipcRenderer.invoke('pyscripts:stop', runId),
  runningPyScripts: (): Promise<Array<{ runId: string; file: string; name: string }>> =>
    ipcRenderer.invoke('pyscripts:running'),
  openPyScriptsDir: (): Promise<{ ok: boolean; dir?: string }> => ipcRenderer.invoke('pyscripts:openDir'),
  onPyScriptEvent: (cb: (e: PyRunEvent) => void): (() => void) => {
    const l = (_e: unknown, d: PyRunEvent): void => cb(d)
    ipcRenderer.on('pyscript:event', l)
    return () => ipcRenderer.removeListener('pyscript:event', l)
  },
  /** 调试日志批量落盘（fire-and-forget；主进程在设置开启+调试打开时才会真正建目录写文件） */
  debugLog: (lines: string[]): void => ipcRenderer.send('debug:log', lines),
  /** 调试日志目录（设置面板展示用） */
  getDebugLogDir: (): Promise<string> => ipcRenderer.invoke('debug:logdir'),
  writeClipboard: (text: string): void => ipcRenderer.send('clipboard:write', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  /** ---- Python 外挂桥 ---- */
  /** 桥状态：running/port/token 为运行时值（未启用时 token 为空串），enabled 为设置里的开关 */
  getBridgeStatus: (): Promise<{ enabled: boolean; running: boolean; port: number; token: string; clientDir: string }> =>
    ipcRenderer.invoke('bridge:status'),
  /** 打开桥客户端示例目录（qzrs.py / example.py） */
  openBridgeDir: (): Promise<OpResult & { dir?: string }> => ipcRenderer.invoke('bridge:openDir'),

  /** ---- OCR 模型（按需下载，脚本找文字用）---- */
  /** 模型状态：ready=true 全部就绪；manualUrl 为空表示未配置手动下载入口 */
  getOcrStatus: (): Promise<{
    version: string
    dir: string
    ready: boolean
    downloading: boolean
    manualUrl: string
    files: { file: string; present: boolean; ok: boolean; size: number }[]
  }> => ipcRenderer.invoke('ocr:status'),
  /** 开始下载（异步，进度走 onOcrProgress 事件） */
  downloadOcrModels: (): Promise<OpResult> => ipcRenderer.invoke('ocr:download'),
  openOcrModelsDir: (): Promise<OpResult & { dir?: string }> => ipcRenderer.invoke('ocr:openDir'),
  /** 打开手动下载页（国内网盘；未配置时不动作） */
  openOcrManual: (): Promise<OpResult> => ipcRenderer.invoke('ocr:openManual'),
  onOcrProgress: (cb: (p: { phase: 'downloading' | 'verifying' | 'done' | 'error'; percent: number; file?: string; filePercent?: number; message?: string }) => void): (() => void) => {
    const l = (_e: unknown, d: { phase: 'downloading' | 'verifying' | 'done' | 'error'; percent: number; file?: string; filePercent?: number; message?: string }): void => cb(d)
    ipcRenderer.on('ocr:progress', l)
    return () => ipcRenderer.removeListener('ocr:progress', l)
  },

  /** ---- 自更新（软件更新）---- */
  /** 当前更新状态快照（渲染层只读这份，不自己拼状态） */
  getUpdateState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('update:state'),
  /** 手动查一次更新（启动时的静默检查由主进程自己触发） */
  checkUpdate: (): Promise<{ ok: boolean; available?: boolean; reason?: string }> =>
    ipcRenderer.invoke('update:check'),
  /** 下载并摊进暂存区（不覆盖任何正在运行的文件） */
  downloadUpdate: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('update:download'),
  /** 重启并更新：交接给退出后运行的助手，随后本进程退出 */
  applyUpdate: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('update:apply'),
  /** 打开更新目录（含 apply.log，更新失败时看原因） */
  openUpdateDir: (): Promise<OpResult & { dir?: string }> => ipcRenderer.invoke('update:openDir'),
  onUpdateState: (cb: (s: UpdateSnapshot) => void): (() => void) => {
    const l = (_e: unknown, d: UpdateSnapshot): void => cb(d)
    ipcRenderer.on('update:state', l)
    return () => ipcRenderer.removeListener('update:state', l)
  },

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
