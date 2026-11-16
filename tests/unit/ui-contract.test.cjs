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

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

/* Repo-relative paths are compared as POSIX strings, so the suite reads the
   same on Windows as it does on macOS and Linux. */
const relPosix = (full) => path.relative(ROOT, full).split(path.sep).join('/')

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
  rel: relPosix(file),
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

test('the account has a reachable backups page with smart as the default', () => {
  const router = fs.readFileSync(path.join(SRC, 'router.js'), 'utf8')
  assert.match(router, /name: 'account-backups'/, 'the backups page needs a route')

  const rail = fs.readFileSync(path.join(SRC, 'components', 'RailContext.vue'), 'utf8')
  assert.match(rail, /'\/account\/backups'/, 'the account rail needs a backups row')

  const view = fs.readFileSync(
    path.join(SRC, 'views', 'account', 'AccountBackupView.vue'),
    'utf8',
  )
  assert.match(view, /backup\.status/, 'the page reads the schedule and the shelf')
  assert.match(view, /backup\.run/, 'the page can run a backup now')
  assert.match(view, /backup\.restore/, 'a snapshot can be restored as a copy')
  assert.match(view, /backup\.setDirectory/, 'the target folder is a setting')
  assert.match(view, /backup\.chooseFolder/, 'desktop builds can open a folder picker')
  assert.match(view, /Backup folder/, 'the target folder has a visible control')

  const store = fs.readFileSync(path.join(ROOT, 'electron', 'backup-store.cjs'), 'utf8')
  assert.match(store, /const DEFAULT_MODE = 'smart'/, 'smart is the default')
  assert.match(store, /\.remote\.token/, 'secrets stay out of snapshots')
  assert.match(store, /new yazl\.ZipFile/, 'a snapshot is a ZIP file')
  assert.match(store, /backup\.setDirectory|function setDirectory/, 'the target is persisted')
})

