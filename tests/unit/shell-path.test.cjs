/**
 * A GUI launch has a bare PATH. Harness discovery must still find a binary in
 * the places a terminal user would already have on PATH.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { ensureGuiPath } = require('../../electron/shell-path.cjs')

test('the GUI PATH gains the home and version-manager bins, once each', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-path-'))
  const local = path.join(home, '.local', 'bin')
  const node = path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'bin')
  fs.mkdirSync(local, { recursive: true })
  fs.mkdirSync(node, { recursive: true })

  const env = { PATH: '/usr/bin:/bin:/usr/bin' }
  const value = ensureGuiPath({ platform: 'linux', home, env })
  const dirs = value.split(':')

  assert.equal(dirs.filter((dir) => dir === '/usr/bin').length, 1)
  assert.ok(dirs.includes(local))
  assert.ok(dirs.includes(node))
  assert.ok(dirs.indexOf(local) < dirs.indexOf('/usr/bin'))
  /* Directories that do not exist are not kept. */
  assert.ok(!dirs.includes(path.join(home, '.volta', 'bin')))
  assert.equal(env.PATH, value)
})

test('pnpm global bins are found in both layouts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-path-'))
  /* pnpm 10 puts shims in `<PNPM_HOME>/bin`; older versions used `<PNPM_HOME>`.
     A pi installed by the nested layout was reported as “not installed”. */
  const flat = path.join(home, 'Library', 'pnpm')
  const nested = path.join(flat, 'bin')
  fs.mkdirSync(flat, { recursive: true })
  fs.mkdirSync(nested, { recursive: true })

  const dirs = ensureGuiPath({ platform: 'darwin', home, env: { PATH: '/usr/bin:/bin' } }).split(':')
  assert.ok(dirs.includes(flat))
  assert.ok(dirs.includes(nested))
})

test('a custom PNPM_HOME is added, with and without its bin directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-path-'))
  const pnpmHome = path.join(home, 'custom-pnpm')
  fs.mkdirSync(path.join(pnpmHome, 'bin'), { recursive: true })

  const dirs = ensureGuiPath({
    platform: 'darwin',
    home,
    env: { PATH: '/usr/bin:/bin', PNPM_HOME: pnpmHome },
  }).split(':')
  assert.ok(dirs.includes(pnpmHome))
  assert.ok(dirs.includes(path.join(pnpmHome, 'bin')))
})

test('version-manager bins are ordered newest first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-path-'))
  const nvm = path.join(home, '.nvm', 'versions', 'node')
  const fnm = path.join(home, '.fnm', 'node-versions')
  const versions = ['v8.17.0', 'v22.12.0', 'v9.11.2']
  for (const version of versions) {
    fs.mkdirSync(path.join(nvm, version, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(fnm, version, 'installation', 'bin'), { recursive: true })
  }

  /* A packaged build once crashed here: the sort compared `Dirent`, not names. */
  const dirs = ensureGuiPath({ platform: 'linux', home, env: { PATH: '/bin' } }).split(':')
  const nvmBins = dirs.filter((dir) => dir.startsWith(nvm))
  const fnmBins = dirs.filter((dir) => dir.startsWith(fnm))

  assert.deepEqual(nvmBins, [
    path.join(nvm, 'v22.12.0', 'bin'),
    path.join(nvm, 'v9.11.2', 'bin'),
    path.join(nvm, 'v8.17.0', 'bin'),
  ])
  assert.deepEqual(fnmBins, [
    path.join(fnm, 'v22.12.0', 'installation', 'bin'),
    path.join(fnm, 'v9.11.2', 'installation', 'bin'),
    path.join(fnm, 'v8.17.0', 'installation', 'bin'),
  ])
})
