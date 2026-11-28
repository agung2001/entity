/**
 * A transcript has to stay readable, and the history has to stay openable.
 *
 * Two rules, both paid for on a real profile (a workspace of a few hundred
 * conversations came to 221 MB, one thread of *eight messages* was 20 MB, and
 * opening any thread took 1.3 s):
 *
 *  1. a delegated run's step trace belongs to the session it spawned. The
 *     parent keeps a digest — the last few steps and the paths the dropped ones
 *     named — and it is bounded at write *and* at read, so a file written
 *     before the digest existed compacts itself on its next rewrite;
 *  2. attribution needs the sibling threads to decide who wrote a file, so it
 *     reads their files — keyed on each file's own mtime and size, never
 *     re-parsed when nothing changed, and never read at all by a conversation
 *     that could not own anything on the shelf.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { digestSteps, MAX_STEPS } = require('../../electron/mention-digest.cjs')

/* ── the digest itself ──────────────────────────────────────────────── */

function fatStep(index) {
  return {
    seq: index + 1,
    type: index % 2 ? 'tool_result' : 'tool_use',
    at: '2026-11-20T10:00:00.000Z',
    tool: index % 2 ? undefined : 'bash',
    content: 'x'.repeat(40_000),
    output: 'y'.repeat(40_000),
    input: {
      command: 'git -C /Users/ada/orca/workspaces/scope-shelf/app status',
      path: 'z'.repeat(5_000),
    },
    durationMs: 12,
  }
}

test('a digest keeps the tail a card reads and drops the rest', () => {
  const steps = Array.from({ length: 40 }, (_, index) => fatStep(index))
  const digest = digestSteps(steps)

  assert.equal(digest.steps.length, MAX_STEPS)
  assert.equal(digest.steps.at(-1).seq, 40, 'the newest step is kept')
  /* the tool a card prints, and its input, survive the clip */
  assert.ok(digest.steps.some((step) => step.tool === 'bash'))
  assert.ok(digest.steps.some((step) => String(step.input?.command || '').includes('git -C')))
  /* bounded: 40 steps × 80 kB was 3.2 MB */
  assert.ok(JSON.stringify(digest).length < 40_000, JSON.stringify(digest).length)
})

test('the paths the dropped steps named are carried forward', () => {
  const steps = Array.from({ length: 40 }, (_, index) => fatStep(index))
  const digest = digestSteps(steps)
  assert.ok(
    digest.paths.includes('/Users/ada/orca/workspaces/scope-shelf/app'),
    JSON.stringify(digest.paths),
  )
})

test('a trace that already fits is left alone, and an absent one is empty', () => {
  assert.deepEqual(digestSteps(undefined), { steps: [], paths: [] })
  const one = [{ seq: 1, type: 'text', at: '', content: 'hello' }]
  assert.deepEqual(digestSteps(one).steps, one)
})

test('a digest is idempotent', () => {
  const once = digestSteps(Array.from({ length: 12 }, (_, index) => fatStep(index)))
  const twice = digestSteps(once.steps)
  assert.deepEqual(twice.steps, once.steps)
})

