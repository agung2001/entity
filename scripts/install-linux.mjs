#!/usr/bin/env node
/**
 * Install the Linux AppImage produced by `npm run package:linux` for the
 * current user, replacing whatever is already installed in ~/Applications.
 *
 * What it touches, all under the user's home:
 *   ~/Applications/Entity.AppImage          the live binary
 *   ~/.local/share/applications/*.desktop   launcher entry
 *   ~/.local/share/icons/hicolor/<size>/apps  icon ladder
 *   ~/.local/bin/entity-<version>.AppImage  convenience symlink
 *
 * The profile under ~/.entity is never touched. Set XDG_DATA_HOME to install
 * the launcher/icon elsewhere; ENTITY_APP_DIR overrides ~/Applications.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const home = os.homedir()
const appDir = process.env.ENTITY_APP_DIR || path.join(home, 'Applications')
const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
const binDir = path.join(home, '.local', 'bin')

const source = path.join(root, 'release', `Entity-${version}.AppImage`)
if (!fs.existsSync(source)) {
  console.error(`Missing ${path.relative(root, source)}. Run \`npm run package:linux\` first.`)
  process.exit(1)
}

const target = path.join(appDir, 'Entity.AppImage')
fs.mkdirSync(appDir, { recursive: true })
fs.copyFileSync(source, target)
fs.chmodSync(target, 0o755)

const iconDir = path.join(root, 'build', 'icons')
if (fs.existsSync(iconDir)) {
  for (const file of fs.readdirSync(iconDir)) {
    const match = /^(\d+x\d+)\.png$/.exec(file)
    if (!match) continue
    const size = match[1]
    const destination = path.join(dataHome, 'icons', 'hicolor', size, 'apps')
    fs.mkdirSync(destination, { recursive: true })
    fs.copyFileSync(path.join(iconDir, file), path.join(destination, 'entity.png'))
  }
}

const applications = path.join(dataHome, 'applications')
fs.mkdirSync(applications, { recursive: true })
const desktop = path.join(applications, 'entity.desktop')
fs.writeFileSync(
  desktop,
  [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Entity',
    'Comment=Vue 3 + Electron desktop application',
    `Exec=${target} %U`,
    'Icon=entity',
    'Terminal=false',
    'Categories=Utility;',
    'StartupWMClass=entity',
    'MimeType=x-scheme-handler/entity;',
    '',
  ].join('\n'),
)
fs.chmodSync(desktop, 0o644)

fs.mkdirSync(binDir, { recursive: true })
const link = path.join(binDir, `entity-${version}.AppImage`)
fs.rmSync(link, { force: true })
fs.symlinkSync(target, link)

for (const [command, args] of [
  ['update-desktop-database', [applications]],
  ['gtk-update-icon-cache', ['-f', '-t', path.join(dataHome, 'icons', 'hicolor')]],
]) {
  spawnSync(command, args, { stdio: 'ignore' })
}

console.log(`Installed Entity ${version}`)
console.log(`  binary   ${target}`)
console.log(`  launcher ${desktop}`)
console.log(`  symlink  ${link}`)
