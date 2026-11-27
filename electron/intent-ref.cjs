/**
 * What the message is *for*, when a regex cannot say.
 *
 * `mention-ref` reads a message with regexes, on purpose: `@entity <job>` is a
 * delegation and `spawn N @entity <job>` is N of them. That grammar is exact and
 * cheap, and it stays the first reader. What it cannot do is read *intent* — and
 * a fan-out is intent, so people kept writing it in ways no anchored pattern
 * survives:
 *
 *   - `let's spawn 4 @designer …` — the ask inside a sentence;
 *   - `… @youtrack:ENTITY:3 Work on the issues.` then, on its own line,
 *     `Spawn 3 @coder …` — the ask after a mention, where a read swallowed it.
 *
 * Both were demoted to ONE ordinary run: one card where four were asked for, and
 * no error to say so. Patching the pattern each time is what kept it happening,
 * so the grammar is no longer asked to guess. It is replaced by one classifier
 * call — the same harness that is about to answer the turn — which reads the
 * message and answers either "this is a fan-out, here is the plan" or "nothing
 * to fan out".
 *
 * Four rules keep this from becoming a second, vaguer language:
 *
 *   - **The grammar goes first.** A message the grammar reads exactly never costs
 *     a call; a message that names no entity with a job can delegate nothing, so
 *     it never costs one either.
 *   - **It proposes; the person confirms.** The plan lands in the ordinary
 *     fan-out path, so every row, its folder and the count are on the hold card
 *     before a harness starts. A wrong guess costs one keystroke, not six agents.
 *   - **It cannot invent a name.** The entity must be one this workspace has, and
 *     a plan that fails to produce a usable one is dropped — the message then
 *     runs exactly as it does today.
 *   - **Silence is not a guess.** An explicit `{"spawn": false}` is respected.
 *     When the message pastes an issue URL, `derivePlan` is authoritative for
 *     the *list*: the URL already names the exact tracker query, and a model
 *     that writes its own (`relates to: unresolved`) can resolve to nothing.
 */
const { runOneShot, lastJson } = require('./oneshot.cjs')

/* `skill-ref` resolves a leading `/workspace:x` into `use this skill <path>` and
   puts it at the very front, so every reading below has to look past it. */
const SKILL_PROLOGUE = /^use this skill \S+\s*\n+/i

/** The message without the skill prologue the composer's `/skill` put there. */
function bodyOf(text) {
  const source = String(text || '')
  const prologue = source.match(SKILL_PROLOGUE)
  return prologue ? source.slice(prologue[0].length) : source
}

/* The whole token, so `/Entity-v0.0.7` does not survive into the job. */
const ISSUE_URL = /https?:\/\/\S*?\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_JOB = 4_000
/* A typed row list is capped like a resolved one, and for the same reason: the
   reply above reads a bounded number of rows, and a fan-out may not silently
   lose an answer. Kept equal to `mention-ref`'s `MAX_FANOUT_ROWS`. */
const MAX_FANOUT_ROWS = 12
/* The `spawn N` ceiling, and the same number `mention-ref` enforces. Kept here
   too so a model's guess is clamped into something runnable rather than thrown
   back as "spawn 9 is more than 5 runs" on a card the person did not write. */
const MAX_RUNS = 5

