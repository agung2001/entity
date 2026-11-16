/**
 * Workspace backups — ZIP snapshots with a smart retention policy.
 *
 * A backup is one `.zip` file per run, written under
 * `<target>/<workspace-id>/<timestamp>.zip`. `target` defaults to
 * `<ENTITY_HOME>/backups` and can be changed per workspace from Account →
 * Backups. The archive holds the workspace at its root plus a `backup.json`
 * manifest; skill symlinks are listed in the manifest so a restore works on a
 * machine that uses junctions or a different filesystem.
 *
 * Two rules matter:
 *
 *   1. An archive never carries secrets or transient state. `.remote.token`,
 *      `.remote.json`, `.remote-trash/`, `.bin/` (absolute paths of this build)
 *      and `runs/` (harness logs and attachment temp dirs) are left out.
 *   2. Only one backup runs per workspace at a time, and every run ends with
 *      the retention pass. The smart policy is the union of "last 7 days",
 *      "one per week this month" and "one per month this year".
 *
 * The schedule is checked by a timer in the main process (`start`). The timer
 * is unref'd so it never keeps the app alive, and it is re-created with the
 * call table after a dev-server reload.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const yazl = require('yazl')
const unzipper = require('unzipper')
const workspaces = require('./workspace-store.cjs')

const fsp = fs.promises

const ROOT = path.join(workspaces.ROOT, 'backups')
const SETTINGS_FILE = 'settings.json'
const MANIFEST_FILE = 'backup.json'
const SCHEMA = 1
const KIND = 'entity.workspace.backup'
const DEFAULT_MODE = 'smart'
const MODES = ['smart', 'daily', 'weekly', 'monthly', 'manual']
const MAX_MANUAL = 20
const DAY_MS = 24 * 60 * 60 * 1000
const START_DELAY_MS = 60_000
const INTERVAL_MS = 30 * 60_000
const ZIP_MODE = 0o600

const SKIP_TOP = new Set(['.bin', 'runs', '.remote-trash'])
const SKIP_FILE = new Set(['.remote.json', '.remote.token', '.remote-token'])

const MODE_INFO = [
  {
    id: 'smart',
    label: 'Smart',
    desc: 'Daily for the last 7 days, one a week this month, one a month this year.',
    tag: 'recommended',
    automatic: true,
  },
  {
    id: 'daily',
    label: 'Daily',
    desc: 'One ZIP a day, keeping the last 14 days.',
    tag: '14 days',
    automatic: true,
  },
  {
    id: 'weekly',
    label: 'Weekly',
    desc: 'One ZIP a week, keeping the last 12 weeks.',
    tag: '12 weeks',
    automatic: true,
  },
  {
    id: 'monthly',
    label: 'Monthly',
    desc: 'One ZIP a month, keeping the last 12 months.',
    tag: '12 months',
    automatic: true,
  },
  {
    id: 'manual',
    label: 'Manual only',
    desc: 'Never runs on its own. Keeps the last 20 ZIPs you make.',
    tag: '20 ZIPs',
    automatic: false,
  },
]

const running = new Map()
let timer = null
let bootTimer = null
let ticking = false

function nowIso() {
  return new Date().toISOString()
}

function expandHome(value) {
  const text = String(value || '')
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

function tilde(value) {
  const home = os.homedir()
  const text = String(value || '')
  if (text === home) return '~'
  if (text.startsWith(`${home}${path.sep}`)) return `~${text.slice(home.length)}`
  return text
}

function modeOf(value) {
  const mode = String(value || '')
  return MODES.includes(mode) ? mode : DEFAULT_MODE
}

function infoOf(mode) {
  return MODE_INFO.find((entry) => entry.id === modeOf(mode)) || MODE_INFO[0]
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* a filesystem without modes */
  }
  return value
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode })
  try {
    fs.chmodSync(dir, mode)
  } catch {
    /* a filesystem without modes */
  }
  return dir
}

/* ── settings: mode and target folder, keyed by workspace ─────────── */

function settingsPath() {
  return path.join(ROOT, SETTINGS_FILE)
}

