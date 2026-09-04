import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc, type AppManager } from './ipc'
import { Store } from './stores'

// 启用 HEVC(H.265) 硬件解码：Electron ≥ v20 官方二进制已内置 HEVC 硬解代码，
// 因 HEVC 专利默认运行时关闭，这里显式开启 PlatformHEVCDecoderSupport 即可启用硬解。
// （软件 HEVC 解码需重新编译 ffmpeg，不在本方案内；须在 app ready 前设置。）
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

let mainWindow: BrowserWindow | null = null
let manager: AppManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Scrcpy Control',
    backgroundColor: '#0f1115',
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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
