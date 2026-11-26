/**
 * The connector contract: one folder per connector, on both sides.
 *
 * This repository adds connectors all the time, and the expensive mistakes have all
 * been one shape — a connector named in one place and forgotten in another (a
 * mention that resolves in the composer but not in a turn, a dashboard row with no
 * body, a call that exists in the renderer and nowhere in the main process). The fix
 * is not more discipline; it is one folder per connector that a test can read.
 *
 *   electron/connectors/<id>/connector.cjs   the descriptor: id, resolver, mention,
 *                                            the catalog entry, dashboard, calls
 *   electron/connectors/<id>/mention.cjs     resolve / preview
 *   electron/connectors/<id>/dashboard.cjs   the read behind the tab
 *   src/connectors/<id>/…                    the Vue bodies, composable and cards
 *
 * `electron/connectors/registry.cjs` lists the folders and derives the mention map,
 * the account heads and the call table from them; `connector-catalog.cjs` assembles
 * its connector half from the same descriptors. This test is what keeps that honest.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const registry = require('../../electron/connectors/registry.cjs')
const catalog = require('../../electron/connector-catalog.cjs')

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts))
const mainFolder = (id) => path.join('electron', 'connectors', id)
const renderFolder = (id) => path.join('src', 'connectors', id)

test('every connector is one folder, and the registry lists exactly those', () => {
  const folders = fs
    .readdirSync(path.join(ROOT, 'electron', 'connectors'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(
    [...registry.FOLDERS].sort(),
    folders,
    'a connector folder is missing from the registry, or the registry names a folder that is not there',
  )

  const ids = registry.ENTRIES.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'two descriptors share a row id')
  assert.deepEqual(ids, registry.FOLDERS, 'a descriptor id does not match its folder')

  const kinds = registry.ENTRIES.filter((entry) => entry.resolver).map((entry) => entry.resolver)
  assert.equal(new Set(kinds).size, kinds.length, 'two descriptors share a resolver kind')

  const heads = registry.ENTRIES.filter((entry) => entry.mention).map((entry) => entry.mention)
  assert.equal(new Set(heads).size, heads.length, 'two connectors offer the same mention head')
})

test('a descriptor carries the three names once, and the files its declarations need', () => {
  for (const entry of registry.ENTRIES) {
    const folder = mainFolder(entry.id)
    assert.ok(exists(folder, 'connector.cjs'), `${entry.id} has no connector.cjs`)

    assert.ok(entry.entry && typeof entry.entry === 'object', `${entry.id} has no catalog entry`)
    assert.ok(entry.entry.label, `${entry.id}'s catalog entry has no label`)
    assert.ok(entry.entry.kind, `${entry.id}'s catalog entry has no kind`)

    if (entry.mention) {
      assert.ok(entry.resolver, `${entry.id} offers @${entry.mention}: but declares no resolver`)
      assert.ok(exists(folder, 'mention.cjs'), `${entry.id} declares a mention but has no mention.cjs`)
    }
    if (entry.resolver) {
      assert.equal(
        typeof entry.mentionModule,
        'function',
        `${entry.id} has a resolver kind but no mentionModule`,
      )
    }

    /* A carried call is a promise the call table keeps: every call is a function,
       named like a call, and the dashboard's own call is among them. */
    const names = Object.keys(entry.calls || {})
    for (const [name, handler] of Object.entries(entry.calls || {})) {
      assert.equal(typeof handler, 'function', `${entry.id}'s ${name} has no handler`)
      assert.match(name, /^[a-zA-Z-]+\.[a-zA-Z]+$/, `${entry.id}'s ${name} is not a call name`)
    }
    if (names.length) {
      assert.ok(exists(folder, 'dashboard.cjs'), `${entry.id} answers calls but has no dashboard.cjs`)
    }
    if (entry.dashboard) {
      assert.ok(
        entry.dashboard.kind,
        `${entry.id}'s dashboard names no renderer kind — the tab has no body to open`,
      )
      assert.ok(
        ['cli', 'oauth', 'token', 'mcp'].includes(entry.dashboard.mode),
        `${entry.id}'s dashboard mode "${entry.dashboard.mode}" is not one of the four`,
      )
      assert.ok(entry.dashboard.call, `${entry.id}'s dashboard names no call`)
      assert.ok(
        names.includes(entry.dashboard.call),
        `${entry.id}'s dashboard call "${entry.dashboard.call}" is not in its own calls`,
      )
    }
  }
})

