/**
 * The desktop shell is not a browser tab: it needs an application icon and a
 * title bar a person can grab. Both are easy to lose in a refactor, and neither
 * shows up in the renderer tests.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('the packaged app has an icon for every platform', () => {
  for (const platform of ['mac', 'win', 'linux']) {
    const icon = pkg.build?.[platform]?.icon
    assert.ok(icon, `${platform} config names an icon`)
    assert.ok(fs.existsSync(path.join(root, icon)), `${icon} exists`)
  }
  /* The same PNG is the runtime window icon in dev and on Linux. */
  assert.ok(pkg.build.files.includes('build/icon.png'))
  assert.deepEqual(pkg.build.extraResources?.[0], { from: 'build/icon.png', to: 'icon.png' })
})

test('the window keeps a title bar that can be dragged', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /titleBarStyle: 'default'/)
  assert.match(source, /app\.dock\.setIcon/)
})
