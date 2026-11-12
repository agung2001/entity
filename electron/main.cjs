const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const { createRpc } = require('./rpc.cjs')
const { watchWorkspaces } = require('./workspace-watch.cjs')
const registry = require('./child-registry.cjs')
const workspaces = require('./workspace-store.cjs')

// Set by `npm run dev:desktop`; empty when running a built app.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_URL)

let mainWindow = null
let rpc = null
let watcher = null

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
  /* Anything a previous instance left behind — a crash runs no handler — is
     still running and still spending the machine's CPU. Kill it before the
     window opens, not after the user notices the fan. */
  try {
    const reaped = registry.reapOrphans({ log: (line) => console.log(`[entity] ${line}`) })
    if (reaped.length) console.log(`[entity] reaped ${reaped.length} orphaned child process(es)`)
  } catch {
    /* an unreadable temp directory is not a reason to refuse to start */
  }

  rpc = createRpc({
    emit: broadcast,
    reveal: (file) => shell.showItemInFolder(file),
  })

  /* An agent that rewrites its own instructions writes a file this process did
     not write. Without this watch the window would keep rendering the previous
     instructions until the user navigated away and back. */
  watcher = watchWorkspaces({ root: workspaces.WORKSPACES_DIR, emit: broadcast })

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
   that outlives the window is reported as canceled on the next boot.

   The quit is deferred until the children are actually gone: SIGTERM first so a
   harness can flush its transcript, SIGKILL on the whole process group after a
   short grace period. Otherwise the app closes and the tree keeps running. */
let stopping = false
app.on('before-quit', async (event) => {
  if (stopping) return
  stopping = true
  event.preventDefault()

  try {
    watcher?.close()
  } catch {
    /* quitting anyway */
  }

  try {
    rpc?.closeAll()
  } catch {
    /* quitting anyway */
  }

  try {
    await registry.stopAll({ graceMs: 3000 })
  } catch {
    /* the sync handler below is the backstop */
  } finally {
    app.quit()
  }
})

/* `process.exit` and hard kills skip the promise above. This handler cannot
   await, so it only has the last resort: SIGKILL on each group. */
process.on('exit', () => {
  try {
    registry.stopAllSync()
  } catch {
    /* nothing left to do on the way out */
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit())
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
