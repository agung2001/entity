const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const localData = require('./local-data.cjs')

// Set by `npm run dev:desktop`; empty when running a built app.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_URL)

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the user's browser, never as an in-app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Keep the renderer on its own origin; only the dev server may be revisited.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(RENDERER_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('http')) shell.openExternal(url)
    }
  })

  if (isDev) {
    mainWindow.loadURL(RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }))

  /* Local machine data. The renderer never gets a path or a shell — it asks for
     the parsed ssh config, a probe of one known alias, and the skill libraries. */
  ipcMain.handle('ssh:hosts', () => localData.readSshHosts())
  ipcMain.handle('ssh:probe', (_event, alias) => localData.probeSshHost(String(alias || '')))
  ipcMain.handle('skills:scan', () => localData.scanSkillLibrary())
  ipcMain.handle('skills:read', (_event, payload) => {
    const { harness, name } = payload || {}
    return localData.readSkillEntry(String(harness || ''), String(name || ''))
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
