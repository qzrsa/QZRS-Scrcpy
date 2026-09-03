import { app, BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { registerIpc, type AppManager } from './ipc'
import { Store } from './stores'

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
