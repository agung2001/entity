/**
 * The connector catalog is a contract, so it gets a test.
 *
 * The failure this exists for: a catalog entry names a `resolver` that
 * `mention-ref` does not answer. Nothing would throw — the mention would simply
 * resolve to silence, and the page would keep documenting a syntax that does
 * nothing. A typo has to be a red test, not a quiet downgrade.
 */
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const catalog = require('../../electron/connector-catalog.cjs')
const mentionRef = require('../../electron/mention-ref.cjs')

test('every resolver a connector documents is one the parser actually answers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron', 'mention-ref.cjs'), 'utf8')
  for (const [id, entry] of Object.entries(catalog.CATALOG)) {
    const resolver = entry.work?.resolver
    if (!resolver) continue
    assert.ok(
      catalog.RESOLVERS.has(resolver),
      `${id} names resolver "${resolver}", which is not in RESOLVERS`,
    )
    /* The table and the parser are one thing: every advertised head must be a
       head `parseMention` recognises, or the composer would offer a mention that
       parses as `unknown`. */
    const head = String(entry.work.mention || '').replace(/^@/, '').replace(/:$/, '')
    const parsed = mentionRef.parseMention(`@${head}:probe`)
    assert.equal(
      parsed.kind,
      resolver,
      `@${head}: parses as "${parsed.kind}", not "${resolver}" — the page and the parser disagree`,
    )
    assert.match(source, new RegExp(`'${head}'|"${head}"`), `${head} is not mentioned in mention-ref`)
  }
})

test('a connector with no resolver offers no mention', () => {
  /* A custom connector has no shipped resolver, so `@id:` must not be on offer —
     that is the whole "known vs pass-through" split, enforced in one place. */
  assert.equal(catalog.mentionOf('a-connector-nobody-ships'), '')
  assert.equal(catalog.mentionOf('thysql'), '')
  for (const kind of catalog.mentionKinds()) {
    assert.ok(kind.resolver, `${kind.name} is offered with no resolver`)
    assert.equal(kind.name, catalog.workOf(kind.id).mention)
  }
})

test('the shipped connectors are the three the integration store also tracks', () => {
  /* `integrations-store` keeps a machine-wide switch for exactly these three. If
     the catalog grows an id the store does not know, `mention.sources` would gate
     it against a switch that does not exist. */
  assert.deepEqual([...catalog.IDS].sort(), ['github', 'orca', 'youtrack'])
  for (const id of catalog.IDS) assert.ok(catalog.CATALOG[id], `${id} vanished from the catalog`)
  /* internal parsers are not installable connectors */
  assert.ok(!catalog.INSTALLABLE.includes('artifact'))
  assert.ok(!catalog.INSTALLABLE.includes('thread'))
})

test('a mention is offered only where its connector is installed', () => {
  /* The gate the composer reads. Without a workspace the catalogue answers (a
     test, the palette); with one, an uninstalled connector contributes nothing —
     which is what stops `@orca:` being offered on a workspace that uninstalled
     it, and what makes mentions workspace-scoped instead of machine-wide. */
  const store = require('../../electron/connector-store.cjs')
  const catalogNames = catalog.mentionKinds().map((entry) => entry.name)
  assert.ok(catalogNames.length > 0, 'the catalogue offers nothing at all')

  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'entity-cxn-gate-'))
  const before = process.env.ENTITY_HOME
  process.env.ENTITY_HOME = profile
  try {
    /* a fresh module graph so the stores read the scratch profile */
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}electron${path.sep}`)) delete require.cache[key]
    }
    const workspaces = require('../../electron/workspace-store.cjs')
    const fresh = require('../../electron/connector-store.cjs')
    const created = workspaces.create({ label: 'demo-workspace' })

    const empty = fresh.mentionKinds({ workspace: created.id })
    assert.deepEqual(
      empty.map((entry) => entry.id).sort(),
      ['artifact', 'thread'],
      'nothing is installed, so only the internal parsers are offered',
    )
    fresh.install({ workspace: created.id, id: 'orca' })
    assert.ok(
      fresh.mentionKinds({ workspace: created.id }).some((entry) => entry.id === 'orca'),
      'installing a connector must make its mention available',
    )
    fresh.uninstall({ workspace: created.id, id: 'orca' })
    assert.ok(
      !fresh.mentionKinds({ workspace: created.id }).some((entry) => entry.id === 'orca'),
      'uninstalling must take the mention away',
    )
  } finally {
    if (before === undefined) delete process.env.ENTITY_HOME
    else process.env.ENTITY_HOME = before
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('every documented example uses the syntax it is documented under', () => {
  for (const [id, entry] of Object.entries(catalog.CATALOG)) {
    const mention = entry.work?.mention || ''
    if (!mention) continue
    for (const example of entry.work.examples || []) {
      assert.ok(
        example.startsWith(mention),
        `${id}: example "${example}" does not start with ${mention}`,
      )
      const parsed = mentionRef.parseMention(example)
      assert.equal(
        parsed.kind,
        entry.work.resolver,
        `${id}: "${example}" parses as "${parsed.kind}"`,
      )
    }
  }
})

/**
 * The composer splits a typed mention into fields before it asks for suggestions,
 * and its `FIELD_GROUPS` decides **where**. When that map and the resolver disagree,
 * the menu shows nothing for a valid mention — twice now: `@gmail:muh` and
 * `@youtube-studio:<acct>:<channel>:s`.
 *
 * Rejoining the fields would hide the bug (a rejoin always reconstructs the same
 * string), so this asserts the thing that actually matters: **the resolver receives
 * at most two fields**, and the second carries the rest intact. That is the
 * contract every account-bearing preview branch is written against.
 */
test('every account-bearing kind is grouped so its preview sees two fields at most', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'components', 'SlashComposer.vue'), 'utf8')
  const map = /const FIELD_GROUPS = \{([^}]*)\}/.exec(source)
  assert.ok(map, 'FIELD_GROUPS is missing from the composer')

  for (const [kind, entry] of Object.entries(catalog.CATALOG)) {
    const resolver = entry.work?.resolver
    if (!resolver) continue
    /* Only the `<account>:<query>` shapes go through the grouping. */
    const syntax = String(entry.work.syntax || '')
    if (!syntax.includes('<account')) continue

    /* The map is keyed by the **mention head**, not the connector id: `@drive:`
       carries `google-drive`'s accounts, and the catalog keys it `google-drive`. */
    const head = String(entry.work.mention || '').replace(/^@/, '').replace(/:$/, '')
    const groups = Number(new RegExp(`'?${head}'?:\\s*(\\d+)`).exec(map[1])?.[1] ?? 0)
    assert.equal(
      groups,
      2,
      `@${head}: is a two-segment mention but FIELD_GROUPS gives it ${groups || 'no'} grouping, so the preview would see the query split across several fields`,
    )

    /* The second field must carry the whole tail — colons included — because the
       preview branches split it themselves. A three-segment kind proves it. */
    const typed =
      kind === 'youtube-studio' ? 'account:channel:summary 7' : 'account:from:stripe'
    const parts = typed.split(':')
    const fields = [...parts.slice(0, groups - 1), parts.slice(groups - 1).join(':')]
    assert.equal(fields.length, 2, `${kind}: expected two fields, got ${JSON.stringify(fields)}`)
    assert.equal(
      fields[1],
      typed.slice(typed.indexOf(':') + 1),
      `${kind}: the second field lost part of the query (${JSON.stringify(fields)})`,
    )
  }
})
