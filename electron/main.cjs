const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { createRpc } = require('./rpc.cjs')
const { watchWorkspaces } = require('./workspace-watch.cjs')
const registry = require('./child-registry.cjs')
const workspaces = require('./workspace-store.cjs')
const remoteSync = require('./remote-sync.cjs')

// Set by `npm run dev:desktop`; empty when running a built app.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_URL)

let mainWindow = null
let rpc = null
let watcher = null

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Open one file in VS Code from the thread-metadata panel.
 *
 * `code` is the portable route. macOS falls back to the app bundle when the
 * CLI was never installed; Windows resolves the install path instead of going
 * through `cmd.exe`, because the target is a user path and no shell is used.
 */
function runEditor(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 8000, windowsHide: true }, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

async function openInEditor(target) {
  const candidates = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    candidates.push(['code.cmd', ['--reuse-window', target]])
    if (local) {
      candidates.push([
        path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        ['--reuse-window', target],
      ])
    }
  } else if (process.platform === 'darwin') {
    candidates.push(['code', ['--reuse-window', target]])
    candidates.push(['open', ['-a', 'Visual Studio Code', target]])
  } else {
    candidates.push(['code', ['--reuse-window', target]])
    candidates.push(['code-insiders', ['--reuse-window', target]])
  }

  for (const [bin, args] of candidates) {
    try {
      await runEditor(bin, args)
      return { editor: 'vscode', app: bin }
    } catch {
      /* try the next route */
    }
  }
  throw new Error(
    'VS Code was not found. Install it and make the `code` command available, then try again.',
  )
}

function showNotification({ title, body, route, tag } = {}) {
  if (!Notification.isSupported()) return false
  const note = new Notification({
    title: String(title || 'entity'),
    body: String(body || ''),
    silent: true,
  })
  note.on('click', () => {
    focusWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:notification-click', {
        route: String(route || ''),
        tag: String(tag || 'entity'),
      })
    }
  })
  note.show()
  return true
}

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
  /* A local edit in a connected workspace is the push half of two-way sync.
     The debounce lives in the sync module, so a burst of writes is one pass. */
  if (event?.kind === 'workspace-changed' && event.workspace) {
    try {
      remoteSync.noteLocalChange(event.workspace)
    } catch {
      /* a sync that cannot start is reported by the next poll */
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('entity:event', event)
  }
}

if (process.platform === 'win32') app.setAppUserModelId('com.artistudio.entity')

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
    /* `openPath` resolves to an error message, not a rejection. */
    openPath: async (target) => {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    },
    openExternal: (url) => shell.openExternal(url),
    openInEditor,
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

  ipcMain.handle('app:notify', (_event, payload) => showNotification(payload || {}))

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
    await rpc?.closeAll()
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
