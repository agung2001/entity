/**
 * Auto-update — one updater for the whole app, owned by the main process.
 *
 * The feed is the public GitHub release of `agung2001/entity`, read by
 * `electron-updater`'s GitHub provider. No token: the repository is public.
 *
 * Four rules matter:
 *
 *   1. Nothing is constructed unless the app is packaged. A dev checkout has no
 *      version to install from, so `state()` answers `{ status: 'dev' }` and the
 *      page shows the development state instead of an updater that cannot work.
 *   2. `autoDownload` is false. A download is something a person starts; the
 *      timer only ever *checks*. `autoInstallOnAppQuit` is true, so a download
 *      that is decided on later is applied as the app closes.
 *   3. An unsigned macOS bundle cannot be installed by Squirrel.Mac. The release
 *      workflow builds with `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, so `manual`
 *      is normally set there and `install()` refuses with a sentence instead of
 *      relaunching nothing.
 *   4. A failed *check* is silent: it is recorded for the page and never paints
 *      the rail. A failed *download* is a state, because the person started it.
 *
 * The check timer is unref'd, so it never keeps the app alive, and `start` is
 * idempotent so a dev-server reload does not stack timers.
 */
const { execFileSync } = require('node:child_process')

const REPO = { provider: 'github', owner: 'agung2001', repo: 'entity' }
/* The prefix of every release link; the page and the rail append a tag. */
const RELEASES = 'https://github.com/agung2001/entity/releases'
const INTERVAL_MS = 6 * 60 * 60 * 1000
const BOOT_DELAY_MS = 4_000
const MANUAL_REASON =
  'This build is not signed, so macOS will not install an update by itself. Download it from the release page instead.'

/* In the dev server `require('electron')` is the path to the binary, not the
   Electron API, so this module has to load without it. */
function electronApp() {
  try {
    const electron = require('electron')
    return electron && typeof electron.app?.getVersion === 'function' ? electron.app : null
  } catch {
    return null
  }
}

