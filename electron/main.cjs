const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const { createRpc } = require('./rpc.cjs')

// Set by `npm run dev:desktop`; empty when running a built app.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_URL)

let mainWindow = null
let rpc = null

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

/** Run events go to every window; they carry their own workspace id. */
function broadcast(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('entity:event', event)
  }
}

app.whenReady().then(() => {
  rpc = createRpc({
    emit: broadcast,
    reveal: (file) => shell.showItemInFolder(file),
  })

  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }))

  /* One channel for every local call. The renderer never gets a path or a
     shell — it asks for a parsed result, and the call table decides what that
     costs. */
  ipcMain.handle('entity:call', (_event, payload) => rpc.call(payload?.fn, payload?.args))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/* A run is a child of this process. Quitting takes it down, which is why a run
   that outlives the window is reported as canceled on the next boot. */
app.on('before-quit', () => {
  try {
    rpc?.closeAll()
  } catch {
    /* quitting anyway */
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
