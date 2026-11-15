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