function readSettings() {
  const raw = readJson(settingsPath(), {}) || {}
  const map = raw && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)
    ? raw.workspaces
    : {}
  return { schema: SCHEMA, workspaces: { ...map } }
}

function writeSettings(settings) {
  return writeJson(settingsPath(), {
    schema: SCHEMA,
    workspaces: settings.workspaces || {},
    updatedAt: nowIso(),
  })
}

function defaultConfig() {
  return {
    mode: DEFAULT_MODE,
    directory: '',
    lastBackupAt: '',
    lastError: null,
    updatedAt: '',
  }
}

/**
 * The previous build stored the mode in `<backups>/<id>/config.json`. Adopt it
 * once, then keep every workspace's settings in the one file so changing the
 * target folder does not move the settings with the ZIPs.
 */
function readConfig(id) {
  const settings = readSettings()
  let raw = settings.workspaces[id]
  let migrated = false
  if (!raw) {
    const legacy = readJson(path.join(ROOT, id, 'config.json'), null)
    if (legacy && typeof legacy === 'object') {
      raw = legacy
      settings.workspaces[id] = { ...legacy }
      migrated = true
    }
  }
  const config = {
    ...defaultConfig(),
    ...(raw && typeof raw === 'object' ? raw : {}),
  }
  config.mode = modeOf(config.mode)
  config.directory = typeof config.directory === 'string' ? config.directory : ''
  config.lastBackupAt = typeof config.lastBackupAt === 'string' ? config.lastBackupAt : ''
  config.lastError =
    config.lastError && typeof config.lastError === 'object'
      ? { at: String(config.lastError.at || ''), message: String(config.lastError.message || '') }
      : null
  if (migrated) {
    try {
      writeSettings(settings)
    } catch {
      /* the old file still answers next time */
    }
  }
  return config
}

function writeConfig(id, patch = {}) {
  const settings = readSettings()
  const current = settings.workspaces[id] || {}
  const next = {
    ...current,
    ...patch,
    mode: modeOf(patch.mode !== undefined ? patch.mode : current.mode),
    updatedAt: nowIso(),
  }
  if (next.lastError === undefined) delete next.lastError
  settings.workspaces[id] = next
  writeSettings(settings)
  return next
}

/** The base folder for this workspace's ZIP files. */
function directoryOf(config) {
  const raw = String(config?.directory || '').trim()
  if (!raw) return ROOT
  const expanded = expandHome(raw)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : ROOT
}

function backupDirOf(record) {
  return path.join(directoryOf(readConfig(record.id)), record.id)
}

function backupDir(id) {
  return backupDirOf(workspaces.open(id))
}

/** Resolve the longest existing prefix, so a path under a symlink still compares. */
function canonicalPath(value) {
  let head = path.resolve(String(value || ''))
  const tail = []
  while (true) {
    if (fs.existsSync(head)) {
      return path.join(realPath(head), ...tail.reverse())
    }
    tail.push(path.basename(head))
    const parent = path.dirname(head)
    if (parent === head) return path.resolve(value)
    head = parent
  }
}

function isInside(parent, child) {
  const a = canonicalPath(parent)
  const b = canonicalPath(child)
  return b === a || b.startsWith(`${a}${path.sep}`)
}

function validateDirectory(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Choose a backup folder.')
  const expanded = expandHome(raw)
  if (!path.isAbsolute(expanded)) {
    throw new Error('Use an absolute folder path, or a path that starts with ~.')
  }
  const target = path.resolve(expanded)
  const stat = fs.statSync(target, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) throw new Error('That path is a file, not a folder.')
  return target
}

/* ── calendar buckets ─────────────────────────────────────────────── */

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** ISO week key, with the week belonging to the year that owns its Thursday. */
function weekKey(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date)
  const day = (d.getDay() + 6) % 7
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - day + 3)
  const first = new Date(d.getFullYear(), 0, 4)
  const firstDay = (first.getDay() + 6) % 7
  first.setDate(first.getDate() - firstDay + 3)
  const week = 1 + Math.round((d.getTime() - first.getTime()) / (7 * DAY_MS))
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function startOfDay(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function daysAgo(now, date) {
  return Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS)
}

