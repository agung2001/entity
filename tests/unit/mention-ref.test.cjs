/**
 * `@` mentions: the grammar, the four sources, and the two failure modes.
 *
 * The heavy adapters are stubbed through the `deps` seam — the real Orca CLI and
 * MCP servers are exercised by hand, not in a unit test. What is asserted here
 * is the contract: what a mention resolves to, what a name error does versus an
 * empty search, and what the harness finally sees.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-mention-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const mention = require('../../electron/mention-ref.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `mention-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'chief-of-staff', harness: 'claude' })
  entities.scaffold({ workspace: created.id, name: 'py-agent', harness: 'claude' })
  const record = workspaces.open(created.id)
  fs.mkdirSync(path.join(record.path, 'artifacts', 'shots'), { recursive: true })
  fs.writeFileSync(path.join(record.path, 'artifacts', 'shots', 'login-shot.png'), 'x')
  fs.writeFileSync(path.join(record.path, 'artifacts', 'release-notes.md'), 'x')
  return record
}

function deps(overrides = {}) {
  return {
    orcaRepos: async () => [
      { displayName: 'One', path: '/tmp/orca/One' },
      { displayName: 'Maka', path: '/tmp/orca/maka-repo' },
    ],
    mcpCall: async ({ server, tool, arguments: args }) => {
      if (server === 'youtrack' && tool === 'search_issues') {
        assert.match(String(args.query), /login/)
        return {
          data: {
            issuesPage: [
              { id: 'AC-361', summary: 'Login loops', url: 'https://yt/issue/AC-361', customFields: { State: 'Open' } },
            ],
          },
        }
      }
      if (server === 'maka' && tool === 'maka_search_notes') {
        return { data: { results: [{ path: 'notes/plan.md', name: 'plan.md' }] } }
      }
      throw new Error(`unexpected tool ${server}/${tool}`)
    },
    runEntity: async (_record, entity, job) => ({ ok: true, answer: `${entity.name} handled "${job}"`, error: '' }),
    ...overrides,
  }
}

test('a message is segmented at every mention', () => {
  const { segments } = mention.parse(
    '@py-agent run the tests   @youtrack:AC:login bug  and summarise',
  )
  assert.deepEqual(segments.map((s) => s.kind), ['entity', 'youtrack'])
  assert.equal(segments[0].name, 'py-agent')
  assert.equal(segments[0].job, 'run the tests')
  assert.equal(segments[1].project, 'AC')
  assert.equal(segments[1].query, 'login bug  and summarise')
})

test('the typed forms split their fields, spaces allowed in the last one', () => {
  const cases = [
    ['@maka:one:plan for november', { kind: 'maka', vault: 'one', query: 'plan for november' }],
    ['@maka:plan', { kind: 'maka', vault: '', query: 'plan' }],
    ['@artifact:shot 2026', { kind: 'artifact', query: 'shot 2026' }],
    ['@orca:One:src/my file.ts', { kind: 'orca', project: 'One', file: 'src/my file.ts' }],
    ['@orca:One', { kind: 'orca', project: 'One', file: '' }],
    ['@youtrack:AC:re: login', { kind: 'youtrack', project: 'AC', query: 're: login' }],
    ['@youtrack:login bug', { kind: 'youtrack', project: '', query: 'login bug' }],
  ]
  for (const [text, expected] of cases) {
    const [segment] = mention.parse(text).segments
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(segment[key], value, `${text} → ${key}`)
    }
  }
})

test('a structured field stops at the first space, so a sentence is not a project', () => {
  const [orca] = mention.parse('@orca:maka tell me what this project is about?').segments
  assert.equal(orca.project, 'maka')
  assert.equal(orca.file, '')

  const [yt] = mention.parse('@youtrack:AC what is up').segments
  assert.equal(yt.project, 'AC')
  assert.equal(yt.query, 'what is up')

  /* a free query still takes the whole sentence */
  const [maka] = mention.parse('@maka:one:plan for november').segments
  assert.equal(maka.query, 'plan for november')
})

test('the block names the mention, not the sentence around it', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@orca:One tell me about it', { deps: deps() })
  assert.equal(out.mentions[0].token, '@orca:One')
  assert.match(out.text, /^- @orca:One → \/tmp\/orca\/One/m)
})

test('an email address is not a mention, and an unknown kind is left alone', () => {
  assert.deepEqual(mention.parse('ping me@example.com').segments, [])
  const [segment] = mention.parse('@nonsense:value here').segments
  assert.equal(segment.kind, 'unknown')
})

test('an artifact is resolved to artifact:// plus its absolute path', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@artifact:login shot', { deps: deps() })
  assert.match(out.text, /^Resolved mentions/)
  assert.match(out.text, /artifact:\/\/shots\/login-shot\.png/)
  assert.equal(out.mentions[0].kind, 'artifact')
  assert.equal(out.mentions[0].items.length, 1)
  /* the original words are still there, below the block */
  assert.match(out.text, /\n\n@artifact:login shot$/)
})

