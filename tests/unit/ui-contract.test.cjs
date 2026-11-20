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

/* ── stylesheets ──────────────────────────────────────────────────────────
   Styling is split by surface: `src/styles/app.css` is a list of @imports, one
   per file, and that list is the cascade order. The contract reads the sheet the
   app actually loads — app.css with its imports flattened, in that same order —
   so a rule moving to another file never changes what these tests see. */
const STYLES = path.join(SRC, 'styles')
const SHARED_SHEETS = ['login.css', 'skill.css', 'welcome.css']
const SHEETS = [...fs.readFileSync(path.join(STYLES, 'app.css'), 'utf8').matchAll(/@import '\.\/([\w-]+\.css)'/g)].map(
  (match) => match[1],
)

function allStyles() {
  assert.ok(SHEETS.length >= 20, 'app.css should import the per-surface sheets')
  for (const name of SHARED_SHEETS) {
    assert.ok(SHEETS.includes(name), `${name} is no longer imported`)
  }
  return SHEETS.map((name) => fs.readFileSync(path.join(STYLES, name), 'utf8')).join('\n')
}

/** Each sheet with its comments and its token declarations removed: only what a
    surface actually paints, which is what the ladders below are about. */
function paintedSheets() {
  return SHEETS.map((name) => ({
    name,
    css: fs
      .readFileSync(path.join(STYLES, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') /* a commented-out rule is not a rule */
      .replace(/:root(\[[^\]]*\])?\s*\{[^}]*\}/g, '') /* a ladder declares itself */,
  }))
}

/** The steps of one ladder, read from the `:root` block in tokens.css. */
function ladder(prefix, label, minSteps) {
  const tokens = fs.readFileSync(path.join(STYLES, 'tokens.css'), 'utf8')
  const root = tokens.match(/:root \{[\s\S]*?\n\}/)
  assert.ok(root, 'tokens.css has no :root block to declare the ladders in')
  const steps = [...root[0].matchAll(new RegExp(`(${prefix}(?:-[a-z0-9]+)?):\\s*([^;]+);`, 'g'))]
    .map(([, name, value]) => ({ name, value: value.trim() }))
  assert.ok(steps.length >= minSteps, `the ${label} ladder lost its steps (${steps.length})`)
  for (const step of steps) {
    assert.match(step.value, /^\d+(\.\d+)?px$/, `${step.name} is not a plain px step: ${step.value}`)
  }
  /* ascending, and no two steps on the same number: a duplicate is a step that
     was added next to an existing one instead of reused */
  const px = steps.map((step) => Number.parseFloat(step.value))
  for (let i = 1; i < px.length; i += 1) {
    assert.ok(px[i] > px[i - 1], `the ${label} ladder is out of order at ${steps[i].name}`)
  }
  return new Set(steps.map((step) => step.name))
}

test('the composer keeps attachments below the prompt and documents them', () => {
  const composer = fs.readFileSync(path.join(SRC, 'components', 'SlashComposer.vue'), 'utf8')
  const help = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  assert.match(composer, /attach-btn/, 'the composer needs an attachment button before send')
  assert.match(composer, /attach-file-input/, 'the attachment button opens file and folder pickers')
  assert.match(help, /@file:/, 'Composer help documents file attachments')
  assert.match(help, /@mcp:/, 'Composer help documents MCP attachments')
  assert.doesNotMatch(help, /@skill:/, 'skills stay on the slash syntax')
})