function monthsAgo(now, date) {
  const a = new Date(now)
  const b = new Date(date)
  return (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth())
}

function startOfWeek(date) {
  const d = startOfDay(date)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d
}

function weeksAgo(now, date) {
  return Math.round((startOfWeek(now).getTime() - startOfWeek(date).getTime()) / (7 * DAY_MS))
}

function sameMonth(date, now) {
  const a = new Date(date)
  const b = new Date(now)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

function sameYear(date, now) {
  return new Date(date).getFullYear() === new Date(now).getFullYear()
}

/**
 * The names to keep, given snapshots newest-first.
 *
 * `items` is `{ name, date }[]`; `date` may be a Date or an ISO string. The
 * function is pure so the policy can be tested without touching the disk.
 */
function retentionKeep(items, mode, now = new Date()) {
  const rows = Array.isArray(items) ? items : []
  const policy = modeOf(mode)

  const newestPer = (keyOf, predicate) => {
    const seen = new Set()
    const out = []
    for (const item of rows) {
      const date = item.date instanceof Date ? item.date : new Date(item.date)
      if (!Number.isFinite(date.getTime())) continue
      if (predicate && !predicate(date)) continue
      const key = keyOf(date)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item.name)
    }
    return out
  }

  if (policy === 'smart') {
    const daily = newestPer(dayKey, (date) => daysAgo(now, date) >= 0 && daysAgo(now, date) < 7)
    /* "Once a week this month": buckets are ISO weeks, but only snapshots
       taken inside the current month compete for a weekly slot. */
    const weekly = newestPer(weekKey, (date) => sameMonth(date, now))
    /* "Every month this year": one per calendar month, current year. */
    const monthly = newestPer(monthKey, (date) => sameYear(date, now))
    return new Set([...daily, ...weekly, ...monthly])
  }

  if (policy === 'daily') {
    return new Set(
      newestPer(dayKey, (date) => daysAgo(now, date) >= 0 && daysAgo(now, date) < 14),
    )
  }
  if (policy === 'weekly') {
    return new Set(
      newestPer(weekKey, (date) => weeksAgo(now, date) >= 0 && weeksAgo(now, date) < 12),
    )
  }
  if (policy === 'monthly') {
    return new Set(
      newestPer(monthKey, (date) => monthsAgo(now, date) >= 0 && monthsAgo(now, date) < 12),
    )
  }
  /* Manual only: no calendar promise, but the shelf stays finite. */
  return new Set(rows.slice(0, MAX_MANUAL).map((item) => item.name))
}

/** Does this workspace need a backup right now, for its policy? */
function shouldRun(mode, items, now = new Date()) {
  const policy = modeOf(mode)
  if (policy === 'manual') return false
  const rows = Array.isArray(items) ? items : []
  if (!rows.length) return true

  const newest = (keyOf) => keyOf(new Date(now))
  if (policy === 'smart' || policy === 'daily') {
    return !rows.some((item) => dayKey(item.date) === newest(dayKey))
  }
  if (policy === 'weekly') {
    return !rows.some((item) => weekKey(item.date) === newest(weekKey))
  }
  if (policy === 'monthly') {
    return !rows.some((item) => monthKey(item.date) === newest(monthKey))
  }
  return false
}

/** When the next automatic run is expected; '' for manual-only. */
function nextDueAt(mode, items, now = new Date()) {
  const policy = modeOf(mode)
  if (policy === 'manual') return ''
  if (shouldRun(policy, items, now)) return new Date(now).toISOString()

  const next = new Date(now)
  if (policy === 'smart' || policy === 'daily') {
    next.setDate(next.getDate() + 1)
    next.setHours(0, 5, 0, 0)
    return next.toISOString()
  }
  if (policy === 'weekly') {
    const day = (next.getDay() + 6) % 7
    next.setDate(next.getDate() + (7 - day))
    next.setHours(0, 5, 0, 0)
    return next.toISOString()
  }
  next.setMonth(next.getMonth() + 1, 1)
  next.setHours(0, 5, 0, 0)
  return next.toISOString()
}

