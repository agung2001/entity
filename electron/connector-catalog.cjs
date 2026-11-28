/**
 * The connector catalog: the definitions Entity itself ships.
 *
 * A connector is one of two things, and the difference matters at the only moment
 * that counts — when a turn is built:
 *
 *   - **known** — Entity ships a resolver for it. `@github:owner/repo` becomes a
 *     real repository in the prompt, `@orca:project:path` a real path, `@youtrack:AC:bug`
 *     a real issue. The resolver lives beside its connector
 *     (`connectors/<id>/mention.cjs`) or, for the three that predate the
 *     folders, in `mention-ref.cjs`; this file is where its *contract* lives, as
 *     data, so the roster and the composer cannot disagree about what a mention
 *     does.
 *   - **custom** — nothing is shipped. `@<id>:` attaches the connector's
 *     definition and status as context and the entity uses its own tools.
 *
 * The `work` block is not a second implementation. It is the documentation of one
 * that exists, rendered on the connector's page and used to gate the mention menu:
 * **a kind with no `resolver` never offers a colon syntax it cannot resolve.**
 *
 * `kind` stays what the runtime needs (`mcp` / `cli` / `rest`). `builtIn` is
 * provenance — a label on an ordinary row — so a built-in YouTrack still opens
 * `:workspace/mcp/youtrack` and still lives in `mcp.json`.
 */
/* The three ids that also keep a machine-wide switch in `integrations-store`.
   Named here rather than required from it: `integrations-store` loads
   `mention-ref`, which loads this file, and a require-cycle would hand one of the
   three a half-built module. */
const IDS = ['orca', 'youtrack', 'github']

const SCHEMA = 1

/**
 * One entry per shipped definition.
 *
 * `work` says what a person types, what comes back, and which resolver answers it:
 *
 *   mention   the literal prefix the composer and the parser agree on
 *   resolves  one clause: what the mention produces
 *   syntax    the shape of the argument
 *   examples  two or three real ones, shown as-is
 *   returns   what lands in the prompt
 *   resolver  a key in `RESOLVERS`, or null for "context only"
 *   needs     the one prerequisite, in words
 *   page      where this connector's MCP binding is documented, for `mcp` kinds
 *
 * A `resolver` value must exist in `mention-ref`'s table; `tests/unit/connector-store`
 * fails the build if one does not. That is what stops a typo from silently
 * downgrading a known connector to a pass-through.
 */
/**
 * The connector half of this table comes from the registry, which reads one
 * descriptor per connector folder (`connectors/<id>/connector.cjs`). This file keeps
 * the rows that are not connectors — the app's own shelves, an MCP server Entity runs
 * itself, a machine — and the shape every row is read through.
 *
 * Splice order is deliberate: `entries()` and `mentionKinds()` present connectors in
 * the order written below, and the roster and the composer both read those lists as
 * they come.
 */
const CONNECTORS = require('./connectors/registry.cjs').catalogEntries()

