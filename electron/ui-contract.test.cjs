/**
 * Static contract for the interface rules in DESIGN.md.
 *
 * These are cheap checks over the source, not a browser test: they exist so a
 * dialog added without an Escape handler (or a shortcut typed into a component
 * instead of the catalog) fails `npm test` instead of surviving review.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.vue')) out.push(full)
  }
  return out
}

const FILES = walk(SRC).map((file) => ({
  file,
  rel: path.relative(ROOT, file),
  text: fs.readFileSync(file, 'utf8'),
}))

test('the composer keeps attachments below the prompt and documents them', () => {
  const composer = fs.readFileSync(path.join(SRC, 'components', 'SlashComposer.vue'), 'utf8')
  const help = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  assert.match(composer, /attach-btn/, 'the composer needs an attachment button before send')
  assert.match(composer, /attach-file-input/, 'the attachment button opens file and folder pickers')
  assert.match(help, /@file:/, 'Composer help documents file attachments')
  assert.match(help, /@mcp:/, 'Composer help documents MCP attachments')
  assert.doesNotMatch(help, /@skill:/, 'skills stay on the slash syntax')
})

test('the machine capability page brands harnesses and offers search', () => {
  const file = path.join(SRC, 'views', 'MachineDetailView.vue')
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /<HarnessIcon\b/, 'harnesses need their thesvg mark')
  assert.match(text, /type="search"/, 'the harness/model inventory needs a search input')
})

test('every modal registers an Escape handler', () => {
  const modals = FILES.filter((entry) => /class="[^"]*\bmodal\b/.test(entry.text))
  assert.ok(modals.length > 0, 'expected at least one modal in src/')
  const missing = modals
    .filter((entry) => !/useDialogDismiss\s*\(/.test(entry.text))
    .map((entry) => entry.rel)
  assert.deepEqual(missing, [], `modals without useDialogDismiss: ${missing.join(', ')}`)
})

test('no dialog relies on @keydown.esc on its own element', () => {
  const offenders = FILES.filter((entry) => /@keydown\.esc\b/.test(entry.text)).map(
    (entry) => entry.rel,
  )
  assert.deepEqual(offenders, [], `use useDialogDismiss instead: ${offenders.join(', ')}`)
})

test('the shortcut guide reads the catalog instead of its own combos', () => {
  const guide = fs.readFileSync(path.join(SRC, 'components/ShortcutsDialog.vue'), 'utf8')
  assert.match(guide, /from '@\/lib\/shortcuts'/)
  assert.match(guide, /shortcutGroups\(\)/)
  assert.doesNotMatch(guide, /['"`]⌘|['"`]Ctrl\+/)
})

test('the guide is reachable from the hub layout', () => {
  const layout = fs.readFileSync(path.join(SRC, 'layouts/HubLayout.vue'), 'utf8')
  assert.match(layout, /import ShortcutsDialog from '@\/components\/ShortcutsDialog.vue'/)
  assert.match(layout, /<ShortcutsDialog/)
  assert.match(layout, /matchesShortcut\('guide'/)
})

test('no component hard-codes a shortcut combo', () => {
  const offenders = FILES.filter(
    (entry) =>
      !entry.rel.endsWith('src/components/ShortcutsDialog.vue') &&
      /⌘|⌥|⇧|Ctrl\+/.test(entry.text),
  ).map((entry) => entry.rel)
  assert.deepEqual(offenders, [], `use shortcutLabel() instead: ${offenders.join(', ')}`)
})

test('the shortcut catalog is well formed and unique', () => {
  const catalog = fs.readFileSync(path.join(SRC, 'lib/shortcuts.js'), 'utf8')
  for (const group of ['anywhere', 'chat']) {
    assert.match(catalog, new RegExp(`id: '${group}'`), `missing group ${group}`)
  }
  const ids = [...catalog.matchAll(/^\s{8}id: '([a-z-]+)',$/gm)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, 'duplicate shortcut ids')
  for (const id of ['palette', 'rail', 'theme', 'new-thread', 'escape', 'guide', 'focus', 'send', 'timeline']) {
    assert.ok(ids.includes(id), `missing shortcut ${id}`)
  }
})

/* ── loading budget ────────────────────────────────────────────────────────
   The app is a desktop shell around local files; a screen that is never
   opened should never be downloaded. These checks keep the entry chunk from
   quietly collecting every view again. */

const MODULES = []
function walkModules(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkModules(full)
    else if (entry.name.endsWith('.js')) {
      MODULES.push({ file: full, rel: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf8') })
    }
  }
}
walkModules(SRC)

test('every route component is a dynamic import', () => {
  const router = fs.readFileSync(path.join(SRC, 'router.js'), 'utf8')
  assert.doesNotMatch(router, /^import \w+ from '@\/views\//m, 'a view is imported statically')
  assert.doesNotMatch(router, /^import \w+ from '@\/layouts\//m, 'the layout is imported statically')
  const lazy = new Set([...router.matchAll(/const (\w+) = \(\) => import\('@\/[^']+'\)/g)].map((m) => m[1]))
  const used = [...router.matchAll(/component: (\w+)/g)].map((m) => m[1])
  const eager = used.filter((name) => !lazy.has(name))
  assert.deepEqual(eager, [], `route components without a dynamic import: ${eager.join(', ')}`)
})

test('the entry module does not pull a screen or the parser', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')
  assert.doesNotMatch(main, /@\/views\//)
  assert.doesNotMatch(main, /@\/layouts\//)
  assert.doesNotMatch(main, /@\/components\//)
})

test('marked and dompurify live behind the lazy prose engine', () => {
  const importers = MODULES.filter((entry) => /from '(marked|dompurify)'/.test(entry.text)).map(
    (entry) => entry.rel,
  )
  assert.deepEqual(importers, ['src/lib/prose-engine.js'])
})
