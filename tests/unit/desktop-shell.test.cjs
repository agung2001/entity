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
  /* Linux mounts the whole hicolor ladder, not one 1024 px file. A launcher
     asking for a 48 px icon must not be handed a downscaled giant and a file
     manager must not be left without a scalable/small mark. */
  const linuxIcons = fs.readdirSync(path.join(root, pkg.build.linux.icon))
  for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
    assert.ok(linuxIcons.includes(`${size}x${size}.png`), `build/icons has a ${size}px icon`)
  }
  /* The same PNG is the runtime window icon in dev and on Linux. */
  assert.ok(pkg.build.files.includes('build/icon.png'))
  assert.deepEqual(pkg.build.extraResources?.[0], { from: 'build/icon.png', to: 'icon.png' })
})

test('the desktop entry is named for the app Electron actually creates', () => {
  assert.equal(pkg.desktopName, 'entity.desktop')
  assert.equal(pkg.build.linux.syncDesktopName, true)
})

test('the browser install carries PNG marks beside the SVG', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'site.webmanifest'), 'utf8'))
  const sources = manifest.icons.map((icon) => icon.src)
  for (const source of ['./favicon.svg', './icon-192.png', './icon-512.png']) {
    assert.ok(sources.includes(source), `manifest carries ${source}`)
    assert.ok(fs.existsSync(path.join(root, 'public', source.replace('./', ''))), `${source} exists`)
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  assert.match(html, /rel="apple-touch-icon"/)
  assert.match(html, /icon-192\.png/)
})

test('the window keeps a title bar that can be dragged', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /titleBarStyle: 'default'/)
  assert.match(source, /app\.dock\.setIcon/)
})
