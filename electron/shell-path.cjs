/**
 * A GUI app does not inherit the PATH a terminal has.
 *
 * Launched from Finder or the Dock, macOS gives an app `/usr/bin:/bin:/usr/sbin:/sbin`
 * — no Homebrew, no npm global prefix, no version manager. Harness discovery then
 * reports "pi is not installed" for a binary that is right there in /opt/homebrew/bin.
 *
 * Add the usual install locations once, at boot, before any harness is looked up or
 * spawned. A custom prefix still belongs in Configuration → Harness path; this only
 * restores what a terminal user would already have.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* User-installed tools first; the system directories stay last. */
const POSIX_PREFIX = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
const POSIX_SYSTEM = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

const HOME_DIRS = [
  '.local/bin',
  'bin',
  '.npm-global/bin',
  '.bun/bin',
  '.volta/bin',
  '.local/share/pnpm',
  'Library/pnpm',
  '.asdf/shims',
  '.local/share/mise/shims',
  '.nodenv/shims',
]

function readdir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
}

function newestFirst(a, b) {
  return String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * The version directories, newest first, so the first `node` on PATH is the one
 * a terminal would use. Takes plain names, not `Dirent` objects — sorting the
 * objects themselves is what broke a packaged build in the first place.
 */
function newestNames(dir) {
  return readdir(dir)
    .map((entry) => entry.name)
    .sort(newestFirst)
}

/** Version managers keep their bin directories under the home folder. */
function versionManagerDirs(home) {
  const dirs = []
  const nvm = path.join(home, '.nvm', 'versions', 'node')
  for (const name of newestNames(nvm)) dirs.push(path.join(nvm, name, 'bin'))

  const fnm = path.join(home, '.fnm', 'node-versions')
  for (const name of newestNames(fnm)) {
    dirs.push(path.join(fnm, name, 'installation', 'bin'))
  }
  return dirs
}

function candidateDirs({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const dirs = []
    const appData = env.APPDATA || ''
    const localAppData = env.LOCALAPPDATA || ''
    const profile = env.USERPROFILE || home
    if (appData) dirs.push(path.join(appData, 'npm'))
    if (localAppData) dirs.push(path.join(localAppData, 'pnpm'))
    dirs.push(path.join(profile, '.volta', 'bin'), path.join(profile, '.bun', 'bin'))
    return dirs
  }
  return [
    ...POSIX_PREFIX,
    ...HOME_DIRS.map((rel) => path.join(home, rel)),
    ...versionManagerDirs(home),
    ...POSIX_SYSTEM,
  ]
}

/**
 * Prepend the discovered directories to `env.PATH`, keeping the original order and
 * dropping duplicates or paths that do not exist (a dead PATH entry only slows
 * every lookup). Returns the value it set, so a caller or a test can inspect it.
 */
function ensureGuiPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const key = platform === 'win32' ? 'Path' : 'PATH'
  const current = String(env[key] || env.PATH || '')
  const seen = new Set()
  const kept = []
  for (const dir of [...candidateDirs({ platform, home, env }), ...current.split(path.delimiter)]) {
    const value = String(dir || '').trim()
    if (!value) continue
    const id = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(id)) continue
    seen.add(id)
    if (platform !== 'win32' && !fs.existsSync(value)) continue
    kept.push(value)
  }
  const value = kept.join(path.delimiter)
  env[key] = value
  if (key !== 'PATH') env.PATH = value
  return value
}

module.exports = { candidateDirs, ensureGuiPath }