/** Squirrel.Mac compares the bundle's signature; an unsigned one is refused. */
function signedBundle(app) {
  if (process.platform !== 'darwin' || !app?.isPackaged) return true
  try {
    execFileSync('codesign', ['-dv', app.getPath('exe')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The dev server has no `app` to ask, so the checkout's own number is the
 *  honest answer for the page's dev state. */
function packageVersion() {
  try {
    return String(require('../package.json').version || '')
  } catch {
    return ''
  }
}

/**
 * The release body arrives as the GitHub feed's HTML. The page draws one line
 * per top-level bullet and never renders markup from the network, so the tags
 * are stripped here, once, and links keep their text.
 */
function noteBullets(notes) {
  const body = typeof notes === 'string' ? notes : ''
  if (!body.trim()) return []
  const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((hit) => hit[1])
  const lines = items.length
    ? items
    : body.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line) || line.trim())
  return lines
    .map((line) =>
      line
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/^\s*[-*]\s+/, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
}

function errorOf(error) {
  return {
    code: String(error?.code || error?.name || 'EUNKNOWN'),
    message: String(error?.message || error || 'The updater failed.')
      .replace(/^Error:\s*/, '')
      .split('\n')[0],
  }
}

function createUpdateStore({ emit = () => {}, log = () => {} } = {}) {
  const app = electronApp()
  const packaged = Boolean(app?.isPackaged)
  const manual = packaged && !signedBundle(app)

  const state = {
    status: packaged ? 'idle' : 'dev',
    manual,
    current: String(app?.getVersion?.() || packageVersion()),
    latest: '',
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    notes: [],
    notesUrl: RELEASES,
    publishedAt: '',
    checkedAt: '',
    platform: process.platform,
    arch: process.arch,
    error: null,
    settings: { auto: true, installOnQuit: true },
  }

  let updater = null
  let phase = ''
  let checking = false
  let bootTimer = null
  let timer = null

  function snapshot() {
    return {
      ...state,
      error: state.error ? { ...state.error } : null,
      settings: { ...state.settings },
    }
  }

  function publish() {
    emit({ kind: 'update.state', ...snapshot() })
  }

  function applyInfo(info) {
    state.latest = String(info?.version || '')
    state.notes = noteBullets(info?.releaseNotes)
    state.publishedAt = String(info?.releaseDate || '')
    state.total = Number(info?.files?.[0]?.size) || 0
    state.notesUrl = state.latest ? `${RELEASES}/tag/v${state.latest}` : RELEASES
  }

  function fail(error, kind) {
    /* `error.code` keeps the updater's own word (ENOTFOUND, EACCES, …): it is
       the only part of the message a person can search for. */
    state.error = { ...errorOf(error), kind, percent: state.percent }
    if (kind === 'download') state.status = 'error'
    log(`update ${kind} failed: ${state.error.code} ${state.error.message}`)
  }

  if (packaged) {
    const { autoUpdater } = require('electron-updater')
    updater = autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = state.settings.installOnQuit
    updater.setFeedURL(REPO)

    updater.on('download-progress', (info) => {
      state.status = 'downloading'
      state.percent = Math.max(0, Math.min(100, Math.round(Number(info?.percent) || 0)))
      state.bytesPerSecond = Number(info?.bytesPerSecond) || 0
      state.transferred = Number(info?.transferred) || 0
      state.total = Number(info?.total) || state.total
      publish()
    })

    updater.on('update-downloaded', () => {
      state.status = 'ready'
      state.percent = 100
      state.transferred = state.total || state.transferred
      state.error = null
      publish()
    })

    updater.on('error', (error) => {
      /* The awaited call records its own failure; this listener catches the
         paths with no promise attached (the quit-time install). */
      if (phase === 'download' || phase === 'install') fail(error, phase)
      else if (!checking) publish()
    })
  }

  /**
   * One check. `byPerson` is the only case that paints `checking` in the rail:
   * the six-hourly check that finds nothing must look like nothing happened.
   */
  async function check({ byPerson = false } = {}) {
    if (!updater) return snapshot()
    if (checking) return snapshot()
    checking = true
    phase = 'check'
    const before = state.status
    if (byPerson) {
      state.status = 'checking'
      publish()
    }
    try {
      const result = await updater.checkForUpdates()
      state.checkedAt = new Date().toISOString()
      state.error = null
      if (result?.isUpdateAvailable) {
        applyInfo(result.updateInfo)
        /* A download that is already running or on disk is further along than
           a fresh "available"; a re-check must not send it backwards. */
        if (state.status !== 'ready' && state.status !== 'downloading') state.status = 'available'
      } else if (state.status !== 'ready' && state.status !== 'downloading') {
        state.status = 'idle'
      }
    } catch (error) {
      fail(error, 'check')
      state.status = before === 'checking' ? 'idle' : before
    } finally {
      checking = false
      phase = ''
      publish()
    }
    return snapshot()
  }

  /** A download the person started. Never starts a second one. */
  async function download() {
    if (!updater) throw new Error('Updates are only available in the packaged app.')
    if (manual) throw new Error(MANUAL_REASON)
    if (state.status === 'downloading' || state.status === 'ready') return snapshot()
    if (!state.latest) throw new Error('There is no version to download yet. Check again first.')
    phase = 'download'
    state.status = 'downloading'
    state.percent = 0
    state.transferred = 0
    state.error = null
    publish()
    try {
      await updater.downloadUpdate()
      state.status = 'ready'
      state.percent = 100
      state.error = null
    } catch (error) {
      fail(error, 'download')
    } finally {
      phase = ''
      publish()
    }
    return snapshot()
  }

  /** Apply the downloaded file and relaunch. Refused where it cannot work. */
  function install() {
    if (!updater) throw new Error('Updates are only available in the packaged app.')
    if (manual) throw new Error(MANUAL_REASON)
    if (state.status !== 'ready') throw new Error('No downloaded update is waiting to install.')
    phase = 'install'
    updater.quitAndInstall(false, true)
    return snapshot()
  }

  function setSettings(patch = {}) {
    if (typeof patch.auto === 'boolean') {
      state.settings.auto = patch.auto
      if (patch.auto) start({ log })
      else stop()
    }
    if (typeof patch.installOnQuit === 'boolean') {
      state.settings.installOnQuit = patch.installOnQuit
      if (updater) updater.autoInstallOnAppQuit = patch.installOnQuit
    }
    publish()
    return snapshot()
  }

  function start({ log: write = log } = {}) {
    if (!updater || bootTimer || timer) return
    bootTimer = setTimeout(() => {
      bootTimer = null
      /* ponytail: one quiet check at launch, four seconds after the call table
         exists, so the rail is painted before the network is touched. A second
         chance after a wake-from-sleep needs an interval that also notices the
         clock jump — upgrade there if a laptop sleeping through six hours turns
         out to miss updates. */
      if (state.settings.auto) check().catch(() => {})
    }, BOOT_DELAY_MS)
    bootTimer.unref?.()
    timer = setInterval(() => {
      if (state.settings.auto) check().catch(() => {})
    }, INTERVAL_MS)
    timer.unref?.()
    write(`update checks every ${INTERVAL_MS / 60_000} min`)
  }

  function stop() {
    if (bootTimer) clearTimeout(bootTimer)
    if (timer) clearInterval(timer)
    bootTimer = null
    timer = null
  }

  return { state: snapshot, check, download, install, setSettings, start, stop }
}

module.exports = { createUpdateStore, REPO, RELEASES, INTERVAL_MS, noteBullets }
