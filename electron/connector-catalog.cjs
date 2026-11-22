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
const RESOLVERS = new Set(['orca', 'github', 'youtrack', 'maka', 'artifact', 'thread'])

/** The shipped definitions a person can install. Internal ones are not connectors. */
const INSTALLABLE = Object.entries(CATALOG)
  .filter(([, entry]) => entry.kind !== 'internal')
  .map(([id]) => id)

const entryOf = (id) => CATALOG[String(id || '').toLowerCase()] || null

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

/** The documentation block, rendered as it is on the connector's page. */
function workOf(id) {
  const entry = entryOf(id)
  if (!entry) return null
  return {
    ...entry.work,
    how: entry.work.how || [],
    samples: entry.work.samples || [],
    label: entry.label,
    kind: entry.kind,
    verified: Boolean(entry.verify),
    documented: entry.kind === 'mcp' ? entry.work.page || 'mcp.json' : '',
  }
}

module.exports = {
  SCHEMA,
  CATALOG,
  RESOLVERS,
  IDS,
  INSTALLABLE,
  entryOf,
  mentionOf,
  mentionKinds,
  workOf,
}