test('the call table is exactly what the descriptors declare', () => {
  const declared = registry.ENTRIES.flatMap((entry) => Object.keys(entry.calls || {})).sort()
  assert.deepEqual(Object.keys(registry.calls()).sort(), declared)

  /* The table is a spread in `rpc.cjs`, so a name cannot be added here and forgotten
     there. */
  const rpc = read('electron', 'rpc.cjs')
  assert.match(rpc, /\.\.\.connectorRegistry\.calls\(\)/, 'the call table no longer spreads the registry')
})

test('rpc.cjs and the catalog know no connector module path', () => {
  const rpc = read('electron', 'rpc.cjs')
  assert.doesNotMatch(
    rpc,
    /require\('\.\/connectors\/(?!registry\.cjs')[a-z-]+/,
    'a connector module is required by rpc.cjs again — it belongs in its folder',
  )
  assert.doesNotMatch(
    rpc,
    /require\('\.\/connectors\/[a-z-]+\/[a-z]+\.cjs'\)/,
    'a connector folder is required by rpc.cjs again — the registry owns that',
  )

  /* The catalog is a splice: internal rows keep their prose here, connectors bring
     theirs from their own descriptor. */
  const source = read('electron', 'connector-catalog.cjs')
  for (const entry of registry.ENTRIES) {
    const key = /^[a-z][a-z0-9]*$/.test(entry.id) ? entry.id : `'${entry.id}'`
    assert.ok(
      source.includes(`${key}: CONNECTORS.`) || source.includes(`${key}: CONNECTORS[`),
      `${entry.id} is written out in the catalog again instead of assembled from its descriptor`,
    )
  }
})

test('every mention head resolves through its own kind', () => {
  const heads = registry.accountHeads()
  for (const [head, kind] of Object.entries(heads)) {
    assert.ok(registry.KINDS.includes(kind), `@${head}: maps to "${kind}", which is not a kind`)
    const resolver = require('../../electron/connectors/index.cjs').resolverFor(kind)
    assert.equal(typeof resolver, 'function', `@${head}: resolves to nothing`)
  }
  const values = Object.values(heads)
  assert.equal(new Set(values).size, values.length, 'two heads resolve through one kind')
})

test('every dashboard has a body on both sides', () => {
  const table = read('src', 'connectors', 'dashboards.js')
  const pane = read('src', 'connectors', 'ConnectorDashboardPane.vue')

  for (const entry of registry.ENTRIES) {
    if (!entry.dashboard) continue
    /* An `mcp` connector's tab is drawn by the MCP page — YouTrack is that one — so
       the connector page's table is the three rest/cli/token shapes. */
    if (entry.dashboard.mode === 'mcp') {
      assert.ok(
        exists(renderFolder(entry.id), 'YoutrackDashboard.vue'),
        `${entry.id} has no dashboard body in its own folder`,
      )
      assert.match(read('src', 'views', 'McpServerView.vue'), /YoutrackDashboard\.vue/, 'the MCP page does not draw it')
      continue
    }
    const kind = entry.dashboard.kind
    assert.match(table, new RegExp(`\\n  ${kind}: \\{`), `${kind} has no entry in the dashboard table`)
    assert.match(pane, new RegExp(`body === '${kind}'`), `${kind} has a table entry but no pane body`)

    /* The renderer half is one folder per connector too, named after the row. */
    const folder = renderFolder(entry.id)
    assert.ok(fs.existsSync(path.join(ROOT, folder)), `${entry.id} has no renderer folder`)
    assert.ok(
      fs.readdirSync(path.join(ROOT, folder)).some((name) => name.endsWith('Dashboard.vue')),
      `${folder} has no dashboard component`,
    )
    assert.ok(
      fs.readdirSync(path.join(ROOT, folder)).some((name) => name.startsWith('use')),
      `${folder} has no composable`,
    )
  }
})

