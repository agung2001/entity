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
 * The walk itself (stored path → `ENTITY_ORCA_BIN` → these candidates → PATH) and
 * the preference file are `connectors/_binary.cjs`, shared with `gh`. What is
 * Orca's own is where an installed app keeps its CLI on each platform, and the order
 * below.
 *
 * **The order, and why it is this order.** The app's own install first, then the
 * user's bin, then the system directories. Step 2 before 3 is not cosmetic:
 * `/usr/local/bin/orca` is, on real machines, a root-owned symlink into an app
 * bundle that may no longer exist, and a stale one must not outrank a working
 * `~/.local/bin/orca` — `existsSync` is false for a broken symlink, which is exactly
 * the check wanted, on every platform.
 *
 * Nothing here throws. A resolver that threw would fail a run over a tool it might
 * not even need; an answer that cannot run is reported by the probe, with the path
 * that was tried.
 */
const os = require('node:os')
const path = require('node:path')
const { resolverFor } = require('../_binary.cjs')
const config = require('./config.cjs')

const WIN = process.platform === 'win32'
/* A CLI inside an installed app lives under `resources/bin`, the same relative path
   on every platform — the macOS bundle just spells it `Contents/Resources`. */
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
  return [path.join(home, '.local', 'bin'), path.join(home, 'bin')].flatMap((dir) =>
    NAMES.map((name) => path.join(dir, name)),
  )
}

/** System installs. Linux keeps them in one place; macOS appends its own. */
function systemCandidates() {
  if (WIN) return []
  const dirs = ['/usr/local/bin', '/usr/bin']
  /* `snap install` is a real way a CLI lands on a Linux box and not on a Mac. */
  if (process.platform !== 'darwin') dirs.push('/snap/bin')
  return dirs.map((dir) => path.join(dir, 'orca'))
}

const orca = resolverFor({
  store: config,
  environment: 'ENTITY_ORCA_BIN',
  bare: 'orca',
  groups: [
    { source: 'app', paths: installCandidates() },
    { source: 'home', paths: homeCandidates() },
    { source: 'system', paths: systemCandidates() },
  ],
})

module.exports = {
  candidates: orca.candidates,
  resolve: orca.resolve,
  orcaBinary: orca.binary,
  orcaDir: orca.dir,
}