/* ── archive helpers ──────────────────────────────────────────────── */

function stamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = (value) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function uniqueZipPath(dir, date) {
  const base = stamp(date)
  let candidate = path.join(dir, `${base}.zip`)
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${base}-${n}.zip`)
  }
  return candidate
}

/** One relative path, forward-slashed and contained under the workspace root. */
function safeRel(value) {
  const text = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  const parts = text.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return ''
  /* A drive-letter path is a Windows escape. A colon is a legal filename on
     POSIX, so only reject it where it can change the destination. */
  if (process.platform === 'win32' && parts.some((part) => part.includes(':'))) return ''
  return parts.join('/')
}

function skipSource(root, full) {
  const rel = path.relative(root, full)
  if (!rel) return true
  const parts = rel.split(path.sep)
  if (SKIP_TOP.has(parts[0])) return false
  if (SKIP_FILE.has(parts[parts.length - 1])) return false
  if (parts.some((part) => part.endsWith('.tmp'))) return false
  return true
}

/**
 * Walk the workspace once. Directories and symlinks are tracked separately:
 * the ZIP gets directory entries and symlink entries, and the manifest keeps
 * the link targets so a restore can recreate them even where a ZIP extractor
 * would write a link as a regular file.
 */
function collectWorkspace(root) {
  const files = []
  const dirs = []
  const links = []
  let count = 0
  let bytes = 0

  const walk = (dir, rel = '') => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (!skipSource(root, full)) continue
      if (entry.isSymbolicLink()) {
        try {
          links.push({ path: child, target: fs.readlinkSync(full) })
          count += 1
        } catch {
          /* a link that vanished mid-walk */
        }
        continue
      }
      if (entry.isDirectory()) {
        dirs.push(child)
        walk(full, child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(full)
        files.push({ name: child, full, date: stat.mtime })
        count += 1
        bytes += stat.size
      } catch {
        /* a file removed mid-walk */
      }
    }
  }

  walk(root)
  return { files, dirs, links, count, bytes }
}

function zipSymlink(entry) {
  const mode = Number(entry?.externalFileAttributes || 0) >>> 16
  return (mode & 0o170000) === 0o120000
}

async function readZipManifest(file) {
  let directory
  try {
    directory = await unzipper.Open.file(file)
  } catch {
    return null
  }
  const entry = directory.files.find((row) => row.path === MANIFEST_FILE)
  if (!entry) return null
  try {
    const buffer = await entry.buffer()
    const manifest = JSON.parse(buffer.toString('utf8'))
    if (!manifest || manifest.schema !== SCHEMA || manifest.kind !== KIND) return null
    return manifest
  } catch {
    return null
  }
}

async function listSnapshots(id) {
  const dir = backupDir(id)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !/\.zip$/i.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    const manifest = await readZipManifest(file)
    if (!manifest) continue
    const date = new Date(manifest.createdAt)
    if (!Number.isFinite(date.getTime())) continue
    let bytes = 0
    try {
      bytes = fs.statSync(file).size
    } catch {
      continue
    }
    out.push({
      name: entry.name,
      file,
      createdAt: manifest.createdAt,
      date,
      reason: manifest.reason === 'manual' ? 'manual' : 'auto',
      mode: modeOf(manifest.mode),
      files: Number.isFinite(manifest.files) ? manifest.files : 0,
      bytes,
      sourceBytes: Number.isFinite(manifest.bytes) ? manifest.bytes : 0,
      label: String(manifest.label || ''),
    })
  }
  out.sort((a, b) => b.date.getTime() - a.date.getTime())
  return out
}

/** `.tmp-*` files are a crash or a quit mid-write. They are not backups. */
function cleanStaleTemps(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.name.startsWith('.tmp-')) continue
    const full = path.join(dir, entry.name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* another instance may still be writing it */
    }
  }
}

function workspaceArchiveError(error) {
  return String(error?.message || error)
}

/**
 * Write one ZIP: manifest first, then directories, symlinks and files. The
 * archive goes to a temp name in the target directory and is renamed into
 * place only after the stream closed, so a crash cannot leave a short ZIP
 * looking like a valid backup.
 */
async function createSnapshot(record, { reason = 'auto', mode = DEFAULT_MODE } = {}) {
  const config = readConfig(record.id)
  const dir = path.join(directoryOf(config), record.id)
  if (isInside(record.path, dir)) {
    throw new Error('The backup folder is inside this workspace. Choose a folder outside it.')
  }
  ensureDir(dir, 0o700)
  cleanStaleTemps(dir)

  const createdAt = nowIso()
  const date = new Date(createdAt)
  const target = uniqueZipPath(dir, date)
  const tmp = path.join(dir, `.tmp-${path.basename(target)}-${process.pid}`)
  fs.rmSync(tmp, { force: true })

  /* A backup must contain the skill bytes, not a link to a harness library
     that the next machine may not have. */
  workspaces.materialiseSkillLinks(record)
  const collected = collectWorkspace(record.path)
  const manifest = {
    schema: SCHEMA,
    kind: KIND,
    format: 'zip',
    workspace: record.id,
    label: record.label,
    createdAt,
    reason: reason === 'manual' ? 'manual' : 'auto',
    mode: modeOf(mode),
    files: collected.count,
    bytes: collected.bytes,
    dirs: collected.dirs,
    links: collected.links,
  }

  const zipfile = new yazl.ZipFile()
  const output = fs.createWriteStream(tmp, { mode: ZIP_MODE })
  const done = new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    zipfile.on('error', fail)
    zipfile.outputStream.on('error', fail)
    output.on('error', fail)
    output.on('close', finish)
  })

  zipfile.outputStream.pipe(output)
  try {
    /* The manifest goes in first; the ZIP central directory is still at the
       end, but a person opening the archive sees what it is immediately. */
    zipfile.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), MANIFEST_FILE, {
      mtime: date,
      mode: 0o100600,
    })
    for (const rel of collected.dirs) {
      zipfile.addEmptyDirectory(`${rel}/`, { mtime: date, mode: 0o040755 })
    }
    for (const file of collected.files) {
      zipfile.addFile(file.full, file.name, { mtime: file.date, mode: 0o100644 })
    }
    /* Symlinks are not ZIP entries: the manifest carries their targets, and
       restore recreates them with the right junction/symlink for the OS. */
    zipfile.end()
    await done

    fs.renameSync(tmp, target)
    try {
      fs.chmodSync(target, ZIP_MODE)
    } catch {
      /* a filesystem without modes */
    }
    try {
      writeConfig(record.id, { lastBackupAt: createdAt, lastError: null })
    } catch {
      /* the ZIP is the product; a settings write must not delete it */
    }
    try {
      await prune(record.id, modeOf(mode), date)
    } catch {
      /* retention is best effort; the new ZIP is already safe */
    }
    let bytes = 0
    try {
      bytes = fs.statSync(target).size
    } catch {
      /* the entry is still valid; the size is cosmetic */
    }
    return {
      name: path.basename(target),
      createdAt,
      reason: manifest.reason,
      mode: manifest.mode,
      files: manifest.files,
      bytes,
      sourceBytes: manifest.bytes,
    }
  } catch (error) {
    output.destroy()
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* the stream may still be closing on Windows */
    }
    try {
      writeConfig(record.id, {
        lastError: { at: nowIso(), message: workspaceArchiveError(error) },
      })
    } catch {
      /* the original archive error is the useful one */
    }
    throw error
  }
}

/** Delete every ZIP outside the policy's keep set. */
async function prune(id, mode, now = new Date()) {
  const items = await listSnapshots(id)
  const keep = retentionKeep(items, mode, now)
  const removed = []
  for (const item of items) {
    if (keep.has(item.name)) continue
    try {
      fs.rmSync(item.file, { force: true })
      removed.push(item.name)
    } catch {
      /* an unreadable ZIP is not a reason to fail the new one */
    }
  }
  return removed
}

async function snapshotNameOf(id, name) {
  const value = String(name || '')
  if (
    !value ||
    path.basename(value) !== value ||
    value.startsWith('.') ||
    !/\.zip$/i.test(value)
  ) {
    throw new Error('That is not a backup ZIP name.')
  }
  const file = path.join(backupDir(id), value)
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) throw new Error('That backup no longer exists.')
  const manifest = await readZipManifest(file)
  if (!manifest) throw new Error('That ZIP is not an entity workspace backup.')
  return { name: value, file, manifest, bytes: stat.size }
}

async function entryFor(record, now = new Date()) {
  const config = readConfig(record.id)
  const directory = directoryOf(config)
  const items = await listSnapshots(record.id)
  const info = infoOf(config.mode)
  const lastBackupAt = config.lastBackupAt || items[0]?.createdAt || ''
  return {
    id: record.id,
    label: record.label,
    displayPath: record.displayPath || record.path,
    mode: config.mode,
    automatic: info.automatic,
    directory,
    directoryDisplay: tilde(directory),
    defaultDirectory: path.resolve(directory) === path.resolve(ROOT),
    backupDir: path.join(directory, record.id),
    backupDirDisplay: tilde(path.join(directory, record.id)),
    lastBackupAt,
    lastError: config.lastError,
    running: running.has(record.id),
    due: shouldRun(config.mode, items, now),
    nextDueAt: nextDueAt(config.mode, items, now),
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    items: items.map(({ date, file, ...item }) => item),
  }
}

async function status(now = new Date()) {
  const rows = await Promise.all(workspaces.list().map((record) => entryFor(record, now)))
  return {
    root: ROOT,
    displayRoot: tilde(ROOT),
    modes: MODE_INFO,
    defaultMode: DEFAULT_MODE,
    intervalMs: INTERVAL_MS,
    workspaces: rows,
  }
}

function runNow(id) {
  const record = workspaces.open(id)
  if (running.has(record.id)) throw new Error('A backup is already running for this workspace.')
  const config = readConfig(record.id)
  /* Reservation before the async call: `createSnapshot` can reject before its
     first await (an unwritable target), and a rejected promise in the map
     would lock this workspace out of every future backup. */
  running.set(record.id, null)
  const task = (async () => {
    try {
      await createSnapshot(record, { reason: 'manual', mode: config.mode })
    } finally {
      running.delete(record.id)
    }
  })()
  return task.then(() => entryFor(workspaces.open(id)))
}

async function setMode({ id, mode } = {}) {
  const record = workspaces.open(id)
  const next = modeOf(mode)
  writeConfig(record.id, { mode: next })
  const items = listSnapshots(record.id)
  /* The schedule change is instant; the first snapshot runs behind it. Wait
     only until the task has decided to start (or not), then return the entry
     with `running` set. Waiting for the archive would freeze the radio. */
  let started
  const decided = new Promise((resolve) => {
    started = resolve
  })
  const task = (async () => {
    try {
      const rows = await items
      if (running.has(record.id) || !shouldRun(next, rows)) return
      running.set(record.id, null)
      started()
      try {
        await createSnapshot(record, { reason: 'auto', mode: next })
      } catch {
        /* the config keeps lastError for the page to show */
      } finally {
        running.delete(record.id)
      }
    } finally {
      started()
    }
  })()
  task.catch(() => {})
  await decided
  return entryFor(workspaces.open(id))
}

/** Move existing ZIPs to the new target; roll back if a move fails midway. */
function realPath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function moveZips(oldDir, newDir) {
  if (realPath(oldDir) === realPath(newDir)) return
  let entries = []
  try {
    entries = fs.readdirSync(oldDir, { withFileTypes: true })
  } catch {
    return
  }
  ensureDir(newDir, 0o700)
  const moved = []
  try {
    for (const entry of entries) {
      if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue
      const source = path.join(oldDir, entry.name)
      const base = path.basename(entry.name, '.zip')
      let dest = path.join(newDir, entry.name)
      for (let n = 2; fs.existsSync(dest); n += 1) {
        dest = path.join(newDir, `${base}-${n}.zip`)
      }
      try {
        fs.renameSync(source, dest)
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error
        try {
          fs.copyFileSync(source, dest)
        } catch (error) {
          fs.rmSync(dest, { force: true })
          throw error
        }
        fs.unlinkSync(source)
      }
      moved.push([dest, source])
    }
  } catch (error) {
    for (const [dest, source] of moved.reverse()) {
      try {
        fs.renameSync(dest, source)
      } catch {
        /* a rollback that fails leaves the ZIP at the new target */
      }
    }
    throw error
  }
  try {
    fs.rmdirSync(oldDir)
  } catch {
    /* legacy snapshot directories may still live there */
  }
}

async function setDirectory({ id, directory } = {}) {
  const record = workspaces.open(id)
  if (running.has(record.id)) {
    throw new Error('A backup is running for this workspace. Try again when it finishes.')
  }
  const config = readConfig(record.id)
  const target = validateDirectory(directory)
  /* Create the base folder (without changing its mode), then resolve it. A
     symlink that looks outside can still point into the workspace. */
  fs.mkdirSync(target, { recursive: true })
  const realTarget = realPath(target)
  const newDir = path.join(realTarget, record.id)
  if (isInside(record.path, newDir)) {
    throw new Error('Choose a folder outside this workspace — a backup of the workspace cannot live inside it.')
  }

  ensureDir(newDir, 0o700)
  const probe = path.join(newDir, `.write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
  } finally {
    fs.rmSync(probe, { force: true })
  }

  const oldDir = path.join(directoryOf(config), record.id)
  moveZips(oldDir, newDir)
  writeConfig(record.id, { directory: realTarget })
  return entryFor(workspaces.open(id))
}

