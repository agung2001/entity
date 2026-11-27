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

/* The Orca fixture is resolved with `path.resolve`, so it must be an absolute
   path that survives the round trip on every platform. */
const ORCA_ROOT = path.join(os.tmpdir(), 'orca')
const ORCA_ONE = path.join(ORCA_ROOT, 'One')

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const mention = require('../../electron/mention-ref.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `mention-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'chief-of-staff', harness: 'claude' })
  entities.scaffold({ workspace: created.id, name: 'py-agent', harness: 'claude' })
  const record = workspaces.open(created.id)
  /* one workspace skill, so a delegated `/workspace:x` job has something real */
  fs.mkdirSync(path.join(record.path, 'skills', 'alpha'), { recursive: true })
  fs.writeFileSync(
    path.join(record.path, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: A fixture skill\n---\n\nDo the alpha thing.\n',
  )
  fs.mkdirSync(path.join(record.path, 'artifacts', 'shots'), { recursive: true })
  fs.writeFileSync(path.join(record.path, 'artifacts', 'shots', 'login-shot.png'), 'x')
  fs.writeFileSync(path.join(record.path, 'artifacts', 'release-notes.md'), 'x')
  return record
}

function deps(overrides = {}) {
  return {
    orcaRepos: async () => [
      { displayName: 'One', path: ORCA_ONE },
      { displayName: 'Maka', path: path.join(ORCA_ROOT, 'maka-repo') },
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
  assert.ok(out.text.includes(`- @orca:One → ${ORCA_ONE} — One`))
})

test('an email address is not a mention, and an unknown kind is left alone', () => {
  assert.deepEqual(mention.parse('ping me@example.com').segments, [])
  const [segment] = mention.parse('@nonsense:value here').segments
  assert.equal(segment.kind, 'unknown')
})

test('a colon inside the job does not turn an entity into a namespace', () => {
  const job =
    'Desk /Users/me/repo (branch main, clean). One task: implement the plan. Do not commit.'
  const [segment] = mention.parse(`@coder ${job}`).segments
  assert.equal(segment.kind, 'entity')
  assert.equal(segment.name, 'coder')
  assert.equal(segment.job, job)
})

test('a colon in the sentence is prose, not the start of a file field', async () => {
  /* this exact message was refused with "@orca:entity this is how I usually
     develop features quickly is not a project Orca knows" — the colon inside
     `https://` made the whole sentence a project name */
  const [orca] = mention.parse(
    '@orca:entity this is how I develop features quickly :\nhttp://localhost:5183/x?y=z\n\ncheck it',
  ).segments
  assert.equal(orca.project, 'entity')
  assert.equal(orca.file, '')

  /* and a real file field still wins when its colon touches the name */
  const [file] = mention.parse('@orca:One:src/my file.ts').segments
  assert.equal(file.project, 'One')
  assert.equal(file.file, 'src/my file.ts')

  /* the same shape, resolved for real */
  const record = workspace()
  const out = await mention.rewrite(
    record,
    '@orca:One this is my workflow : https://example.com/a?b=c',
    { deps: deps() },
  )
  assert.equal(out.mentions[0].items[0].label, path.join(ORCA_ONE))
})

test('an unknown namespace is a hard error, not silently dropped', async () => {
  const record = workspace()
  await assert.rejects(
    () => mention.rewrite(record, '@nonsense:value here', { deps: deps() }),
    /is not a mention kind/,
  )
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
  assert.ok(ok.text.includes(path.join(ORCA_ONE, 'src', 'app.ts')))

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

test('an entity mention keeps the sub-run trace and execution', async () => {
  const record = workspace()
  const execution = {
    harness: 'claude',
    model: 'claude-test',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    ms: 1000,
    status: 'ok',
  }
  const steps = [
    { seq: 1, type: 'tool_use', tool: 'bash', callId: 'c1', input: { command: 'echo hi' } },
    { seq: 2, type: 'tool_result', tool: 'bash', callId: 'c1', output: 'hi' },
  ]
  const out = await mention.rewrite(record, '@py-agent run it', {
    deps: deps({
      runEntity: async () => ({ ok: true, answer: 'ran it', error: '', steps, execution }),
    }),
  })
  assert.equal(out.mentions[0].status, 'ok')
  assert.equal(out.mentions[0].job, 'run it')
  assert.deepEqual(out.mentions[0].steps, steps)
  assert.equal(out.mentions[0].execution.harness, 'claude')
  assert.equal(out.mentions[0].execution.ms, 1000)
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

test('spawn N runs one instruction N times, in parallel, one session each', async () => {
  const record = workspace()
  const jobs = []
  const out = await mention.rewrite(record, 'spawn 3 @py-agent write a poem', {
    deps: deps({
      runEntity: async (_record, entity, job) => {
        jobs.push(job)
        return { ok: true, answer: `answer ${jobs.length}`, error: '' }
      },
    }),
  })
  assert.equal(jobs.length, 3)
  /* each run is told which one it is, or three answers to one sentence repeat */
  assert.match(jobs[0], /^write a poem\n\n\(Run 1 of 3 /)
  assert.match(jobs[2], /^write a poem\n\n\(Run 3 of 3 /)
  assert.equal(out.mentions.length, 3)
  assert.deepEqual(out.mentions.map((row) => row.share), ['1/3', '2/3', '3/3'])
  /* the person's own words stay on the mention, not the note */
  assert.equal(out.mentions[1].job, 'write a poem')
})

test('a spawn introduced by a sentence is still a fan-out', async () => {
  const record = workspace()
  const jobs = []
  /* The prefix used to be anchored to the first word of the message, so a
     request written the way people write it — the ask inside a sentence — was
     demoted to ONE ordinary run: four cards asked for, one card shown, and no
     error to say so. */
  const out = await mention.rewrite(
    record,
    'By following the settings pages.\n\n' +
      'I want to improve them.\n\n' +
      "let's spawn 4 @py-agent To work on the design of each page.",
    {
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'ok', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 4)
  assert.deepEqual(out.mentions.map((row) => row.share), ['1/4', '2/4', '3/4', '4/4'])
  /* the job is the person's words, not the sentence that introduced them */
  assert.equal(jobs[0], 'To work on the design of each page.\n\n(Run 1 of 4 of this same instruction. Produce a distinct result — do not coordinate with the other runs, which you cannot see.)')
  assert.doesNotMatch(out.text, /skipped/)
})

test('a spawn after a mention is that job\'s own text, not a fan-out', () => {
  /* `@py-agent run spawn 2 @py-agent` would otherwise start a second run
     nobody asked for: the prefix is read in the opening prose only. */
  const { segments } = mention.parse('ask @py-agent to spawn 3 @designer')
  assert.deepEqual(segments.map((s) => s.kind), ['entity', 'entity'])
  assert.equal(segments[0].job, 'to spawn 3')
})

test('a bracketed row list is the list, not the first mention', async () => {
  const record = workspace()
  const rows = []
  /* `spawn per [@a, @b] @entity` is still a prefix: the `@` rows inside the
     brackets are rows, so the opening prose has to look past them. */
  const out = await mention.rewrite(record, "let's spawn per [one, two] @py-agent improve", {
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        rows.push(job)
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(
    out.mentions.filter((row) => row.kind === 'entity').map((row) => row.row),
    ['one', 'two'],
  )
})

test('spawn 3 is the cap it wrote, above the two-mention rule', async () => {
  const record = workspace()
  let runs = 0
  const out = await mention.rewrite(record, 'spawn 3 @py-agent do it', {
    deps: deps({
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 3)
  assert.doesNotMatch(out.text, /skipped/)
})

test('spawn is capped, and saying more is a hard error before anything runs', async () => {
  const record = workspace()
  let runs = 0
  await assert.rejects(
    () =>
      mention.rewrite(record, 'spawn 9 @py-agent do it', {
        deps: deps({
          runEntity: async () => {
            runs += 1
            return { ok: true, answer: 'ok', error: '' }
          },
        }),
      }),
    /spawn 9 is more than 5 runs/,
  )
  assert.equal(runs, 0)
})

test('“spawn 3 tasks in the backlog” is prose, not a fan-out', async () => {
  const record = workspace()
  let runs = 0
  const out = await mention.rewrite(record, 'spawn 3 tasks in the backlog', {
    deps: deps({
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 0)
  assert.deepEqual(out.mentions, [])
  assert.equal(out.text, 'spawn 3 tasks in the backlog')
})

test('a comma after the name is not part of the job', async () => {
  const record = workspace()
  const seen = []
  await mention.rewrite(record, '@py-agent, fix the build', {
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        seen.push(job)
        return { ok: true, answer: 'fixed', error: '' }
      },
    }),
  })
  assert.deepEqual(seen, ['fix the build'])
})

test('spawn per runs once for every row the list resolved', async () => {
  const record = workspace()
  const seen = []
  const out = await mention.rewrite(
    record,
    'spawn per @youtrack:AC:login bug @py-agent fix it',
    {
      deps: deps({
        mcpCall: async ({ tool, arguments: args }) => {
          assert.equal(tool, 'search_issues')
          /* the fan-out asks for as many rows as it may run */
          assert.equal(args.limit, 12)
          return {
            data: {
              issuesPage: [
                { id: 'AC-1', summary: 'First', url: 'https://yt/AC-1', customFields: { State: 'Open' } },
                { id: 'AC-2', summary: 'Second', url: 'https://yt/AC-2', customFields: { State: 'Open' } },
                { id: 'AC-3', summary: 'Third', url: 'https://yt/AC-3', customFields: { State: 'Open' } },
              ],
            },
          }
        },
        runEntity: async (_record, _entity, job) => {
          seen.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(seen.length, 3)
  /* the row reaches the run through its note, so the person's words stay the
     instruction and a `/workspace:` skill can still lead it */
  assert.match(seen[0], /^fix it\n\n\(Run 1 of 3: your row is "AC-1 — First"/)
  assert.match(seen[2], /AC-3 — Third/)
  const runs_ = out.mentions.filter((row) => row.kind === 'entity')
  assert.deepEqual(
    runs_.map((row) => row.row),
    ['AC-1 — First', 'AC-2 — Second', 'AC-3 — Third'],
  )
  assert.equal(runs_[0].job, 'AC-1 — First\n\nfix it')
  /* the session's first message is the row and the person's words, no note */
  /* the block lists the three runs by their rows, and the list once is not
     repeated as seven lines */
  assert.match(out.text, /- AC-2 — Second \(py-agent\) → answer: done/)
  assert.doesNotMatch(out.text, /AC-2 — Second — AC · Open/)
})

test('a fan-out runs all its rows, past the two-mention ceiling', async () => {
  const record = workspace()
  let runs = 0
  const out = await mention.rewrite(record, 'spawn per @youtrack:AC:bug @py-agent fix', {
    deps: deps({
      mcpCall: async () => ({
        data: {
          issuesPage: Array.from({ length: 7 }, (_, index) => ({
            id: `AC-${index + 1}`,
            summary: `Issue ${index + 1}`,
            customFields: {},
          })),
        },
      }),
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 7)
  assert.equal(out.mentions.filter((row) => row.kind === 'entity').length, 7)
  assert.doesNotMatch(out.text, /skipped/)
})

test('a typed row list fans out — a catalogue in a file has no mention', async () => {
  const record = workspace()
  const jobs = []
  const out = await mention.rewrite(
    record,
    'spawn per [scenes/horizontal/card-list, scenes/horizontal/hero, scenes/horizontal/broll] ' +
      '@py-agent improve this scene base',
    {
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 3)
  assert.match(jobs[0], /^improve this scene base\n\n\(Run 1 of 3: your row is "scenes\/horizontal\/card-list"/)
  assert.match(jobs[2], /broll/)
  /* the row is the session title, and it is the path, not the shared instruction */
  assert.deepEqual(
    out.mentions.filter((row) => row.kind === 'entity').map((row) => row.row),
    ['scenes/horizontal/card-list', 'scenes/horizontal/hero', 'scenes/horizontal/broll'],
  )
  /* no list mention exists, so the block is exactly one line per run */
  assert.doesNotMatch(out.text, /@youtrack|nothing found/)
})

test('a typed row list is capped like a resolved one, and nothing is sent over it', async () => {
  const record = workspace()
  let runs = 0
  const thirteen = Array.from({ length: 13 }, (_, i) => `scene-${i}`).join(', ')
  await assert.rejects(
    () =>
      mention.rewrite(record, `spawn per [${thirteen}] @py-agent improve`, {
        deps: deps({
          runEntity: async () => {
            runs += 1
            return { ok: true, answer: 'ok', error: '' }
          },
        }),
      }),
    /lists 13 rows and runs one per row, at most 12/,
  )
  assert.equal(runs, 0)
  /* an empty bracket is a mistake, not a zero-run fan-out */
  await assert.rejects(
    () => mention.rewrite(record, 'spawn per [ ] @py-agent improve', { deps: deps() }),
    /empty row list/,
  )
})

test('an empty list spawns nothing and says so', async () => {
  const record = workspace()
  let runs = 0
  const out = await mention.rewrite(record, 'spawn per @youtrack:AC:nothing @py-agent fix', {
    deps: deps({
      mcpCall: async () => ({ data: { issuesPage: [] } }),
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 0)
  assert.match(out.text, /note: spawn per ran nothing/)
})

test('spawn per without a list, or without an entity, is a hard error', async () => {
  const record = workspace()
  await assert.rejects(
    () => mention.rewrite(record, 'spawn per @py-agent fix it', { deps: deps() }),
    /spawn per needs the list before the entity/,
  )
  await assert.rejects(
    () => mention.rewrite(record, 'spawn per @youtrack:AC:bug', { deps: deps() }),
    /spawn per needs an entity to run/,
  )
})

test('a skill at the front of a fan-out is carried onto each run', async () => {
  const record = workspace()
  const jobs = []
  /* `/workspace:…` at the front is what the person meant by it: every run routed
     by that skill. Refusing it only taught people to retype a message the app
     could already read — the classifier's plan carries the prologue instead. */
  const { segments } = mention.parse(
    'use this skill /skills/alpha\n\n@py-agent write a poem',
  )
  assert.equal(segments[0].kind, 'entity')
  await mention.rewrite(record, 'use this skill /skills/alpha\n\nspawn 2 @py-agent write a poem', {
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  /* the grammar path keeps the prologue on the message, so the harness loads it
     once; a classified fan-out is the one that carries it per run */
  assert.equal(jobs.length, 2)
})

test('a delegated job may carry its own /workspace: skill', async () => {
  const record = workspace()
  const seen = []
  await mention.rewrite(record, '@py-agent /workspace:alpha fix the build', {
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        seen.push(job)
        return { ok: true, answer: 'fixed', error: '' }
      },
    }),
  })
  assert.equal(seen.length, 1)
  assert.match(seen[0], /^use this skill .*skills[\\/]alpha\n\nfix the build$/)
})

test('an unknown skill in a delegated job is a hard error', async () => {
  const record = workspace()
  let runs = 0
  await assert.rejects(
    () =>
      mention.rewrite(record, '@py-agent /workspace:ghost fix the build', {
        deps: deps({
          runEntity: async () => {
            runs += 1
            return { ok: true, answer: 'ok', error: '' }
          },
        }),
      }),
    /is not a skill this workspace can reach/,
  )
  assert.equal(runs, 0)
})

test('a mention after the job is named as the trap it is', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, 'spawn 2 @py-agent fix it in @orca:One', {
    deps: deps({
      orcaRepos: async () => [{ displayName: 'One', path: ORCA_ONE }],
    }),
  })
  /* the job stops at the `@`, and the resolved repo path never reaches the run */
  assert.equal(out.mentions.filter((row) => row.kind === 'entity')[0].job, 'fix it in')
  assert.match(out.text, /@orca:One is a mention of its own, so the delegated job stopped before it/)
})

test('a fan-out announces every row, then each one as it starts and settles', async () => {
  const record = workspace()
  const seen = []
  await mention.rewrite(record, 'spawn 3 @py-agent write a poem', {
    deps: deps({
      runEntity: async (_record, _entity, job) => ({
        ok: true,
        answer: `answer to ${job.slice(0, 12)}`,
        error: '',
      }),
    }),
    onProgress: (data) => seen.push(data),
  })
  /* the first event carries all three rows, before any harness exists */
  assert.equal(seen[0].total, 3)
  assert.deepEqual(
    seen[0].rows.map((row) => row.status),
    ['queued', 'queued', 'queued'],
  )
  assert.equal(seen[0].rows[0].share, '1/3')
  assert.equal(seen[0].rows[1].name, 'py-agent')
  /* then each run reports running, and finally the whole set is answered */
  assert.ok(seen.some((data) => data.rows.filter((row) => row.status === 'running').length === 3))
  const last = seen[seen.length - 1]
  assert.deepEqual(
    last.rows.map((row) => row.status),
    ['ok', 'ok', 'ok'],
  )
  assert.match(last.rows[2].answer, /^answer to write a poem/)
})

test('a stopped turn starts no queued run', async () => {
  const record = workspace()
  let runs = 0
  await mention.rewrite(record, 'spawn 3 @py-agent write a poem', {
    deps: deps({
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
    stopped: () => true,
  })
  assert.equal(runs, 0)
})

test('every delegated harness is handed to the caller, so Stop can reach it', async () => {
  const record = workspace()
  let given = 0
  await mention.rewrite(record, '@py-agent fix it', {
    deps: deps({
      runEntity: async (_record, _entity, _job, options) => {
        assert.equal(typeof options.onChild, 'function')
        given += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
    onChild: () => {},
  })
  assert.equal(given, 1)
})

test('the parent is told what ran, never the raw fan-out sentence', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, 'spawn 2 @py-agent write a poem', { deps: deps() })
  assert.equal(out.mentions.length, 2)
  /* a parent holding `spawn 2 @py-agent …` could delegate a third time; the
     prompt says the work is done instead. The transcript keeps the words. */
  assert.doesNotMatch(out.text, /spawn 2/)
  assert.match(out.text, /2 runs of @py-agent, all of the same instruction/)
  /* it has no task of its own any more, so it is told what to write instead of
     answering "your message contains no new task" — which is what it did */
  assert.match(out.text, /Write one short paragraph saying what each run did/)
  assert.match(out.text, /do not run them again and do not do their work yourself/)
})

test('the block stops at twelve rows and says how many it dropped', async () => {
  const record = workspace()
  const many = Array.from({ length: 15 }, (_, i) => `note-${i}`)
  const out = await mention.rewrite(record, many.map((name) => `@artifact:${name}`).join(' '), {
    deps: deps(),
  })
  /* nothing matches, so every mention is "nothing found" — one row each */
  const rows = out.text.split('\n').filter((line) => line.startsWith('- @artifact:'))
  assert.equal(rows.length, 12)
  assert.match(out.text, /\(\+3 more resolved\)/)
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

test('a name with no job is a reference, and punctuation is not part of the name', async () => {
  const record = workspace()
  let ran = false
  const out = await mention.rewrite(record, 'I want to delete the @py-agent.', {
    deps: deps({
      runEntity: async () => {
        ran = true
        return { ok: true, answer: '', error: '' }
      },
    }),
  })
  const [seg] = mention.parse('I want to delete the @py-agent.').segments
  assert.equal(seg.name, 'py-agent')
  assert.equal(seg.job, '')
  assert.equal(ran, false, 'a bare mention must not start an entity run')
  assert.equal(out.mentions.length, 1)
  assert.equal(out.mentions[0].reference, true)
  assert.equal(out.mentions[0].status, 'ok')
  assert.match(out.text, /named only; no job was given/)
  assert.doesNotMatch(out.text, /no answer/)
})

/* A row's verdict is the *last* thing it said, so a head-only digest showed the
   setup and never the ending. Short answers stay byte-identical (`:243` above). */
test('a long answer keeps its tail in the digest, which is where a row ends', async () => {
  const record = workspace()
  const setup = 'read the fixture and noted what changed. '.repeat(20)
  const answer = `${setup}still running: nothing.`
  assert.ok(answer.length > 400, 'the fixture must be long enough to be cut')
  const out = await mention.rewrite(record, '@py-agent fix the failing test', {
    deps: deps({ runEntity: async () => ({ ok: true, answer, error: '' }) }),
  })
  /* the ending survives the cut … */
  assert.match(out.text, /still running: nothing\./)
  /* … and the head is still the head */
  assert.match(out.text, /→ answer: read the fixture and noted/)
  /* the digest stays bounded: head 240 + ' … ' + tail 160 */
  const digest = out.text.split('→ answer: ')[1].split('\n')[0].trim()
  assert.equal(digest.length, 403)
  assert.ok(digest.includes(' … '))
  /* the whole answer is untouched — the session, not the card, is the report */
  assert.equal(out.mentions[0].answer, answer)
})

/* ── the plan gate ────────────────────────────────────────────────────
   A message that delegates sends as always; the runs wait for an answer. The
   seam is one awaited promise, so everything below is the same rewrite with a
   different answer — no second code path to keep in step. */

test('a hold sees the plan before any harness exists, and Run keeps the turn', async () => {
  const record = workspace()
  const ran = []
  const plans = []
  const out = await mention.rewrite(record, '@py-agent fix the failing test', {
    hold: async (plan) => {
      plans.push(plan)
      assert.deepEqual(ran, [], 'the gate must open before a run starts')
      return { action: 'run' }
    },
    deps: deps({
      runEntity: async (_record, entity) => {
        ran.push(entity.name)
        return { ok: true, answer: 'the fixture was stale', error: '' }
      },
    }),
  })
  assert.deepEqual(ran, ['py-agent'])
  assert.equal(plans.length, 1, 'one plan per turn')
  const plan = plans[0]
  assert.deepEqual(plan.reads, [], 'nothing was read, so nothing is claimed')
  assert.equal(plan.rows.length, 1)
  assert.deepEqual(
    { name: plan.rows[0].name, job: plan.rows[0].job, harness: plan.rows[0].harness },
    { name: 'py-agent', job: 'fix the failing test', harness: 'claude' },
  )
  /* the folder is the one the harness would start in, shown the way a person
     reads it — and `~` is what most entities have */
  assert.equal(plan.rows[0].dir, os.homedir())
  assert.equal(plan.rows[0].shownDir, '~')
  assert.equal(plan.shownDir, '~')
  assert.ok(plan.timeoutMs > 0, 'the ceiling travels with the plan')
  /* and the turn is byte-identical to one that was never gated */
  assert.match(out.text, /→ answer: the fixture was stale/)
})

test('reads resolve before the hold, because the gate covers work that has not happened', async () => {
  const record = workspace()
  let readsAtHold = null
  const out = await mention.rewrite(
    record,
    '@youtrack:AC:login bug then @py-agent fix it',
    {
      hold: async (plan) => {
        readsAtHold = plan.reads
        return { action: 'run' }
      },
      deps: deps({
        mcpCall: async () => ({
          data: { issuesPage: [{ id: 'AC-361', summary: 'Login loops', url: 'https://yt/issue/AC-361' }] },
        }),
        runEntity: async () => ({ ok: true, answer: 'done', error: '' }),
      }),
    },
  )
  assert.equal(readsAtHold.length, 1)
  assert.equal(readsAtHold[0].kind, 'youtrack')
  assert.equal(readsAtHold[0].count, 1)
  assert.match(readsAtHold[0].detail, /AC-361/)
  /* the read is in the block the parent reads, not only in the plan */
  assert.match(out.text, /AC-361 — Login loops/)
})

test('a cancelled plan starts nothing and says which plan it was', async () => {
  const record = workspace()
  let ran = 0
  await assert.rejects(
    mention.rewrite(record, '@py-agent fix the failing test', {
      hold: async () => ({ action: 'cancel', reason: 'cancelled' }),
      deps: deps({
        runEntity: async () => {
          ran += 1
          return { ok: true, answer: 'should not happen', error: '' }
        },
      }),
    }),
    (error) => {
      assert.equal(
        error.message,
        'Delegation cancelled — nothing was sent to @py-agent.',
        'the sentence names the target, not the harness',
      )
      assert.equal(error.hold, 'cancelled', 'the caller needs to know why, to settle the card')
      return true
    },
  )
  assert.equal(ran, 0, 'Cancel means nothing started')
})

/* The held plan is a form: Run carries the count and the words that were on
   screen. The engine applies them once, before any run starts — a trimmed plan
   starts fewer runs, and every run receives its own card's text, not the
   sentence the message was sent with. */
test('Run starts the words and the count the card showed', async () => {
  const record = workspace()
  const asked = []
  const out = await mention.rewrite(record, '@py-agent fix the failing test', {
    hold: async () => ({ action: 'run', count: 1, rows: ['the card said this'] }),
    deps: deps({
      runEntity: async (_record, entity, job) => {
        asked.push({ name: entity.name, job })
        return { ok: true, answer: `${entity.name} handled "${job}"`, error: '' }
      },
    }),
  })
  assert.equal(asked.length, 1)
  assert.match(asked[0].job, /the card said this/)
  assert.doesNotMatch(asked[0].job, /fix the failing test/)
  assert.match(out.text, /the card said this/)
  assert.equal(out.mentions[0].job, 'the card said this')

  /* `spawn 2` held with one card starts one run, and says `1/1` rather than
     keeping the `1/2` the trim made untrue. */
  const kept = []
  const trimmed = await mention.rewrite(record, 'spawn 2 @py-agent x', {
    hold: async () => ({ action: 'run', count: 1, rows: ['only one'] }),
    deps: deps({
      runEntity: async (_record, entity, job) => {
        kept.push({ name: entity.name, job })
        return { ok: true, answer: `${entity.name} handled "${job}"`, error: '' }
      },
    }),
  })
  assert.equal(kept.length, 1, 'a trimmed plan starts exactly the runs it kept')
  assert.match(kept[0].job, /only one/)
  assert.equal(trimmed.mentions.length, 1)
  assert.equal(trimmed.mentions[0].share, undefined, 'one run is not a share of two')
})

test('an expired plan says so, and a refused message never reaches the gate', async () => {
  const record = workspace()
  let opened = false
  await assert.rejects(
    mention.rewrite(record, '@py-agent fix the failing test', {
      hold: async () => ({ action: 'cancel', reason: 'expired' }),
      deps: deps(),
    }),
    (error) => {
      assert.equal(error.message, 'The plan expired before it was answered — nothing was started.')
      assert.equal(error.hold, 'expired')
      return true
    },
  )
  /* an unknown entity throws before a plan exists: a gate after a refusal would
     train people to click Run on messages that cannot run */
  await assert.rejects(
    mention.rewrite(record, '@ghost fix it', {
      hold: async () => {
        opened = true
        return { action: 'run' }
      },
      deps: deps(),
    }),
    /is not an entity in this workspace/,
  )
  assert.equal(opened, false, 'no gate behind a refusal')
  /* a reference mention is not a delegation either */
  let referenceOpened = false
  await mention.rewrite(record, 'I want to delete @py-agent.', {
    hold: async () => {
      referenceOpened = true
      return { action: 'run' }
    },
    deps: deps(),
  })
  assert.equal(referenceOpened, false, 'a name with no job runs nothing, so it asks nothing')
})

/* `spawn 1` is a delegated run, not a fan-out of zero.
   
   The parent prompt swapped the raw sentence for "the run already happened" only
   when the count was > 1, so one requested run read as an ordinary message: the
   child answered, and then the parent was handed the same instruction as its own
   job and did the work again, in the same session, at full length. A message that
   delegated one run is exactly as delegated as one that delegated four. */
test('spawn 1 does not hand the parent its own job back', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, 'spawn 1 @py-agent redesign the MCP page', {
    deps: deps(),
  })
  assert.equal(out.mentions.length, 1)
  assert.equal(out.mentions[0].job, 'redesign the MCP page')
  /* the one run already happened, so the sentence that asked for it is not the
     parent's task any more */
  assert.doesNotMatch(out.text, /spawn 1/)
  assert.match(out.text, /has already happened and its answer is/)
  assert.match(out.text, /Do not repeat it yourself and do not delegate it again/)
})

test('a plain mention still keeps its own sentence, so the entity answers it', async () => {
  const record = workspace()
  /* No `spawn`: `@agent <job>` runs the job in the turn, and the parent entity
     answers the person's message — its own words are the task. */
  const out = await mention.rewrite(record, '@py-agent check the site', { deps: deps() })
  assert.equal(out.mentions.length, 1)
  assert.match(out.text, /@py-agent check the site$/)
})

/* A job that is only a preposition is a missing instruction, and it used to run.
   
   `spawn 1 @designer on @orca:entity <the real ask>` splits at the second `@`, so
   the child was handed the single word "on", asked the person for a brief, and a
   session was filed under the title "on" — while the actual request sat in the
   segment the run never saw. A note afterwards is too late: the run already
   happened and a conversation already exists. */
test('a delegated job that is only a preposition is refused before anything runs', async () => {
  const record = workspace()
  let ran = 0
  const jobs = []
  const attempt = (text) =>
    mention.rewrite(record, text, {
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          ran += 1
          jobs.push(job)
          return { ok: true, answer: 'asked for a brief', error: '' }
        },
      }),
    })

  for (const text of [
    'spawn 1 @py-agent on @orca:One the real ask lives after the repo',
    '@py-agent on @orca:One the real ask lives after the repo',
    '@py-agent in @orca:One fix the bug',
  ]) {
    await assert.rejects(attempt(text), /has no job/, text)
  }
  assert.equal(ran, 0, 'a refusal happens before the first harness')
  assert.deepEqual(jobs, [])

  /* the message that names a MENTION after a real job still runs: "fix it in"
     is a sentence the run can act on, and the existing note covers the repo */
  const ok = await mention.rewrite(record, '@py-agent fix it in @orca:One the real ask', {
    deps: deps({ orcaRepos: async () => [{ displayName: 'One', path: ORCA_ONE }] }),
  })
  assert.equal(ok.mentions.filter((row) => row.kind === 'entity')[0].job, 'fix it in')
})

/* The message that made this layer's blind spot visible.
   
   `spawn 1 @designer on @orca:entity <the real ask>` — the grammar splits the job
   at the second `@`, so the run was handed "on". Because the split *succeeded*,
   the grammar believed it had read the message exactly and never asked the
   classifier, which is the whole point of having one. Now an unreadable job is a
   third reason to classify (after "no prefix" and "it enumerates"), so the model
   proposes `spawn 1 @designer <the whole instruction>` and the ordinary hold card
   is what the person confirms.
*/
test('a cut-off job asks the classifier instead of running on a preposition', async () => {
  const record = workspace()
  let asked = 0
  const jobs = []
  const out = await mention.rewrite(
    record,
    'spawn 1 @py-agent on @orca:One the real ask lives after the repo',
    {
      intent: async () => {
        asked += 1
        return { spawn: true, runs: 1, entity: 'py-agent', job: 'the real ask lives after the repo' }
      },
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
        orcaRepos: async () => [{ displayName: 'One', path: ORCA_ONE }],
      }),
    },
  )
  assert.equal(asked, 1, 'the grammar claimed a reading it did not have')
  assert.deepEqual(jobs, ['the real ask lives after the repo'])
  assert.equal(out.mentions.filter((row) => row.kind === 'entity')[0].status, 'ok')
})

test('a typed plan keeps its job past the `@` its words contain', async () => {
  /* The message that shipped broken: a person wrote `for project @orca:entity ,
     I want you to spawn @coder for each connector below … one app : @orca:One`,
     the classifier read the four connectors correctly, and the rendered sentence
     then lost both the project and the task. `parse` cut each run's job at the
     next `@` ("For project") and `resolveOrca` threw `@orca:entity, is not a
     project Orca knows` — a read, so it threw *before* the hold card could be
     drawn and the turn rolled back to an empty transcript.

     A plan's job is the person's prose, not mention syntax: it is never re-read
     as one. `@orca:entity,` also names the project `entity`, the comma being the
     sentence's own punctuation. */
  const record = workspace()
  const jobs = []
  const thoughts = []
  const out = await mention.rewrite(
    record,
    'for project @orca:entity , I want you to spawn @py-agent for each connector below\n' +
      'one app : @orca:One\n' +
      '## Connectors\n- github\n- fitbit',
    {
      intent: async () => ({
        mode: 'typed',
        spawn: true,
        rows: ['github', 'fitbit'],
        entity: 'py-agent',
        job:
          'For project @orca:entity, make each row complete. one app : @orca:One',
      }),
      hold: async () => ({ action: 'run' }),
      onProgress: (event) => thoughts.push(event),
      deps: deps({
        orcaRepos: async () => [
          { displayName: 'entity', path: path.join(ORCA_ROOT, 'entity') },
          { displayName: 'One', path: ORCA_ONE },
        ],
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 2, 'one run per connector')
  for (const [index, job] of jobs.entries()) {
    /* the row reaches the run through its share note, then the whole
       instruction, unfiltered by the `@` it contains */
    assert.match(job, /^For project @orca:entity, make each row complete\./)
    assert.match(job, /one app : @orca:One/, 'the job kept the `@` it wrote')
    assert.match(
      job,
      new RegExp(`your row is "(?:github|fitbit)"`),
      `run ${index + 1} was not told its connector`,
    )
  }
  /* and the `@orca:` words in the job are prose: they resolve nothing */
  assert.equal(thoughts.at(-1).rows.length, 2)
  assert.equal(out.mentions.filter((row) => row.kind === 'orca').length, 0)
})

test('a namespaced name keeps the sentence’s punctuation out of the project', async () => {
  /* `@orca:entity,` is the project `entity`. Reading the comma as part of the
     name threw `@orca:entity, is not a project Orca knows` — a message that
     reads perfectly, refused by punctuation. `resolveOrca` matches the name, so
     the strip has to live where the name is read. */
  assert.equal(mention.parseMention('@orca:entity, do it').project, 'entity')
  assert.equal(mention.parseMention('@orca:entity,').project, 'entity')
  assert.equal(mention.parseMention('@orca:One:src/App.vue').file, 'src/App.vue')
  assert.equal(mention.parseMention('@youtrack:ENTITY:ENTITY-37, fix it').query, 'ENTITY-37, fix it')
})

test('a bracket row list holds rows, not mentions', async () => {
  /* `spawn per [@scope/pkg, b] @coder …` names a package and a row. The `@` is
     inside the list, which `openingProse` already reads as rows; `parse` has to
     agree, or the run is refused as `@scope/pkg is not an entity`. */
  const { segments } = mention.parse('spawn per [\n@scope/pkg\nb\n] @py-agent do it')
  assert.deepEqual(segments.map((s) => s.kind), ['entity'])
  assert.equal(segments[0].name, 'py-agent')
  assert.equal(segments[0].job, 'do it')
})

test('a delegated message is classified, even when the grammar reads it', async () => {
  /* The grammar can split `@entity` from its job, and that is all it can do. It
     cannot see that two lines order two different jobs, so a message that hands
     work to an agent always pays the one call — the plan is the only reading
     that is per run. */
  const record = workspace()
  let asked = 0
  const out = await mention.rewrite(record, 'spawn 1 @py-agent redesign the MCP page', {
    intent: async () => {
      asked += 1
      return { spawn: false }
    },
    deps: deps(),
  })
  assert.equal(asked, 1, 'a delegation is never second-guessed by the grammar')
  assert.equal(out.mentions.length, 1)
  assert.equal(out.mentions[0].job, 'redesign the MCP page')
})

test('a message that delegates nothing costs no classifier call', async () => {
  const record = workspace()
  let asked = 0
  await mention.rewrite(record, 'Take your time, then tell me what @artifact:plan says', {
    intent: async () => {
      asked += 1
      return { spawn: false }
    },
    deps: deps(),
  })
  assert.equal(asked, 0, 'no entity means nothing to plan')
})

/* ── the conversation a run was delegated from ──────────────────── */

/* The message that defines "implement A" lives in this thread and nowhere else.
   A child session starts empty, so the last exchange has to travel with it. */
function parentThread(overrides = {}) {
  return {
    id: 't_parent',
    title: 'Delegation throughput',
    messages: [
      { who: 'me', text: 'what should we do about the delegation loop?' },
      {
        who: 'agent',
        text: 'Concrete plan: artifact://release-notes.md — A is the loop, B is the brief.',
      },
      { who: 'me', text: '@py-agent implement A from artifact://release-notes.md' },
    ],
    ...overrides,
  }
}

function threadsFor(thread, read = null) {
  return { read: read || (async (id) => (id === thread.id ? thread : null)) }
}

test('a delegated run is handed the conversation it came from', async () => {
  const record = workspace()
  const thread = parentThread()
  const jobs = []
  const out = await mention.rewrite(
    record,
    '@py-agent implement A from artifact://release-notes.md',
    {
      threadId: thread.id,
      deps: deps({
        threads: threadsFor(thread),
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 1)
  const handed = jobs[0]
  /* the task still leads: a `/workspace:` skill has to stay the first line */
  assert.match(handed, /^implement A from artifact:\/\/release-notes\.md/)
  /* what "A" means is in the prompt now — and this turn's own ask is not
     repeated back as if it were history */
  assert.match(handed, /Earlier ask:\nwhat should we do about the delegation loop\?/)
  assert.match(handed, /Last answer there:\nConcrete plan:/)
  assert.doesNotMatch(handed, /Earlier ask: @py-agent implement A/)
  /* the notation became a path the run can open, in the tree the file is in */
  assert.ok(handed.includes(path.join(record.path, 'artifacts', 'release-notes.md')))
  /* and it is labelled as background, so the run does not redo the work */
  assert.match(handed, /background, not your task/)
  /* the card keeps the job alone: the block is the engine's, not the plan's */
  assert.equal(out.mentions[0].job, 'implement A from artifact://release-notes.md')
})

test('a plan saved as a personal artifact is handed over as a real path', async () => {
  const record = workspace()
  const plan = artifacts.saveText({
    workspace: record.id,
    name: 'delegation-plan.md',
    text: 'A: checkpoint commits. B: brief rewrite.',
  })
  const absolute = plan.path.startsWith('~/')
    ? path.join(os.homedir(), plan.path.slice(2))
    : plan.path
  const thread = parentThread({
    messages: [
      { who: 'me', text: 'make a plan' },
      { who: 'agent', text: `Concrete plan: artifact://${plan.id}` },
      { who: 'me', text: `@py-agent implement A from artifact://${plan.id}` },
    ],
  })
  const jobs = []
  await mention.rewrite(record, `@py-agent implement A from artifact://${plan.id}`, {
    threadId: thread.id,
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.ok(jobs[0].includes(absolute), 'the personal shelf path, not a guess')
})

test('an artifact named in this turn’s own words is resolved too', async () => {
  /* the file can be named right before the mention; the plan then copies only
     the job out of the message, so the exchange alone would not point at it */
  const record = workspace()
  const thread = parentThread({ messages: [{ who: 'me', text: 'earlier' }] })
  const jobs = []
  await mention.rewrite(record, '@py-agent continue from artifact://shots/login-shot.png', {
    threadId: thread.id,
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  /* the fixture put this file in the shared tree with no share record, so the
     path has to be that tree — the store reports it as `unclaimed` */
  assert.ok(jobs[0].includes(path.join(record.path, 'artifacts', 'shots', 'login-shot.png')))
})

test('the card carries the whole prompt, and Run sends it once', async () => {
  /* The card is the form. A prompt approved with the conversation block hidden
     is approved blind, so the block is on the row — and the field the person
     leaves is the whole prompt, never task + a block appended twice. */
  const record = workspace()
  const thread = parentThread()
  const cards = []
  const jobs = []
  await mention.rewrite(record, '@py-agent implement A from artifact://release-notes.md', {
    threadId: thread.id,
    hold: async (plan) => {
      cards.push(...plan.rows.map((row) => ({ job: row.job, context: row.context })))
      /* exactly what the component sends: the prompt on screen, task + block */
      return {
        action: 'run',
        count: plan.rows.length,
        instruction: plan.instruction,
        rows: plan.rows.map((row) => `${row.job}\n\n${row.context}`.trim()),
      }
    },
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.equal(cards.length, 1)
  assert.match(cards[0].job, /^implement A from artifact:\/\/release-notes\.md/)
  assert.match(cards[0].context, /Context from the conversation this run was delegated from/)
  assert.match(cards[0].context, /Earlier ask:\nwhat should we do/)
  const marks = (jobs[0].match(/Context from the conversation this run was delegated from/g) || [])
    .length
  assert.equal(marks, 1, 'the block is in the prompt, not appended to it again')
  assert.match(jobs[0], /^implement A from artifact:\/\/release-notes\.md/)
  /* the transcript card is the record of what ran: the whole prompt, once */
  const out = await mention.rewrite(record, '@py-agent implement A', {
    threadId: thread.id,
    hold: async (plan) => ({
      action: 'run',
      count: plan.rows.length,
      rows: plan.rows.map((row) => `${row.job}\n\n${row.context}`.trim()),
    }),
    deps: deps({ threads: threadsFor(thread) }),
  })
  assert.match(out.mentions[0].job, /^implement A\n\nContext from the conversation/)
  assert.equal(
    (out.mentions[0].job.match(/Context from the conversation/g) || []).length,
    1,
    'one block on the card too',
  )
})

test('a revised task still carries the turn’s context', async () => {
  /* The band is a task, not a prompt: sending only it must not throw the
     context away. */
  const record = workspace()
  const thread = parentThread()
  const jobs = []
  await mention.rewrite(record, '@py-agent implement A from artifact://release-notes.md', {
    threadId: thread.id,
    hold: async () => ({ action: 'run', count: 1, instruction: 'implement A, in a child worktree' }),
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.match(jobs[0], /^implement A, in a child worktree\n\nContext from the conversation/)
  const marks = (jobs[0].match(/Context from the conversation this run was delegated from/g) || [])
    .length
  assert.equal(marks, 1)
})

test('no thread reader, or a thread that cannot be read, leaves the job alone', async () => {
  const record = workspace()
  const jobs = []
  const run = async (depsHere) => {
    jobs.length = 0
    await mention.rewrite(record, '@py-agent implement A', {
      threadId: 't_parent',
      deps: deps({
        ...depsHere,
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    })
    assert.equal(jobs.length, 1)
    assert.doesNotMatch(jobs[0], /Context from the conversation/)
    assert.equal(jobs[0], 'implement A')
  }
  /* a test seam with no reader, and a reader that throws: both are the same
     answer — the run keeps its own words and still starts */
  await run({})
  await run({
    threads: {
      read: async () => {
        throw new Error('this thread cannot be read')
      },
    },
  })
})

test('a context block that travelled into a child is not nested again', async () => {
  const record = workspace()
  const marker = 'Context from the conversation this run was delegated from'
  const thread = parentThread({
    messages: [
      { who: 'me', text: 'first ask' },
      {
        who: 'agent',
        text:
          'Deep work happened.\n\n' +
          marker +
          ' — background, not your task.\nEarlier ask: the original ask',
      },
      { who: 'me', text: '@py-agent delegate once more' },
    ],
  })
  const jobs = []
  await mention.rewrite(record, '@py-agent delegate once more', {
    threadId: thread.id,
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.match(jobs[0], /Last answer there:\nDeep work happened\./)
  assert.doesNotMatch(jobs[0], /the original ask/, 'the nested block was cut out')
  const marks = (jobs[0].match(/Context from the conversation this run was delegated from/g) || [])
    .length
  assert.equal(marks, 1, 'one block, never a block inside a block')
})

test('the context block is bounded, so one essay cannot drown the job', async () => {
  const record = workspace()
  const thread = parentThread({
    messages: [
      { who: 'me', text: 'first ask' },
      { who: 'agent', text: `${'A'.repeat(4_000)}END-OF-ANSWER` },
      { who: 'me', text: '@py-agent do it' },
    ],
  })
  const jobs = []
  await mention.rewrite(record, '@py-agent do it', {
    threadId: thread.id,
    deps: deps({
      threads: threadsFor(thread),
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.doesNotMatch(jobs[0], /END-OF-ANSWER/)
  assert.ok(jobs[0].length < 3_500, 'a bounded hand-off, not a transcript')
  /* a cut reads as a cut, not as the end of the answer */
  assert.match(jobs[0], /…\nArtifacts named there|…$/m)
})

test('the run’s own record names its worktree, not the ticket key', async () => {
  /* One fan-out shares a cwd and a ticket key, so the key alone paints the same
     word on every card. The record names the path this run actually worked in;
     Orca's list says which of those still exists. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-wt-'))
  const bin = path.join(root, 'bin')
  const mine = path.join(root, 'orca', 'workspaces', 'entity', 'entity-53-card')
  const other = path.join(root, 'orca', 'workspaces', 'entity', 'entity-53-newer')
  fs.mkdirSync(mine, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  const worktrees = [
    { path: mine, branch: 'refs/heads/entity-53-card', lastActivityAt: 1, repoId: 'r1' },
    { path: other, branch: 'refs/heads/entity-53-newer', lastActivityAt: 999, repoId: 'r1' },
  ]
  fs.writeFileSync(
    path.join(bin, 'orca'),
    `#!/bin/sh\ncase "$1 $2" in\n  "worktree list") echo '${JSON.stringify({ result: { worktrees } })}' ;;\n  *) echo '{"result":{"repos":[]}}' ;;\nesac\n`,
    { mode: 0o755 },
  )
  /* git status is only ever run against a path Orca returned, and a clean
     workspace says nothing at all. */
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const previous = { orca: process.env.ENTITY_ORCA_BIN, path: process.env.PATH }
  process.env.ENTITY_ORCA_BIN = path.join(bin, 'orca')
  process.env.PATH = `${bin}${path.delimiter}${previous.path || ''}`
  try {
    const state = await mention.worktreeState({
      cwd: os.tmpdir(),
      ticket: 'ENTITY-53',
      record: { steps: [], answer: `worked in ${mine} and merged it` },
    })
    assert.equal(state.path, mine, 'the ticket key picked a different worktree')
    assert.equal(state.name, 'entity-53-card')
    assert.equal(state.state, 'clean')
  } finally {
    if (previous.orca === undefined) delete process.env.ENTITY_ORCA_BIN
    else process.env.ENTITY_ORCA_BIN = previous.orca
    process.env.PATH = previous.path
  }
})

/* ── a message that is nothing but a read ─────────────────────────────────────
   A connector mention on its own line is a whole question, and the rows are the
   answer. Handing it to a harness asked the entity to invent an instruction: a
   mention-only YouTube Studio summary became a YouTrack search for "a board
   issue about this video" instead of the numbers already resolved. */

test('a message that is only a read answers itself', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@youtrack:AC:login bug', {
    deps: deps({
      mcpCall: async () => ({
        data: { issuesPage: [{ id: 'AC-361', summary: 'Login loops', url: 'https://yt/issue/AC-361' }] },
      }),
    }),
  })
  assert.equal(out.readsOnly, true)
  /* the answer is the rows, as Markdown, under the token they came from */
  assert.match(out.answer, /`@youtrack:AC:login bug`/)
  assert.match(out.answer, /- AC-361 — Login loops — AC · https:\/\/yt\/issue\/AC-361/)
  /* and the prompt still carries the block, so a turn that follows can read it */
  assert.match(out.text, /^Resolved mentions/)
})

test('a read with a sentence under it is still a turn', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@youtrack:AC:login bug\nsummarise the causes', {
    deps: deps({
      mcpCall: async () => ({
        data: { issuesPage: [{ id: 'AC-361', summary: 'Login loops', url: 'https://yt/issue/AC-361' }] },
      }),
    }),
  })
  assert.equal(out.readsOnly, undefined)
  assert.equal(out.answer, undefined)
})

test('a delegated entity is never answered in place of running it', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@py-agent', {
    deps: deps({ runEntity: async () => ({ ok: true, answer: 'nothing to do' }) }),
  })
  assert.equal(out.readsOnly, undefined)
})

test('an empty read answers "nothing found" instead of asking a harness', async () => {
  const record = workspace()
  const out = await mention.rewrite(record, '@artifact:no-such-shot', { deps: deps() })
  assert.equal(out.readsOnly, true)
  assert.match(out.answer, /nothing found/)
  assert.match(out.answer, /note: @artifact:no-such-shot matched no file in this workspace/)
})
