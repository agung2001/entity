/**
 * What the person meant, when the grammar cannot read it.
 *
 * `mention-ref` reads a message with regexes, on purpose: a fan-out is *asked
 * for*, never inferred, so `spawn 3 @coder …` runs three times and
 * `spawn @coder …` used to run once — silently, because a bare `spawn` matches
 * no prefix and the sentence therefore became one ordinary job.
 *
 * That silent case is what this module exists for. The person typed `spawn` and
 * a count was nowhere to be found; the intent is unambiguously "one run per
 * something", and the something is usually an issue list pasted as a URL. Rather
 * than teach the grammar to guess, we ask the harness that is about to run the
 * turn, and hand `mention-ref` back a `spawn per …` sentence it already knows
 * how to read.
 *
 * Three rules keep this from becoming a second, vaguer language:
 *
 *   - **Only for an unanswered `spawn`.** `wantsFanout` is a cheap, deterministic
 *     gate: a message the grammar already understands is never second-guessed,
 *     so this costs one model call on the one shape that used to fail, and none
 *     on anything else.
 *   - **It proposes; the person confirms.** The rewrite lands in the ordinary
 *     fan-out path, so the rows, their folders and the count are on the hold card
 *     before a harness starts. A wrong guess costs one keystroke, not six agents.
 *   - **It cannot invent a name.** The entity must be one this workspace has, the
 *     list must be a mention `mention-ref` resolves, and a plan that fails to
 *     produce both is dropped — the message then runs exactly as it does today.
 *
 * When the model is unavailable (no harness, a CLI that errors, garbage output)
 * `derivePlan` still reads the pasted issue URL deterministically. A fallback
 * that is a little blunt beats a fan-out that silently never happens.
 */
const { runOneShot, lastJson } = require('./oneshot.cjs')

/* The one shape that used to swallow the request: `spawn` with no count after
   it. `spawn 3 @x` and `spawn per @x` both parse; `spawn @x` did not.

   Read in the prose *before the first mention*, which is the same window
   `mention-ref` reads its prefixes in: `let's spawn @coder …` is the ask written
   the way people write it, and anchoring this to `^` would run it once. */
const SPAWN_WITHOUT_COUNT = /\bspawn\b(?!\s+(?:per\b|\d))/i
/* The first mention's `@`, so everything before it is prose and everything
   after it is a mention's own text. */
const FIRST_MENTION = /(^|[\s(\[])@(?=@?[A-Za-z0-9._-])/

/* `skill-ref` resolves a leading `/workspace:x` into `use this skill <path>` and
   puts it at the very front, so every check below has to look past it. */
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

const INSTRUCTION = [
  'You read one message a person is about to send to a coding agent, and you decide',
  'whether it asks for ONE job or for MANY separate runs of one instruction.',
  '',
  'Answer with JSON only — no prose, no code fences:',
  '{"fanout":true,"list":"@youtrack:…","entity":"coder","job":"…"}',
  '',
  '- `fanout` is true only when the person wants several separate runs, one per row',
  '  of a list (one per issue, one per file, one per scene). Asking to "create one',
  '  issue" or to "fix this bug" is ONE run: `fanout: false`.',
  '- `list` is the mention for that list, in exactly this grammar:',
  '  `@youtrack:<PROJECT KEY>:<query>` — for issues a project relates to,',
  '  `@youtrack:ENTITY:relates to: ENTITY-25 #Unresolved`. Keep any state filter',
  '  the person wrote (#Unresolved, #Resolved) verbatim. Never invent a filter.',
  '- `entity` is the entity name the person addressed, without the `@`.',
  '- `job` is what EACH run should do, in the person\'s own words, with the',
  '  reference to the list itself removed — every run is told its own row',
  '  separately, and a job that still says "for each issue" confuses it.',
  '',
  'Choose `fanout: false` whenever you are unsure. A missed fan-out runs once and',
  'the person retypes; a wrong one starts several agents on work nobody asked for.',
].join('\n')

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Is this the message shape that used to run once by accident?
 *
 * Deliberately narrow. A message that already parses as a fan-out is not asked
 * about, because the person's own `spawn N` is the better answer than anything a
 * model could return.
 */
function wantsFanout(text) {
  const source = bodyOf(text)
  const at = FIRST_MENTION.exec(source)
  /* keep the `@` itself: the lookahead below needs one after the number */
  const lead = at ? source.slice(0, at.index + at[1].length + 1) : source
  return SPAWN_WITHOUT_COUNT.test(lead)
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
  if (!job || job.split(/\s+/).length < 3) return null
  return { list, entity, job: job.slice(0, MAX_JOB), derived: true }
}

/** A plan is only usable if both halves are a shape `mention-ref` can resolve. */
function usable(plan, entities = []) {
  if (!plan || typeof plan !== 'object') return null
  const entity = String(plan.entity || '').replace(/^@/, '').trim()
  const list = String(plan.list || '').trim()
  const job = String(plan.job || '').trim()
  /* a bare `@youtrack:` resolves nothing, so the kind has to carry a query */
  if (!entity || !/^@?(?:youtrack|orca|artifact|maka):\S/.test(list)) return null
  if (!job) return null
  if (entities.length && !entities.map(String).includes(entity)) return null
  return {
    list: list.startsWith('@') ? list : `@${list}`,
    entity,
    job: job.slice(0, MAX_JOB),
    derived: Boolean(plan.derived),
  }
}

function parseAnswer(text) {
  const parsed = lastJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.fanout !== true) return null
  return { list: parsed.list, entity: parsed.entity, job: parsed.job }
}

/**
 * A reader bound to one harness: the same voice that is about to run the turn
 * decides what the turn is. `null` when there is no harness to ask, so callers
 * can pass it unconditionally and get only the deterministic fallback.
 */
function reader({ harness = '', model = '', entities = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = String(harness || '')
  if (!id) return null
  return async function readIntent(text) {
    const source = bodyOf(text)
    if (!wantsFanout(source)) return null
    const names = entities.map(String).filter(Boolean)
    let plan = null
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
        label: 'read intent',
      })
      plan = usable(parseAnswer(result.text), names)
    } catch {
      /* A harness that will not answer is not a reason to lose the request: the
         deterministic reading below still knows a pasted issue URL when it sees
         one. */
      plan = null
    }
    return plan || usable(derivePlan(source, { entities: names }), names)
  }
}

module.exports = {
  INSTRUCTION,
  wantsFanout,
  bodyOf,
  derivePlan,
  usable,
  reader,
  stripIssueClause,
}
