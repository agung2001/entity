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

test('the artifacts card answers one shelf at a time', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'WorkspaceArtifactsView.vue'), 'utf8')

  /* Two populations with two different answers: the shared shelf has a rule that
     syncs, the personal one has none at all. One column holding both put a
     personal count beside a workspace-wide threshold. */
  assert.match(view, /role="tablist"\s+aria-label="Which shelf"/, 'the card needs a shelf switch')
  assert.match(view, /setShelf\('personal'\)/, 'the personal shelf is not reachable')
  assert.match(view, /query\.shelf/, 'the tab state belongs to the URL, or Back loses it')
  assert.match(view, /tab: 'artifacts'/, 'the switch must keep the page\'s own tab')

  /* The rule — chart, thresholds, cadence, protections, the pass — is the shared
     shelf's, and must not render over the personal one. */
  /* the rule renders only while the shared shelf is the one on screen: it sits
     between the shared template and the personal one */
  const openAt = view.indexOf("<template v-if=\"shelf === 'shared'\">")
  const ruleAt = view.indexOf('The rule ②')
  const personalAt = view.indexOf('the personal shelf ────')
  assert.ok(openAt > 0 && ruleAt > openAt, 'the rule is not inside the shared-only block')
  assert.ok(personalAt > ruleAt, 'the shared rule leaks onto the personal shelf')

  /* And the one action the personal shelf owns is emptying it. */
  assert.match(view, /openPersonalShelf/, 'the personal shelf has no way out')
  assert.match(view, /shelf === 'personal'\s*\?/, 'the erase section does not follow the shelf')
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

test('the connectors page paints its rows before it probes the CLIs', () => {
  /* Account → Integrations and Account → MCP are one page now, in the workspace
     that owns their definitions: `ConnectorsView` is the surface, and the rule it
     was paid for — rows first, status second, cached — still holds. */
  const view = fs.readFileSync(path.join(SRC, 'views', 'ConnectorsView.vue'), 'utf8')
  const store = fs.readFileSync(path.join(SRC, 'stores', 'integrations.js'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'integrations-store.cjs'), 'utf8')
  const rpc = fs.readFileSync(path.join(ROOT, 'electron', 'rpc.cjs'), 'utf8')

  /* two calls, because the two halves cost different things */
  assert.match(rpc, /'integrations\.probe'/, 'the status line needs its own call')
  assert.match(backend, /async function probe\(/, 'the probe is a function of its own')
  assert.match(backend, /PROBE_TTL/, 'the probe has to be cached')
  const connectorStore = fs.readFileSync(path.join(SRC, 'stores', 'connectors.js'), 'utf8')
  assert.match(connectorStore, /export async function probeConnectors/, 'the renderer owns the second read')
  assert.ok(
    connectorStore.indexOf('probeIntegrations({') > connectorStore.indexOf('await loadIntegrations({'),
    'the rows must land before the probe is asked for',
  )
  assert.match(rpc, /'connector\.list'/, 'the merged row list needs its own call')

  /* a roster is a table, and one searchable */
  assert.match(view, /type="search"/, 'the roster needs a visible filter')
  assert.match(view, /shortcutLabel\('inventory-search'\)/, 'the search carries the catalog key')
  assert.match(view, /role="table"/, 'the roster is a table, not a card grid')
  assert.match(view, /class="ct-head"/, 'the roster needs its own head')
  const css = allStyles()
  /* One source of truth for the tracks: the head and every row read the same
     `--ct-tracks`, and the state overrides change that variable rather than
     swapping in a second template — two templates is how a head drifts off its
     columns. Every one of them still has to let a column shrink. */
  const tracks = [...css.matchAll(/--ct-tracks:\s*([^;]+);/g)].map((match) => match[1].trim())
  assert.ok(tracks.length >= 1, 'the tracks are declared once, as a variable')
  for (const value of tracks) {
    assert.match(value, /minmax\(0,/, `a column has to be able to shrink: ${value}`)
  }
  const table = css.match(/\n\.ct-head,\n\.ct-row \{[^}]*\}/)
  assert.ok(table, '.ct-head/.ct-row have no base track rule')
  assert.match(
    table[0],
    /grid-template-columns:\s*var\(--ct-tracks\)/,
    'the head and the row take their template from the one variable',
  )

  /* the merge's own rule: every row states a scope, a machine row may only be
     copied, an unmanaged row may only be adopted */
  const row = fs.readFileSync(path.join(SRC, 'components', 'ConnectorRow.vue'), 'utf8')
  assert.match(row, /Copy here/, 'a machine row needs its one verb')
  assert.match(row, /Adopt/, 'an unmanaged row must be adoptable')
  assert.match(row, /row\.scope === 'machine'/, 'the scope is a column on every row')
  assert.match(
    row,
    /row\.scope === 'machine'[\s\S]{0,400}Copy here/,
    'a machine row\'s only verb is `Copy here`',
  )
  assert.match(
    row,
    /row\.unmanaged[\s\S]{0,400}Adopt/,
    'an unmanaged row\'s only verb is `Adopt`',
  )

  /* DESIGN.md → "The name is the link, the row is not": a row holds the verbs, so
     wrapping it in an anchor would nest interactive elements. The row links out
     from its *name* instead, and a connector has its own page. */
  assert.match(row, /<router-link[\s\S]{0,200}class="ct-who"/, 'the name is the link')
  assert.doesNotMatch(
    row,
    /<router-link[^>]*>[\s\S]{0,600}?<button/,
    'no button inside the row\'s link',
  )
  /* The row element itself must not be the link, whatever it is wrapped in. */
  assert.doesNotMatch(
    row,
    /<router-link[^>]*class="ct-row"|<div[^>]*class="ct-row"[^>]*\n?\s*<router-link[^>]*>\s*\n?\s*<span class="ct-mk"/,
    'the row is not an anchor: only the name is',
  )
  /* One roster, one address: an MCP server and a cli/rest row are both
     `connectors/:id`, and the page switches on the row's own kind. The route is
     not duplicated per kind, and a name both kinds could hold must not depend on
     which route object the router matched first. */
  assert.doesNotMatch(
    row,
    /name: 'mcp-server'/,
    'the row links to one address, not one per kind',
  )
  assert.match(
    row,
    /name: 'connector-page'[\s\S]{0,120}id: row\.id/,
    'a row links to its connector page',
  )
  const connectorPage = fs.readFileSync(path.join(SRC, 'views', 'ConnectorPageView.vue'), 'utf8')
  /* An unknown id stays on the MCP page, because the MCP page already draws the
     states an unknown id can be in and this one would call them "no connector".
     So the cli shell is gated on a *known* non-mcp row, not on `kind === 'mcp'`. */
  assert.match(
    connectorPage,
    /isCliPage = computed\(\(\) => Boolean\(row\.value\) && row\.value\.kind !== 'mcp'\)/,
    'the connector page decides on the row\'s own kind, defaulting to the MCP page',
  )
  assert.match(
    connectorPage,
    /<McpServerView v-else-if="!isCliPage" \/>/,
    'the connector page draws the MCP page for an mcp row',
  )
  /* A failed roster read must not leave the page blank: `loaded` never turns
     true on an error, so the gate falls through instead of waiting forever. */
  assert.match(
    connectorPage,
    /const pending = computed\(\(\) => !connectors\.loaded && !connectors\.error\)/,
    'the kind gate falls through when the roster read fails',
  )
  assert.match(view, /role="table"/, 'the roster is one table')
  /* A refused credential still has to say so on both surfaces that can take one:
     the add sheet in the roster, and the connector's own page. */
  assert.match(view, /Nothing was saved/, 'a rejected credential must say nothing was written')
  const page = fs.readFileSync(path.join(SRC, 'views', 'ConnectorPageView.vue'), 'utf8')
  assert.match(page, /nothing is written|Nothing was saved/i, 'the connector page says the same')
})

test('the machine capability page brands harnesses and offers search', () => {
  const file = path.join(SRC, 'views', 'MachineDetailView.vue')
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /<HarnessIcon\b/, 'harnesses need their thesvg mark')
  assert.match(text, /type="search"/, 'the harness/model inventory needs a search input')
  /* One tablist, one tab per section, one live panel: a section that loses its
     tab, or a second panel drawn beside it, is a report the member cannot read
     section by section, and nothing else in the suite opens this page. */
  assert.equal([...text.matchAll(/role="tab"/g)].length, 6, 'one tab per report section')
  assert.equal([...text.matchAll(/role="tabpanel"/g)].length, 1, 'the strip owns one panel')
  assert.match(text, /class="rpt-gap"/, 'an unread group draws the note, never an empty table')
  for (const label of ['Harnesses', 'Overview', 'Cron', 'Docker', 'Skills', 'Orca']) {
    assert.match(text, new RegExp(`id="rep-tab-${label.toLowerCase()}"`), `${label} needs its tab`)
  }
})

