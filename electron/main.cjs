const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, Notification, shell, session } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRpc } = require('./rpc.cjs')
const { watchWorkspaces } = require('./workspace-watch.cjs')
const registry = require('./child-registry.cjs')
const { ensureGuiPath } = require('./shell-path.cjs')
const workspaces = require('./workspace-store.cjs')
const remoteSync = require('./remote-sync.cjs')
const { routeFromUrl } = require('./deep-link.cjs')

/* Finder and the Dock start Electron with a bare PATH; a harness installed by
   Homebrew or npm would look "not installed". Restore the usual locations
   before anything reads it. */
ensureGuiPath()

// Set by `npm run dev:desktop`; empty when running a built app.
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(RENDERER_URL)
const isMac = process.platform === 'darwin'

/* The window icon lives outside the asar in a packaged build (extraResources),
   and in the checkout during development or `npm run start`. */
const ICON_PATH = (() => {
  const packaged = path.join(process.resourcesPath || '', 'icon.png')
  const checkout = path.join(__dirname, '..', 'build', 'icon.png')
  return process.resourcesPath && fs.existsSync(packaged) ? packaged : checkout
})()

let mainWindow = null
let rpc = null
let watcher = null

/* The renderer owns the setting copy in localStorage; main keeps the last sync
   so a turn that finishes after the window closed can still decide. */
const notificationPrefs = { enabled: true, replies: true, errors: true, backgroundOnly: true }

/* Windows and Linux hand a protocol launch to this process in argv. It is
   forwarded once the window can receive it, then forgotten. */
let launchRoute = ''
if (!isMac) {
  const raw = process.argv.find((arg) => /^entity:\/\//i.test(String(arg)))
  if (raw) launchRoute = routeFromUrl(raw)
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* `entity://open` is how the browser build reaches the installed app. The
 * protocol points at this executable; a second launch focuses the window and
 * carries the route it was opened with. */
const PROTOCOL = 'entity'

function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch {
    /* a machine that refuses the registration still runs the app */
  }
}

function sendDeepLink(route) {
  if (!route) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('app:deep-link', { route })
}

function openDeepLink(raw) {
  focusWindow()
  sendDeepLink(routeFromUrl(raw))
}

/* Dev and the packaged app share a userData directory, so a lock would make
   `dev:desktop` silently quit whenever the installed app is open. Keep the lock
   for the shipped app; dev runs beside it. */
const primaryInstance = isDev || app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine = []) => {
    const raw = (Array.isArray(commandLine) ? commandLine : []).find((arg) =>
      /^entity:\/\//i.test(String(arg)),
    )
    if (raw) openDeepLink(raw)
    else focusWindow()
  })
  app.on('open-url', (event, raw) => {
    event.preventDefault()
    openDeepLink(raw)
  })
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

/** The native folder picker for Account → Backups. '' means cancelled. */
async function chooseDirectory(title = 'Choose a folder') {
  const owner = BrowserWindow.getFocusedWindow() || mainWindow
  const options = {
    title,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths?.length) return ''
  return result.filePaths[0]
}

