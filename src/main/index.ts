import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc, type AppManager } from './ipc'
import { Store } from './stores'
import { themeBackground } from './theme'

// 启用 HEVC(H.265) 硬件解码：Electron ≥ v20 官方二进制已内置 HEVC 硬解代码，
// 因 HEVC 专利默认运行时关闭，这里显式开启 PlatformHEVCDecoderSupport 即可启用硬解。
// （软件 HEVC 解码需重新编译 ffmpeg，不在本方案内；须在 app ready 前设置。）
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

// 单实例锁：防止双开导致两份 adb 轮询、userData 写入竞争、重复投屏会话。
// 第二次启动的进程拿不到锁会直接退出，同时唤起已有窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null
let manager: AppManager | null = null

function createWindow(theme: 'dark' | 'light' | 'system'): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: false, // 自定义标题栏，移除系统 chrome
    title: 'QZRS Scrcpy',
    // 底色跟随主题，避免浅色模式下启动瞬间闪深色（与 styles.css 的 --bg 对应）
    backgroundColor: themeBackground(theme),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const store = new Store()
  manager = registerIpc(store)

  const settings = store.getSettings()
  createWindow(settings.theme)

  // 'system' 主题下操作系统切换深浅色时，同步窗口底色
  nativeTheme.on('updated', () => {
    const bg = themeBackground(store.getSettings().theme)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(bg)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(store.getSettings().theme)
  })
})

app.on('window-all-closed', () => {
  void manager?.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void manager?.dispose()
  nativeTheme.themeSource = 'system'
})