const CATALOG = {
  /* Orca is a connector folder like the rest (`connectors/orca/`): the descriptor
     carries this entry and the resolver sits beside it. It stays first because a
     person's own machine is what they try first. */
  orca: CONNECTORS.orca,
  github: CONNECTORS.github,
  youtrack: CONNECTORS.youtrack,
  maka: {
    label: 'Maka',
    kind: 'mcp',
    verify: null,
    /* the app's own site — shown on the connector page as the place to read about
       the service a person is about to attach */
    website: 'https://maka.agungsundoro.com',
    summary: 'Notes, pdfs and feeds from a local vault.',
    work: {
      mention: '@maka:',
      resolves: 'notes, in one vault or across every vault',
      syntax: '@maka:[<vault>:]<query>',
      examples: ['@maka:one:plan', '@maka:retro'],
      returns: 'the matching notes — title and the line that matched',
      resolver: 'maka',
      needs: 'the Maka MCP server in this workspace’s pool',
      page: 'mcp.json',
      how: [
        'A vault name before the colon scopes the search; without one it reads every vault.',
        'The matching notes come back as a title and the line that matched, so a long note is not pasted whole.',
      ],
      samples: [
        { code: '@maka:one:plan', then: 'notes in the “one” vault matching “plan”' },
        { code: '@maka:retro', then: 'every vault, one query' },
      ],
    },
  },

  /* ── the fourth kind: a connector that reads a local daemon ──────────────
     Tailscale authenticates nothing, stores no token and offers no mention, so its
     entry is ordinary data and lives in its own folder
     (`connectors/tailscale/connector.cjs`) like every other connector's. */
  tailscale: CONNECTORS.tailscale,

  /* ── the browser this machine already has open ───────────────────────────
     Chrome DevTools is an MCP server Google ships, not one a workspace owns, so
     there is no `launcher` — nothing in the workspace holds the program. What the
     entry carries instead is `server`: the server's own `npx` line, which
     `connector-store.install()` writes into `mcp.json` as-is. It names no home
     directory, so it syncs and still means the same thing on the second machine.
     It answers no `@` form — a browser is something a turn drives, not something
     typed in a composer. */
  'chrome-devtools': CONNECTORS['chrome-devtools'],

  /* ── a shipped server that lives in the workspace ────────────────────────
     Open Design is an MCP server, and unlike Maka it is not something a person
     installs on their own computer: the workspace's own `skills/opendesign/` holds
     it, and `skills/**` syncs. So the entry carries the `launcher` that install
     writes into the pool — a workspace-relative path, never a home directory, never
     a versioned payload path, never a daemon port — and the definition is portable
     by construction.

     Two facts ride on the entry rather than on a second list in the renderer:
     `readOnlyTools` is what a mention may call, and `timeoutMs` is the deadline a
     cold start gets (a first run downloads and starts a server; 12 s reads as a
     broken server and is not). */
  'open-design': CONNECTORS['open-design'],

  /* ── account-bearing connectors ────────────────────────────────────────
     A `rest` row whose credential is one refresh token *per account*, on this
     machine — not one token for the connector. So the catalog entry says
     `oauth: true` and the sheet writes one row; the accounts themselves are
     connected on the connector's page, which is the only surface that can carry
     per-account verbs.

     **No `work` block, deliberately.** Spec §10 open question 1 — does Gmail ship
     a resolver, or is it context-only — is unanswered, so these four are
     context-only: a `@gmail:` form with nothing behind it would be a promise the
     parser cannot keep, and `workOf` returning nothing is what keeps the page on
     its resolver-less "In the chat" card. When question 1 is answered, a
     `work` block plus a `RESOLVERS` entry is the whole change.

     `summary` is the one line the roster's Built-in pane and the add sheet's card
     both print, so the catalog stays the only list of what the app ships. */
  gmail: CONNECTORS.gmail,
  'google-drive': CONNECTORS['google-drive'],
  /* The calendar is the read-only sibling of the other Google rows: one grant,
     one week of events, and no verb that would move one. The mention is a search
     over the calendars a person already sees, which is what makes
     `@gcal:avery:planning` answer with an event rather than a suggestion to book
     one. */
  'google-calendar': CONNECTORS['google-calendar'],
  youtube: CONNECTORS.youtube,
  /* ── YouTube **Studio**: the channel's own data, not a public search ──────
     A separate connector from `youtube` on purpose. `@youtube:` searches what
     anyone can see; this reads the things only the owner can — views, watch time,
     subscriber movement, traffic sources, revenue and the comments waiting for a
     reply. They are different grants, so they are different cards.

     Every answer is computed from the YouTube Data API and the Analytics API, and
     the *shapes* follow what YouTube Studio puts on screen so the numbers are the
     ones a person already trusts. */
  'youtube-studio': CONNECTORS['youtube-studio'],

  /* ── a connector that signs in but has no account list ────────────────────
     Habitify is `rest` + `oauth`, one account per install, and it reads its data
     through the provider's own **remote MCP server** rather than a REST endpoint.
     So it is account-bearing for the grant and mention-resolved for the read: the
     resolver dials `https://mcp.habitify.me/mcp` with the stored access token.
     `provider: 'habitify'` is what points it at its own provider row — including
     the dynamic client registration that mints a client id for the loopback port
     this run actually listens on. */
  habitify: CONNECTORS.habitify,

  /* ── one day, drawn ─────────────────────────────────────────────────────
     Fitbit is `rest` + `oauth` like Habitify, and one account per install — but its
     page carries a second tab, `?tab=dashboard`, because a day of steps is a picture
     before it is a sentence. The tab reads through `electron/connectors/fitbit/dashboard.cjs`;
     this entry says what the mention means and what a read costs, which is the only
     number a person needs to know before pressing it. */
  fitbit: CONNECTORS.fitbit,

  /* ── a paste-once credential ─────────────────────────────────────────────
     `credential: 'token'` is the other way a `rest` row authenticates: one opaque
     API key, pasted once, that never refreshes. There is no consent screen and no
     per-account row — one shared credential, many members — so this entry carries
     no `oauth` flag and the sheet lands it with no tier.

     Its workspace id, IANA timezone and member map are **workspace** state, kept on
     the row's `fields` in `connectors.json`: none of them is a secret, and a report
     computed in the wrong zone is the bug the week math exists to avoid. */
  clockify: CONNECTORS.clockify,

  /* ── the second paste-once key, for a different reason ───────────────────
     Pexels is a public library rather than a workspace, so its key answers one
     question and no report: there is no dashboard tab, no account row and no
     setting to keep beside it. The entry is here because the mention is — the
     library is only worth attaching if `@pexels:` can hand an agent a picture. */
  pexels: CONNECTORS.pexels,

  /* ── a report made of a Drive folder, with no mention behind it ──────────
     Lynk.id ships no resolver on purpose. It is a **report**, not a lookup: the
     answer is one table computed from up to a hundred spreadsheets, and its only
     setting — which folder they live in — belongs to the workspace, not to a line
     typed in the composer. So this entry carries `work` with no `mention` and no
     `resolver`: the page draws its config card and no syntax, `mentionOf()` returns
     '', and the composer never offers `@lynk:` for something nothing answers.

     `provider: 'google'` is implicit (it is the default in `oauth-providers`), but
     the grant is not the Drive connector's: `drive.readonly` reaches the whole
     Drive, which `drive.file` cannot, so it is declared in its own tier in
     `oauth-scopes.cjs`. */
  lynk: CONNECTORS.lynk,

  x: CONNECTORS.x,

  /* ── an account-bearing row whose credential is pasted ────────────────────
     Threads is `oauth: true` with `provider: 'threads'`, so its accounts live in the
     same two files Gmail's and X's do — one row per account, one token per row — and
     the mention's first segment is the account. What makes it different is only how an
     account gets there: `pasteToken` on the provider row, because Threads has no
     per-install loopback redirect to register, so the card asks for the token a person
     already holds instead of opening a browser. The token verbs are not used for it at
     all, which is why this entry carries no `credential: 'token'`.

     It is read-only and it costs calls: one insight request per post in the window,
     which is why the dashboard holds its answer for ten minutes and the mention reads
     that same answer instead of asking again. */
  threads: CONNECTORS.threads,

  /* ── the two credentialless feeds ────────────────────────────────────────
     A feed is a URL and nothing else: no resolver, no account, no call, no token,
     so neither entry carries a `work` block and neither offers a mention. They are
     installable all the same — `connector.install` writes the row, `news-store`
     fetches it in the main process, and News is the only page that reads it.

     Two, not one, because the News tabs read disjoint sets: `google-trends` is the
     single feed the Trends tab will ever read (its host is the rule `isTrends()`
     matches) and `reddit` is an ordinary news feed for General. Any other feed —
     another subreddit, another country's trends, a blog — is a feed a person adds
     with `kind: 'rss'`, which is why the add sheet keeps its own card for it. */
  'google-trends': CONNECTORS['google-trends'],
  reddit: CONNECTORS.reddit,

  /* ── shipped parsers, not connectors ────────────────────────────────────
     `@artifact:` and `@thread:` name a workspace object, not a service: there is
     nothing to connect, no credential, no scope. They keep their resolvers and
     are listed here so the composer has ONE table to build its menu from. */
  artifact: {
    label: 'Artifact',
    kind: 'internal',
    verify: null,
    work: {
      mention: '@artifact:',
      resolves: 'a file on this workspace’s artifact shelf',
      syntax: '@artifact:<name>',
      examples: ['@artifact:shot-2026', '@artifact:report'],
      returns: 'the matching artifacts as `artifact://` references the chat renders inline',
      resolver: 'artifact',
      needs: '',
      page: '',
      how: ['A file on the shelf becomes an `artifact://` reference the chat renders inline.'],
      samples: [{ code: '@artifact:report', then: 'the matching file, attached to the turn' }],
    },
  },
  thread: {
    label: 'Conversation',
    kind: 'internal',
    verify: null,
    work: {
      mention: '@thread:',
      resolves: 'another conversation in this workspace',
      syntax: '@thread:<id>',
      examples: ['@thread:t_abc123'],
      returns: 'that conversation’s digest, so the entity can read what was decided there',
      resolver: 'thread',
      needs: '',
      page: '',
      how: ['Another conversation’s digest, so the entity can read what was decided there.'],
      samples: [{ code: '@thread:t_abc123', then: 'that conversation, summarised into the prompt' }],
    },
  },
}