test('voice mode is a dismissible full dialog wired into the composer', () => {
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  const dialog = fs.readFileSync(
    path.join(SRC, 'components', 'VoiceChatDialog.vue'),
    'utf8',
  )
  const catalog = fs.readFileSync(path.join(SRC, 'lib', 'shortcuts.js'), 'utf8')

  assert.match(chat, /<VoiceChatDialog\b/, 'the chat page owns the voice dialog')
  assert.match(chat, /import VoiceChatDialog from/, 'the dialog is mounted by ChatView')
  /* the button sits at the right edge of the composer context row, before help */
  const voiceAt = chat.indexOf('class="compose-voice"')
  const helpAt = chat.indexOf('class="compose-help"')
  assert.ok(voiceAt > 0 && helpAt > voiceAt, 'the voice button must precede Composer help')

  assert.match(dialog, /useDialogDismiss\s*\(/, 'Esc must close the voice dialog')
  assert.match(dialog, /aria-label="Close"/, 'the dialog needs a visible close button')
  assert.match(dialog, /class="scrim"/, 'the dialog needs a backdrop that closes it')
  assert.match(dialog, /<EntityMark\b/, 'the entity animation is the centrepiece')
  assert.match(dialog, /voice-emoji/, 'the entity mood emoji is shown large')
  assert.match(dialog, /startMicrophone/, 'the local listener is wired up')
  assert.match(dialog, /voice\.transcribe/, 'the local listener transcribes through the call table')
  /* the spoken answer is also shown, because the voice may be hard to follow */
  assert.match(dialog, /class="voice-reply"/, 'the dialog shows the reply text while speaking')
  assert.match(dialog, /replyChunks/, 'the spoken text is split and highlighted')

  /* every finished answer can be read aloud from the thread itself */
  const list = fs.readFileSync(path.join(SRC, 'components', 'MessageList.vue'), 'utf8')
  assert.match(list, /from '@\/lib\/voice'/, 'the thread reuses the voice module')
  assert.match(list, /Read response aloud/, 'answers get a read-aloud action')
  assert.match(list, /msg-act/, 'it sits with copy, share and save')

  /* the reply must not be cut off by its own voice */
  assert.match(dialog, /mic\?\.hold\(\)/, 'the microphone is held while the entity speaks')
  assert.match(dialog, /onBargeIn/, 'barge-in comes from the strict local gate')
  assert.ok(
    dialog.indexOf('isStopPhrase(clean)') < dialog.indexOf('echoLikely(clean'),
    'a spoken "stop" must be handled before the echo test',
  )

  assert.match(catalog, /id: 'voice'/, 'the shortcut belongs in the catalog')
  assert.match(chat, /matchesShortcut\('voice'/, 'the catalog entry needs a handler')
  /* a browser tab's paste-as-plain keeps the combo inside a text field */
  assert.match(chat, /isField\(event\.target\)/, 'voice must not steal paste-as-plain')
  assert.match(chat, /voiceShortcut = shortcutLabel\('voice'\)/, 'the hint comes from the catalog')
})

test('the thread metadata drawer is dismissible and belongs to the chat header', () => {
  const panel = fs.readFileSync(
    path.join(SRC, 'components', 'ThreadMetadataPanel.vue'),
    'utf8',
  )
  assert.match(panel, /useDialogDismiss\s*\(/, 'the drawer must register an Escape entry')
  assert.match(panel, /aria-label="Close thread metadata"/, 'the drawer needs a close button')
  assert.match(panel, /type="search"/, 'a list of links and paths needs a visible filter')

  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  assert.match(chat, /<ThreadMetadataPanel\b/, 'the chat owns the drawer')
  assert.match(chat, /matchesShortcut\('metadata'/, 'the catalog entry needs a handler')
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
  for (const id of ['palette', 'rail', 'theme', 'new-thread', 'escape', 'guide', 'focus', 'send', 'timeline', 'metadata', 'voice', 'terminal']) {
    assert.ok(ids.includes(id), `missing shortcut ${id}`)
  }
})

test('the composer ceiling lives in CSS, not in the component', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles/app.css'), 'utf8')
  const composer = fs.readFileSync(path.join(SRC, 'components/SlashComposer.vue'), 'utf8')
  const rule = css.match(/\.slash-input\s*\{[^}]*max-height:\s*([^;]+);/)
  assert.ok(rule, '.slash-input has no max-height')
  const ceiling = rule[1].trim()
  /* viewport-relative, so a short window still leaves the transcript a screen */
  assert.match(ceiling, /vh/, `the ceiling does not follow the window: ${ceiling}`)
  const px = Number.parseFloat(ceiling.replace(/^min\(/, '').split(',').pop())
  assert.ok(px >= 320, `a long draft stops growing too early: ${ceiling}`)
  /* one ceiling: the component reads it instead of repeating the number */
  assert.match(composer, /getComputedStyle\(el\)\.maxHeight/, 'the component reads the ceiling')
  assert.doesNotMatch(composer, /Math\.min\(el\.scrollHeight,\s*\d+\)/, 'the ceiling is hard-coded')
})

/* ── the chat header ─────────────────────────────────────────────────────
   The bar floats over the thread as glass with the identity on the left and the
   actions on the right; the counters live on the composer. A header back in the
   flow has nothing to blur, and one that does not pay for its own measured
   height hides the first line of the thread. */

test('the chat header floats over the thread with two zones of glass', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles/app.css'), 'utf8')
  const view = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')

  const rule = css.match(/\n\.cp-head \{[^}]*\}/)
  assert.ok(rule, '.cp-head has no base rule')
  assert.match(rule[0], /position:\s*absolute/, 'the header is still in the flow')
  assert.match(rule[0], /container-type:\s*inline-size/, 'the header does not answer to its own column')
  /* the tint and the blur live in one place, over the pixel field */
  const glass = css.match(/\n\.cpanel > \.cp-head \{[^}]*\}/)
  assert.ok(glass, 'the header has no glass rule')
  assert.match(glass[0], /backdrop-filter:\s*blur\(/, 'the header is not glass')
  assert.match(glass[0], /background:[^;]*transparent/, 'the header is painted opaque')

  const columns = rule[0].match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(columns, 'the header is not a grid')
  /* one entry per track: collapse minmax(...) first, its contents hold spaces */
  const tracks = columns[1].trim().replace(/\([^()]*\)/g, 'track').split(/\s+/)
  assert.equal(tracks.length, 2, `the header needs two zones: ${columns[1]}`)
  /* a long title wraps; the measured height keeps the transcript clear */
  assert.match(rule[0], /height:\s*auto/, 'the header cannot grow with the title')
  assert.match(view, /headObserver/, 'the header height is not measured')

  /* the list owes the floating bar its height, from the same variable */
  const list = css.match(/\n\.c-thread \{[^}]*\}/)
  assert.ok(list, '.c-thread has no base rule')
  assert.match(
    list[0],
    /padding:\s*calc\(var\(--cp-head-h/,
    'the transcript does not reserve the floating header',
  )

  /* counters are not chrome: the timeline already names the turns */
  const header = view.match(/<header[^>]*class="cp-head"[^>]*>[\s\S]*?<\/header>/)
  assert.ok(header, 'no chat header in the view')
  assert.match(header[0], /class="cp-left"/, 'the identity is not a zone of its own')
  assert.equal((view.match(/class="ask-stat"/g) || []).length, 0, 'the counters came back')
})

test('the terminal sheet is a closed card, not a flap', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles/app.css'), 'utf8')
  const rule = css.match(/\n\.term-panel \{[^}]*\}/)
  assert.ok(rule, '.term-panel has no base rule')
  assert.doesNotMatch(rule[0], /border-bottom:\s*0/, 'the sheet is drawn open at the bottom')
  assert.match(rule[0], /border:\s*1px solid/, 'the sheet has no border of its own')
  assert.match(rule[0], /border-radius:\s*12px/, 'the sheet is not rounded on all four corners')
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
      MODULES.push({ file: full, rel: relPosix(full), text: fs.readFileSync(full, 'utf8') })
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

test('the chart renderer is imported only behind the lazy chart component', () => {
  const importers = MODULES.filter((entry) => /from 'echarts\//.test(entry.text)).map(
    (entry) => entry.rel,
  )
  assert.deepEqual(importers, ['src/lib/echarts-core.js'])
  const chart = FILES.find((entry) => entry.rel.endsWith('src/components/EChart.vue'))
  assert.match(chart.text, /import\('@\/lib\/echarts-core'\)/)
})

test('marked and dompurify live behind the lazy prose engine', () => {
  const importers = MODULES.filter((entry) => /from '(marked|dompurify)'/.test(entry.text)).map(
    (entry) => entry.rel,
  )
  assert.deepEqual(importers, ['src/lib/prose-engine.js'])
})
