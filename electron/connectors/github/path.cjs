/**
 * Where the `gh` CLI is, decided once instead of once per caller.
 *
 * Four places ask: this connector (which spawns it for a mention), its dashboard
 * (which reads the signed-in logins), the settings probe (which asks whether it
 * runs), and a child harness's environment (`platform-brief.env`), which otherwise
 * spends its first turns on `which gh` and a wrong answer. They share one answer.
 *
 * The walk itself — stored path → `ENTITY_GH_BIN` → these candidates → PATH — and
 * the preference file are `connectors/_binary.cjs`, shared with Orca. What is this
 * connector's own is where each platform's package managers put `gh`.
 *
 * The order is "a package manager's install, then the user's own bin, then the
 * system directories": on macOS both Homebrew prefixes are tried before
 * `/usr/local/bin`, because an Intel-era `gh` there must not outrank the
 * Apple-silicon one a person actually uses; `existsSync` rejects a broken symlink,
 * which is the same trap that made `/usr/local/bin/orca` useless.
 *
 * Nothing here throws. An answer that cannot run is the probe's to report, with the
 * path that was tried.
 */
const os = require('node:os')
const path = require('node:path')
const { resolverFor } = require('../_binary.cjs')
const config = require('./config.cjs')

const WIN = process.platform === 'win32'
/* `gh.exe` from the MSI, `gh.exe` from scoop's shim, `gh.cmd` from an npm install. */
const NAMES = WIN ? ['gh.exe', 'gh.cmd'] : ['gh']

/** Where a platform's package manager installs `gh`. */
function packageCandidates() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    /* Apple silicon Homebrew, then Intel's — one of the two exists on a real Mac. */
    return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
  }
  if (WIN) {
    /* The MSI's two roots, scoop's shims, and Chocolatey's bin. */
    const roots = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'GitHub CLI'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI'),
    ].filter(Boolean)
    const named = roots.flatMap((root) => NAMES.map((name) => path.join(root, name)))
    if (process.env.USERPROFILE) named.push(path.join(process.env.USERPROFILE, 'scoop', 'shims', 'gh.exe'))
    if (process.env.ProgramData) named.push(path.join(process.env.ProgramData, 'chocolatey', 'bin', 'gh.exe'))
    return named
  }
  /* Linuxbrew, then the distro's own two. */
  return [
    path.join(home, '.linuxbrew', 'bin', 'gh'),
    '/home/linuxbrew/.linuxbrew/bin/gh',
    '/usr/local/bin/gh',
  ]
}

/** The places a person installs a binary for themselves. */
function homeCandidates() {
  const home = os.homedir()
  return [path.join(home, '.local', 'bin'), path.join(home, 'bin')].flatMap((dir) =>
    NAMES.map((name) => path.join(dir, name)),
  )
}

/** System installs. `snap` and the distro's prefix are Linux only. */
function systemCandidates() {
  if (WIN) return []
  const dirs = ['/usr/bin']
  if (process.platform !== 'darwin') dirs.push('/snap/bin')
  return dirs.map((dir) => path.join(dir, 'gh'))
}

const gh = resolverFor({
  store: config,
  environment: 'ENTITY_GH_BIN',
  bare: 'gh',
  groups: [
    { source: 'package', paths: packageCandidates() },
    { source: 'home', paths: homeCandidates() },
    { source: 'system', paths: systemCandidates() },
  ],
})

module.exports = {
  candidates: gh.candidates,
  resolve: gh.resolve,
  githubBinary: gh.binary,
  githubDir: gh.dir,
}