/** The resolver keys `mention-ref` actually answers. A catalog entry may not name anything else. */
const RESOLVERS = new Set([
  'orca', 'github', 'youtrack', 'maka',
  'gmail', 'drive', 'calendar', 'youtube', 'youtube-studio', 'x', 'threads',
  'clockify', 'habitify', 'fitbit', 'opendesign', 'pexels',
  'artifact', 'thread',
])

/** The shipped definitions a person can install. Internal ones are not connectors. */
const INSTALLABLE = Object.entries(CATALOG)
  .filter(([, entry]) => entry.kind !== 'internal')
  .map(([id]) => id)

/** The ones that carry accounts rather than a single token. Derived from the table
 *  above, never listed a second time: adding a fifth provider is one entry. */
const ACCOUNT_BEARING = Object.entries(CATALOG)
  .filter(([, entry]) => entry.oauth === true)
  .map(([id]) => id)

const entryOf = (id) => CATALOG[String(id || '').toLowerCase()] || null

/**
 * The installable catalog as the surfaces list it.
 *
 * One table, two doors: the roster's Built-in pane and the add sheet's card
 * groups both read this, so a new provider is **one entry above** and appears in
 * both places. The earlier shape had the sheet's cards written into a component,
 * which is how a shipped connector goes missing from its own add sheet.
 */