function showNotification({ title, body, route, tag, silent = false, probe = false } = {}) {
  if (!Notification.isSupported()) {
    return Promise.resolve({
      shown: false,
      reason: 'Notifications are not supported on this system.',
    })
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const note = new Notification({
      title: String(title || 'entity'),
      body: String(body || ''),
      silent: Boolean(silent),
    })
    note.on('failed', (_event, error) => {
      finish({ shown: false, reason: String(error || 'The notification could not be shown.') })
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
    try {
      note.show()
    } catch (error) {
      finish({ shown: false, reason: String(error?.message || error) })
      return
    }

    /* macOS drops a banner for an unsigned bundle without firing `failed`.
       Notification Center is the only honest read-back; elsewhere show() not
       throwing is all the platform tells us. */
    if (probe && process.platform === 'darwin' && typeof Notification.getHistory === 'function') {
      setTimeout(async () => {
        try {
          const history = await Notification.getHistory()
          const found = history.some(
            (entry) => entry.title === note.title && entry.body === note.body,
          )
          finish(
            found
              ? { shown: true, reason: 'delivered' }
              : {
                  shown: true,
                  reason:
                    'macOS did not deliver it — check System Settings → Notifications → Entity',
                },
          )
        } catch {
          finish({ shown: true, reason: '' })
        }
      }, 400)
      return
    }

    /* `failed` arrives shortly after show() when it arrives at all. */
    setTimeout(() => finish({ shown: true, reason: '' }), 200)
  })
}

/** The chat-turn banner main owns when the window is not in front of the person. */
function turnNotification(event) {
  const message = event?.data?.message
  if (!message || message.who === 'sys') return null
  if (!notificationPrefs.enabled) return null
  const kind = message.error ? 'error' : 'reply'
  if (kind === 'error' && !notificationPrefs.errors) return null
  if (kind === 'reply' && !notificationPrefs.replies) return null
  const away =
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.isMinimized() ||
    !mainWindow.isFocused()
  if (notificationPrefs.backgroundOnly && !away) return null

  const entity = event.entity || 'Entity'
  const text = String(message.text || message.error || '').replace(/\s+/g, ' ').trim()
  const body = text.length > 160 ? `${text.slice(0, 159)}…` : text
  return {
    title: message.error ? `${entity} needs attention` : `${entity} replied`,
    body: body || (message.error ? 'The turn failed.' : 'A new reply is ready.'),
    route: `/${event.workspace}/chat?thread=${encodeURIComponent(event.threadId)}`,
    tag: `chat:${event.threadId}`,
  }
}

/**
 * The microphone is the only device the renderer may reach, and only for voice
 * mode. Chromium asks the session, not the call table, so this is where the
 * allow-list belongs: `media` (getUserMedia audio) and speaker selection, and
 * nothing else. A denial here is what the dialog reports as blocked.
 */
function installPermissions() {
  const allowed = new Set(['media', 'speaker-selection'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    allowed.has(permission),
  )
}

/* The application menu carries the copy/paste roles a window without one would
   lose, and the Settings… accelerator that has no way into Account otherwise. */
function installMenu() {
  const openAccountSettings = () => {
    focusWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:open-account')
    }
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      /* macOS puts Settings under the app name, where people look for it. */
      ...(isMac
        ? [
            {
              label: app.getName() || 'Entity',
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Settings…', accelerator: 'Cmd+,', click: openAccountSettings },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : [
            {
              label: 'File',
              submenu: [
                { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openAccountSettings },
              ],
            },
          ]),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    /* Match the theme the app will paint, so the first frame is not a flash of
       the wrong canvas. */
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151411' : '#ffffff',
    title: 'Entity',
    icon: ICON_PATH,
    /* Windows and Linux get the native frame plus a hidden menu bar: Alt still
       reveals it, but the window opens without a File/Edit/View strip. */
    autoHideMenuBar: !isMac,
    /* A real title bar on every platform. `hiddenInset` on macOS left the
       traffic lights floating over the rail and gave the window no drag area. */
    titleBarStyle: 'default',
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

  mainWindow.webContents.once('did-finish-load', () => {
    if (!launchRoute) return
    const route = launchRoute
    launchRoute = ''
    sendDeepLink(route)
  })

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
  if (event?.kind === 'chat.turn' && event.phase === 'done') {
    const payload = turnNotification(event)
    if (payload) void showNotification(payload)
  }
}

app.setName('Entity')
if (process.platform === 'win32') app.setAppUserModelId('com.entity.app')

app.whenReady().then(() => {
  if (!primaryInstance) return
  registerProtocol()
  /* In development the process is Electron.app, so the dock keeps the default
     atom until we hand it the product icon. A packaged build reads the icns
     from the bundle instead. */
  if (isMac && !app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(ICON_PATH)
    } catch {
      /* a missing icon must not stop the window from opening */
    }
  }
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
    chooseDirectory,
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

  ipcMain.handle('app:notification-settings', (_event, payload = {}) => {
    for (const key of Object.keys(notificationPrefs)) {
      if (typeof payload?.[key] === 'boolean') notificationPrefs[key] = payload[key]
    }
    return { ...notificationPrefs }
  })

  /* One channel for every local call. The renderer never gets a path or a
     shell — it asks for a parsed result, and the call table decides what that
     costs. */
  ipcMain.handle('entity:call', (_event, payload) => rpc.call(payload?.fn, payload?.args))

  /* Voice mode needs the microphone; everything else stays denied. */
  installPermissions()

  installMenu()
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