test('an orca project becomes a path, and a path cannot escape it', async () => {
  const record = workspace()
  const ok = await mention.rewrite(record, '@orca:One:src/app.ts', { deps: deps() })
  assert.match(ok.text, /\/tmp\/orca\/One\/src\/app\.ts/)

  /* a path that leaves the project it named is refused, not quietly resolved */
  await assert.rejects(
    () => mention.rewrite(record, '@orca:One:../../etc/passwd', { deps: deps() }),
    /points outside that project/,
  )
})

test('an unknown orca project is a hard error, before anything is sent', async () => {
  const record = workspace()
  await assert.rejects(
    () => mention.rewrite(record, '@orca:Nope:src/app.ts', { deps: deps() }),
    /not a project Orca knows/,
  )
})

test('youtrack scopes the search to the project it named', async () => {
  const record = workspace()
  const calls = []
  const out = await mention.rewrite(record, '@youtrack:AC:login bug', {
    deps: deps({
      mcpCall: async (args) => {
        calls.push(args)
        return { data: { issuesPage: [{ id: 'AC-361', summary: 'Login loops', url: 'https://yt/issue/AC-361' }] } }
      },
    }),
  })
  assert.equal(calls[0].server, 'youtrack')
  assert.equal(calls[0].tool, 'search_issues')
  assert.equal(calls[0].arguments.query, 'project: AC login bug')
  assert.match(out.text, /AC-361 — Login loops — AC · https:\/\/yt\/issue\/AC-361/)
})

test('an empty search is a note, not a blocked message', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@youtrack:AC:zzz', {
    deps: deps({ mcpCall: async () => ({ data: { issuesPage: [] } }) }),
  })
  assert.match(out.text, /@youtrack:AC:zzz → nothing found/)
  assert.match(out.text, /note: @youtrack:zzz found no issue/)
  /* the turn can still run */
  assert.equal(out.mentions.length, 1)
})

test('an entity mention runs that entity and injects its answer', async () => {
  const record = workspace()
  const seen = []
  const out = await mention.rewrite(record, '@py-agent fix the failing test', {
    deps: deps({
      runEntity: async (_record, entity, job) => {
        seen.push({ name: entity.name, job })
        return { ok: true, answer: 'the fixture was stale', error: '' }
      },
    }),
  })
  assert.deepEqual(seen, [{ name: 'py-agent', job: 'fix the failing test' }])
  assert.match(out.text, /\(entity py-agent\) → answer: the fixture was stale/)
  assert.equal(out.mentions[0].kind, 'entity')
  assert.equal(out.mentions[0].answer, 'the fixture was stale')
})

test('an unknown entity is a hard error', async () => {
  const record = workspace()
  await assert.rejects(
    () => mention.rewrite(record, '@ghost fix it', { deps: deps() }),
    /@ghost is not an entity in this workspace/,
  )
})

test('a failed entity run becomes a note instead of breaking the turn', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@py-agent fix it', {
    deps: deps({ runEntity: async () => ({ ok: false, answer: '', error: 'not signed in' }) }),
  })
  assert.match(out.text, /note: @py-agent failed: not signed in/)
})

