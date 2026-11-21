/**
 * The intent layer: the one message shape the grammar could not read.
 *
 * `spawn @coder do it` — a `spawn` with no count — matched no prefix, so the
 * whole sentence became ONE ordinary job and ran once, silently. These tests
 * pin the two halves of the fix:
 *
 *   1. the deterministic reading (`derivePlan`), which knows a pasted issue URL
 *      and needs no model at all;
 *   2. the seam itself, with the reader injected, so what is asserted is the
 *      contract — that a derived plan reaches the ordinary fan-out path, and
 *      that everything else is left exactly as it was.
 *
 * The real harness call is exercised by hand, not here: a unit test that runs
 * `pi` is a test that fails on a machine without it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-intent-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const mention = require('../../electron/mention-ref.cjs')
const intent = require('../../electron/intent-ref.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `intent-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'coder', harness: 'claude' })
  entities.scaffold({ workspace: created.id, name: 'secretary', harness: 'claude' })
  const record = workspaces.open(created.id)
  fs.mkdirSync(path.join(record.path, 'skills', 'code-milestone'), { recursive: true })
  fs.writeFileSync(
    path.join(record.path, 'skills', 'code-milestone', 'SKILL.md'),
    '---\nname: code-milestone\ndescription: A fixture skill\n---\n\nDo the milestone.\n',
  )
  return record
}

const NAMES = ['coder', 'secretary']

/** Three issues as the mention resolver sees them. */
const ISSUES = ['ENTITY-33', 'ENTITY-32', 'ENTITY-30'].map((id) => ({
  id,
  summary: `${id} summary`,
  url: `https://youtrack.example.test/issue/${id}`,
  customFields: { State: 'Submitted' },
}))

function deps(overrides = {}) {
  return {
    orcaRepos: async () => [],
    mcpCall: async ({ tool, arguments: args }) => {
      if (tool !== 'search_issues') throw new Error(`unexpected tool ${tool}`)
      /* the fan-out asks for as many rows as it may run */
      assert.equal(args.limit, 12)
      return { data: { issuesPage: ISSUES, hasNextPage: false } }
    },
    runEntity: async () => ({ ok: true, answer: 'done', error: '' }),
    ...overrides,
  }
}

/* ── the deterministic reading ─────────────────────────────────────── */

test('a pasted issue URL is read as the list its children come from', () => {
  const plan = intent.derivePlan(
    'spawn @coder entity for each issue relates to : ' +
      'https://youtrack.example.test/issue/ENTITY-25/Entity-v0.0.7 #Unresolved only. ' +
      'let it work on the issue.',
    { entities: NAMES },
  )
  assert.ok(plan, 'an issue URL is a plan')
  assert.equal(plan.list, '@youtrack:ENTITY:relates to: ENTITY-25 #Unresolved')
  assert.equal(plan.entity, 'coder')
  /* the clause that named the list is gone; the instruction is the rest */
  assert.equal(plan.job, 'let it work on the issue.')
})

