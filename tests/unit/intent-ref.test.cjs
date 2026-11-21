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

/* ── the gate ─────────────────────────────────────────────────────── */

test('only a spawn with no count is asked about', () => {
  assert.equal(intent.wantsFanout('spawn @coder fix it'), true)
  /* a fan-out the grammar already reads is never second-guessed */
  assert.equal(intent.wantsFanout('spawn 3 @coder fix it'), false)
  assert.equal(intent.wantsFanout('spawn per @youtrack:AC:bug @coder fix it'), false)
  /* `spawn N` stays prose here; the grammar's own rule decides that, and this
     layer never sees it */
  assert.equal(intent.wantsFanout('spawn 3 tasks in the backlog'), false)
  assert.equal(intent.wantsFanout('@coder fix it'), false)
  assert.equal(intent.wantsFanout('run the tests'), false)
})

test('the ask is read in the prose before the first mention', () => {
  /* The same window `mention-ref` reads its prefixes in: the sentence that
     introduces the ask is part of the ask. */
  assert.equal(intent.wantsFanout("let's spawn @coder fix it"), true)
  /* …and a `spawn` written after a mention belongs to that job's words. */
  assert.equal(intent.wantsFanout('ask @coder to spawn a helper'), false)
  /* a sentence that merely mentions words after it is still prose */
  assert.equal(intent.wantsFanout('@coder fix the backlog'), false)
})

test('the skill prologue the composer inserts is looked past', () => {
  /* `skill-ref` puts `/workspace:x` at the very front as `use this skill <path>` */
  const text = 'use this skill /skills/alpha\n\nspawn @coder fix it'
  assert.equal(intent.wantsFanout(text), true)
  assert.equal(intent.bodyOf(text), 'spawn @coder fix it')
})

/* ── the seam ─────────────────────────────────────────────────────── */

test('a derived plan reaches the ordinary fan-out, one run per row', async () => {
  const record = workspace()
  const jobs = []
  const out = await mention.rewrite(
    record,
    'spawn @coder fix what relates to https://youtrack.example.test/issue/ENTITY-25 #Unresolved',
    {
      /* no reader: the deterministic reading is the fallback, not a second path */
      intent: async (source) => intent.usable(intent.derivePlan(source, { entities: NAMES }), NAMES),
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 3, 'one run per row, not one for the message')
  /* the row is the run's, and it does not repeat the shared instruction */
  assert.match(jobs[0], /^fix what relates to\n\n\(Run 1 of 3: your row is "ENTITY-33 — ENTITY-33 summary"/)
  assert.deepEqual(
    out.mentions.filter((row) => row.kind === 'entity').map((row) => row.row),
    ['ENTITY-33 — ENTITY-33 summary', 'ENTITY-32 — ENTITY-32 summary', 'ENTITY-30 — ENTITY-30 summary'],
  )
  /* the reply above is told the runs happened, so it does not delegate again */
  assert.match(out.text, /3 runs of @coder, one per row above/)
})

test('the hold sees every row before a harness exists', async () => {
  const record = workspace()
  const plans = []
  let runs = 0
  await mention.rewrite(
    record,
    'spawn @coder fix what relates to https://youtrack.example.test/issue/ENTITY-25',
    {
      intent: async (source) => intent.usable(intent.derivePlan(source, { entities: NAMES }), NAMES),
      hold: async (plan) => {
        plans.push(plan)
        return { action: 'run' }
      },
      deps: deps({
        runEntity: async () => {
          runs += 1
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(plans.length, 1, 'one plan per turn')
  assert.equal(plans[0].rows.length, 3)
  assert.equal(runs, 3, 'the run happens after the answer, not before it')
})

test('a leading skill moves into each run instead of being refused', async () => {
  const record = workspace()
  const jobs = []
  /* this is what `skill-ref` hands us: the prologue, then the unreadable spawn */
  await mention.rewrite(
    record,
    'use this skill /skills/code-milestone\n\n' +
      'spawn @coder work the issue relating to ENTITY-25',
    {
      intent: async (source) => intent.usable(intent.derivePlan(source, { entities: NAMES }), NAMES),
      deps: deps({
        runEntity: async (_record, _entity, job) => {
          jobs.push(job)
          return { ok: true, answer: 'done', error: '' }
        },
      }),
    },
  )
  assert.equal(jobs.length, 3)
  /* every run is routed by its own skill, which is the whole rule — and the
     prologue still leads the job, or the harness will not load it */
  for (const job of jobs) {
    assert.match(job, /^use this skill .*skills[\\/]code-milestone\n\nwork the issue relating to/)
  }
  assert.equal(jobs.filter((job) => /use this skill /.test(job)).length, 3)
})

test('no reader, or a reader with nothing to say, leaves the message alone', async () => {
  const record = workspace()
  const jobs = []
  /* exactly today's behaviour: one run, the sentence intact */
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
  assert.match(out.text, /spawn @coder write a poem/, 'the person\'s own words are the prompt')
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

/* ── the plan a model or a fallback may propose ──────────────────── */

test('a plan is only usable when both halves are resolvable', () => {
  const good = { list: '@youtrack:ENTITY:relates to: ENTITY-25', entity: 'coder', job: 'fix it' }
  assert.deepEqual(intent.usable(good, NAMES), { ...good, derived: false })

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

test('the instruction refuses a fan-out it is unsure about', () => {
  /* the prompt is the safety mechanism: an unsure model must answer false */
  assert.match(intent.INSTRUCTION, /Choose `fanout: false` whenever you are unsure/)
  assert.match(intent.INSTRUCTION, /Never invent a filter/)
})