test('a page ornament is drawn once, in the mark\'s own language', () => {
  /* One module owns the silhouettes and one component paints them: a page that
     re-traces its own drawing is how the app grew two pixel languages. */
  const voxel = fs.readFileSync(path.join(SRC, 'lib', 'voxel.js'), 'utf8')
  assert.match(voxel, /export const VOXELS/, 'the silhouettes live in one list')
  assert.match(voxel, /mask: \[/, 'a silhouette is a hand-written mask')
  assert.match(voxel, /function bounds/, 'the viewBox frames the painted cells')

  const mark = fs.readFileSync(path.join(SRC, 'components', 'VoxelMark.vue'), 'utf8')
  assert.match(mark, /from '@\/lib\/voxel'/, 'the ornament reads the shared module')
  assert.doesNotMatch(mark, /<svg[\s>]/, 'the mark is generated, not re-traced in the template')

  /* the pages that open on an ornament use it, and neither hand-draws one */
  for (const [file, shape] of [
    ['views/OverviewView.vue', 'station'],
    ['views/SkillsView.vue', 'blade'],
  ]) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8')
    assert.match(text, new RegExp(`<VoxelMark[^>]*shape="${shape}"`), `${file} lost its ${shape}`)
    /* the ornament's slot holds the component and nothing else: no second
       hand-drawn `<svg>` inside the crest it was moved into */
    const slot = text.match(/(?:ovc-hero-mark|sk-crest)[^>]*>([\s\S]{0,240}?)<\/span>/)
    assert.ok(slot, `${file} has no ornament slot`)
    assert.doesNotMatch(slot[1], /<svg[\s>]/, `${file} draws its own pixels`)
  }

  /* the fills are the character's recipe, so an ornament never brings a palette */
  const brand = fs.readFileSync(path.join(SRC, 'styles', 'brand.css'), 'utf8')
  assert.match(brand, /\.vx \.vx-fc \{[^}]*fill: var\(--mk\)/, 'the face is the mark colour')
  assert.match(brand, /\.vx \.vx-hi \{[^}]*color-mix/, 'the lit edge is derived, not a grey')
})

test('the turn deadline is a setting the page actually offers', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'WorkspaceChatsView.vue'), 'utf8')
  const store = fs.readFileSync(path.join(SRC, 'stores', 'turn.js'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'turn-timeout-store.cjs'), 'utf8')
  const chat = fs.readFileSync(path.join(ROOT, 'electron', 'chat-store.cjs'), 'utf8')
  const rpc = fs.readFileSync(path.join(ROOT, 'electron', 'rpc.cjs'), 'utf8')

  /* a clock a person cannot change is the complaint this feature answers */
  assert.match(view, /type="number"[\s\S]{0,400}Stop a turn after|Stop a turn after/, 'no field')
  assert.match(view, /setTurnMinutes|typeTurn/, 'the field never writes')
  assert.match(store, /turn\.set/, 'the renderer has no write')
  assert.match(rpc, /'turn\.set'/, 'the call table has no write')
  assert.match(backend, /function set\(/, 'the store has no write')

  /* the turn path must read it per turn, not once at require time */
  assert.match(chat, /turnTimeout\.turnTimeoutMs\(\)/, 'the deadline is not read from the store')
  assert.doesNotMatch(chat, /const HARNESS_TURN_MS/, 'the deadline is a constant again')

  /* the environment still wins, and a refusal may not look like a save */
  assert.match(backend, /source: 'environment'/, 'the environment case is not reported')
  assert.match(view, /turn\.editable/, 'the field does not follow the read-only case')
  assert.match(backend, /RANGE_MS/, 'nothing bounds the number')
})