test('the renderer table keys are the resolver kinds, and the two connectors whose own band reads declare no pane read', () => {
  const table = read('src', 'connectors', 'dashboards.js')
  const kinds = ['github', 'calendar', 'studio', 'clockify', 'habitify', 'fitbit', 'lynk']
  for (const kind of kinds) {
    assert.match(table, new RegExp(`\\n  ${kind}: \\{`), `${kind} has no entry in the dashboard table`)
  }
  /* Only these two exist: predicates that hold for a table nobody checks are how a
     seventh connector gets a second read of one screen. */
  for (const kind of ['clockify', 'fitbit']) {
    const entry = table.slice(table.indexOf(`\n  ${kind}: {`))
    assert.match(entry.slice(0, entry.indexOf('\n  },')), /read: null/, `${kind} must not read twice`)
  }
  for (const kind of ['github', 'calendar', 'studio', 'habitify', 'lynk']) {
    const entry = table.slice(table.indexOf(`\n  ${kind}: {`))
    assert.match(entry.slice(0, entry.indexOf('\n  },')), /read\(\{/, `${kind} declares no pane read`)
  }
})

test('the read envelope is one implementation', () => {
  /* `DESIGN.md`: the page prints the rule it follows, and never hardcodes the
     duration. That rule used to be eight copies of the same eleven lines — which is
     eight places to type a number the main process already knows. */
  const clock = read('src', 'connectors', 'parts', 'readClock.js')
  for (const name of ['ttlWords', 'cachedUntil', 'cacheNote']) {
    assert.match(clock, new RegExp(`export function ${name}\\(`), `readClock.js has no ${name}`)
  }
  /* The stamp needs `ago()`, so it lives next door — and `readClock.js` imports
     nothing, which is what lets `tests/unit/read-clock.test.cjs` pin the rule. */
  assert.doesNotMatch(clock, /^import /m, 'readClock.js must stay import-free to be testable')
  assert.match(
    read('src', 'connectors', 'parts', 'readStamp.js'),
    /export function readStamp\(/,
    'readStamp.js has no readStamp',
  )

  const dashboardFiles = registry.ENTRIES.flatMap((entry) => {
    const folder = path.join(ROOT, 'src', 'connectors', entry.id)
    if (!fs.existsSync(folder)) return []
    return fs
      .readdirSync(folder)
      .filter((name) => name.endsWith('.vue'))
      .map((name) => path.join(folder, name))
  })

  for (const file of dashboardFiles) {
    const text = fs.readFileSync(file, 'utf8')
    const where = path.relative(ROOT, file)
    /* A dashboard that prints a duration must take its words from the payload. A
       page that only *compares* `cacheTtlMs` (Lynk.id's stale check) formats nothing
       and needs no import. */
    if (/\bttlText\b|\bcacheText\b|\bcacheNote\b/.test(text)) {
      assert.match(text, /parts\/readClock/, `${where} formats a cache duration by itself`)
    }
    /* The unit strings are the rule; a literal here is a second copy of it. */
    assert.doesNotMatch(text, /'1 day'|'1 minute'|'\$\{days\} days'/, `${where} types a unit instead of using readClock`)
  }
})

test('a visually-hidden table caption cannot escape its scroll box', () => {
  /* The bug this pins, measured on the Clockify tab: `<caption class="sr-only">` is
     `position: absolute` with a 1 px box, and a caption has no positioned ancestor
     inside a table — so its containing block was the initial one, three captions
     landed outside `.main-scroll`'s clip, and the *document* grew to 1822 px in a
     900 px window: a second scrollbar and ~900 px of blank page under the content.
     `.dsh-tblscroll { position: relative }` is the fix; deleting it brings the
     phantom scrollbar back, silently. */
  const css = read('src', 'styles', 'connector-page.css')
  const box = css.slice(css.indexOf('.dsh-tblscroll {'))
  assert.match(
    box.slice(0, box.indexOf('}')),
    /position:\s*relative/,
    '.dsh-tblscroll lost `position: relative`, so an sr-only caption escapes its clip',
  )

  /* Every visually-hidden element on a dashboard must sit inside one of those boxes
     — a caption in Clockify's tables, a day label in Habitify's grid. Asserting the
     wrapper exists in the same file is enough: a `sr-only` in a dashboard without a
     scroll box is the same bug with a different element name. */
  for (const entry of registry.ENTRIES) {
    const folder = renderFolder(entry.id)
    if (!fs.existsSync(path.join(ROOT, folder))) continue
    for (const name of fs.readdirSync(path.join(ROOT, folder))) {
      if (!name.endsWith('.vue')) continue
      const text = read(folder, name)
      if (!text.includes('class="sr-only"')) continue
      assert.match(
        text,
        /class="dsh-tblscroll"/,
        `${folder}/${name} has a visually-hidden element but no positioned scroll box`,
      )
    }
  }
})
