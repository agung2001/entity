#!/usr/bin/env node
/**
 * Install the macOS app produced by `npm run package:mac`, replacing an
 * existing copy in /Applications.
 *
 * The DMG is mounted read-only, the `.app` inside is copied to a staging path
 * with ditto, and only then swapped into place. The profile under ~/.entity is
 * never touched. Set ENTITY_APP_DIR to install somewhere other than
 * /Applications, for example `ENTITY_APP_DIR="$HOME/Applications"`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version, build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const productName = build?.productName || 'Entity'

if (process.platform !== 'darwin') {
  console.error('package:mac:install only runs on macOS.')
  process.exit(1)
}

const releaseDir = path.join(root, 'release')
const exact = path.join(releaseDir, `${productName}-${version}.dmg`)
const dmg = fs.existsSync(exact)
  ? exact
  : (fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [])
      .filter((name) => name.endsWith('.dmg'))
      .map((name) => path.join(releaseDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]

if (!dmg || !fs.existsSync(dmg)) {
  console.error(`Missing a .dmg in ${path.relative(root, releaseDir)}. Run \`npm run package:mac\` first.`)
  process.exit(1)
}

const targetDir = process.env.ENTITY_APP_DIR || '/Applications'
const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-dmg-'))
let mounted = false

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function quitRunningApp() {
  const running = spawnSync('/usr/bin/pgrep', ['-x', productName], { stdio: 'ignore' })
  if (running.status !== 0) return
  console.log(`Quitting running ${productName}…`)
  spawnSync('/usr/bin/osascript', ['-e', `tell application "${productName}" to quit`], {
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spawnSync('/usr/bin/pgrep', ['-x', productName], { stdio: 'ignore' }).status !== 0) return
    sleep(250)
  }
  console.warn(`  ${productName} is still running; continuing anyway.`)
}

try {
  execFileSync('/usr/bin/hdiutil', [
    'attach',
    '-nobrowse',
    '-readonly',
    '-mountpoint',
    mountPoint,
    dmg,
  ], { stdio: 'ignore' })
  mounted = true

  const appName = fs
    .readdirSync(mountPoint)
    .filter((name) => name.endsWith('.app'))
    .sort((a, b) => {
      const preferred = `${productName}.app`
      if (a === preferred) return -1
      if (b === preferred) return 1
      return a.localeCompare(b)
    })[0]
  if (!appName) throw new Error(`No .app found inside ${path.basename(dmg)}`)

  const sourceApp = path.join(mountPoint, appName)
  const targetApp = path.join(targetDir, appName)
  const stagingApp = path.join(targetDir, `.${appName}.new-${process.pid}`)

  fs.mkdirSync(targetDir, { recursive: true })
  quitRunningApp()

  fs.rmSync(stagingApp, { recursive: true, force: true })
  try {
    execFileSync('/usr/bin/ditto', [sourceApp, stagingApp])
    fs.rmSync(targetApp, { recursive: true, force: true })
    fs.renameSync(stagingApp, targetApp)
  } catch (error) {
    fs.rmSync(stagingApp, { recursive: true, force: true })
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new Error(
        `Cannot write ${targetDir}. Run \`npm run package:mac\` then \`sudo node scripts/install-mac.mjs\`, or set ENTITY_APP_DIR to a writable folder.`,
      )
    }
    throw error
  }

  spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetApp], { stdio: 'ignore' })

  console.log(`Installed ${productName} ${version}`)
  console.log(`  app   ${targetApp}`)
  console.log(`  from  ${dmg}`)
} finally {
  if (mounted) {
    spawnSync('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
  }
  fs.rmSync(mountPoint, { recursive: true, force: true })
}