const INSTRUCTION = [
  'Read one message a person is sending to a coding agent. Answer what it is for.',
  'JSON only, no prose.',
  '',
  'ONE conversation or one plain request — the usual case:',
  '{"spawn": false}',
  '',
  'SEVERAL runs — ONE ENTRY PER RUN, in the order they were asked for. Each entry',
  'names the agent for that run and, in its own words, what that run must do:',
  '{"spawn": true, "runs": [{"entity": "coder", "job": "implement A, use an orca child worktree"}, {"entity": "coder", "job": "implement B, update the main instruction"}]}',
  'The same job N times is that same shape with the entry repeated N times. A',
  'different agent per run is allowed.',
  '',
  'A LIST OF ITEMS under one instruction is `rows` — one run per item, and the',
  'item travels with its run:',
  '{"spawn": true, "rows": ["a", "b", "c"], "entity": "designer", "job": "improve this page"}',
  '{"spawn": true, "list": "@youtrack:ENTITY:relates to: ENTITY-25", "entity": "coder", "job": "fix it"}',
  '',
  'ONE run for one agent — `spawn 1`, or a sentence that names a repo, file or issue',
  'AFTER the agent so the job itself is cut short. Give the whole instruction as',
  '`job`, including what came after that reference, and name the repo/path inside it',
  'in words:',
  '{"spawn": true, "runs": [{"entity": "designer", "job": "redesign the MCP detail page at http://…/mcp/youtrack in <repo path>"}]}',
  '',
  'How to split runs:',
  '- Every line or bullet that orders something is its own run, with THAT order as',
  '  its job. Two orders are two entries — never hand both to both runs.',
  '- A bulleted list of things to work on (pages, files, URLs, issues) under one',
  '  instruction is `rows`, not entries that repeat the same words.',
  '- A written count (`spawn 3`) with nothing listed is that many entries with the',
  '  same job.',
  '- Every sentence that tells an agent something to do must survive in its job.',
  '',
  '- `entity`: the agent addressed, without `@`, from the names below.',
  '- `job`: what ONE run does, copied as words from the message. Drop the count and',
  '  the items. Never paraphrase or add a clause. A job is never empty and never',
  '  just the agent\'s name.',
  '- `rows`/`list`: the items, one per run, in their words.',
  '',
  'The word `spawn` immediately before an agent (`spawn @coder …`) is always a',
  'fan-out, even with no number — pick a sensible number of entries (3) and let the',
  'confirmation card correct it. "spawn 3 tasks in the backlog" is not (no agent).',
  '',
  'Unsure? {"spawn": false}. Not fan-outs: a question, one job for one agent, naming',
  'an agent in passing, work already done.',
].join('\n')

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A number of copies the message asks for, written down.
 *
 * `spawn 4`, `Spawn 3`, `spawn 2` — the grammar's own prefix, read from the same
 * opening prose. Used only to keep a plan honest: a model that answers `rows`
 * over a sentence with a count and no list has invented the items.
 */
function writtenCount(source) {
  const match = /\bspawn\s+(\d{1,2})\b/i.exec(String(source || ''))
  const count = match ? Number(match[1]) : 0
  return Number.isFinite(count) && count >= 2 ? count : 0
}

/**
 * The last run of bullets in the message, as words — every bullet, whatever it
 * says. `listedItems` is the narrower reading of the same text: a row list is
 * one *item* per bullet, while a bullet can also be an *order* (see `runs`).
 *
 * Deliberately structural only: a bullet someone wrote is read as a bullet, not
 * interpreted. Both readings start here, so they can never disagree about what
 * the list is.
 */
function bulletRun(source) {
  const lines = String(source || '').split(/\r?\n/)
  const isBullet = (line) => /^\s*[-*+]\s+\S/.test(line)
  /* The LAST list is the work. A message often opens with one list of material
     to read ("By following the design of:") and then lists what to touch
     ("I want to improve the design of these pages:"). Only one of those is the
     fan-out, and it is the one nearest the instruction at the end. */
  let end = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isBullet(lines[index])) {
      end = index
      break
    }
  }
  if (end < 0) return []
  /* Walk back to the start of that run of bullets, over blank lines only. */
  let start = end
  for (let index = end - 1; index >= 0; index -= 1) {
    if (isBullet(lines[index])) start = index
    else if ('' === lines[index].trim()) continue
    else break
  }
  return lines
    .slice(start, end + 1)
    .filter(isBullet)
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * The items a message enumerates, if it enumerates any.
 *
 * A markdown bullet list is the one structural hint a message gives about
 * itself, and it is the same hint that means "one run per item": four bullets
 * are four things, and four agents handed one sentence would each redesign the
 * same page. Reading the list here — from the text, cheaply — is not a guess
 * about intent, it is reading what is literally on screen. The classifier is
 * told to prefer `rows` for a list; this is what happens when it does not,
 * including when it read a written count instead.
 *
 * Deliberately narrow: at least two bullets, and each carrying a URL, a path or
 * an `@` reference. Prose someone bulleted is not a list of items — it may be a
 * list of orders instead (`repairWithRuns`), and a single bullet is not a list.
 */
