/**
 * The connector registry: one folder per connector, and this is the list of them.
 *
 * Each `electron/connectors/<id>/` folder carries its own descriptor
 * (`connector.cjs`), its mention (`mention.cjs`) and its dashboard read
 * (`dashboard.cjs`). This file names the folders, in the order a person would try
 * them, and derives the three maps everything else asks for:
 *
 * | map            | who reads it                                   |
 * | -------------- | ---------------------------------------------- |
 * | mention kinds  | `index.cjs` (the resolver facade)               |
 * | account heads  | `mention-ref.cjs` (which `@…:` reads an account) |
 * | call table     | `rpc.cjs` (one spread, no connector knowledge)  |
 * | process hooks  | `rpc.cjs` and `main.cjs` (`attachAll`/`fanoutAll`/`shutdownAll`) |
 *
 * **The descriptor is the source of truth for the three names**, which is why they
 * are not repeated anywhere:
 *
 * | field     | what it is                                                | example          |
 * | --------- | --------------------------------------------------------- | ---------------- |
 * | `id`      | the row id — the roster, `connectors.json`, the address    | `google-calendar` |
 * | `resolver`| the resolver kind — `connectorOfKind`, the module basename | `calendar`        |
 * | `mention` | the head a person actually types                          | `gcal`            |
 *
 * The catalog also assembles itself from here (`catalogEntries()`), so a connector's
 * `work` prose is written where its code is instead of in a second table.
 *
 * **Nothing here loads a module that reads anything.** Every descriptor is data plus
 * lazily-required functions, so listing a connector costs one small file, and the
 * seven dashboard modules (about five thousand lines) are parsed only when the tab
 * that needs one is opened.
 */

/**
 * The folders, in mention order. A connector with no mention (`github`, `youtrack`,
 * `lynk`) is still listed here — it answers calls, and its calls live in its folder.
 *
 * `require` is inside each arrow so the list itself costs nothing: this file is read
 * at startup by the catalog and by `rpc.cjs`.
 */
const FOLDERS = [
  /* First: this machine's own projects, which is what a person tries first. */
  'orca',
  'gmail',
  'google-drive',
  'google-calendar',
  'youtube',
  'youtube-studio',
  'x',
  'clockify',
  'habitify',
  'fitbit',
  'open-design',
  /* The fourth kind: it reads a local daemon instead of a remote service, so it
     authenticates nothing, offers no mention and answers no dashboard tab — but it
     is a connector like the rest, with its calls and its catalog entry in its own
     folder. Listed here with the credentialless ones, because it needs no account. */
  'tailscale',
  'github',
  'youtrack',
  'lynk',
  /* The two credentialless feeds News reads. They are connectors like the rest —
     a row with a URL and no credential — so they install, list and uninstall with
     the same verbs; nothing here resolves a mention or answers a call. Kept last
     because neither is something a workspace attaches on purpose on day one: a
     person installs the one they want to read. */
  'google-trends',
  'reddit',
]

const loaded = new Map()

/** The descriptor for one folder, required once and kept. */
function descriptor(folder) {
  if (!loaded.has(folder)) loaded.set(folder, require(`./${folder}/connector.cjs`))
  return loaded.get(folder)
}

/** Every descriptor, in `FOLDERS` order. */
const ENTRIES = FOLDERS.map(descriptor)

const byKind = new Map()
const byId = new Map()
for (const entry of ENTRIES) {
  byId.set(entry.id, entry)
  if (entry.resolver) byKind.set(entry.resolver, entry)
}

/** Every resolver kind, in the order a person would try them. */
const KINDS = ENTRIES.filter((entry) => entry.resolver).map((entry) => entry.resolver)

/** The mention module for a resolver kind, or null. */
function mentionModule(kind) {
  const entry = byKind.get(String(kind || ''))
  return entry?.mentionModule ? entry.mentionModule() : null
}

/** The resolver for a kind, or null.
 *
 * A module exports `resolve<Name>` (`resolveGmail`, `resolveX`…) so its file reads as
 * the thing it is; a module that prefers the generic `resolve` is accepted too. */
function resolverFor(kind) {
  const entry = byKind.get(String(kind || ''))
  const mod = mentionModule(kind)
  if (!mod || !entry) return null
  return mod.resolve || (entry.suffix ? mod[`resolve${entry.suffix}`] : null) || null
}

/** The save-time check a `credential: 'token'` connector ships, or null. */
function verifyFor(kind) {
  const entry = byKind.get(String(kind || ''))
  return typeof entry?.verify === 'function' ? entry.verify : null
}

/** `{ gcal: 'calendar', gmail: 'gmail', … }` — the heads that read an account, and
 *  the kind each one resolves through. Derived, so `mention-ref.cjs` cannot offer a
 *  head this registry does not know. */
function accountHeads() {
  const heads = {}
  for (const entry of ENTRIES) {
    if (entry.account && entry.mention && entry.resolver) heads[entry.mention] = entry.resolver
  }
  return heads
}

/** The catalog's connector half: `{ <row id>: <catalog entry> }`. */
function catalogEntries() {
  const entries = {}
  for (const entry of ENTRIES) entries[entry.id] = entry.entry
  return entries
}

/** The call table's connector half: every call name, as the handler `rpc.cjs` spreads
 *  in. Declared once per connector, in that connector's own folder. */
function calls() {
  const table = {}
  for (const entry of ENTRIES) {
    for (const [name, handler] of Object.entries(entry.calls || {})) table[name] = handler
  }
  return table
}

/** The row id for a resolver kind, for a caller that has to name the row. */
function idOfKind(kind) {
  return byKind.get(String(kind || ''))?.id || ''
}

/** Which tab a connector draws, and what its lock is made of — or null. */
function dashboardFor(kind) {
  return byKind.get(String(kind || ''))?.dashboard || null
}

/* ── the process hooks ───────────────────────────────────────────────────────
   A connector's calls are the normal way to reach it. Three optional hooks are for
   the one connector that needs the *process* instead: it serves this app over HTTP,
   so it needs the call table behind that page (`attach`), the event stream it
   already emits (`fanout`), and a stop when the app quits (`shutdown`).

   They live here rather than as a `require('./connectors/tailscale/…')` in `rpc.cjs`
   because that is exactly the mistake `rpc.cjs` is not allowed to make (see
   `tests/unit/connector-registry.test.cjs`): a connector's module path belongs in
   its own folder, and every caller asks the registry. */

/** Hand the call table to whoever needs it. Called once, by a process that owns one. */
function attachAll(call) {
  for (const entry of ENTRIES) {
    if (typeof entry.attach === 'function') entry.attach(call)
  }
}

/** Mirror one emitted event to whatever a connector is currently serving. */
function fanoutAll(event) {
  for (const entry of ENTRIES) {
    if (typeof entry.fanout !== 'function') continue
    try {
      entry.fanout(event)
    } catch {
      /* a listener that already closed is not an event failure */
    }
  }
}

/** Stop anything a connector started. Runs on quit, where promises never resolve. */
function shutdownAll() {
  for (const entry of ENTRIES) {
    if (typeof entry.shutdown !== 'function') continue
    try {
      entry.shutdown()
    } catch {
      /* a server that already stopped is not a failed shutdown */
    }
  }
}

module.exports = {
  ENTRIES,
  FOLDERS,
  KINDS,
  accountHeads,
  attachAll,
  calls,
  catalogEntries,
  dashboardFor,
  fanoutAll,
  idOfKind,
  mentionModule,
  resolverFor,
  shutdownAll,
  verifyFor,
}
