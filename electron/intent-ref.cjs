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
 *     Only a reader that says nothing (no JSON, an exit code, a timeout) falls
 *     through to `derivePlan`, which still reads a pasted issue URL by itself.
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
/* The `spawn N` ceiling, and the same number `mention-ref` enforces. Kept here
   too so a model's guess is clamped into something runnable rather than thrown
   back as "spawn 9 is more than 5 runs" on a card the person did not write. */
const MAX_RUNS = 5

const INSTRUCTION = [
  'You read one message a person is about to send to a coding agent. Decide what',
  'the message is for, and answer with JSON only — no prose, no code fences.',
  '',
  'Most messages are ONE conversation with an agent, or a plain request. Say so:',
  '{"spawn": false}',
  '',
  'Sometimes the person wants the same instruction run SEVERAL times in parallel,',
  'each copy in its own sub-session — the same job N times, or once per row of a',
  'list. Say so, and name the plan:',
  '{"spawn": true, "runs": 3, "entity": "designer", "job": "To work on the design of each pages."}',
  '{"spawn": true, "list": "@youtrack:ENTITY:relates to: ENTITY-37 #Unresolved", "entity": "coder", "job": "…"}',
  '',
  '- `entity` is the agent the person addressed, without the `@`. It must be one of',
  '  the names given below; never invent one.',
  '- `job` is what EACH run should do, in the person\'s own words. Copy their words',
  '  — do not rewrite, translate or shorten them. Remove two things only: the',
  '  number of copies, and any sentence that is context for the *whole* message',
  '  rather than an instruction to the agent ("By following the design of these',
  '  pages", "I want to improve them"). The job is what one agent is asked to do.',
  '- `runs` is how many parallel copies they asked for — "spawn 4", "four agents",',
  '  "three of you", "give me 2". A number above one is what makes this a fan-out.',
  '  Use `runs` when the copies need no shared list. Take the number out of the',
  '  job: "three passes over the diff" is `runs: 3` with the job "passes over the',
  '  diff", not a job that repeats the count each run already knows.',
  '- `list` is the mention to resolve into rows, in exactly this grammar:',
  '  `@youtrack:<PROJECT KEY>:<query>` — for issues a project relates to,',
  '  `@youtrack:ENTITY:relates to: ENTITY-25 #Unresolved`. Keep any state filter',
  '  the person wrote (#Unresolved, #Resolved) verbatim. Never invent a filter.',
  '  Use `list` instead of `runs` when the copies come from rows.',
  '- An explicit count WINS over a list. `Spawn 3 @coder work on the issues that',
  '  relate to ENTITY-37` is `runs: 3`: they named the number, so give them three.',
  '  Use `list` only when the count comes from the rows ("one per issue", "do each',
  '  one") and no number was written.',
  '',
  'Answer `{"spawn": false}` whenever you are unsure. These are NOT fan-outs:',
  'asking a question, asking for one job for one agent, naming an agent in passing',
  '("remove @designer from the list"), or asking about work already done. A missed',
  'fan-out costs one retype; a wrong one starts several agents on work nobody asked',
  'for.',
].join('\n')

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * The one plan shape the rest of the app reads, or null for "answer directly".
 *
 * Two modes, because a fan-out takes its count from one of two places: `repeat`
 * is the same instruction N times (`spawn 4 @designer …`), `rows` is one run per
 * row a list resolves (`spawn per @youtrack:… @coder …`). A plan of one run is
 * not a fan-out — the grammar already delegates that, and a card for it would be
 * a confirmation step in front of something that already works.
 */
function usable(plan, entities = []) {
  if (!plan || typeof plan !== 'object') return null
  /* The model's own "nothing to fan out" is an answer, not a failed read. */
  if (plan.spawn === false || plan.fanout === false) return null
  const entity = String(plan.entity || '').replace(/^@/, '').trim()
  if (!entity) return null
  if (entities.length && !entities.map(String).includes(entity)) return null
  const job = String(plan.job || '').trim()
  if (!job) return null
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
  if (!Number.isFinite(runs) || runs < 2) return null
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
    /* An explicit "no" is respected. Only silence falls through to the
       deterministic reading below, which still knows a pasted issue URL. */
    if (verdict) return usable(verdict, names)
    return usable(derivePlan(source, { entities: names }), names)
  }
}

module.exports = {
  INSTRUCTION,
  MAX_RUNS,
  bodyOf,
  derivePlan,
  namesEntity,
  usable,
  reader,
  stripIssueClause,
}