test('the machines page is a roster with a rail, not a card gallery', () => {
  const view = fs.readFileSync(path.join(SRC, 'views', 'MachinesView.vue'), 'utf8')
  const shelf = fs.readFileSync(path.join(SRC, 'views', 'WorkspaceView.vue'), 'utf8')
  /* The other embedded list that opens a detail pane: it must obey the same rule. */
  const connectorsView = fs.readFileSync(path.join(SRC, 'views', 'ConnectorsView.vue'), 'utf8')

  /* DESIGN.md → "A roster is a table": a gallery of five-button cards was the
     shape this page had, and it could not say why a row was red. */
  assert.doesNotMatch(view, /class="mgrid"/, 'the roster is a table, not a card grid')
  assert.doesNotMatch(view, /class="mcard"/, 'the roster is a table, not a card grid')
  assert.match(view, /class="mrow"/, 'the roster needs its rows')
  assert.match(view, /class="mfhead"/, 'a roster has a sticky desk')

  /* a scan result that arrives as a toast and nothing else is the defect: the
     reason has to survive on the row */
  /* DESIGN.md: a template may not carry layout in a `style` attribute. A data
     value does (a progress bar's own width is not a margin), and so does a
     custom property a shared recipe reads — `--hero` is the cabinet's input, not
     this page's decision about margins. */
  const inline = [...view.matchAll(/\sstyle="([^"]*)"/g)]
    .map((match) => match[1].trim())
    .filter((decl) => !decl.startsWith('--'))
  assert.deepEqual(inline, [], `inline layout in the template: ${inline.join(', ')}`)
  assert.match(view, /data-fail/, 'a failed scan states its reason on the row')

  /* an embedded tab owns no page head, and this one takes the wide measure */
  /* one drawing per meaning, from the vendored iconoir set — no hand-drawn
     arrows: the set that shipped before used a table grid for two different
     "forget" actions, a pixel apart */
  assert.match(view, /<UiIcon name="refresh" \/>/, 'reload needs the refresh glyph')
  assert.match(view, /<UiIcon name="refresh-double" \/>/, 'the fleet needs its own glyph')
  assert.match(view, /<UiIcon name="scanning"/, 'a host read needs the scanning glyph')
  assert.match(view, /<UiIcon name="trash"/, 'forget needs the bin')
  /* and the vendored files still match the component's paths */
  const icons = path.join(SRC, 'components', 'icons')
  const component = fs.readFileSync(path.join(SRC, 'components', 'UiIcon.vue'), 'utf8')
  for (const name of ['refresh', 'refresh-double', 'scanning', 'nav-arrow-right', 'trash']) {
    assert.ok(fs.existsSync(path.join(icons, `${name}.svg`)), `${name}.svg is not vendored`)
    const real = [...fs.readFileSync(path.join(icons, `${name}.svg`), 'utf8').matchAll(/d="([^"]+)"/g)]
      .map((match) => match[1])
    const key = name.includes('-') ? `'${name}'` : name
    const block = component.match(new RegExp(`  ${key.replace(/'/g, "\\'")}: \\[\\n((?:.*\\n)*?)  \\],`))
    assert.ok(block, `${name} has no entry in UiIcon`)
    assert.deepEqual([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), real, `${name} drifted from its file`)
  }
  assert.match(fs.readFileSync(path.join(icons, 'LICENSE.iconoir.md'), 'utf8'), /MIT License/, 'the licence travels with the vendored glyphs')

  /* the page is a fragment: bar and shelf are siblings under the parent's shell */
  assert.doesNotMatch(view, /class="mach-page"/, 'no wrapper: the bar must be a direct child of .detail-view')
  assert.match(shelf, /view detail-view/, 'a five-column roster needs the measure the entity page uses')

  /* the fleet facts are a row above the table, not a rail beside it: a 306px
     column cost the roster a third of the band and repeated the hero */
  assert.doesNotMatch(view, /class="entp-rail"/, 'the fleet facts are a row, not a rail')
  assert.doesNotMatch(view, /class="entp-grid"/, 'the page is one column, so the table is full width')
  assert.match(view, /class="mach-strip"/, 'the facts strip is missing')
  assert.ok(
    view.indexOf('class="mach-strip"') < view.indexOf('class="mftable"'),
    'the strip sits after the banner and before the table',
  )

  /* the page's verbs live on the entity profile's second row, not under the
     facts: a settings page with three page-wide actions in a card is a toolbar
     that forgot where it belongs */
  assert.match(view, /class="entp-bar"/, 'the page needs the entity shell\'s second row')
  assert.match(view, /class="entp-crumb"/, 'the second row states where you are')
  assert.ok(
    view.indexOf('class="entp-bar"') < view.indexOf('class="entp-hero"'),
    'the bar is the page\'s top edge, above the hero',
  )
  const actions = view.slice(view.indexOf('class="entp-bar"'), view.indexOf('class="mach-shelf"'))
  for (const verb of ['Test every host', 'Forget every fact', 'Reload']) {
    assert.ok(actions.includes(verb), `${verb} belongs on the second row, not in the roster`)
  }
  assert.doesNotMatch(view, /class="mach-actions"/, 'the facts row must not carry the verbs too')

  /* no section head over the roster: the hero's counter and the facts row have
     said it, and a heading between them and the field is a gap nobody reads */
  assert.doesNotMatch(view, /class="entp-sec-head"/, 'the roster needs no heading')
  assert.match(view, /class="mbar"[\s\S]*?class="mftable"/, 'the field sits straight on the table')

  /* DESIGN.md → "The name is the link, the row is not": the name carries the
     route, the row wraps buttons, and the address is text */
  assert.match(view, /<router-link[\s\S]{0,400}?class="nm"/, 'the host name is the link')
  assert.doesNotMatch(view, /class="addr"[^>]*>\s*<router-link/, 'the address must not be a second link')
  assert.doesNotMatch(view, /class="mrow"[^>]*\n?\s*<router-link/, 'the row is not an anchor')

  /* one filter, the band's full width — no sentence beside it */
  assert.match(view, /class="mbar"/, 'the search bar is missing')
  assert.match(view, /id="inventory-search"/, 'the roster needs its one filter')
  /* the sentence that used to share the bar with the search field */
  assert.doesNotMatch(view, /local<\/b> is always available/, 'the tagline that shared the bar is gone')
  assert.doesNotMatch(view, /class="mbar">[\s\S]*?<span class="mnote"/, 'the bar holds the field alone')
  assert.match(allStyles(), /\.mbar \.wsl-search \{[^}]*flex: 1 1 100%/, 'the filter must take the band')

  /* the shell is the parent's: nesting `.detail-view` inside `.detail-view`
     insets the page by 56px and puts the roster on a second measure. The rule is
     "WorkspaceView decides, an embedded view brings no shell of its own" — not
     the shape of the ternary, which also carries Connectors, the other list with
     a detail pane. */
  assert.doesNotMatch(view, /class="[^"]*\bview detail-view\b/, 'the embedded root must not bring a second shell')
  assert.doesNotMatch(
    connectorsView,
    /class="[^"]*\bview detail-view\b/,
    'the embedded root must not bring a second shell',
  )
  const shell = shelf.match(/:class="([^"]*detail-view[^"]*)"/)
  assert.ok(shell, 'WorkspaceView owns the detail shell')
  assert.match(shell[1], /tab === 'machines'/, 'the machines tab gets the detail shell')
  assert.match(shell[1], /'view detail-view'/, 'the detail shell is the detail-view measure')

  /* `--hero` is what the cabinet mixes its paper, grid and shadow from; without
     it every color-mix(var(--hero) …) is invalid and the hero is a white box */
  assert.match(view, /--hero:\s*var\(--accent\)/, 'the hero must publish --hero')

  /* the ornament is the shared voxel, not a second drawing */
  assert.match(view, /<VoxelMark shape="station"/, 'the hero wears the specimen sheet station')
  assert.match(view, /shortcutLabel\('inventory-search'\)/, 'the search carries the catalog key')

  const css = allStyles()
  assert.match(css, /\.mrow \{[^}]*min-height: 60px/, 'a data row is 60 px')
  assert.match(css, /\.mfhead \{[^}]*position: sticky/, 'the desk sticks to the scroll box')
  /* The row is a grid of exactly five tracks, and the desk and the cells take
     the SAME template — written by `fleetTracks`, because a reader may drag it.
     A track list in CSS would be a second source of truth and the header would
     drift off the cells. */
  const row = css.match(/\n\.mfhead,\n\.mrow \{[^}]*grid-template-columns:([^;]+);/)
  assert.ok(row, '.mfhead/.mrow have no base track rule')
  assert.equal(row[1].trim().split(/\s+(?![^(]*\))/).filter(Boolean).length, 4, 'the row is four columns')
  assert.match(view, /FLEET_COLS\s*=\s*\[/, 'the five columns are declared once')
  assert.match(view, /const fleetTracks = computed/, 'one template for the desk and the cells')
  /* one bound style, so the desk and every cell cannot disagree */
  assert.match(view, /const gridStyle = computed\(/, 'the template needs one binding')
  /* the desk, the skeleton rows and the data rows are three bindings of one
     value — three places that would otherwise each keep their own copy */
  assert.equal(
    (view.match(/:style="gridStyle"/g) || []).length,
    3,
    'the desk and both kinds of row must take the same template',
  )
  /* and it is applied only in the band that uses five columns */
  assert.match(view, /narrow\.value\s*\?\s*null/, 'a bound template wins over the mobile container query')
  /* a column a reader may drag needs a floor, or its header label is truncated */
  /* one flexible track that eats the spare width, three fixed ones */
  assert.match(
    view,
    /const ceiling = index === 0 \? '1fr' : `\$\{width\}px`/,
    'the machine track is the flexible one',
  )
  for (const id of ['host', 'state', 'cap', 'fact']) {
    assert.match(view, new RegExp(`id: '${id}', label: '[^']+', min: \\d+, max: \\d+`), `${id} has no bounds`)
  }
  /* `auto` / `max-content` resolve per element, which is what misaligns a desk */
  assert.doesNotMatch(view, /fleetTracks[\s\S]{0,400}?(auto|max-content)/, 'tracks must be lengths')
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

test('the skills roster is the band, and a skill keeps the settings rail', () => {
  const rail = fs.readFileSync(path.join(SRC, 'components', 'RailContext.vue'), 'utf8')
  const router = fs.readFileSync(path.join(SRC, 'router.js'), 'utf8')

  /* The roster is an inventory: the page *is* the list, and the panel beside it
     was the same rows drawn narrower. No `skills` branch in the route map. */
  assert.doesNotMatch(rail, /return \{ id: 'skills'/, 'the skills rail section is back')
  assert.doesNotMatch(rail, /section\.id === 'skills'/, 'the skills panel template is back')
  /* and the phone must not offer a drawer that opens nothing */
  assert.match(
    router,
    /name: 'skills',[\s\S]{0,220}rail: false/,
    'the skills route still claims a second tier',
  )

  /* A skill's own page is a detail page: it shows the workspace settings list,
     with the way back to the roster in its header. */
  assert.match(rail, /name === 'machine' \|\| name === 'skill' \|\| name === 'connector-page'/)
  assert.match(rail, /name === 'skill' \? 'skills'/)
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
  /* the button closes the composer context row, immediately before help. The
     read is a prefix so an extra class (`cp-icon`) does not break it. */
  const voiceAt = chat.indexOf('class="compose-voice')
  const helpAt = chat.indexOf('class="compose-help')
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

test('the header title has a catalog key, and the combo is never hidden', () => {
  const catalog = fs.readFileSync(path.join(SRC, 'lib', 'shortcuts.js'), 'utf8')
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')

  assert.match(catalog, /id: 'thread-title'/, 'renaming a thread is a catalog action')
  assert.match(chat, /matchesShortcut\('thread-title'/, 'the catalog entry needs a handler')
  assert.match(chat, /titleShortcut = shortcutLabel\('thread-title'\)/, 'the hint comes from the catalog')
  /* the key has to land in the field with the old name selected, not just open it */
  const start = chat.indexOf('function startTitleEdit')
  assert.ok(start > 0, 'startTitleEdit is gone')
  assert.match(
    chat.slice(start, start + 400),
    /titleInput\.value\?\.select\(\)/,
    'the rename key leaves the old title untouched instead of selected',
  )

  /* The chip is the only place a combo is written before a hover: hiding it
     left a button that read "Timeline" and said nothing about `⌥⇧T`. A comment
     naming the class is not a rule, so the sheets are read commented-out. */
  const hidden = paintedSheets()
    .filter(({ css }) => /\.trace-kbd[^{]*\{[^}]*display:\s*none/.test(css))
    .map(({ name }) => name)
  assert.deepEqual(hidden, [], `the shortcut chip is hidden again in ${hidden.join(', ')} — drop the label, keep the chip`)
})

test('opening a thread says so instead of showing an empty page', () => {
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  const store = fs.readFileSync(path.join(SRC, 'stores', 'hub.js'), 'utf8')

  /* One read wrapper owns the flag, so the rail, the address bar and the first
     open all say the same thing — a second call site would silently skip it. */
  assert.match(store, /opening: ''/, 'the chat state has nowhere to record a read in flight')
  assert.match(store, /async function readThread\(id\)/, 'no single read wrapper')
  assert.match(store, /hub\.chat\.opening = id/, 'the read never sets the flag')
  assert.match(store, /if \(seq === threadReadSeq\) hub\.chat\.opening = ''/, 'a slow early read clears the newest flag')

  const open = store.slice(store.indexOf('export async function openThread'))
  const select = store.slice(store.indexOf('export async function selectThread'))
  assert.match(open, /await readThread\(id\)/, 'openThread reads around the flag')
  assert.match(select, /await readThread\(id\)/, 'selectThread reads around the flag')

  /* The skeleton is a surface of its own, before the transcript and after the
     no-entity note, and it is announced rather than only painted. */
  const panel = chat.indexOf('class="cpanel cpanel-empty cpanel-opening"')
  const body = chat.indexOf('v-else-if="thread"')
  assert.ok(panel > 0, 'the chat view has no opening surface')
  assert.ok(panel < body, 'the opening surface comes after the thread it replaces')
  assert.match(chat, /v-else-if="openingSlow"/, 'the skeleton shows on the first frame of every read')
  assert.match(chat, /aria-busy="true"/, 'the loading surface is not announced')
  assert.match(chat, /role="status"/, 'the loading surface has no live region')
  /* the row the rail already lists names what is coming */
  assert.match(chat, /summaryFor\(openingSlow\.value\)/, 'the skeleton cannot name the thread it opens')
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

  /* the composer's head carries the controls for what this turn runs against
     and nothing that counts: the queries/responses totals left with the dock
     rebuild, and they are not coming back to the header either */
  assert.doesNotMatch(view, /cp-stats/, 'the queries/responses totals do not belong in the dock')
  const dock = css.match(/\n\.cp-stats \{[^}]*\}/)
  assert.equal(dock, null, '.cp-stats still has a rule')
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

test('a card or row menu is a teleported layer, not a native dropdown', () => {
  /* A card is its own paint layer — its hover lift is a `transform` — so a
     `<details>` dropdown positioned inside it is covered by the next card and
     its lower items stop taking clicks. Every card/row menu is the same layer
     the rail uses: in the body, measured from the trigger, closed by Escape. */
  const css = allStyles()
  const pop = css.match(/\n\.wsl-menu-pop \{[^}]*\}/)
  assert.ok(pop, '.wsl-menu-pop has no base rule')
  assert.match(pop[0], /position:\s*fixed/, 'the workspace menu is still painted inside the card')

  const view = fs.readFileSync(path.join(SRC, 'views', 'ManageWorkspacesView.vue'), 'utf8')
  assert.match(view, /<Teleport to="body">/, 'the workspace menu is not teleported out of the card')
  assert.match(view, /openRowMenu/, 'the workspace menu is not measured from its trigger')
  assert.match(view, /useDialogDismiss\s*\(/, 'Escape does not close the workspace menu')
  assert.doesNotMatch(view, /<details class="wsl-menu"/, 'a native dropdown is clipped by the next card')
})

test('the terminal sheet is a closed card, not a flap', () => {
  const css = allStyles()
  const rule = css.match(/\n\.term-panel \{[^}]*\}/)
  assert.ok(rule, '.term-panel has no base rule')
  assert.doesNotMatch(rule[0], /border-bottom:\s*0/, 'the sheet is drawn open at the bottom')
  assert.match(rule[0], /border:\s*1px solid/, 'the sheet has no border of its own')
  assert.match(rule[0], /border-radius:\s*var\(--r-md\)/, 'the sheet is not rounded on all four corners')
})

test("a goal's selector and its mark come from the shared components", () => {
  const goalFiles = FILES.filter((entry) => /(^|\/)components\/goal\/|(^|\/)views\/Goal/.test(entry.rel))
  assert.ok(goalFiles.length >= 5, 'the goals surface is still there')

  /* An entity is an identity, so its axis is `PickMenu`: a native select cannot
     carry the entity's mark, its search, its teleported menu or its locked state.
     (A compact priority chip may stay a select — it is a word, not a thing.) */
  /* The fields are one component (step 1 and the review render it), so the
     picker is asserted where the form lives, and neither file may own a native
     select for the entity. */
  const fields = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalFields.vue'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  assert.match(
    fields,
    /<PickMenu[\s\S]{0,240}?icons="entity"/,
    "the entity selector is the app's picker",
  )
  assert.doesNotMatch(fields, /<select[\s>]/, 'no native select for the entity')
  assert.doesNotMatch(create, /<select[\s>]/, 'no native select in the flow either')

  /* One drawing per destination: an empty state or a note wears the rail's own
     glyph. A copied `<circle>` here is a second mark that drifts. */
  const redrawn = goalFiles
    .filter((entry) => /circle cx="8" cy="8" r="2\.2"/.test(entry.text))
    .map((entry) => entry.rel)
  assert.deepEqual(redrawn, [], `the goal mark belongs to NavIcon, not ${redrawn.join(', ')}`)
  const blank = fs.readFileSync(path.join(SRC, 'views', 'GoalsView.vue'), 'utf8')
  assert.match(blank, /<NavIcon name="goal"\s*\/>/, "the empty state wears the rail's glyph")

  /* The planning turn is long enough to narrate: the call streams its phases and
     the page draws them with a clock, instead of a spinner that says nothing. */
  const rpc = fs.readFileSync(path.join(ROOT, 'electron', 'rpc.cjs'), 'utf8')
  assert.match(
    rpc,
    /'goals\.draft': \(args\) => goalDraft\.draft\(\{ \.\.\.args, emit \}\)/,
    'the planning turn is streamed',
  )
  assert.match(create, /onRunEvent\(/, 'the page listens to its own stream')
  assert.match(create, /draft-live-clock/, 'the planning turn shows elapsed time')
  assert.match(create, /draft-steps/, 'the planning turn shows what it is doing')
})

/* ── a write is confirmed on the form that owns it ─────────────────────────
   `Create goal` used to store on click from a button that showed a count, and a
   plan edit used to splice a row into a list of dates the planner had reasoned
   about. Both are the same mistake: the surface skipped the thing that owns the
   consequence. */

test('creating a goal is confirmed on the goal\'s own fields', () => {
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  const fields = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalFields.vue'), 'utf8')

  /* one form, two mounts: step 1 and the review dialog render the same component */
  assert.ok(
    (create.match(/<GoalFields/g) || []).length >= 2,
    'the confirmation is the goal\'s fields, not a second design of them',
  )
  assert.match(fields, /id="goal-title"/, 'the fields keep their ids, so the shortcuts still find them')
  assert.match(fields, /defineExpose\(\{ focus, toggleEntity \}\)/, 'the page asks the form for focus')

  /* the plan buttons open the review; the dialog's primary is the only writer */
  assert.ok(
    (create.match(/@click="openAdjust/g) || []).length >= 4,
    'the head and the foot both open the review, for create and for adjust',
  )
  assert.match(create, /class="modal goaladjust"/, 'the review is a dialog')
  assert.match(create, /class="x mo-x"/, 'the close control is the shell\'s, not a bare .mo-x')
  assert.match(create, /openAdjust\('adjust'\)/, 'Adjust goal is its own verb, not a hidden consequence')
  assert.match(create, /useDialogDismiss\(\{[\s\S]{0,120}?adjustOpen/, 'the review closes on Esc')
  assert.match(create, /nothing is written until you create it/i, 'the dialog says the write is not done yet')
})

test('on the draft, a row\'s tick is a lock', () => {
  const row = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskRow.vue'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  const store = fs.readFileSync(path.join(ROOT, 'electron', 'goals-store.cjs'), 'utf8')

  assert.match(row, /lockable: \{ type: Boolean, default: false \}/, 'only the draft asks for a lock')
  assert.match(row, /emit\('lock', !locked\.value\)/, 'the box toggles the lock')
  assert.match(row, /props\.editable && !props\.readonly && !locked\.value/, 'a locked row is not editable')
  assert.match(row, /!compact && !readonly && !locked/, 'a locked row has no menu')
  assert.match(create, /lockable/, 'the draft turns the box into a lock')
  assert.match(create, /if \(task\.locked\) return/, 'a locked row cannot be removed')
  assert.match(create, /\(\{ locked, \.\.\.task \}\)/, 'the lock does not become a permission on the stored goal')
  assert.match(store, /locked: raw\.locked === true/, 'a reload of the draft keeps the lock')
})

test('a plan edit is local, not a planning turn', () => {
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  const dialog = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskDialog.vue'), 'utf8')

  /* adding, editing and removing are writes to the list. Dates were reasoned
     together, but buying a whole re-plan per keystroke is the thing that made
     the step expensive; a hand-edited plan may drift, and that is the trade. */
  assert.doesNotMatch(create, /revisePlan\(/, 'no planning turn on an edit')
  assert.match(create, /function submitTask[\s\S]{0,500}?tasks\.value = \[\.\.\.tasks\.value/, 'adding appends')
  assert.match(create, /function removeTask[\s\S]{0,200}?tasks\.value = tasks\.value\.filter/, 'removing filters')
  assert.doesNotMatch(create, /revising/, 'there is no busy list for a turn that does not run')
  assert.match(create, /@click="addTask"/, '+ Task opens the composer')
  assert.match(dialog, /SlashComposer/, "the new task is written in the app's composer, not a form")
  assert.match(dialog, /Add task/, 'the dialog says what pressing it does')
  assert.match(dialog, /no planning\s+turn is spent/, 'the copy says the turn is not spent')
  /* the task's entity is picked with the app's picker, the same one the goal's
     own form uses — not a native select and not the planner's guess alone */
  assert.match(dialog, /<PickMenu[\s\S]{0,220}?icons="entity"/, "the entity is the app's picker")
  assert.match(dialog, /class="x mo-x"/, "the close control is the shell's")
})

test("a task's source is an attachment, not a second field", () => {
  const store = fs.readFileSync(path.join(ROOT, 'electron', 'goals-store.cjs'), 'utf8')
  const add = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskDialog.vue'), 'utf8')
  const edit = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskEditDialog.vue'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')

  /* the composer already carries attachments; a second Source input asked the
     person to type a path the box could have kept */
  assert.doesNotMatch(edit, /Source <span class="opt">/, 'there is no separate Source field')
  assert.doesNotMatch(edit, /file\.reveal/, 'nothing asks the OS to reveal a source')
  assert.match(add, /v-model:attachments="attachments"/, 'the add dialog keeps them')
  assert.match(edit, /v-model:attachments="attachments"/, 'the edit dialog keeps them')
  assert.match(create, /submitTask\(text, entityName, attached/, 'the attachment list reaches the page')
  assert.match(create, /attached\[0\]/, 'the first one is the source')
  /* only the reference is stored: the bytes belong to the turn, not the goal */
  assert.match(store, /value: text\(raw\?\.value, 1000\)/, 'a token keeps its location, not its data')
})

test('a task can be enhanced in place, once', () => {
  const add = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskDialog.vue'), 'utf8')
  const edit = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskEditDialog.vue'), 'utf8')
  const composer = fs.readFileSync(path.join(SRC, 'components', 'SlashComposer.vue'), 'utf8')

  for (const dialog of [add, edit]) {
    assert.match(dialog, /class="task-enh"/, 'the dialog offers Enhance')
    assert.match(dialog, /<PromptEnhanceDialog/, 'it reuses the enhance dialog')
    assert.match(dialog, /@apply="applyEnhance"/, 'the answer replaces the field')
  }
  /* the add dialog draws Enhance next to its label, so the composer's own copy of
     the same action is turned off — two buttons for one verb */
  assert.match(add, /:show-enhance="false"/, 'one Enhance, not two')
  assert.match(composer, /showEnhance: \{ type: Boolean, default: true \}/, 'the composer can stand down')
})

test('a task can be edited where it is read, and in full from its menu', () => {
  const edit = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskEditDialog.vue'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')

  assert.match(edit, /<PickMenu[\s\S]{0,220}?icons="entity"/, 'the entity is the app\'s picker')
  assert.match(edit, /id="taskedit-date"/, 'the edit dialog owns the due date')
  assert.doesNotMatch(edit, /id="taskedit-source"/, 'the source is the composer\'s attachments')
  /* the title is step 1's composer, so a task can carry `@` and `/` too */
  assert.match(edit, /<SlashComposer[\s\S]{0,400}?label="Task — \/ for a skill, @ to mention"/, 'the title is the shared composer')
  assert.match(edit, /:show-enhance="false"/, 'the composer does not duplicate the dialog\'s Enhance')
  assert.match(edit, /class="x mo-x"/, 'the close control is the shell\'s')
  assert.match(edit, /role="group" aria-label="Priority"/, 'priority is a group of words, not a code field')
  assert.match(create, /<TaskEditDialog/, 'the page mounts it')
  assert.match(create, /@edit="openTaskEdit\(task\)"/, 'the row menu opens it')
})

test('a task title swaps into a field in its own cell', () => {
  const row = fs.readFileSync(path.join(SRC, 'components', 'goal', 'TaskRow.vue'), 'utf8')
  const css = fs.readFileSync(path.join(SRC, 'styles', 'goals.css'), 'utf8')

  /* the row's words are a button that swaps into a field in the same cell; a
     `start('title')` with no input behind it is an edit that silently does
     nothing (that shipped once) */
  assert.match(row, /v-if="editing === 'title'"/, 'the title has an editing branch')
  assert.match(row, /class="tx tx-input"/, 'the field keeps the row\'s own type')
  assert.match(row, /@click="start\('title'\)"/, 'the button opens the field')
  assert.match(css, /\.goals-page \.task \.tx-input/, 'the field is styled, not a user-agent input')
})

test('going back from the plan keeps the plan', () => {
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')

  /* Back is navigation, not discard: step 1 offers the way back to the drafted
     list until the fields the plan was made from change, and only then asks for
     another planning turn */
  assert.match(create, /const draftSignature/, 'the plan remembers what it was drafted from')
  assert.match(create, /const planStale/, 'step 1 knows whether the plan still fits')
  assert.match(create, /function backToTasks/, 'the plan is one click away')
  assert.match(create, /function draftOrReturn/, 'the primary chooses between returning and drafting')
  assert.match(create, /Back to the tasks/, 'the button says what it does')
  assert.match(create, /Draft again/, 'a stale plan is re-drafted, and says so')
  assert.match(create, /draftSignature\.value = signature\(\)/, 'a landed draft stamps its signature')
})

test('the goal form numbers its fields in the order they appear', () => {
  const catalog = fs.readFileSync(path.join(SRC, 'lib', 'shortcuts.js'), 'utf8')
  const fields = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalFields.vue'), 'utf8')

  /* digits follow the form: a new field between two others takes its number, and
     the ones after it move, so the hint never points at the wrong box */
  const order = ['goal-title', 'goal-entity', 'goal-scope', 'goal-sentence', 'goal-deadline', 'goal-privacy']
  const numbers = order.map((id) => {
    const block = catalog.split(`id: '${id}'`)[1]?.slice(0, 400) || ''
    const hit = block.match(/'alt', 'shift', '(\d)'/)
    return hit ? Number(hit[1]) : null
  })
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6], 'the catalog counts the form in reading order')
  assert.match(fields, /keys\.scope/, 'the scope label prints its own digit')
  assert.match(fields, /if \(field === 'scope'\)/, 'the digit lands on the checked scope card')
})

test('a goal has a planner and a scope, and they are separate answers', () => {
  const store = fs.readFileSync(path.join(ROOT, 'electron', 'goals-store.cjs'), 'utf8')
  const planner = fs.readFileSync(path.join(ROOT, 'electron', 'goal-draft.cjs'), 'utf8')
  const fields = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalFields.vue'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  const view = fs.readFileSync(path.join(SRC, 'views', 'GoalView.vue'), 'utf8')

  /* one picker used to be asked to mean both "who runs the draft" and "who may be
     given a task"; the record keeps them apart, and old records keep the planner */
  assert.match(store, /plannedBy: text\(raw\.plannedBy \?\? raw\.entity/, 'old records keep their planner')
  assert.match(store, /const SCOPES = \['auto', 'only'\]/, 'the scope is a closed set')
  assert.match(store, /entities: namesOf\(/, 'scope names are deduplicated')

  assert.match(fields, /Planned by <kbd/, 'the planner is named what it is')
  assert.match(fields, /Work goes to/, 'the scope is its own question')
  assert.match(fields, /Automatic/, 'automatic is offered')
  assert.match(fields, /Only these/, 'a closed scope is offered')
  assert.match(fields, /emit\('toggle-scope'/, 'a chip toggles the mention, it does not keep a second list')
  assert.match(fields, /written into the sentence as/, 'the copy says where a pick lands')

  assert.match(create, /const mentionedEntities/, 'the sentence can set the scope')
  assert.match(create, /function toggleScope/, 'a pick writes the mention')
  assert.match(create, /function clearScope/, 'automatic takes the mentions out')
  assert.match(create, /tidySentence/, 'taking a mention out does not leave a space before a full stop')
  assert.match(create, /watch\(mentionedEntities/, 'the card follows the sentence')
  assert.match(create, /scope: effectiveScope\.value\.mode/, 'the draft turn is told the scope')
  assert.match(create, /taskEntityOptions/, 'the task dialogs only offer entities in scope')
  assert.match(planner, /function scopeLine/, 'the brief states the scope')
  assert.match(
    planner,
    /scope === 'only' && allowed\.length === 1/,
    'a one-entity scope is closed, not a suggestion the model may ignore',
  )
  assert.match(view, /goal\.plannedBy/, 'the goal page prints the planner')
})

test('the plan can be read by month or by week', () => {
  const calendar = fs.readFileSync(path.join(SRC, 'components', 'goal', 'DraftCalendar.vue'), 'utf8')

  assert.match(calendar, /const view = ref\('month'\)/, 'the month is the default')
  assert.match(calendar, /role="tab"[^>]*@click="setView\('week'\)"/, 'the week is a tab, not a second page')
  assert.match(calendar, /const weekCells = computed/, 'a week is its own seven cells')
  assert.match(calendar, /shiftDay\(weekOf\.value, delta \* 7\)/, 'stepping in week view moves seven days')
  assert.match(calendar, /data-view="view"/, 'the grid knows which reading it is')
})

test('every verb on step 2 has a shortcut and renders its hint', () => {
  const catalog = fs.readFileSync(path.join(SRC, 'lib', 'shortcuts.js'), 'utf8')
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')

  assert.match(catalog, /id: 'goal-adjust'/, 'Adjust the goal is in the one catalog')
  assert.match(catalog, /id: 'goal-task'/, 'Add a task is in the same catalog')
  assert.match(create, /matchesShortcut\('goal-task'/, 'the add key is handled')
  assert.match(create, /matchesShortcut\('goal-adjust'/, 'the key is handled')
  assert.ok(
    (create.match(/shortcutLabel\('goal-adjust'\)/g) || []).length >= 1,
    'the button renders the label from the catalog, not a literal',
  )
  assert.ok(
    (create.match(/\{\{ adjustKey \}\}/g) || []).length >= 2,
    'both Adjust buttons show the same hint',
  )
})

test('a page draft is per-tab and expires', () => {
  const source = fs.readFileSync(path.join(SRC, 'lib', 'draftCache.js'), 'utf8')
  const cache = source.replace(/\/\*[\s\S]*?\*\//g, '') /* a comment is not storage */
  /* a draft belongs to the tab it was written in; localStorage would hand it to
     a second window and keep it for ever */
  assert.match(cache, /sessionStorage/, 'a draft is per-tab')
  assert.doesNotMatch(cache, /localStorage/, 'a draft is not a preference')
  assert.match(cache, /expiresAt/, 'every entry carries its own expiry')
  assert.match(cache, /export const DRAFT_TTL_MS/, 'the TTL is one declared number')
  assert.match(cache, /Date\.now\(\) - \+ ttl|expiresAt: Date\.now\(\) \+ ttl|Date\.now\(\) \+ ttl/, 'the write stamps an expiry')
  assert.match(cache, /expiresAt\) > Date\.now\(\)|Number\(entry\.expiresAt\) > Date\.now\(\)/, 'the read enforces it')
  assert.match(cache, /removeItem/, 'an expired entry is removed, not merely ignored')
  /* the goal form is the caller, and it clears on both exits */
  const create = fs.readFileSync(path.join(SRC, 'components', 'goal', 'GoalCreate.vue'), 'utf8')
  assert.match(create, /clearDraft\(CACHE_KEY\)/, 'the draft is cleared when the goal is created or cancelled')
  assert.match(create, /restored-bar/, 'a restored draft says so, with a way out')
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

/* ── retrying the prompt itself ───────────────────────────────────────────
   The failed turn's row has its own Retry, but the question is what a person
   re-asks, and that row disappears as soon as a retry answers — so the prompt
   carries the action too. A retry spends a real turn and a prompt that was
   already answered gets a second question at the foot of the thread, so both
   buttons go through one confirmation instead of sending on the click. */

test('a prompt is retried from its own row, behind one confirmation', () => {
  const list = fs.readFileSync(path.join(SRC, 'components', 'MessageList.vue'), 'utf8')
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  const dialog = fs.readFileSync(path.join(SRC, 'components', 'PromptRetryDialog.vue'), 'utf8')

  /* the prompt's own foot: the action is on the row the person wrote, and the
     failure row's button routes through the same event */
  assert.match(list, /msg-act--retry/, 'the prompt has no retry in its own actions row')
  assert.match(list, /Ask this prompt again/, 'the prompt retry has no accessible name')
  assert.match(list, /emit\('retry', m\)/, 'the prompt retry is not wired out')

  /* one dialog, dismissible like every other surface */
  assert.match(dialog, /useDialogDismiss\s*\(/, 'Esc must close the retry dialog')
  assert.match(dialog, /aria-label="Close"/, 'the retry dialog needs a visible close button')
  assert.match(dialog, /class="scrim"/, 'the retry dialog needs a backdrop that closes it')
  assert.match(dialog, /prompt-retry-go/, 'the dialog has no confirm button')
  assert.match(dialog, /replace/, 'the dialog cannot say that the failure is replaced')
  assert.match(chat, /<PromptRetryDialog\b/, 'the chat does not mount the retry dialog')

  /* the mode is read from the transcript, not remembered on the row */
  assert.match(chat, /function replacesFailedTurn/, 'the retry cannot tell a failure from an answer')
  assert.match(chat, /every\(\(entry\) => entry\.who === 'sys' && entry\.error\)/, 'a retry replaces rows that are not a failed turn')

  /* and nothing is sent before the confirmation */
  const open = chat.indexOf('function retryFailed')
  const confirm = chat.indexOf('async function confirmRetry')
  assert.ok(open > 0 && confirm > open, 'the retry open and confirm handlers are not both there')
  assert.doesNotMatch(
    chat.slice(open, confirm),
    /chatSend\(/,
    'the retry sends before it is confirmed',
  )
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

/* A refresh is not a cancel. The window's `sending` map is memory, so after a
   reload only the summary carries the truth — and a turn that is still running
   must not read as idle, or the bubble, the Stop and the composer lock all
   disappear while a delegated child is still working. */
test('a turn that is still running survives a refresh', () => {
  const store = fs.readFileSync(path.join(SRC, 'stores', 'hub.js'), 'utf8')
  const chat = fs.readFileSync(path.join(SRC, 'views', 'ChatView.vue'), 'utf8')
  const backend = fs.readFileSync(path.join(ROOT, 'electron', 'chat-store.cjs'), 'utf8')

  /* the backend answers `working` from its own live map */
  assert.match(
    backend,
    /working:\s*sending\.has\(thread\.id\)/,
    'the summary does not report a turn that is still running',
  )
  /* the renderer reads that answer as well as its own memory */
  const isSending = store.match(/export const isSending =[^\n]*\n(?:[^\n]*\n)*?[^\n]*settled/)
  assert.ok(isSending, 'isSending ignores the summary, so a refresh forgets the turn')
  assert.match(store, /settled:\s*\{\}/, 'the store keeps no memory of what it saw settle')
  assert.match(store, /export function markSettled/, 'a settled turn cannot overrule a stale summary')
  assert.match(chat, /markSettled\(id\)/, 'the done event does not record that the turn settled')
})

/* A stopped turn still delegated.
   
   The sessions a turn filed outlive it: `chat.send` writes one per entity
   mention before the harness answers, and a Stop does not take them back. The
   card that links to them was rendered only on an `agent` row, so a turn that
   ended as "Stopped by you." showed no card at all and read as "nothing was
   spawned" — while the session sat in the rail under its parent. */
test('a session a stopped turn filed is still reachable from the transcript', () => {
  const list = fs.readFileSync(path.join(SRC, 'components', 'MessageList.vue'), 'utf8')
  const sysBranch = list.slice(
    list.indexOf("v-if=\"m.who === 'sys'\""),
    list.indexOf('v-else', list.indexOf("v-if=\"m.who === 'sys'\"")),
  )
  assert.ok(sysBranch.length > 0, 'the sys branch moved; update this contract')
  assert.match(
    sysBranch,
    /v-if="delegations\(m\)\.length"/,
    'a sys row never draws its delegation cards, so a stopped turn hides its sessions',
  )
  assert.match(sysBranch, /<DelegationCard\b/, 'the card itself is missing from the sys branch')
})

test('a back button keeps its glyph whether or not it carries a label', () => {
  /* Measured, not assumed: `.view.detail-view > .entp-bar .back { width: 30px }` was
     written for the Entities index's bare chevron, and it also matched the four pages
     whose back button has a label. The flex item that gave way was the 12px glyph, so
     `Connectors`, `MCP`, `Entities` and `Skills` each rendered their label with an
     `svg` 0px wide — a button that looks like it is missing its icon. */
  const css = fs.readFileSync(path.join(SRC, 'styles', 'entities-page.css'), 'utf8')
  assert.doesNotMatch(
    css,
    /\.entp-bar \.back \{/,
    'the square back button is keyed on `.back` again — a labelled button loses its glyph',
  )
  assert.match(css, /\.entp-bar \.back-icon \{/, 'the bare chevron needs its square')

  const views = fs.readdirSync(path.join(SRC, 'views'))
  const labelled = []
  for (const name of views) {
    if (!name.endsWith('.vue')) continue
    const text = fs.readFileSync(path.join(SRC, 'views', name), 'utf8')
    if (!/class="back\b/.test(text)) continue
    /* The button's own text, outside the `<svg>`: the label a person reads. */
    const body = text.slice(text.search(/class="back\b/))
    const close = body.search(/<\/(button|router-link)>/)
    const inner = body.slice(0, close < 0 ? 400 : close)
    const withoutSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').trim()
    if (/\.back-icon\b/.test(inner)) {
      assert.equal(withoutSvg, '', `${name}: a .back-icon button must not carry a label`)
      continue
    }
    labelled.push(name)
    assert.match(inner, /<svg\b/, `${name}'s back button has a label but no glyph`)
  }
  assert.ok(labelled.length >= 4, 'the labelled back buttons are the ones this rule is for')
})