async function openFolder({ id, name, openPath } = {}) {
  if (typeof openPath !== 'function') {
    throw new Error('Opening a folder is not available in this build.')
  }
  const record = workspaces.open(id)
  let target = backupDirOf(record)
  if (name) target = path.dirname((await snapshotNameOf(record.id, name)).file)
  ensureDir(target, 0o700)
  await openPath(target)
  return { path: target }
}

async function removeSnapshot({ id, name } = {}) {
  const record = workspaces.open(id)
  if (running.has(record.id)) {
    throw new Error('A backup is running for this workspace. Try again when it finishes.')
  }
  const snapshot = await snapshotNameOf(record.id, name)
  fs.rmSync(snapshot.file, { force: true })
  return entryFor(workspaces.open(id))
}

function uniqueRestoreLabel(label) {
  const base = String(label || 'Workspace')
    .replace(/\s*\(restored\)$/i, '')
    .trim()
    .slice(0, 70)
  return `${base || 'Workspace'} (restored)`
}

function recreateLinks(staging, links, warnings) {
  for (const link of Array.isArray(links) ? links : []) {
    const rel = safeRel(link?.path)
    const target = String(link?.target || '')
    if (!rel || !target) continue
    const dest = path.join(staging, ...rel.split('/'))
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(dest), target)
    if (!fs.existsSync(resolved)) {
      warnings.push(`${rel}: skill link target is not on this machine`)
      continue
    }
    try {
      ensureDir(path.dirname(dest), 0o755)
      /* if an extractor wrote the symlink entry as a regular file, replace it */
      fs.rmSync(dest, { force: true })
      if (process.platform === 'win32') {
        fs.symlinkSync(resolved, dest, fs.statSync(resolved).isDirectory() ? 'junction' : 'file')
      } else {
        fs.symlinkSync(target, dest)
      }
    } catch {
      warnings.push(`${rel}: skill link could not be recreated`)
    }
  }
}