function entries() {
  return INSTALLABLE.map((id) => {
    const entry = CATALOG[id]
    return {
      id,
      label: entry.label,
      kind: entry.kind,
      /* `credential` is present only where it is not the default: `token` means a
         paste-once key rather than an OAuth consent. */
      credential: entry.credential || '',
      oauth: entry.oauth === true,
      summary: entry.summary || '',
      /* the service's own site, when it ships one — the connector page links here */
      website: entry.website || '',
      /* what the catalog promises a mention does, or '' for a context-only entry */
      resolves: entry.work?.resolves || '',
    }
  })
}

/** The service's own site, or '' when the catalog does not name one. */
function websiteOf(id) {
  return entryOf(id)?.website || ''
}

/** The `@` prefix a connector offers, or '' when it has no resolver (context only). */
function mentionOf(id) {
  const entry = entryOf(id)
  if (!entry?.work?.resolver) return ''
  return entry.work.mention
}

/**
 * Everything the composer needs to offer a kind, in the composer's own shape.
 * Only entries whose resolver exists are offered: a mention that resolves to
 * nothing is worse than no mention at all.
 */
function mentionKinds() {
  return Object.entries(CATALOG)
    .filter(([, entry]) => entry.work?.resolver && RESOLVERS.has(entry.work.resolver))
    .map(([id, entry]) => ({
      id,
      name: entry.work.mention,
      desc: entry.work.resolves,
      resolver: entry.work.resolver,
      builtIn: entry.kind !== 'internal',
      kind: entry.kind,
    }))
}

/** The documentation block, rendered as it is on the connector's page. An entry
 *  with no `work` block is context-only: it ships no mention, and `null` is how
 *  the page knows to draw its resolver-less card instead of a syntax. */
function workOf(id) {
  const entry = entryOf(id)
  if (!entry?.work) return null
  return {
    ...entry.work,
    how: entry.work.how || [],
    samples: entry.work.samples || [],
    label: entry.label,
    kind: entry.kind,
    verified: Boolean(entry.verify),
    documented: entry.kind === 'mcp' ? entry.work.page || 'mcp.json' : '',
    website: entry.website || '',
  }
}

module.exports = {
  SCHEMA,
  CATALOG,
  RESOLVERS,
  IDS,
  INSTALLABLE,
  ACCOUNT_BEARING,
  entryOf,
  entries,
  websiteOf,
  mentionOf,
  mentionKinds,
  workOf,
}