test('the state filter is the person\'s, and absence means absence', () => {
  const base = 'spawn @coder please fix everything that relates to ENTITY-25'
  assert.doesNotMatch(intent.derivePlan(base, { entities: NAMES }).list, /#/)
  assert.match(
    intent.derivePlan(`${base} #Unresolved`, { entities: NAMES }).list,
    /#Unresolved$/,
  )
  assert.match(intent.derivePlan(`${base} #Resolved`, { entities: NAMES }).list, /#Resolved$/)
})

test('a message with no issue key is not this kind of message', () => {
  assert.equal(intent.derivePlan('spawn @coder write a poem', { entities: NAMES }), null)
  assert.equal(intent.derivePlan('', { entities: NAMES }), null)
})

test('an entity this workspace does not have is not planned', () => {
  /* a card naming an entity that would be refused further down is a card the
     person read for nothing */
  const text = 'spawn @ghost fix what relates to ENTITY-25'
  assert.equal(intent.derivePlan(text, { entities: NAMES }), null)
})

/* ── the two answers ─────────────────────────────────────────────── */

test('a plan is a repeat or a row list, and nothing else', () => {
  /* the same instruction N times */
  assert.deepEqual(
    intent.usable({ spawn: true, runs: 4, entity: 'coder', job: 'do it' }, NAMES),
    { mode: 'repeat', runs: 4, entity: 'coder', job: 'do it', derived: false },
  )
  /* one run per row a list resolves */
  const rows = intent.usable(
    { spawn: true, list: '@youtrack:ENTITY:relates to: ENTITY-37 #Unresolved', entity: 'coder', job: 'do it' },
    NAMES,
  )
  assert.equal(rows.mode, 'rows')
  assert.equal(rows.list, '@youtrack:ENTITY:relates to: ENTITY-37 #Unresolved')
})

test('a listed set of items is one run per item, not N of one instruction', () => {
  /* This is the difference the person feels: `runs: 4` over four pages gives four
     agents the same sentence — four redesigns of one page — when they asked for
     one page each. `rows` is how a plan says "one page each". */
  const plan = intent.usable(
    {
      spawn: true,
      rows: ['settings?tab=mcp', 'account/harnesses', 'account/integrations', 'account'],
      entity: 'coder',
      job: 'improve the design of this page',
    },
    NAMES,
  )
  assert.equal(plan.mode, 'typed')
  assert.equal(plan.rows.length, 4)
  assert.deepEqual(plan.rows, [
    'settings?tab=mcp',
    'account/harnesses',
    'account/integrations',
    'account',
  ])
})

test('a row is one item, so a duplicate cannot become two runs', () => {
  /* a comma is the list separator: leaving one inside a row silently splits it,
     and two agents would work on one item */
  const plan = intent.usable(
    { spawn: true, rows: ['a, b', 'a, b', '  ', 'c'], entity: 'coder', job: 'do it' },
    NAMES,
  )
  /* a comma is part of a row's own words, so `a, b` stays ONE row; the repeated
     pair collapses and `  ` is nothing */
  assert.deepEqual(plan.rows, ['a, b', 'c'])
  const dup = intent.usable(
    { spawn: true, rows: ['a', 'a', 'b'], entity: 'coder', job: 'do it' },
    NAMES,
  )
  assert.deepEqual(dup.rows, ['a', 'b'], 'the same item twice is one run')
})

test('an explicit "nothing to fan out" is an answer, not a failed reading', () => {
  /* this is the whole point of the classifier: a direct reply is a verdict */
  assert.equal(intent.usable({ spawn: false }, NAMES), null)
  assert.equal(intent.usable({ fanout: false }, NAMES), null)
  /* and silence is not a verdict — `reader` decides what to do with that */
  assert.equal(intent.usable(null, NAMES), null)
})

test('a plan of one run is not a fan-out', () => {
  /* the grammar already delegates `@coder <job>`; a card in front of the path
     that already works is a confirmation step nobody asked for */
  assert.equal(intent.usable({ spawn: true, runs: 1, entity: 'coder', job: 'do it' }, NAMES), null)
  assert.equal(intent.usable({ spawn: true, entity: 'coder', job: 'do it' }, NAMES), null)
})

test('a count is clamped to what the app will actually run', () => {
  const plan = intent.usable({ spawn: true, runs: 40, entity: 'coder', job: 'do it' }, NAMES)
  assert.equal(plan.runs, intent.MAX_RUNS)
})

test('the skill prologue the composer inserts is looked past', () => {
  /* `skill-ref` puts `/workspace:x` at the very front as `use this skill <path>` */
  const text = 'use this skill /skills/alpha\n\nspawn @coder fix it'
  assert.equal(intent.bodyOf(text), 'spawn @coder fix it')
  /* and the deterministic reading never mistakes the path for prose */
  assert.equal(intent.derivePlan(text, { entities: NAMES }), null)
})

/* ── the seam ─────────────────────────────────────────────────────── */

test('a row-list plan reaches the ordinary fan-out, one run per row', async () => {
  const record = workspace()
  const jobs = []
  const out = await mention.rewrite(
    record,
    'spawn @coder fix what relates to https://youtrack.example.test/issue/ENTITY-25 #Unresolved',
    {
      /* the reader is injected: what is asserted is the contract, not the model */
      intent: async () => intent.usable(intent.derivePlan(
        'spawn @coder fix what relates to ENTITY-25 #Unresolved',
        { entities: NAMES },
      ), NAMES),
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 3, 'one run per row, not one for the message')
  assert.match(jobs[0], /^fix what relates to\n\n\(Run 1 of 3: your row is "ENTITY-33 — ENTITY-33 summary"/)
  assert.deepEqual(
    out.mentions.filter((row) => row.kind === 'entity').map((row) => row.row),
    ['ENTITY-33 — ENTITY-33 summary', 'ENTITY-32 — ENTITY-32 summary', 'ENTITY-30 — ENTITY-30 summary'],
  )
  assert.match(out.text, /3 runs of @coder, one per row above/)
})

test('a counted plan reaches it too, and the card is the ordinary one', async () => {
  const record = workspace()
  const plans = []
  const jobs = []
  /* The shape that used to be invisible: `spawn 3` written inside a sentence,
     after a read, on its own line — anything but the first word of the message. */
  const out = await mention.rewrite(
    record,
    "By following A.\n\nI want B.\n\nlet's spawn 4 @coder To work on the issue.",
    {
      intent: async () =>
        intent.usable({ spawn: true, runs: 4, entity: 'coder', job: 'To work on the issue.' }, NAMES),
      hold: async (plan) => {
        plans.push(plan)
        return { action: 'run' }
      },
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  /* four rows on the card, four runs after Run — the whole bug, both halves */
  assert.equal(plans.length, 1)
  assert.equal(plans[0].rows.length, 4)
  assert.deepEqual(plans[0].rows.map((row) => row.share), ['1/4', '2/4', '3/4', '4/4'])
  assert.equal(jobs.length, 4)
  assert.equal(out.mentions.filter((row) => row.kind === 'entity').length, 4)
  assert.match(out.text, /4 runs of @coder/)
})

test('a message that answers directly asks nobody', async () => {
  const record = workspace()
  const jobs = []
  /* `{"spawn": false}` is a verdict: the message runs exactly as it is */
  const out = await mention.rewrite(record, '@coder why did the build fail?', {
    intent: async () => intent.usable({ spawn: false }, NAMES),
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0], 'why did the build fail?')
  assert.equal(out.mentions.filter((row) => row.kind === 'entity').length, 1)
})

test('a leading skill moves into each run instead of being refused', async () => {
  const record = workspace()
  const jobs = []
  /* this is what `skill-ref` hands us: the prologue, then a message the grammar
     cannot read — and the shape that was a hard error before */
  await mention.rewrite(
    record,
    'use this skill /skills/code-milestone\n\n' +
      "Let's work on this milestone @youtrack:ENTITY:ENTITY-37 Work on unresolved related issues.\n" +
      'Spawn 3 @coder To work on the issue.',
    {
      intent: async () =>
        intent.usable({ spawn: true, runs: 3, entity: 'coder', job: 'To work on the issue.' }, NAMES),
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 3)
  /* every run is routed by its own skill, and the prologue still leads the job */
  for (const job of jobs) {
    assert.match(job, /^use this skill .*skills[\\/]code-milestone\n\nTo work on the issue\./)
  }
})

test('a plan naming an entity this workspace lacks plans nothing', async () => {
  const record = workspace()
  const jobs = []
  /* refused here, before a card is painted — the ordinary path would throw after
     the person had already read it */
  const out = await mention.rewrite(record, '@coder fix it', {
    intent: async () => ({ mode: 'repeat', runs: 3, entity: 'ghost', job: 'fix it' }),
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.equal(jobs.length, 1, 'the message runs as written')
  assert.equal(jobs[0], 'fix it')
  assert.equal(out.mentions.filter((row) => row.kind === 'entity').length, 1)
})

test('no reader, or a reader with nothing to say, leaves the message alone', async () => {
  const record = workspace()
  const jobs = []
  const out = await mention.rewrite(record, 'spawn @coder write a poem', {
    intent: async () => null,
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0], 'write a poem')
  assert.match(out.text, /spawn @coder write a poem/, "the person's own words are the prompt")
})

test('a reader that throws is a reader with nothing to say', async () => {
  const record = workspace()
  let runs = 0
  await mention.rewrite(record, 'spawn @coder write a poem', {
    intent: async () => {
      throw new Error('the harness exited 1')
    },
    deps: deps({
      runEntity: async () => {
        runs += 1
        return { ok: true, answer: 'ok', error: '' }
      },
    }),
  })
  assert.equal(runs, 1, 'a broken reader never multiplies a run')
})

test('the grammar goes first, so an exact message costs no call', async () => {
  const record = workspace()
  let asked = 0
  const jobs = []
  await mention.rewrite(record, 'spawn 2 @coder write a poem', {
    intent: async () => {
      asked += 1
      return null
    },
    deps: deps({
      runEntity: async (_record, _entity, job) => {
        jobs.push(job)
        return { ok: true, answer: 'done', error: '' }
      },
    }),
  })
  assert.equal(asked, 0, 'an exact prefix is never second-guessed')
  assert.equal(jobs.length, 2)
})

/* ── the list on screen, which no model gets to paraphrase ─────── */

const BULLETS =
  '@orca:entity\n' +
  'By following the design of :\n' +
  '- http://localhost:5183/artistudio/settings?tab=skills\n' +
  '- http://localhost:5183/artistudio/settings?tab=machines\n\n' +
  'I want to improve the design of these pages : \n' +
  '- http://localhost:5183/artistudio/settings?tab=mcp\n' +
  '- http://localhost:5183/artistudio/settings?tab=harnesses\n' +
  '- http://localhost:5183/artistudio/settings?tab=integrations\n' +
  '- http://localhost:5183/artistudio/settings?tab=account -> use the avatar, not an animation\n\n' +
  "let's spawn 4 @designer To work on the design of each pages."

test('the list is the last one, not the material quoted at the top', () => {
  /* the message above opens with two pages to READ and then lists four to
     IMPROVE. Fanning out over all six would have two agents redesign a page that
     only needed reading. */
  const rows = intent.listedItems(BULLETS)
  assert.equal(rows.length, 4)
  assert.match(rows[0], /tab=mcp$/)
  assert.match(rows[3], /tab=account/)
  assert.doesNotMatch(rows.join(' '), /tab=skills|tab=machines/)
})

test('prose someone bulleted is not a list of work', () => {
  assert.deepEqual(intent.listedItems('- one thing\n- another thing'), [])
  assert.deepEqual(intent.listedItems('- http://example.test/a'), [], 'one row is not a fan-out')
  assert.deepEqual(intent.listedItems('no bullets at all'), [])
})

test('a written count over a list is repaired to one run per item', () => {
  /* the model answered `runs: 4` — four agents, one sentence, four redesigns of
     one page. The list is on screen, so it is read from the text. */
  const wrong = { mode: 'repeat', runs: 4, entity: 'designer', job: 'To work on the design of each pages.' }
  const fixed = intent.repairWithList(BULLETS, wrong, NAMES.concat('designer'))
  assert.equal(fixed.mode, 'typed')
  assert.equal(fixed.rows.length, 4)
  /* the instruction still travels with the list */
  assert.match(fixed.job, /design of each pages/)
})

test('a plan that already names its rows is left alone', () => {
  /* the model saw something better than a bullet list; do not overrule it */
  const plan = { mode: 'typed', rows: ['a', 'b'], entity: 'coder', job: 'do it' }
  assert.deepEqual(intent.repairWithList(BULLETS, plan, NAMES), plan)
  const rowsPlan = { mode: 'rows', list: '@youtrack:AC:bug', entity: 'coder', job: 'do it' }
  assert.deepEqual(intent.repairWithList(BULLETS, rowsPlan, NAMES), rowsPlan)
})

test('a direct reply stays direct when the message has no list', () => {
  const direct = { mode: 'repeat', runs: 3, entity: 'coder', job: 'do it' }
  assert.equal(intent.repairWithList('spawn 3 @coder do it', direct, NAMES), direct)
})

test('a typed plan becomes the sentence the grammar reads, one row each', async () => {
  const record = workspace()
  const cards = []
  const jobs = []
  /* the whole point of the row: the card says WHICH page, and the run is told to
     do only that page — not four agents handed one sentence */
  /* the shape that used to collapse: a written count AND a list. The list wins,
     because the rows are four different pages. */
  await mention.rewrite(
    record,
    `let's spawn 4 @coder improve each page
- settings?tab=mcp
- account/harnesses
- account/integrations
- account`,
    {
    intent: async () =>
      intent.usable(
        {
          spawn: true,
          rows: ['settings?tab=mcp', 'account/harnesses', 'account/integrations', 'account'],
          entity: 'coder',
          job: 'improve the design of this page',
        },
        NAMES,
      ),
      hold: async (plan) => {
        cards.push(...plan.rows.map((row) => row.row))
        return { action: 'run' }
      },
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.deepEqual(cards, ['settings?tab=mcp', 'account/harnesses', 'account/integrations', 'account'])
  assert.equal(jobs.length, 4)
  /* every run is told its own row, in its own words */
  assert.match(jobs[0], /your row is "settings\?tab=mcp"/)
  assert.match(jobs[3], /your row is "account"/)
  /* the shared instruction is not repeated as the title of each run */
  assert.match(jobs[0], /^improve the design of this page/)
})

test('a comma inside a row is part of the row, not a separator', async () => {
  const record = workspace()
  const cards = []
  /* "use the avatar, not an animation" is ONE page with a comma in its title. The
     sentence this becomes is split on commas AND newlines, so a row must own a
     line — joining with ", " turned this into two runs on half a sentence each. */
  await mention.rewrite(
    record,
    "let's spawn 2 @coder improve these\n" +
      '- settings/account -> use the avatar, not an animation\n' +
      '- settings/mcp',
    {
      intent: async () =>
        intent.usable(
          {
            spawn: true,
            rows: [
              'settings/account -> use the avatar, not an animation',
              'settings/mcp',
            ],
            entity: 'coder',
            job: 'improve this page',
          },
          NAMES,
        ),
      hold: async (plan) => {
        cards.push(...plan.rows.map((row) => row.row))
        return { action: 'run' }
      },
      deps: deps({ runEntity: async () => ({ ok: true, answer: 'done', error: '' }) }),
    },
  )
  assert.deepEqual(cards, [
    'settings/account -> use the avatar, not an animation',
    'settings/mcp',
  ])
})

/* ── the plan a model or a fallback may propose ──────────────────── */

test('a plan is only usable when its halves are resolvable', () => {
  const good = {
    spawn: true,
    list: '@youtrack:ENTITY:relates to: ENTITY-25',
    entity: 'coder',
    job: 'fix it',
  }
  assert.deepEqual(intent.usable(good, NAMES), {
    mode: 'rows',
    list: good.list,
    entity: 'coder',
    job: 'fix it',
    derived: false,
  })

  /* a mention kind that cannot enumerate rows */
  assert.equal(intent.usable({ ...good, list: 'ENTITY-25' }, NAMES), null)
  assert.equal(intent.usable({ ...good, list: '@youtrack:' }, NAMES), null)
  /* an empty job runs nothing; an entity we do not have is refused */
  assert.equal(intent.usable({ ...good, job: '  ' }, NAMES), null)
  assert.equal(intent.usable({ ...good, entity: 'ghost' }, NAMES), null)
  assert.equal(intent.usable({ ...good, entity: '@coder' }, NAMES).entity, 'coder')
  assert.equal(intent.usable(null, NAMES), null)
})

test('no harness means no model, so a reader is not built', () => {
  assert.equal(intent.reader({ harness: '' }), null)
  assert.equal(typeof intent.reader({ harness: 'claude' }), 'function')
})

test('the instruction teaches the three shapes and refuses when unsure', () => {
  /* the prompting is the safety mechanism, so it is asserted like code */
  assert.match(intent.INSTRUCTION, /"spawn": false/)
  assert.match(intent.INSTRUCTION, /"rows"/)
  assert.match(intent.INSTRUCTION, /"runs"/)
  /* kind B exists because four agents handed one sentence redesign one page */
  assert.match(intent.INSTRUCTION, /"rows".*one run per item|one run per item/s)
  /* the words are copied, never composed */
  assert.match(intent.INSTRUCTION, /copied as words from the message|Never paraphrase/)
  assert.match(intent.INSTRUCTION, /Unsure\? \{"spawn": false\}/)
})