test('account integrations paints its rows before it probes the CLIs', () => {
  const view = fs.readFileSync(
    path.join(SRC, 'views', 'account', 'AccountIntegrationsView.vue'),
    'utf8',
  )
  const store = fs.readFileSync(path.join(SRC, 'stores', 'integrations.js'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'integrations-store.cjs'), 'utf8')
  const rpc = fs.readFileSync(path.join(ROOT, 'electron', 'rpc.cjs'), 'utf8')

  /* two calls, because the two halves cost different things */
  assert.match(rpc, /'integrations\.probe'/, 'the status line needs its own call')
  assert.match(backend, /async function probe\(/, 'the probe is a function of its own')
  assert.match(backend, /PROBE_TTL/, 'the probe has to be cached')
  assert.match(store, /export async function probeIntegrations/, 'the renderer owns the second read')
  assert.ok(
    view.indexOf('probeIntegrations({') > view.indexOf('await loadIntegrations({'),
    'the rows must land before the probe is asked for',
  )
  assert.match(view, /int-refresh/, 'a cached read needs a way to refresh it')

  /* a roster is a table, and one searchable */
  assert.match(view, /type="search"/, 'the roster needs a visible filter')
  assert.match(view, /shortcutLabel\('inventory-search'\)/, 'the search carries the catalog key')
  assert.match(view, /class="skt int-t"/, 'the roster is the table grammar, not a card grid')
  const css = allStyles()
  const table = css.match(/\n\.int-t \.row \{[^}]*\}/)
  assert.ok(table, '.int-t .row has no base rule')
  assert.match(table[0], /minmax\(0,/, 'a column has to be able to shrink')
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

test('every field in the New thread dialog carries its own catalog key', () => {
  const dialog = fs.readFileSync(path.join(SRC, 'components', 'NewThreadDialog.vue'), 'utf8')
  const catalog = fs.readFileSync(path.join(SRC, 'lib', 'shortcuts.js'), 'utf8')

  /* Four fields, four combos: a dialog that hints at three of them and leaves the
     fourth to the mouse is the bug this test exists for. */
  const ids = ['pick-entity', 'pick-machine', 'pick-harness', 'pick-model']
  for (const id of ids) {
    assert.match(catalog, new RegExp(`id: '${id}'`), `the catalog lost ${id}`)
    assert.match(dialog, new RegExp(`shortcutLabel\\('${id}'\\)`), `the hint for ${id} is missing`)
    assert.match(dialog, new RegExp(`matchesShortcut\\('${id}'|\\['${id}'`), `nothing handles ${id}`)
  }
  /* the hint is rendered, not typed: the label carries the catalog's string */
  for (const key of ['entity', 'machine', 'harness', 'model']) {
    assert.match(dialog, new RegExp(`pickKeys\\.${key}`), `the ${key} label has no key`)
  }
  assert.doesNotMatch(dialog, /⌥⇧|Ctrl\+/, 'a combo may not be typed into the dialog')
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
  const css = allStyles()
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

test('the chat header floats over the thread with three zones of glass', () => {
  const css = allStyles()
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
  assert.equal(tracks.length, 3, `the header needs three zones: ${columns[1]}`)
  /* the bar matches the app top bar and only grows when the title wraps */
  assert.match(rule[0], /height:\s*auto/, 'the header cannot grow with the title')
  assert.match(rule[0], /min-height:\s*56px/, 'the header is not the top bar height')
  assert.match(view, /headObserver/, 'the header height is not measured')
  assert.match(view, /borderBoxSize/, 'the header reserves only its content box')

  /* the list owes the floating bar its height, from the same variable */
  const list = css.match(/\n\.c-thread \{[^}]*\}/)
  assert.ok(list, '.c-thread has no base rule')
  assert.match(
    list[0],
    /padding:\s*calc\(var\(--cp-head-h/,
    'the transcript does not reserve the floating header',
  )

  /* identity, search, actions: the middle is not another button clump */
  const header = view.match(/<header[^>]*class="cp-head"[^>]*>[\s\S]*?<\/header>/)
  assert.ok(header, 'no chat header in the view')
  assert.match(header[0], /class="cp-left"/, 'the identity is not a zone of its own')
  assert.match(header[0], /class="cp-mid"/, 'the search is not a zone')
  assert.match(header[0], /type="search"/, 'the thread needs a visible search field')
  assert.doesNotMatch(header[0], /cp-stats|cp-floatstats/, 'the totals do not belong in the bar')

  /* the totals close the composer's context row, before voice and help */
  const statsAt = view.indexOf('class="cp-stats"')
  const voiceAt = view.indexOf('class="compose-voice"')
  const helpAt = view.indexOf('class="compose-help"')
  assert.ok(statsAt > 0, 'the queries/responses totals are missing')
  assert.ok(voiceAt > statsAt && helpAt > voiceAt, 'the totals must precede voice and help')
  const stats = css.match(/\n\.cp-stats \{[^}]*\}/)
  assert.ok(stats, '.cp-stats has no base rule')
  assert.match(stats[0], /margin-left:\s*auto/, 'the totals do not close the row')
  assert.doesNotMatch(css, /\.cp-floatstats/, 'the floating pill came back')
})

test('grading a thread is a tag list, not a second title', () => {
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  const rail = fs.readFileSync(path.join(SRC, 'components', 'ChatHistoryRail.vue'), 'utf8')
  const dialog = fs.readFileSync(path.join(SRC, 'components', 'ThreadTagsDialog.vue'), 'utf8')
  const store = fs.readFileSync(path.join(SRC, 'stores', 'hub.js'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'chat-store.cjs'), 'utf8')
  const rpc = fs.readFileSync(path.join(ROOT, 'electron', 'rpc.cjs'), 'utf8')

  assert.match(chat, /<ThreadTagsDialog\b/, 'the chat owns the tag dialog')
  assert.match(chat, /class="cp-tags"/, 'tags show in the header')
  assert.match(rail, /liveTags\(\)/, 'the rail lists the workspace tags')
  assert.match(rail, /toggleTag\(/, 'a rail tag narrows the list')
  assert.match(dialog, /useDialogDismiss\s*\(/, 'Esc closes the tag dialog')
  assert.match(dialog, /Comma separated/, 'the dialog explains its one syntax')
  assert.match(dialog, /tagdlg-chip-x/, 'a saved tag cannot be removed before saving')
  assert.match(dialog, /removeTag\(/, 'the chip has no remove handler')
  assert.match(store, /chat\.tags/, 'the renderer has a tag call')
  assert.match(backend, /function tags\(/, 'the main process stores tags')
  assert.match(rpc, /'chat\.tags'/, 'the call table exposes tags')
})

test('a code artifact is editable with the lazy code editor', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'ArtifactDetailView.vue'), 'utf8')
  const editor = fs.readFileSync(path.join(SRC, 'components', 'CodeEditor.vue'), 'utf8')
  assert.match(view, /<CodeEditor\b/, 'the artifact page does not mount the code editor')
  assert.match(view, /canEditText/, 'only Markdown is treated as editable')
  assert.match(editor, /import\('codemirror'\)/, 'the editor is not lazy')
  assert.match(editor, /lang-python/, 'Python has no language support')
  assert.match(editor, /updateListener/, 'the editor never reports its text')
})

test('workspace members are people with an avatar, not a row of fields', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'WorkspaceView.vue'), 'utf8')
  const css = allStyles()
  assert.match(view, /from '@\/lib\/gravatar'/, 'members do not show a Gravatar')
  assert.match(view, /class="member-avatar"/, 'the member row has no avatar')
  assert.match(view, /aria-label="Member email/, 'the email field is unlabelled')
  assert.match(view, /roleHint\(member\.role\)/, 'the role description is not discoverable')
  assert.match(view, /class="member-remove"/, 'remove is not an icon control')
  const avatar = css.match(/\n\.member-avatar \{[^}]*\}/)
  assert.ok(avatar, '.member-avatar has no base rule')
  assert.match(css, /\.member-avatar img \{[^}]*object-fit:\s*cover/, 'the avatar is not cropped')
})

test('the artifact page reuses the chat glass bar and edits Markdown', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'ArtifactDetailView.vue'), 'utf8')
  const css = allStyles()
  const store = fs.readFileSync(path.join(SRC, 'stores', 'artifacts.js'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'artifact-store.cjs'), 'utf8')

  assert.match(view, /class="artifact-bar"/, 'the file needs the chat glass bar')
  assert.match(view, /MarkdownEditor/, 'a Markdown artifact opens in the editor')
  assert.match(view, /writeArtifactText/, 'the editor saves back to the file')
  assert.match(store, /artifact\.writeText/, 'the renderer has an in-place text write')
  assert.match(backend, /function writeText\(/, 'the main process writes the same artifact')
  assert.match(css, /\.artifact-bar \{[^}]*backdrop-filter:\s*blur\(/, 'the bar is not glass')
  assert.doesNotMatch(
    css,
    /\.media-top \{[\s\S]{0,400}?border-radius:\s*(14px|var\(--r-lg\))/,
    'the floating card came back',
  )
})

test('a popover inside a dialog is a teleported, measured layer', () => {
  const input = fs.readFileSync(path.join(SRC, 'components', 'ModelInput.vue'), 'utf8')
  const css = allStyles()
  assert.match(input, /<Teleport to="body">/, 'model suggestions are clipped by the dialog')
  assert.match(input, /positionMenu/, 'the layer is measured from the field')
  assert.match(input, /window\[method\]\('scroll'/, 'the layer does not follow its field')
  const menu = css.match(/\n\.model-menu \{[^}]*\}/)
  assert.ok(menu, '.model-menu has no base rule')
  assert.match(menu[0], /position:\s*fixed/, 'the suggestions still live inside the dialog')
  assert.doesNotMatch(menu[0], /max-height:\s*280px/, 'the suggestion list is still capped at 280px')
})

test('the terminal sheet is a closed card, not a flap', () => {
  const css = allStyles()
  const rule = css.match(/\n\.term-panel \{[^}]*\}/)
  assert.ok(rule, '.term-panel has no base rule')
  assert.doesNotMatch(rule[0], /border-bottom:\s*0/, 'the sheet is drawn open at the bottom')
  assert.match(rule[0], /border:\s*1px solid/, 'the sheet has no border of its own')
  assert.match(rule[0], /border-radius:\s*var\(--r-md\)/, 'the sheet is not rounded on all four corners')
})

/* ── one ladder each ─────────────────────────────────────────────────────
   A radius is a step on the scale in tokens.css, and so is an absolute type
   size. Twenty-six raw radii and forty-seven raw sizes used to live in the
   sheets — one sheet carried nine micro sizes — so the rule that keeps either
   from growing back is worth a test. Shapes and relative sizes stay literal:
   `50%` is a circle, and `em`, `%`, `clamp()` and `inherit` are supposed to
   follow their context. */

test('every corner is a step on one ladder, declared once', () => {
  const declared = ladder('--r', 'corner', 4)
  const allowed = new Set([...declared].map((name) => `var(${name})`))
  for (const literal of ['0', '50%', 'inherit']) allowed.add(literal)

  const problems = []
  for (const { name: sheet, css } of paintedSheets()) {
    for (const [, raw] of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
      for (const corner of raw.trim().split(/\s+/)) {
        if (!allowed.has(corner)) problems.push(`${sheet}: border-radius: ${raw.trim()}`)
      }
    }
    /* a typo in a step name would silently fall back to a square corner */
    for (const [, name] of css.matchAll(/var\((--r(?:-[a-z0-9]+)?)\)/g)) {
      if (!declared.has(name)) problems.push(`${sheet}: var(${name}) is not on the corner ladder`)
    }
  }

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'corners must come from the ladder in tokens.css, not from a number at the surface',
  )
})

test('every absolute type size is a step on the type ladder', () => {
  const declared = ladder('--fs', 'type', 6)
  const RELATIVE = /^(inherit|initial|unset|revert|0|-?[\d.]+(em|rem|%|vw|vh|vmin|vmax|ch|ex)|(clamp|min|max|calc)\(.*)$/

  const problems = []
  for (const { name: sheet, css } of paintedSheets()) {
    for (const [, raw] of css.matchAll(/font-size:\s*([^;}]+)/g)) {
      const value = raw.trim().replace(/\s*!important$/, '')
      if (/^var\(--fs(?:-[a-z0-9]+)?\)$/.test(value)) continue
      if (RELATIVE.test(value)) continue
      problems.push(`${sheet}: font-size: ${raw.trim()}`)
    }
    for (const [, name] of css.matchAll(/var\((--fs(?:-[a-z0-9]+)?)\)/g)) {
      if (!declared.has(name)) problems.push(`${sheet}: var(${name}) is not on the type ladder`)
    }
  }

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'type sizes come from the ladder in tokens.css; only relative sizes may be written at the surface',
  )
})

