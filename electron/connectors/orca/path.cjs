/**
 * Where Orca's CLI is, decided once instead of once per caller.
 *
 * It lives inside the connector folder because it is the connector's own fact, and
 * because three places need the same answer: this connector (which spawns it), the
 * settings probe (which asks whether it runs), and a child harness's environment
 * (`platform-brief.env`), which otherwise spends its first turns rediscovering it —
 * `which orca`, a confused `not found`, then an `ls` of `/Applications`. The app
 * already knows, so it resolves here once and hands the answer over as
 * `ENTITY_ORCA_BIN`.
 *
 * **The order, and why it is this order.**
 *
 *   1. `~/.entity/orca.json` — a path set on the connector's own page. The most
 *      recent, most deliberate answer a person can give (`config.cjs`).
 *   2. `ENTITY_ORCA_BIN` — how a process is *launched* with an Orca; the E2E suite
 *      and a developer's shell use it.
 *   3. The app's own install, per platform: the macOS bundle, the Windows
 *      `resources\bin` under `%LOCALAPPDATA%\Programs\<product>` (which is where
 *      electron-builder's NSIS installer puts one), `/opt` on Linux.
 *   4. The user's own bin — `~/.local/bin`, then `~/bin`, with `.exe`/`.cmd` tried on
 *      Windows.
 *   5. The system directories on Linux only.
 *   6. Bare `orca`, which is a PATH lookup and the last resort, never an error.
 *
 * Step 4 before 5 is not cosmetic: `/usr/local/bin/orca` is, on real machines, a
 * root-owned symlink into an app bundle that may no longer exist. A stale one must
 * not outrank a working `~/.local/bin/orca`, and `existsSync` is false for a broken
 * symlink — which is exactly the check wanted, on every platform.
 *
 * Nothing here throws. A resolver that threw would fail a run over a tool it might
 * not even need; an answer that cannot run is reported by the probe, with the path
 * that was tried.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const config = require('./config.cjs')

const WIN = process.platform === 'win32'
/* A CLI inside an installed app lives under `resources/bin`, the same relative
   path on every platform — the macOS bundle just spells it `Contents/Resources`. */
const RESOURCE_BIN = ['resources', 'bin']

/** The names a binary can have on this platform, in the order one is preferred. */
const NAMES = WIN ? ['orca.exe', 'orca.cmd'] : ['orca']

/** Where an installed app keeps its CLI, in this platform's own layout. */
function installCandidates() {
  if (process.platform === 'darwin') {
    const home = os.homedir()
    return [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      path.join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'),
    ]
  }
  if (WIN) {
    /* electron-builder's NSIS target installs per-user by default and per-machine
       when asked, so both roots are real. */
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Orca'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Orca'),
    ].filter(Boolean)
    return roots.flatMap((root) => NAMES.map((name) => path.join(root, ...RESOURCE_BIN, name)))
  }
  return NAMES.map((name) => path.join('/opt', 'Orca', ...RESOURCE_BIN, name))
}

/** The places a person installs a CLI for themselves. */
function homeCandidates() {
  const home = os.homedir()
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ].flatMap((dir) => NAMES.map((name) => path.join(dir, name)))
}

/** System installs. Linux keeps them in one place; macOS appends its own. */
function systemCandidates() {
  if (WIN) return []
  const dirs = ['/usr/local/bin', '/usr/bin']
  /* `snap install` is a real way a CLI lands on a Linux box and not on a Mac. */
  if (process.platform !== 'darwin') dirs.push('/snap/bin')
  return dirs.map((dir) => path.join(dir, 'orca'))
}

/** Every automatic candidate, in the order they are tried. */
function candidates() {
  return [...installCandidates(), ...homeCandidates(), ...systemCandidates()]
}

/**
 * `{ binary, dir, source, searched }` — what would be spawned, why, and where the
 * search was allowed to look. `searched` is what the connector's page prints, so a
 * person can see the list they are being asked to beat.
 */
function resolve() {
  const stored = config.read()
  if (stored) return { binary: stored, source: 'stored', searched: [] }
  const fromEnv = String(process.env.ENTITY_ORCA_BIN || '').trim()
  if (fromEnv) return { binary: fromEnv, source: 'environment', searched: [] }
  const searched = candidates()
  for (const candidate of searched) {
    if (fs.existsSync(candidate)) return { binary: candidate, source: sourceOf(candidate), searched }
  }
  /* Bare, not empty: a PATH the harness already has is a real place to find it. */
  return { binary: 'orca', source: 'path', searched }
}

/** Which group a candidate came from, for the page's one-word reason. */
function sourceOf(candidate) {
  if (installCandidates().includes(candidate)) return 'app'
  if (homeCandidates().includes(candidate)) return 'home'
  return 'system'
}

function orcaBinary() {
  return resolve().binary
}

/** The directory to put first on `PATH`, or `''` when the binary is bare. */
function orcaDir(binary = orcaBinary()) {
  const value = String(binary || '')
  return value.includes(path.sep) || (WIN && value.includes('/')) ? path.dirname(value) : ''
}

module.exports = { candidates, orcaBinary, orcaDir, resolve }