/* ── the transcript, on disk ────────────────────────────────────────── */

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-digest-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `digest-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'designer', harness: 'pi' })
  return workspaces.open(created.id)
}

const AT = '2026-11-20T10:00:00.000Z'
const LATER = '2026-11-20T10:05:00.000Z'

/** A parent turn that delegated, as an older build wrote it: trace and all. */
function fatParent(record, { steps = 40 } = {}) {
  const id = `t_fat${String(++seq).padStart(4, '0')}`
  const mention = {
    kind: 'entity',
    token: '@secretary',
    name: 'secretary',
    job: 'review the page',
    answer: 'It is a portfolio, and the nav is one row.',
    status: 'ok',
    ms: 4200,
    threadId: 't_session1',
    execution: { harness: 'pi', status: 'ok', startedAt: AT, endedAt: LATER },
    steps: Array.from({ length: steps }, (_, index) => fatStep(index)),
  }
  const file = path.join(record.path, 'chats', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 1,
        id,
        entity: 'designer',
        machine: 'local',
        harness: 'pi',
        title: 'a fat thread',
        createdAt: AT,
        updatedAt: AT,
        messages: [
          { who: 'me', id: 'm_1', text: '@secretary review the page', at: AT, mentions: [mention] },
          {
            who: 'agent',
            id: 'm_2',
            text: 'Done — three findings.',
            at: LATER,
            execution: {
              harness: 'pi',
              status: 'ok',
              startedAt: AT,
              endedAt: LATER,
              mentions: [mention],
            },
          },
        ],
      },
      null,
      2,
    ),
  )
  return id
}

/** A transcript with nothing to digest: many messages, none of them a trace. */
function wideParent(record) {
  const id = `t_wide${String(++seq).padStart(4, '0')}`
  const messages = []
  for (let index = 0; index < 160; index += 1) {
    messages.push({
      who: index % 2 ? 'agent' : 'me',
      id: `m_${index}`,
      text: `${index}: ${'the nav is one row and the shelf is a grid. '.repeat(50)}`,
      at: AT,
    })
  }
  const file = path.join(record.path, 'chats', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 1,
        id,
        entity: 'designer',
        machine: 'local',
        harness: 'pi',
        title: 'a long thread with nothing to digest',
        createdAt: AT,
        updatedAt: LATER,
        messages,
      },
      null,
      2,
    ),
  )
  return id
}

const fileOf = (record, id) => path.join(record.path, 'chats', `${id}.json`)

test('a read answers a digest of a trace written before the digest existed', () => {
  const record = workspace()
  const id = fatParent(record)
  const before = fs.statSync(fileOf(record, id)).size

  const read = chats.read({ workspace: record.id, id })
  const mention = read.messages[0].mentions[0]

  assert.equal(mention.steps.length, MAX_STEPS)
  assert.ok(mention.paths.length, 'the dropped trace still names its paths')
  assert.equal(mention.answer, 'It is a portfolio, and the nav is one row.')
  assert.equal(mention.threadId, 't_session1')
  assert.equal(mention.execution.status, 'ok')
  /* the answer row carries the same digest, not a second full copy */
  assert.equal(read.messages[1].execution.mentions[0].steps.length, MAX_STEPS)
  assert.ok(JSON.stringify(read).length < before / 20)
  /* reading is not writing: the file is compacted when it is rewritten */
  assert.equal(fs.statSync(fileOf(record, id)).size, before)
})

test('the next rewrite of the file is the compaction, and nothing a card needs is lost', () => {
  const record = workspace()
  const id = fatParent(record)
  const before = fs.statSync(fileOf(record, id)).size

  chats.rename({ workspace: record.id, id, title: 'a smaller thread' })
  const after = fs.statSync(fileOf(record, id)).size
  assert.ok(after < before / 20, `${before} → ${after}`)

  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.title, 'a smaller thread')
  const mention = read.messages[0].mentions[0]
  assert.equal(mention.answer, 'It is a portfolio, and the nav is one row.')
  assert.equal(mention.steps.length, MAX_STEPS)
  assert.ok(mention.paths.some((entry) => entry.includes('orca/workspaces')))
})

/* ── the background sweep ───────────────────────────────────────────── */

test('a sweep compacts the transcripts a previous build wrote fat, and leaves the rest', () => {
  const record = workspace()
  const fat = fatParent(record)
  /* over the size floor but already as small as it can be: a sweep rewrites it
     only if that would halve it, and there is nothing to halve */
  const lean = wideParent(record)
  const before = {
    fat: fs.statSync(fileOf(record, fat)).size,
    lean: fs.statSync(fileOf(record, lean)).size,
  }
  assert.ok(before.lean > 256 * 1024, `${before.lean} is over the size floor`)

  const sweep = chats.compactLegacy({ workspace: record.id })
  assert.equal(sweep.compacted, 1)
  assert.ok(sweep.saved > before.fat / 2, `${sweep.saved} of ${before.fat}`)

  assert.ok(fs.statSync(fileOf(record, fat)).size < before.fat / 4)
  /* a file that would not shrink is not rewritten at all */
  assert.equal(fs.statSync(fileOf(record, lean)).size, before.lean)

  /* the compaction is a rewrite, not a deletion: the card still has everything */
  const read = chats.read({ workspace: record.id, id: fat })
  const mention = read.messages[0].mentions[0]
  assert.equal(mention.answer, 'It is a portfolio, and the nav is one row.')
  assert.equal(mention.status, 'ok')
  assert.equal(mention.steps.length, MAX_STEPS)
  assert.ok(mention.paths.some((entry) => entry.includes('orca/workspaces')))
  /* and the history still lists it */
  assert.ok(chats.list({ workspace: record.id }).some((row) => row.id === fat))
})

test('a sweep honours its limit, and the background one runs at most once per workspace', () => {
  const record = workspace()
  fatParent(record)
  fatParent(record)
  const one = chats.compactLegacy({ workspace: record.id, limit: 1 })
  assert.equal(one.compacted, 1)
  assert.ok(one.scanned >= 2)
  const rest = chats.compactLegacy({ workspace: record.id })
  assert.ok(rest.compacted >= 1)

  /* fire-and-forget answers a boolean: true the first time, false afterwards */
  const other = workspace()
  fatParent(other)
  assert.equal(chats.compactLegacySoon({ workspace: other.id }), true)
  assert.equal(chats.compactLegacySoon({ workspace: other.id }), false)
  assert.equal(chats.compactLegacySoon({}), false)
})

/* ── the caches ─────────────────────────────────────────────────────── */

test('the history answers the same rows twice, and a change is not cached', () => {
  const record = workspace()
  const id = fatParent(record, { steps: 4 })
  chats.create({ workspace: record.id, entity: 'designer', harness: 'pi' })

  const first = chats.list({ workspace: record.id })
  const second = chats.list({ workspace: record.id })
  assert.deepEqual(second, first)
  assert.equal(first.length, 2)

  chats.rename({ workspace: record.id, id, title: 'renamed just now' })
  const third = chats.list({ workspace: record.id })
  assert.equal(third.find((row) => row.id === id).title, 'renamed just now')
})

test('a thread that could not own a shelf file still opens, and stays put', () => {
  const record = workspace()
  const id = fatParent(record, { steps: 4 })
  /* the shelf has one file, from before this conversation existed: the fast
     path is what keeps this open from parsing every sibling to learn that */
  const shelf = path.join(record.path, 'artifacts')
  fs.mkdirSync(shelf, { recursive: true })
  fs.writeFileSync(path.join(shelf, 'old-shot.png'), 'png bytes')
  const early = new Date('2026-11-20T09:00:00.000Z')
  fs.utimesSync(path.join(shelf, 'old-shot.png'), early, early)

  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.messages[1].artifacts, undefined, 'the earlier file is not this turn’s')

  /* a new sibling, then the same thread again: the window cache is keyed per
     file, so the new conversation is seen and the old answers are unchanged */
  const other = chats.create({ workspace: record.id, entity: 'designer', harness: 'pi' })
  assert.ok(chats.read({ workspace: record.id, id: other.id }))
  assert.equal(chats.read({ workspace: record.id, id }).messages[1].artifacts, undefined)
})