/**
 * Restore a ZIP as a *new* workspace. The live one is never touched: a
 * recovery you cannot undo is not a recovery.
 */
async function restore({ id, name } = {}) {
  const record = workspaces.open(id)
  if (running.has(record.id)) {
    throw new Error('A backup is running for this workspace. Try again when it finishes.')
  }
  const snapshot = await snapshotNameOf(record.id, name)
  const label = uniqueRestoreLabel(snapshot.manifest.label || record.label)
  const newId = workspaces.uniqueWorkspaceId(label)
  const final = path.join(workspaces.WORKSPACES_DIR, newId)
  /* Outside the watched `workspaces/` tree on Windows: a recursive `fs.watch`
     holds a subdirectory open and Windows refuses to rename it (EPERM). */
  const staging = workspaces.stagingPath('restore', newId)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  const warnings = []
  try {
    const directory = await unzipper.Open.file(snapshot.file)
    for (const entry of directory.files) {
      const rel = safeRel(entry.path)
      if (!rel || rel === MANIFEST_FILE) continue
      const parts = rel.split('/')
      if (SKIP_TOP.has(parts[0]) || SKIP_FILE.has(parts[parts.length - 1])) continue
      if (entry.type === 'Directory') {
        fs.mkdirSync(path.join(staging, ...rel.split('/')), { recursive: true })
        continue
      }
      if (zipSymlink(entry)) continue
      const dest = path.join(staging, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const mode = rel === 'mcp.json' ? 0o600 : 0o644
      await pipeline(entry.stream(), fs.createWriteStream(dest, { mode }))
    }

    for (const rel of Array.isArray(snapshot.manifest.dirs) ? snapshot.manifest.dirs : []) {
      const safe = safeRel(rel)
      if (safe) fs.mkdirSync(path.join(staging, ...safe.split('/')), { recursive: true })
    }
    for (const dir of ['entities', 'chats', 'skills', 'runs', 'artifacts']) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true })
    }

    recreateLinks(staging, snapshot.manifest.links, warnings)

    const workspaceFile = path.join(staging, 'workspace.json')
    const raw = readJson(workspaceFile, {}) || {}
    const now = nowIso()
    writeJson(
      workspaceFile,
      {
        ...raw,
        schema: 1,
        id: newId,
        label,
        kind: 'local',
        createdAt: raw.createdAt || now,
        restoredAt: now,
        restoredFrom: {
          workspace: record.id,
          backup: snapshot.name,
          createdAt: snapshot.manifest.createdAt || '',
        },
      },
      0o644,
    )

    const membersFile = path.join(staging, 'members.json')
    const members = readJson(membersFile, null)
    if (members && typeof members === 'object') {
      writeJson(membersFile, { ...members, schema: 1, workspace: newId, updatedAt: now }, 0o644)
    }

    workspaces.moveIntoPlace(staging, final)
    return {
      record: workspaces.open(newId),
      warnings,
      source: { workspace: record.id, backup: snapshot.name },
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/* ── the scheduler ────────────────────────────────────────────────── */

async function tick({ log = () => {} } = {}) {
  if (ticking) return
  ticking = true
  try {
    for (const record of workspaces.list()) {
      if (running.has(record.id)) continue
      const config = readConfig(record.id)
      const items = await listSnapshots(record.id)
      if (!shouldRun(config.mode, items)) continue
      running.set(record.id, null)
      try {
        await createSnapshot(record, { reason: 'auto', mode: config.mode })
        log(`backed up ${record.id}`)
      } catch (error) {
        log(`backup failed for ${record.id}: ${error?.message || error}`)
      } finally {
        running.delete(record.id)
      }
    }
  } finally {
    ticking = false
  }
}

function start({ log = () => {} } = {}) {
  if (timer) return
  bootTimer = setTimeout(() => {
    tick({ log }).catch(() => {})
  }, START_DELAY_MS)
  bootTimer.unref?.()
  timer = setInterval(() => {
    tick({ log }).catch(() => {})
  }, INTERVAL_MS)
  timer.unref?.()
}

function stop() {
  if (bootTimer) clearTimeout(bootTimer)
  if (timer) clearInterval(timer)
  bootTimer = null
  timer = null
}

module.exports = {
  ROOT,
  MODE_INFO,
  DEFAULT_MODE,
  status,
  runNow,
  setMode,
  setDirectory,
  openFolder,
  removeSnapshot,
  restore,
  start,
  stop,
  /* pure policy helpers, for the unit tests */
  retentionKeep,
  shouldRun,
  nextDueAt,
  listSnapshots,
  createSnapshot,
  tick,
}