test('at most two entity mentions run, the rest are noted', async () => {
  const record = workspace()
  let runs = 0
  const out = await mention.rewrite(record, '@py-agent one @py-agent two @py-agent three', {
    deps: deps({
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 2)
  assert.match(out.text, /@py-agent three skipped: at most 2 entity mentions per message/)
})

test('the block stops at eight rows and says how many it dropped', async () => {
  const record = workspace()
  const many = Array.from({ length: 12 }, (_, i) => `note-${i}`)
  const out = await mention.rewrite(record, many.map((name) => `@artifact:${name}`).join(' '), {
    deps: deps(),
  })
  /* nothing matches, so every mention is "nothing found" — one row each */
  const rows = out.text.split('\n').filter((line) => line.startsWith('- @artifact:'))
  assert.equal(rows.length, 8)
  assert.match(out.text, /\(\+4 more resolved\)/)
})

test('the composer gets pickable inserts for every kind', async () => {
  const record = workspace()

  const artifacts = await mention.search({ record, kind: 'artifact', fields: ['login shot'], deps: deps() })
  assert.equal(artifacts.items[0].insert, '@artifact:shots/login-shot.png')

  const projects = await mention.search({ record, kind: 'orca', fields: [''], deps: deps() })
  assert.deepEqual(projects.items.map((i) => i.insert), ['@orca:One', '@orca:Maka'])

  const files = await mention.search({ record, kind: 'orca', fields: ['One', 'app'], deps: deps() })
  assert.equal(files.items.length, 0) /* /tmp/orca/One has no files in the fixture */

  const issues = await mention.search({
    record,
    kind: 'youtrack',
    fields: ['AC', 'log'],
    deps: deps({
      mcpCall: async ({ tool, arguments: args }) => {
        assert.equal(tool, 'search_issues')
        assert.equal(args.query, 'project: AC log')
        return {
          data: {
            issuesPage: [
              { id: 'AC-361', summary: 'Login loops', url: 'https://yt/AC-361', customFields: { State: 'Open' } },
            ],
          },
        }
      },
    }),
  })
  assert.equal(issues.items[0].insert, '@youtrack:AC:AC-361')
  /* the row is the issue title and its state, not the raw id */
  assert.equal(issues.items[0].label, 'Login loops · Open')

  const vaults = await mention.search({
    record,
    kind: 'maka',
    fields: [''],
    deps: deps({
      mcpCall: async ({ tool }) => {
        assert.equal(tool, 'maka_list_vaults')
        return { data: { vaults: [{ name: 'one' }, { name: 'technical' }] } }
      },
    }),
  })
  assert.deepEqual(vaults.items.map((i) => i.insert), ['@maka:one:', '@maka:technical:'])
})

test('a youtrack project suggestion comes from find_projects', async () => {
  const record = workspace()
  const out = await mention.search({
    record,
    kind: 'youtrack',
    fields: ['MAKA'],
    deps: deps({
      mcpCall: async ({ tool, arguments: args }) => {
        assert.equal(tool, 'find_projects')
        assert.equal(args.query, 'MAKA')
        return { data: [{ key: 'MAKA', name: 'AI Maka' }] }
      },
    }),
  })
  assert.deepEqual(out.items.map((i) => i.insert), ['@youtrack:MAKA:'])
  /* the row shows the project name, which is what makes the key pickable */
  assert.equal(out.items[0].label, 'AI Maka · MAKA')
})

test('suggestions page: the second page differs and `more` follows the source', async () => {
  const record = workspace()
  const seen = []
  const call = async ({ tool, arguments: args }) => {
    seen.push({ tool, offset: args.offset, limit: args.limit })
    assert.equal(tool, 'search_issues')
    const first = args.offset === 0 ? 301 : 311
    return {
      data: {
        issuesPage: Array.from({ length: args.limit }, (_, i) => ({
          id: `AC-${first + i}`,
          summary: `Issue ${first + i}`,
          url: `https://yt/AC-${first + i}`,
          customFields: { State: 'Open' },
        })),
        hasNextPage: true,
      },
    }
  }
  const page1 = await mention.search({ record, kind: 'youtrack', fields: ['AC', 'x'], deps: deps({ mcpCall: call }) })
  const page2 = await mention.search({
    record,
    kind: 'youtrack',
    fields: ['AC', 'x'],
    offset: 10,
    deps: deps({ mcpCall: call }),
  })
  assert.equal(page1.items.length, 10)
  assert.equal(page1.items[0].insert, '@youtrack:AC:AC-301')
  assert.equal(page2.items[0].insert, '@youtrack:AC:AC-311')
  assert.equal(page1.more, true)
  /* the tool rejects more than 20 per page, so the request is clamped */
  assert.deepEqual(seen.map((s) => s.limit), [10, 10])
})

test('a vault with no query lists its notes instead of nothing', async () => {
  const record = workspace()
  const out = await mention.search({
    record,
    kind: 'maka',
    fields: ['kreasi-ai', ''],
    deps: deps({
      mcpCall: async ({ tool, arguments: args }) => {
        assert.equal(tool, 'maka_list_notes')
        assert.equal(args.vault, 'kreasi-ai')
        return { data: { notes: [{ path: 'notes/a.md', name: 'a.md' }] } }
      },
    }),
  })
  assert.equal(out.items[0].insert, '@maka:kreasi-ai:a.md')
})

test('a message with no mention is returned untouched', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, 'just a normal question', { deps: deps() })
  assert.equal(out.text, 'just a normal question')
  assert.deepEqual(out.mentions, [])
})

test('a double at marks a local mention and keeps the token', () => {
  const parsed = mention.parse('@@py-agent fix the build')
  assert.equal(parsed.segments[0].kind, 'entity')
  assert.equal(parsed.segments[0].name, 'py-agent')
  assert.equal(parsed.segments[0].local, true)
  assert.equal(mention.tokenOf(parsed.segments[0]), '@@py-agent')
})

test('localOnly leaves a single-at mention for the remote context', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@py-agent fix the build', { localOnly: true, deps: deps() })
  assert.equal(out.text, '@py-agent fix the build')
  assert.deepEqual(out.mentions, [])
})