/* ── a failure carries its one action ─────────────────────────────────────
   `@entity` runs settle in the transcript, and a run can fail after its turn
   landed — a timeout, a missing binary, a provider 500. The card said "Failed"
   and offered Continue only, so a ten-run fan-out with six timeouts meant six
   sessions opened and six jobs retyped. The session is the thing that knows the
   question, so every retry re-runs it there, and every surface that can show a
   failure has to offer the fix. */

test('a failed session is retried from the card, the fan-out and the tree', () => {
  const card = fs.readFileSync(path.join(SRC, 'components', 'DelegationCard.vue'), 'utf8')
  const list = fs.readFileSync(path.join(SRC, 'components', 'MessageList.vue'), 'utf8')
  const tree = fs.readFileSync(path.join(SRC, 'components', 'SpawnTreeDialog.vue'), 'utf8')
  const rail = fs.readFileSync(path.join(SRC, 'components', 'ChatHistoryRail.vue'), 'utf8')
  const store = fs.readFileSync(path.join(SRC, 'stores', 'hub.js'), 'utf8')

  /* the card: the failure has a reason and an action, and both disappear when a
     retry has answered — a card stays red only while it is still a failure */
  assert.match(card, /msg-delegation-retry/, 'a failed card offers no retry')
  assert.match(card, /\$emit\('retry', mention\.threadId\)/, 'the card retry does not name its session')
  assert.match(card, /msg-delegation-fail/, 'a failed card does not say why it failed')
  assert.match(card, /recovered/, 'the card cannot tell a retried session from a dead one')
  assert.match(card, /hub\.chat\.summaries/, 'the card reads the stored failure, not the session')

  /* the fan-out: one line with the count and the bulk action */
  assert.match(list, /msg-delegations-alert/, 'a fan-out with failures says nothing about them')
  assert.match(list, /msg-delegations-retry/, 'the fan-out cannot retry its failures')
  assert.match(list, /emit\('retry-sessions'/, 'the fan-out retry is not wired out')
  assert.match(list, /emit\('retry-session'/, 'the per-card retry is not wired out')
  assert.match(list, /hub\.chat\.summaries/, 'the alert counts the stored status, not the sessions')

  /* the tree: a row can be retried, and the footer takes the whole tree */
  assert.match(tree, /spawn-tree-retry/, 'a failed row in the tree offers no retry')
  assert.match(tree, /retrySessions\(failed\.value\.map/, 'the bulk retry is not the whole tree')

  /* the rail: a fan-out that failed while you were elsewhere says so */
  assert.match(rail, /failingKidsOf/, 'the rail does not know which sessions failed')
  assert.match(allStyles(), /\[data-failing='1'\]/, 'the rail indicator has no style of its own')

  /* the store: one retry path, guarded by the row, not awaited */
  assert.match(store, /export function retrySession/, 'there is no single-session retry')
  assert.match(store, /retry: true/, 'a session retry does not use the retry turn')
  assert.match(store, /!row\?\.failed \|\| row\.working/, 'a retry can start on top of a live turn')
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

/* ── a store never calls a function that was deleted ───────────────────────
 *
 * ENTITY-31: `workspaces.js` kept calling `afterScopeWrite()` after the function
 * itself was removed in an unrelated refactor. The write landed, then the call
 * threw `afterScopeWrite is not defined` — so the toast said "saved" and the
 * page kept its stale copy until a manual refresh, which reads as the save
 * having half-failed.
 *
 * No linter runs over this repository, and a renamed local is not something a
 * Vue template check would catch: a bare `name(` resolves at runtime or not at
 * all. This walks the store modules and demands a definition for every bare call
 * it makes, so deleting one end of a pair fails here instead of in the UI.
 */
test('a store calls no function it does not define or import', () => {
  /* The globals a store may legitimately reach for, and nothing else. */
  const BUILTINS = new Set([
    'Promise', 'Object', 'Array', 'JSON', 'Number', 'String', 'Boolean', 'Map', 'Set',
    'Date', 'Math', 'isNaN', 'parseInt', 'parseFloat', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'fetch', 'structuredClone', 'encodeURIComponent',
    'decodeURIComponent', 'btoa', 'atob', 'Error', 'RegExp', 'WeakMap', 'queueMicrotask',
    'requestAnimationFrame', 'cancelAnimationFrame', 'URL', 'Blob', 'FormData',
    /* language keywords that are followed by `(` and are not calls */
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof',
    'function', 'await', 'async', 'void', 'new', 'delete', 'do', 'else', 'with',
    'yield', 'super', 'constructor', 'case',
  ])
  /* Prose is not code: this file's comments are full of `name()` examples, and a
     store's comments explain the shapes it writes. Strip comments and template
     strings before looking for calls, or every sentence becomes a finding. */
  const strip = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
      .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
  const problems = []
  for (const entry of MODULES.filter((item) => /^src\/stores\/.+\.js$/.test(item.rel))) {
    const text = entry.text
    const code = strip(text)
    /* Every name this module can call: its own declarations, imports, and
       destructured or declared locals. */
    const known = new Set()
    for (const match of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) known.add(match[1])
    for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) known.add(match[1])
    /* `const { a, b } = thing` binds a and b without a `= name` of their own. */
    for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const piece of match[1].split(',')) {
        const name = piece.split(':').pop().split(/\s+as\s+/).pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name)
      }
    }
    for (const match of text.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
      if (match[1]) known.add(match[1])
      for (const piece of (match[2] || '').split(',')) {
        const name = piece.split(/\s+as\s+/).pop().trim()
        if (name) known.add(name)
      }
    }
    for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) known.add(match[1])
    /* A call: `name(` not preceded by `.` (a method), or by `function`/`new`/
       `async`, and not a `name: (a, b) =>` definition's parameter list. */
    for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1]
      if (BUILTINS.has(name) || known.has(name)) continue
      const before = code.slice(Math.max(0, match.index - 40), match.index)
      if (/(function|new|async|\.)\s*$/.test(before)) continue
      problems.push(`${entry.rel}: ${name}()`)
    }
  }
  assert.deepEqual(problems, [], `bare calls with no definition in the module: ${problems.join(', ')}`)
})