function listedItems(source) {
  const rows = bulletRun(source)
  if (rows.length < 2) return []
  /* At least two real references — a URL, an `@`-path, or a path-like token — or
     it is prose someone bulleted, not a list of items to split. */
  const concrete = rows.filter((row) => /https?:\/\/|@[\w./-]+|[\w-]+\/[\w./-]+/.test(row))
  if (concrete.length < 2) return []
  return rows.slice(0, MAX_FANOUT_ROWS)
}

/**
 * The last thing the message says after its list — the instruction that applies
 * to every item ("let's spawn 4 @designer To work on the design of each pages").
 */
function afterList(source) {
  const lines = String(source || '').split(/\r?\n/)
  let last = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*[-*+]\s+\S/.test(lines[index])) last = index
  }
  if (last < 0) return ''
  return lines.slice(last + 1).join('\n').trim()
}

/**
 * Does this message address an entity at all?
 *
 * The one check made before the model, and it is not a parse of intent: a message
 * that names no agent has nothing to delegate to, so the answer is provable
 * without asking. It is what keeps "Take your time." and "why did the build
 * fail?" on the direct path — waiting for a classifier to say `spawn: false`
 * about a sentence with no `@` in it is latency nobody gets back.
 */
function namesEntity(source, entities = []) {
  const text = String(source || '')
  if (!text.includes('@')) return false
  if (!entities.length) return true
  return entities.some((name) => new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(text))
}

/**
 * The person's instruction, with the reference to the list taken out of it.
 *
 * Deliberately not a rewrite: every run is told its own row separately (see
 * `shareNote`), so all this has to remove is the part that names the *list* —
 * the URL, the state filter, the leading verb and the addressed entity. What is
 * left is the words the person actually wrote, which is what a run should be
 * given. Surgery that tried to rebuild the sentence produced jobs like "work the
 * issue relating to", which is worse than a leftover clause.
 */
