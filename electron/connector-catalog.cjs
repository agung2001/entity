/**
 * The connector catalog: the definitions Entity itself ships.
 *
 * A connector is one of two things, and the difference matters at the only moment
 * that counts — when a turn is built:
 *
 *   - **known** — Entity ships a resolver for it. `@github:owner/repo` becomes a
 *     real repository in the prompt, `@orca:project:path` a real path, `@youtrack:AC:bug`
 *     a real issue. The code was already in `mention-ref.cjs`; this file is where
 *     its *contract* lives, as data, so the roster and the composer cannot
 *     disagree about what a mention does.
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
const CATALOG = {
  orca: {
    label: 'Orca',
    kind: 'cli',
    binary: 'orca',
    summary: 'Projects and worktrees Orca already manages on this machine.',
    /* what `Test connection` runs, and what makes the row say `found` */
    verify: { argv: ['--version'], okExit: 0, then: ['repo', 'list', '--json'] },
    work: {
      mention: '@orca:',
      resolves: 'a project on this machine, and optionally one file inside it',
      syntax: '@orca:<project>[:<path>]',
      examples: ['@orca:entity', '@orca:entity:src/main.js'],
      returns: 'the project’s real path, or one file inside it — so the entity reads the file, not a guess',
      resolver: 'orca',
      needs: 'the Orca app on this machine',
      page: '',
      /* The long form: what to type, what it becomes, and why that is useful.
         Rendered on the page, so a person learns the syntax without reading code. */
      how: [
        'Orca keeps a project for every repository it manages, with a real path on this machine.',
        'Naming a project puts that path in the prompt, so the entity opens the right folder instead of guessing one.',
        'Naming a file inside it narrows the turn to that one file — useful when you already know where the bug is.',
        'The entity then reads the file with its own tools; Entity only tells it where the file is.',
      ],
      samples: [
        { code: '@orca:entity', then: 'the entity project’s path goes into the prompt' },
        { code: '@orca:entity:src/main.js', then: 'that one file, so the turn starts at the bug' },
      ],
    },
  },
  github: {
    label: 'GitHub CLI',
    kind: 'cli',
    binary: 'gh',
    summary: 'Repositories and searches through the gh CLI already signed in here.',
    verify: { argv: ['auth', 'status'], okExit: 0, then: ['--version'] },
    work: {
      mention: '@github:',
      resolves: 'a repository, or a search across your repositories',
      syntax: '@github:<owner/repo> | <query>',
      examples: ['@github:artistudio/entity', '@github:connector'],
      returns: 'the repository itself — full name, URL, default branch, last push',
      resolver: 'github',
      needs: 'gh signed in on this machine',
      page: '',
      how: [
        'A full name (`owner/repo`) is one repository; anything without a slash is a search across the repositories your token can see.',
        'The repository comes back with its URL, default branch and last push, so the entity knows what it is looking at before it runs anything.',
        'A search returns the matching repositories, capped so a broad word cannot flood the prompt.',
        'Entity does not wrap `gh` — the entity calls it itself when it needs one of its verbs.',
      ],
      samples: [
        { code: '@github:artistudio/entity', then: 'one repository, with its URL and default branch' },
        { code: '@github:connectors', then: 'every repository matching that word' },
      ],
    },
  },
  youtrack: {
    label: 'YouTrack',
    kind: 'mcp',
    verify: null,
    summary: 'Issues, read through this workspace’s MCP pool.',
    work: {
      mention: '@youtrack:',
      resolves: 'issues, scoped to a project key or searched across the workspace',
      syntax: '@youtrack:[<PROJECT>:]<query>',
      examples: ['@youtrack:AC:login bug', '@youtrack:flaky test'],
      returns: 'the matching issues — id, summary, state — read through the MCP pool',
      resolver: 'youtrack',
      needs: 'a token in this workspace’s mcp.json',
      page: 'mcp.json',
      how: [
        'A short upper-case word before the colon is a project key; the rest is the query.',
        'Without a key the whole text is searched across the issues your token can read.',
        'The issues come back as id, summary and state — the same rows the panel on the dashboard would draw.',
        'This goes through the workspace MCP pool, so it stops working the moment the token does.',
      ],
      samples: [
        { code: '@youtrack:AC:login bug', then: 'issues in AC whose text matches “login bug”' },
        { code: '@youtrack:flaky test', then: 'that search across every readable project' },
      ],
    },
  },
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
     Tailscale authenticates nothing and stores no token. There is one machine
     fact to read (`tailscale status --json`), one thing to gate (this repo's own
     `npm run dev:lan`) and one thing to hand over (the phone's address, as a QR).

     **No `work` block, so no mention.** `@tailscale:` would have nothing to put in
     a prompt that the turn cannot read itself; what this connector produces is an
     address a *person* opens on a phone, which is not a prompt. The page it opens
     is its own component (`TailscalePanel.vue`), not the generic cli cards.

     `verify` is the whole of what this app does to the daemon: `tailscale version`
     proves the binary answers and prints the build, and no verb ever writes. */
  tailscale: {
    label: 'Tailscale',
    kind: 'cli',
    binary: 'tailscale',
    website: 'https://tailscale.com',
    summary: 'Open this app on your phone by its tailnet name.',
    verify: { argv: ['version'], okExit: 0 },
  },

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
  'open-design': {
    label: 'Open Design',
    kind: 'mcp',
    verify: null,
    summary: 'Artifacts, files and searches from the design workspace’s own MCP server.',
    website: 'https://open-design.ai/',
    launcher: 'opendesign/bin/opendesign-mcp.sh',
    timeoutMs: 90_000,
    readOnlyTools: ['get_active_context', 'get_artifact', 'get_file', 'search_files', 'list_files'],
    work: {
      mention: '@opendesign:',
      resolves: 'an artifact, one file, or a search across the design workspace',
      syntax: '@opendesign:<artifact|file|search>:<query>',
      examples: ['@opendesign:artifact:onboarding', '@opendesign:search:nav bar'],
      returns: 'the matching artifacts and paths, read through this workspace’s MCP pool',
      resolver: 'opendesign',
      needs: 'the Open Design server installed into this workspace',
      page: 'mcp.json',
      how: [
        'The first segment is what to read — `artifact`, `file` or `search` — and the rest of the line is the query, which may hold spaces.',
        '`artifact` and `file` name one thing directly; `search` looks across the design workspace and lists what matched.',
        'Every read is one of the server’s own read tools. `delete_file` and `delete_project` exist in the pool and are never offered by a mention, so a typo cannot remove anything.',
        'The server runs from this workspace’s `skills/opendesign/`, which travels with the workspace — the same mention works on a teammate’s machine.',
        'Its first start downloads and builds, so a cold run gets a 90-second deadline; after that the pool answers immediately.',
      ],
      samples: [
        { code: '@opendesign:artifact:onboarding', then: 'that artifact’s path and content summary' },
        { code: '@opendesign:search:nav bar', then: 'every file the server matches for those words' },
      ],
    },
  },

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
  gmail: {
    label: 'Gmail',
    kind: 'rest',
    oauth: true,
    verify: null,
    summary: 'Mail an agent may read.',
    work: {
      mention: '@gmail:',
      resolves: 'messages in the mailbox you name, or in every connected mailbox with `all`',
      syntax: '@gmail:<account|all>:<query>',
      examples: ['@gmail:all:from:stripe', '@gmail:work:invoice march'],
      returns: 'the matching messages — subject, sender, date, and which mailbox they came from',
      resolver: 'gmail',
      needs: 'one signed-in Gmail account on this machine',
      page: '',
      how: [
        'The scope comes first, and it is required: `@gmail:work:` is one mailbox, `@gmail:all:` is every usable one.',
        'The account is the localpart of the address, as the card shows it — `@gmail:avery:` for `avery@example.test`.',
        'There is no implicit “no scope means all”: that is what made the first word ambiguous. Write `all` and mean it.',
        'The query is the rest of that line, so it may hold spaces and Gmail\'s own operators (`from:`, `has:attachment`).',
        'Wrap words in quotes to search them as one phrase — `"invoice march"` instead of two loose words. Picking a result inserts the phrase for you.',
        'Put the instruction on the next line — the query stops at the newline, so it is not sent to Google as search text.',
        'A word that is not one of your accounts is an error, not a search — so a typo cannot quietly read the wrong mailbox.',
        'An account whose sign-in expired is skipped, not failed — the note names it.',
      ],
      samples: [
        { code: '@gmail:avery:from:stripe', then: 'Stripe mail in that one mailbox' },
        { code: '@gmail:all:invoice march', then: 'every connected mailbox, and the note says how many answered' },
      ],
    },
  },
  'google-drive': {
    label: 'Google Drive',
    kind: 'rest',
    oauth: true,
    verify: null,
    summary: 'Files an agent may open.',
    work: {
      mention: '@drive:',
      resolves: 'files in the Drive you name, or in every connected Drive with `all`',
      syntax: '@drive:<account|all>:<query>',
      examples: ['@drive:all:Q3 report', '@drive:work:budget'],
      returns: 'the matching files — name, type, modified date, and a link',
      resolver: 'drive',
      needs: 'one signed-in Drive account on this machine',
      page: '',
      how: [
        'The scope comes first and is required: `@drive:work:` is that account\'s Drive, `@drive:all:` is every connected one.',
        'The query is the rest of the line, so it may hold spaces; the instruction goes on the next line.',
        'Quotes make a phrase: `"Q3 report"` searches that sequence rather than the words separately.',
        'Plain words are ANDed across file names and contents — `Q3 report bergstrom` needs all three.',
        'A quoted phrase stays a phrase: `"Q3 report"` searches that sequence, not the two words separately.',
        'Drive\'s own query language also works: `mimeType = \'application/pdf\'`, `modifiedTime > 2025-01-01`, `trashed = false`.',
        'Folder names are matched as part of a file\'s path, not searched on their own.',
        'A word that is not one of your accounts is an error, not a search.',
        'A read scope only reaches files this app created; full access reaches the whole Drive.',
      ],
      samples: [
        { code: '@drive:work:Q3 report', then: 'files needing all three words, in that one Drive' },
        { code: '@drive:all:"Q3 report"', then: 'every connected Drive, matching that exact phrase' },
      ],
    },
  },
  youtube: {
    label: 'YouTube',
    kind: 'rest',
    oauth: true,
    verify: null,
    summary: 'Channels and captions.',
    work: {
      mention: '@youtube:',
      resolves: 'videos in the account you name, or a search as every connected account with `all`',
      syntax: '@youtube:<account|all>:<query>',
      examples: ['@youtube:studio:captions', '@youtube:all:deploy pipeline'],
      returns: 'the matching videos — title, channel, published date, and a link',
      resolver: 'youtube',
      needs: 'one signed-in YouTube account on this machine',
      page: '',
      how: [
        'The scope comes first and is required, and decides whose grant the call runs as.',
        'That matters most for uploads and private videos, where the channel is part of the answer.',
        '`@youtube:all:` searches as every connected account in turn.',
        'A read tier lists videos; the write and full tiers are what allow uploading.',
      ],
      samples: [
        { code: '@youtube:studio:captions', then: 'that account\'s own channel data' },
        { code: '@youtube:studio:deploy pipeline', then: 'videos matching that phrase, as that account' },
      ],
    },
  },
  /* ── YouTube **Studio**: the channel's own data, not a public search ──────
     A separate connector from `youtube` on purpose. `@youtube:` searches what
     anyone can see; this reads the things only the owner can — views, watch time,
     subscriber movement, traffic sources, revenue and the comments waiting for a
     reply. They are different grants, so they are different cards.

     Every answer is computed from the YouTube Data API and the Analytics API, and
     the *shapes* follow what YouTube Studio puts on screen so the numbers are the
     ones a person already trusts. */
  'youtube-studio': {
    label: 'YouTube Studio',
    kind: 'rest',
    oauth: true,
    verify: null,
    summary: 'Views, watch time, subscribers, revenue and comments from your own channel.',
    work: {
      mention: '@youtube-studio:',
      resolves: "the channel's own analytics, catalogue or comment threads",
      syntax: '@youtube-studio:<account>[:<channel>]:<what> [<days>]',
      examples: [
        '@youtube-studio:avery:summary 30',
        '@youtube-studio:avery:main-channel:traffic 90',
        '@youtube-studio:avery:unreplied',
      ],
      returns:
        'the numbers Studio shows — views, watch time, subscribers, revenue — or the videos, comments and traffic sources behind them',
      resolver: 'youtube-studio',
      needs: 'a signed-in channel owner account with the analytics scope',
      page: '',
      how: [
        'The account segment comes first, as every account-bearing connector does — it is the Google login.',
        '**The channel comes next and is optional**, because one Google login can manage several channels (a brand account, a network, a client\'s). Leave it out when the account has only one.',
        'The channel is recognised by not being a keyword, so `summary` is a thing to read and `main-channel` is a channel. A title, a slug of it, or the raw `UC…` id all work.',
        'Then *what*: `summary`, `videos`, `video`, `traffic`, `subscribers`, `comments`, `unreplied`, `playlists`, `revenue` or `search`.',
        'An optional trailing number is the window in days, defaulting to 28 — Studio\'s own default.',
        '`summary` is the Studio overview: the four KPI tiles, their change against the previous equally long window, and the top videos.',
        '`traffic` is the traffic-source breakdown; `subscribers` is net growth by day.',
        '`unreplied` is the newest comments with no reply — the one thing Studio buries two clicks deep.',
        'Revenue needs the monetary analytics scope; without it the row says so instead of printing zero.',
        'Every window is computed against the report\'s own end date, never the clock, so an old answer cannot look fresh.',
      ],
      samples: [
        { code: '@youtube-studio:avery:summary 28', then: 'the four Studio KPIs, their change, and the top videos' },
        { code: '@youtube-studio:avery:main-channel:traffic 90', then: 'where those 90 days of views came from' },
        { code: '@youtube-studio:avery:unreplied', then: 'the comments with no reply yet' },
      ],
    },
  },

  /* ── a connector that signs in but has no account list ────────────────────
     Habitify is `rest` + `oauth`, one account per install, and it reads its data
     through the provider's own **remote MCP server** rather than a REST endpoint.
     So it is account-bearing for the grant and mention-resolved for the read: the
     resolver dials `https://mcp.habitify.me/mcp` with the stored access token.
     `provider: 'habitify'` is what points it at its own provider row — including
     the dynamic client registration that mints a client id for the loopback port
     this run actually listens on. */
  habitify: {
    label: 'Habitify',
    kind: 'rest',
    oauth: true,
    provider: 'habitify',
    website: 'https://habitify.me',
    summary: 'The habits a day was scheduled, and whether they were done.',
    verify: null,
    /* The dashboard tab gates on this block, the same way the `opendesign` entry's
       does: `page` is empty because a `rest` row binds through a consent, not an
       `mcp.json`, and `documented` already leaves a non-MCP kind with no page. */
    work: {
      mention: '@habitify:',
      resolves: 'a day, and optionally one habit within that day',
      syntax: '@habitify:[<habit>:]<date|today|yesterday>',
      examples: ['@habitify:today', '@habitify:Meditate:yesterday'],
      returns: 'the habit name, its status word and the day each row was scheduled on',
      resolver: 'habitify',
      needs: 'a signed-in Habitify account on this machine',
      page: '',
      how: [
        'The date is `today`, `yesterday` or `YYYY-MM-DD` — nothing is guessed, so a malformed date is an error rather than today.',
        'A habit name before the colon narrows the day to that habit; an exact name wins, a single prefix match is accepted, and two prefix matches are refused instead of picking one.',
        'The day comes back as it was scheduled: `completed`, `skipped`, `failed`, or `none` for a habit that was due and not logged.',
        '**Read-only.** The only tool this app calls is `list-habits-by-date`; nothing here writes to Habitify, so completing, skipping or logging a habit cannot happen from a turn or from the Dashboard.',
        'The read goes through Habitify’s MCP server with the account’s own access token, refreshed on this machine and named by its localpart — no address appears in these rows.',
      ],
      samples: [
        { code: '@habitify:today', then: 'every habit scheduled today, with its status' },
        { code: '@habitify:Meditate:yesterday', then: 'that one habit, yesterday' },
      ],
    },
  },

  /* ── a paste-once credential ─────────────────────────────────────────────
     `credential: 'token'` is the other way a `rest` row authenticates: one opaque
     API key, pasted once, that never refreshes. There is no consent screen and no
     per-account row — one shared credential, many members — so this entry carries
     no `oauth` flag and the sheet lands it with no tier.

     Its workspace id, IANA timezone and member map are **workspace** state, kept on
     the row's `fields` in `connectors.json`: none of them is a secret, and a report
     computed in the wrong zone is the bug the week math exists to avoid. */
  clockify: {
    label: 'Clockify',
    kind: 'rest',
    credential: 'token',
    website: 'https://clockify.me',
    summary: 'Tracked hours per project and per person.',
    verify: null,
    work: {
      mention: '@clockify:',
      resolves: 'the hours one project or one person logged in a week',
      syntax: '@clockify:<project|login>:<monday|this week>',
      examples: ['@clockify:design-system:this week', '@clockify:avery:2026-03-02'],
      returns: 'the week’s hours — the project and its members, or one member across every project, then the total and a day-by-day series',
      resolver: 'clockify',
      needs: 'an API key on this machine, and this workspace’s Clockify workspace id',
      page: 'connectors.json',
      how: [
        'The first segment is a project name or a member login — one of the two, never both. A word that is neither is an error, so a typo cannot quietly report on the wrong thing.',
        'The second segment is the week: a Monday written `YYYY-MM-DD`, or `this week`. Leave it out and this week is read, in the workspace’s own timezone.',
        'A week that is not a real Monday, is in the future, or is older than 2020-01-06 is refused — a silently corrected range would answer about a week nobody asked for.',
        'The key is pasted once on the connector’s page and checked there against this workspace before it is saved. It never refreshes, and no page ever reads it back.',
        'Clockify answers 401 for both a bad key and an unknown workspace id, so a rejection names both possibilities rather than blaming the key.',
        'Only the reports API is read: no user list is fetched, so no email address ever reaches a turn.',
      ],
      samples: [
        { code: '@clockify:design-system:this week', then: 'that project’s hours, its members, and the week total' },
        { code: '@clockify:avery:2026-03-02', then: 'one member’s week, split by project' },
      ],
    },
  },

  x: {
    label: 'X',
    kind: 'rest',
    oauth: true,
    /* Named because it is the one account-bearing entry that does not ride Google.
       With `providerOf` derived from this table, a missing line here silently sent
       X's consent screen to Google's endpoints. */
    provider: 'x',
    verify: null,
    summary: 'Posts and threads an agent may read.',
    work: {
      mention: '@x:',
      resolves: 'recent posts matching a search, retweets excluded',
      syntax: '@x:<account|all>:<query>',
      examples: ['@x:main:from:stripe', '@x:all:release notes'],
      returns: 'the matching posts — text, date, and a link',
      resolver: 'x',
      needs: 'an X developer app (OAuth 2.0, PKCE) and one signed-in account on this machine',
      page: '',
      how: [
        'The scope comes first and is required, and decides whose grant the call runs as.',
        'X signs in through its own OAuth 2.0 app with PKCE — a public client, so there is a client id and no secret.',
        'X requires the callback URL to be registered exactly, and the port is picked per connection; if the sign-in is refused for a callback mismatch, that is why.',
        'The search covers recent posts only — about the last seven days, not the full archive.',
        'Retweets are excluded so the rows are original posts.',
        '`@x:all:` runs the search as every connected account in turn.',
      ],
      samples: [
        { code: '@x:main:from:stripe', then: 'recent posts, as that account' },
        { code: '@x:main:release notes', then: 'recent posts matching both words' },
      ],
    },
  },

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
  'gmail', 'drive', 'youtube', 'youtube-studio', 'x',
  'clockify', 'habitify', 'opendesign',
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