function stripIssueClause(source, key, entity) {
  let rest = String(source || '')
  const at = rest.toLowerCase().indexOf(`@${String(entity).toLowerCase()}`)
  if (at >= 0) rest = rest.slice(at + entity.length + 1)

  const surgical = (value) =>
    value
      .replace(new RegExp(`https?:\\/\\/\\S*?\\/${escapeRegExp(key)}\\b\\S*`, 'gi'), ' ')
      .replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, 'gi'), ' ')
      .replace(/#(?:Unresolved|Resolved)\b/gi, ' ')
      .replace(/^[\s,;:–—-]+/, '')
      .replace(/^\s*spawn\b\s*/i, '')
      .replace(/[\t ]+/g, ' ')
      .trim()

  /* The clause that names the list is almost always its own sentence — "entity
     for each issue relates to : <url> #Unresolved only." then the instruction.
     Dropping the leading sentences that introduce the list leaves the words the
     person wrote for the work, which is what a run should be given. */
  const sentences = rest.split(/(?<=[.!?])\s+/)
  const introduces = (sentence) =>
    /(for each|each issue|relates to|#unresolved|#resolved)/i.test(sentence) ||
    sentence.includes(key)
  let start = 0
  while (start < sentences.length - 1 && introduces(sentences[start])) start += 1
  if (start > 0) {
    const remainder = surgical(sentences.slice(start).join(' '))
    if (remainder.split(/\s+/).filter(Boolean).length >= 3) return remainder
  }
  return surgical(rest)
}

/**
 * The plan this message plainly encodes, without asking a model.
 *
 * A pasted YouTrack URL *is* the list: `https://…/issue/ENTITY-25/Entity-v0.0.7`
 * names one issue, and the documented query for its children is
 * `@youtrack:ENTITY:relates to: ENTITY-25`. Returns null when the message carries
 * no issue key at all, which is the signal that this is not this kind of message.
 *
 * This is the fallback for a reader that said *nothing* — never for one that said
 * `{"spawn": false}`.
 */
function derivePlan(text, { entities = [] } = {}) {
  const source = bodyOf(text)
  const url = ISSUE_URL.exec(source)
  const key = url ? url[1] : ((ISSUE_KEY.exec(source) || [])[1] || '')
  if (!key) return null

  /* The addressed entity has to be a real one: a plan that names an entity this
     workspace does not have would be refused further down, after the person has
     already read a card. */
  const entity = entities
    .map(String)
    .find((name) => new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(source))
  if (!entity) return null

  const project = key.replace(/-\d+$/, '')
  /* The state filter is the person's, not ours: keeping `#Unresolved` when they
     wrote it is the difference between one issue and a backlog. */
  const filter = /#Unresolved\b/i.test(source)
    ? ' #Unresolved'
    : /#Resolved\b/i.test(source)
      ? ' #Resolved'
      : ''
  const list = `@youtrack:${project}:relates to: ${key}${filter}`
  const job = stripIssueClause(source, key, entity)
  /* A job of one word is not an instruction, and it is not this layer's call to
     invent one — an unreadable message runs exactly as it does today. */
  if (!job || job.split(/\s+/).filter(Boolean).length < 3) return null
  return { mode: 'rows', list, entity, job: job.slice(0, MAX_JOB), derived: true }
}

/**
 * A pasted issue URL beats the model's tracker query.
 *
 * The URL already spells the list (`…/issue/ENTITY-25/…` plus `#Unresolved`),
 * and `derivePlan` reads it exactly. A model given the same sentence can still
 * answer a query that is shaped like a link search but loses the issue key —
 * `@youtrack:ENTITY-25:relates to: unresolved` treats the issue id as a project
 * and asks for issues relating to the word "unresolved". That resolves zero
 * rows, so the turn runs nothing and no confirmation card ever appears. Keep
 * the model's `entity` and `job` (it read the instruction in context), but take
 * the list from the URL.
 *
 * An explicit `spawn: false` never reaches here as a plan, so it stays respected.
 */
function repairWithIssue(source, plan) {
  if (!plan || plan.mode !== 'rows' || !plan.list) return plan
  if (!/^@?youtrack:/i.test(plan.list)) return plan
  const derived = derivePlan(source, { entities: [plan.entity] })
  if (!derived || derived.list === plan.list) return plan
  return { ...plan, list: derived.list, derived: true }
}

/**
 * The one plan shape the rest of the app reads, or null for "answer directly".
 *
 * `runs` is the plan: one entry per run, each with its agent and its own words.
 * Three readings are kept for compatibility and because the card says them
 * better: `repeat` (one instruction N times), `typed` (N rows the person typed,
 * one shared job) and `rows` (one run per row a list resolves).
 *
 * **One run is a real plan.** It used to be dropped here — "the grammar already
 * delegates that" — which was only true when the grammar could read the job. A
 * message whose job the grammar cut off (`@designer on @orca:entity <the ask>`
 * gives the job `"on"`) needs the classifier to propose the run it could not
 * read, and that plan is for exactly one session. Rejecting it meant the one
 * case that reached this layer was the one case it refused to answer.
 */
function usable(plan, entities = []) {
  if (!plan || typeof plan !== 'object') return null
  /* The model's own "nothing to fan out" is an answer, not a failed read. */
  if (plan.spawn === false || plan.fanout === false) return null
  /* One entry per run: the shape the prompt asks for. Two runs may name two
     agents, and they may say two different things — that is the whole point of
     a list instead of a count. */
  if (Array.isArray(plan.runs)) {
    const fallback = String(plan.entity || '').replace(/^@/, '').trim()
    const runs = []
    for (const entry of plan.runs) {
      const row = entry && typeof entry === 'object' ? entry : { job: entry }
      const runEntity = String(row.entity || '').replace(/^@/, '').trim() || fallback
      const runJob = String(row.job ?? '').trim()
      if (!runEntity || !runJob) continue
      if (entities.length && !entities.map(String).includes(runEntity)) return null
      runs.push({ entity: runEntity, job: runJob.slice(0, MAX_JOB) })
    }
    if (!runs.length) return null
    runs.splice(MAX_RUNS)
    /* The same words to the same agent N times is the repeat shape: the grammar
       and the card already say "one instruction, N sessions" better than N equal
       entries do, and the parent prompt reads it that way. */
    const same = runs.every(
      (run) => run.entity === runs[0].entity && run.job === runs[0].job,
    )
    if (same) {
      return {
        mode: 'repeat',
        runs: runs.length,
        entity: runs[0].entity,
        job: runs[0].job,
        derived: Boolean(plan.derived),
      }
    }
    return { mode: 'runs', runs, derived: Boolean(plan.derived) }
  }

  const entity = String(plan.entity || '').replace(/^@/, '').trim()
  if (!entity) return null
  if (entities.length && !entities.map(String).includes(entity)) return null
  const job = String(plan.job || '').trim()
  if (!job) return null
  /* Items the person wrote themselves. They become `spawn per [a, b] …`, so a
     row is a session title and a different page per run — the thing a repeat
     cannot express. Capped like every other list, and a duplicate row would be
     two agents on one page, so it is dropped here rather than run twice. */
  if (Array.isArray(plan.rows)) {
    const rows = plan.rows
      /* A newline separates two items; a comma does NOT. "account -> use the
         profile avatar, not an animation" is one page with a comma in its name,
         and splitting it would invent a fifth run on half a sentence. */
      .flatMap((row) => String(row ?? '').split(/\n/))
      .map((row) => row.trim())
      .filter(Boolean)
      .filter((row, index, all) => all.indexOf(row) === index)
      .slice(0, MAX_FANOUT_ROWS)
    if (rows.length < 2) return null
    return { mode: 'typed', rows, entity, job: job.slice(0, MAX_JOB), derived: Boolean(plan.derived) }
  }
  const list = String(plan.list || '').trim()
  if (list) {
    /* a bare `@youtrack:` resolves nothing, so the kind has to carry a query */
    if (!/^@?(?:youtrack|orca|artifact|maka):\S/.test(list)) return null
    return {
      mode: 'rows',
      list: list.startsWith('@') ? list : `@${list}`,
      entity,
      job: job.slice(0, MAX_JOB),
      derived: Boolean(plan.derived),
    }
  }
  const runs = Math.trunc(Number(plan.runs ?? plan.count))
  if (!Number.isFinite(runs) || runs < 1) return null
  return {
    mode: 'repeat',
    runs: Math.min(runs, MAX_RUNS),
    entity,
    job: job.slice(0, MAX_JOB),
    derived: Boolean(plan.derived),
  }
}

/** The classification, or null when the answer carried no JSON at all. */
function parseAnswer(text) {
  const parsed = lastJson(text)
  return parsed && typeof parsed === 'object' ? parsed : null
}

/**
 * The plan a reader's answer produces, or the deterministic one when the answer
 * could not be read as a plan.
 *
 * Silence and a malformed answer are not the same thing, but neither is a
 * verdict. Only an explicit `spawn: false` / `fanout: false` says "answer this
 * directly"; a model that names a list the app cannot resolve (a bare sentence,
 * a URL, a 40-run count) has not said no. Falling back to `derivePlan` here is
 * what keeps a pasted issue URL working when the model writes the list in prose
 * instead of an `@youtrack:` token: without it the grammar below reads the
 * message as one ordinary `@coder` run and no confirmation card appears.
 */
function choosePlan(source, verdict, entities = []) {
  const fromVerdict = usable(verdict, entities)
  if (fromVerdict) return fromVerdict
  if (verdict && (verdict.spawn === false || verdict.fanout === false)) return null
  return usable(derivePlan(source, { entities }), entities)
}

/**
 * A reader bound to one harness: the same voice that is about to answer the turn
 * decides what the turn is. `null` when there is no harness to ask, so callers
 * can pass it unconditionally and get only the deterministic fallback.
 */
function reader({ harness = '', model = '', entities = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = String(harness || '')
  if (!id) return null
  const names = entities.map(String).filter(Boolean)
  return async function readMessage(text) {
    const source = bodyOf(text)
    /* Nothing addressed, nothing to delegate to — answered without a call. */
    if (!namesEntity(source, names)) return null
    let verdict = null
    try {
      const result = await runOneShot({
        harness: id,
        model,
        instruction: INSTRUCTION,
        prompt: [
          names.length ? `Entities in this workspace: ${names.join(', ')}` : '',
          '',
          '<message>',
          source,
          '</message>',
        ]
          .filter(Boolean)
          .join('\n'),
        timeoutMs,
        label: 'classify message',
      })
      verdict = parseAnswer(result.text)
    } catch {
      /* a harness that will not answer is a harness with nothing to say */
      verdict = null
    }
    /* An explicit "no" is respected. A verdict that did name a list is still
       checked against a pasted issue URL, and a silent or unreadable answer
       falls through to the deterministic reading, which knows that URL too. */
    const plan = repairWithList(
      source,
      repairWithRuns(source, repairWithIssue(source, choosePlan(source, verdict, names)), names),
      names,
    )
    return plan
  }
}

/**
 * A bulleted message is a list, whatever the model said.
 *
 * The classifier is told to prefer `rows` for an enumerated message, and it
 * still sometimes answers `runs: 4` — which gives four agents the same sentence
 * and four redesigns of one page, the exact failure this layer exists to stop.
 * The list is on screen, so it is read from the text rather than trusted to a
 * model that may be paraphrasing. Narrow on purpose:
 *
 *   - only a plan that is missing the rows is repaired (a model that already
 *     answered `rows`/`typed` is left alone, it saw something better);
 *   - only a `repeat`/direct plan over a message with 2+ concrete bullets;
 *   - the entity must still be one the model named, or one this workspace has.
 */
function repairWithList(source, plan, entities = []) {
  /* A written count is a written count: `Spawn 3 @coder …` with nothing bulleted
     is three runs whatever query a model read into the sentence. Turning that
     into `rows` invents items the person did not list. */
  if (plan && plan.mode !== 'repeat') {
    if (plan.mode !== 'rows') return plan
    const written = writtenCount(source)
    if (!written) return plan
    const rowsHere = listedItems(source)
    if (rowsHere.length >= 2) return plan
    return {
      mode: 'repeat',
      runs: Math.min(written, MAX_RUNS),
      entity: plan.entity,
      job: plan.job,
      derived: true,
    }
  }
  const rows = listedItems(source)
  if (rows.length < 2) return plan
  /* The agent is the one the classifier named, else the one the message names. */
  const entity =
    plan?.entity ||
    entities
      .map(String)
      .find((name) => new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(source))
  if (!entity) return plan
  /* The instruction travels with the list: the last thing said after it. */
  const tail = afterList(source)
  const job = String(plan?.job || '').trim() || tail.replace(/^\s*spawn\s+\d+\s+/i, '')
  if (!job) return plan
  return { mode: 'typed', rows, entity, job: job.slice(0, MAX_JOB), derived: true }
}

/**
 * A written count over bullets that are ORDERS is one run per bullet.
 *
 * `spawn 2 @coder:` followed by two lines that each say what that run must do is
 * not two copies of one sentence and not a row list: the bullets are the jobs.
 * The grammar cannot see this — it hands both runs the whole message, so both
 * sessions open with the same paragraph and neither says which half is theirs.
 *
 * Deliberately narrow, and only when the model said nothing at all: a plan that
 * did come back is a reading of the message, and its bullets may as well be
 * *items* with one shared instruction (that is `rows`). What is provable without
 * a model is the written count agreeing with the bullets on screen. It exists
 * for the turns with no classifier — the CLI, a spawned session — never as a
 * second guess at an answer.
 */
function repairWithRuns(source, plan, entities = []) {
  if (plan) return plan
  const written = writtenCount(source)
  if (written < 2) return plan
  const bullets = bulletRun(source)
  if (bullets.length !== written) return plan
  /* Concrete references are items, not orders: `repairWithList` reads those. */
  if (listedItems(source).length >= 2) return plan
  const entity = entities
    .map(String)
    .find((name) => new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(source))
  if (!entity) return plan
  return {
    mode: 'runs',
    runs: bullets.slice(0, MAX_RUNS).map((job) => ({ entity, job })),
    derived: true,
  }
}

module.exports = {
  INSTRUCTION,
  MAX_RUNS,
  bodyOf,
  bulletRun,
  choosePlan,
  derivePlan,
  listedItems,
  namesEntity,
  repairWithIssue,
  repairWithRuns,
  repairWithList,
  usable,
  writtenCount,
  reader,
  stripIssueClause,
}
