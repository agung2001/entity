/**
 * `@` mentions, resolved once per message.
 *
 * A message is a list of segments. Each `@` mention owns the text that follows
 * it, up to the next mention or the end — which is how a search query can hold
 * spaces without quotes, and how `@py-agent fix the build` means "this entity,
 * this job".
 *
 *   @py-agent finish the migration     the entity runs that job first; its
 *                                      answer is injected into this turn
 *   @orca:One:src/app.ts               orca repo list --json → a real path
 *   @artifact:shot-2026                a workspace artifact, as artifact://
 *   @maka:one:plan                     maka_search_notes over MCP
 *   @youtrack:AC:login bug             search_issues over MCP, scoped to AC
 *   @github:owner/repo                 gh api repos/owner/repo → a real repo
 *   @thread:t_abc123                   another conversation in this workspace:
 *                                      its title, questions and last answer
 *
 * Two failure modes, on purpose:
 *
 *   - a NAME that does not exist (entity, orca project) is an error before the
 *     turn runs — the same rule as `/workspace:<skill>`;
 *   - a SEARCH with no hits becomes a note on the turn and the message still
 *     runs. A mention is a convenience, not a gate.
 *
 * Everything here is bounded: no source is touched unless its kind appears in
 * the message, the expensive ones are capped, and the whole thing happens on
 * send rather than per keystroke.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { tilde } = require('./frontmatter.cjs')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const entities = require('./entity-store.cjs')
const harnesses = require('./harness-store.cjs')
const mcpTools = require('./mcp-tools.cjs')
const mcpRuntime = require('./mcp-runtime.cjs')
const platform = require('./platform-brief.cjs')
const { createParser } = require('./chat-transcript.cjs')
const catalog = require('./connector-catalog.cjs')
const oauthAccounts = require('./oauth-accounts.cjs')
/* The account-bearing connectors live in `electron/connectors/`, one file each, plus
   the plumbing they share. This file keeps the mention grammar and the dispatch; it
   does not know what a message, a file or a video is. */
const connectorRegistry = require('./connectors/index.cjs')
const registry = require('./connectors/registry.cjs')
const { accountScope, connectorOfKind, idScope, queryInsert } = require('./connectors/_shared.cjs')

/* The heads the parser accepts, derived from the catalog rather than written a
   second time here. A connector that ships a resolver contributes its mention; one
   without a resolver contributes nothing, so a custom connector can never offer a
   `@id:` form that would resolve to silence. `KINDS` stays a Set of bare heads
   because that is what the parser compares against. */
const KINDS = new Set(
  catalog
    .mentionKinds()
    .map((entry) => String(entry.name || '').replace(/^@/, '').replace(/:$/, ''))
    .filter(Boolean),
)

/* The mention head → resolver kind for the account-bearing connectors, from the
   registry. That map is the only place the three names a connector has are written
   down — the row id (`google-drive`), the kind (`drive`) and the head a person types
   (`@drive:`) — so a provider added there is offered here, and `@gcal:` is a declared
   alias rather than a special case in the parser. */
const ACCOUNT_KIND = registry.accountHeads()

/* `connectorOfKind` now lives in `connectors/_shared.cjs`, with the rest of the
   account plumbing — one definition, so the parser and the resolvers cannot
   disagree about what `@drive:` reads. */
const ACCOUNT_HEADS = new Set(Object.keys(ACCOUNT_KIND))
/* A first word that is a search operator, not an account. Gmail's documented
   keys, plus the shared X/Drive ones — a mention that reads `@gmail:from:x` means
   the operator, because nobody names a mailbox "from". */
const SEARCH_OPERATORS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'has', 'is', 'in', 'after', 'before',
  'older_than', 'newer_than', 'label', 'category', 'filename', 'size', 'larger',
  'smaller', 'list', 'deliveredto', 'rfc822msgid', 'is', 'name', 'mimeType',
  'modifiedTime', 'trashed', 'starred', 'sharedWithMe', 'owners',
])
/* the mention head for a resolver kind (`google-drive` → `drive`) */
const headOfKind = (kind) => Object.keys(ACCOUNT_KIND).find((head) => ACCOUNT_KIND[head] === kind) || ''

/* A resolver kind is one of the account-bearing four. */
const isAccountKind = (kind) => Object.values(ACCOUNT_KIND).includes(kind)

const MAX_PER_SOURCE = 3
const MAX_BLOCK_ROWS = 12
/* A delegated job is real work — reading a brief, editing files, running the
   test suite — not a search. Two minutes killed the very delegation this
   feature exists for. An hour, because a job that has to be *finished* is not
   one pass: a first pass that goes green, a fix round and a screenshot took 28
   minutes on a real issue. Still bounded, and a person can cancel the turn. */
const MENTION_TIMEOUT_MS = Number(process.env.ENTITY_MENTION_TIMEOUT_MS)
const ENTITY_TIMEOUT_MS = MENTION_TIMEOUT_MS > 0 ? MENTION_TIMEOUT_MS : 60 * 60_000
const MAX_ENTITY_RUNS = 2
/* A job that is only a preposition carries no instruction: `@designer on
   @orca:entity …` stops the job at "on", so the run is asked to do nothing while
   the person's real request sits in the segment after it. A delegated job is a
   sentence; one word that cannot head a sentence is a missing one. */
const DANGLING_JOB = /^(?:on|in|at|for|with|to|by|from|into|onto|over|under|about|via)$/i
/* `spawn N @entity …` is an explicit ask for N parallel runs of one instruction,
   so its own cap is what the person wrote — still bounded, because a typo is not
   a reason to start forty harnesses. */
const MAX_SPAWN_RUNS = 5
/* `spawn per` is one run for each row the list resolved or the member typed.
   Twelve, because a real catalogue slice was ten ("the first 10 scenes") and a
   ceiling nobody chose is how a row goes missing. It stays paired with
   `MAX_BLOCK_ROWS`, which is what the reply above can read. */
const MAX_FANOUT_ROWS = 12
/* What one delegated run may report back. The card and the session show this
   text; the parent's prompt gets a digest of it. Sixteen thousand because a
   real report is longer than it looks: seven rows of a milestone plan, each
   with what changed and what was verified, ends in seven READY lines — and at
   8 000 the cut lands inside the last row, which is the only part a person
   scrolls to. A truncated report reads as a report with a missing task. */
const MAX_DELEGATION_ANSWER = 16_000
const ARTIFACT_SCAN_CAP = 2000
/* What a delegated run is told about the conversation it came from. It is a
   hand-off, not a transcript: the last exchange is the part that defines what
   "implement A" means, and a whole thread would drown the instruction. The
   marker sits on a line of its own so a block that travels into a child (and
   from that child into a grandchild) can be cut back out instead of nesting. */
const DELEGATION_CONTEXT = 'Context from the conversation this run was delegated from'
const CONTEXT_ANSWER_CHARS = 2_000
const CONTEXT_ASK_CHARS = 400
const CONTEXT_TITLE_CHARS = 100
const CONTEXT_ARTIFACTS = 4
/* `artifact://shot-1.png` as the transcript renders it, and as an agent writes
   it in its answer. Trailing punctuation and markdown emphasis are the
   sentence's, not the file's. */
const ARTIFACT_REF = /\bartifact:\/\/([^\s<>"'`]+)/g

/* ── parsing ──────────────────────────────────────────────────────── */

/* A mention starts at `@` after start/space/(/[ so `me@example.com` stays text. */
const MENTION_AT = /(^|[\s(\[])@(?=@?[A-Za-z0-9._-])/g

/* The prose before the first mention — the only place a `spawn` prefix is read.
   A fan-out is asked for by the sentence that introduces it, and people write
   that sentence as prose: "let's spawn 4 @designer …". Anchoring the prefix to
   the first word of the message demoted that request to ONE ordinary run — one
   card where four were asked for, and no error to say so. It stays out of a
   delegated job's words on purpose: a `spawn N` written after a mention is that
   job's own text, and reading it would start runs nobody asked for. */
function openingProse(source) {
  const text = String(source || '')
  /* A mention inside a bracketed row list is a row, not the entity: `spawn per
     [@a, @b] @designer …` must still read as a prefix. */
  const scan = new RegExp(MENTION_AT.source, 'g')
  let match
  while ((match = scan.exec(text))) {
    const at = match.index + match[1].length
    const before = text.slice(0, at)
    const open = (before.match(/\[/g) || []).length
    const close = (before.match(/\]/g) || []).length
    /* keep the `@` itself: every prefix below looks ahead for one */
    if (open <= close) return text.slice(0, at + 1)
  }
  return text
}

/**
 * Does this message address an entity with a job the grammar cannot actually
 * read?
 *
 * A delegated job is the text between its `@` and the next `@`, which is the
 * right rule and stays. The failure is when that slice is not an instruction:
 *
 *   `@designer on @orca:entity I want to redesign this page`
 *                    ^^ the job, and the ask is after the repo
 *
 * A job of one word that cannot head a sentence (a preposition, a bare article)
 * is a cut-off instruction, not a terse one. The grammar cannot recover the
 * words, so this is the signal `rewrite` uses to ask the classifier instead of
 * running a session on `"on"`.
 */
function openingProseHasUnreadableJob(source) {
  const { segments } = parse(source)
  return segments.some((segment, index) => {
    if (segment.kind !== 'entity') return false
    const job = String(segment.job || '').trim()
    /* no job at all is a reference — that is already read correctly */
    if (!job) return false
    /* anything with a content word in it is a job the grammar read */
    if (!DANGLING_JOB.test(job)) return false
    /* ...and it only counts if the sentence really does continue past it; a
       trailing `@designer on` with nothing after it is merely empty */
    return index + 1 < segments.length
  })
}

/* `spawn 3 @secretary …` and `spawn per @youtrack:… @coder …`, in the opening
   prose. Both only count when a mention follows, so "spawn 3 tasks in the
   backlog" stays prose. */
const SPAWN_PREFIX = /\bspawn\s+(\d{1,2})\s+(?=@)/
const SPAWN_PER = /\bspawn\s+per\s+(?=@)/i
/* A `spawn` with no count, a `spawn` inside a sentence, a `Spawn 3` on its own
   line after a read — the grammar cannot read intent, and every attempt to teach
   it another shape demoted a fan-out to ONE ordinary run without saying so. Those
   messages are no longer guessed at here: `intent-ref` classifies the message and
   hands back the plan as one of the three sentences below, which this grammar
   does read exactly. See `planSentence` and the `intent` seam in `rewrite`. */
/* `spawn per [a, b, c] @entity …` — the rows are written out. A catalogue that
   lives in a JSON file has no mention that can enumerate it, and copying ten
   names is shorter than any selector syntax. */
const SPAWN_ROWS = /\bspawn\s+per\s+\[([^\]]*)\]\s+(?=@)/i
/* `skill-ref` replaces a leading `/workspace:x` with this line before we see the
   prompt, so a skill at the front of a fan-out arrives as a prologue. */
const SKILL_PROLOGUE = /^use this skill \S+\s*\n+/i

/* `end` is the offset just past the prefix in `source`, not a match length: the
   prefix may sit mid-sentence, and every caller slices or compares against it. */
function spawnPrefix(source) {
  const lead = openingProse(source)
  const rows = lead.match(SPAWN_ROWS)
  if (rows) {
    /* A newline separates rows when there is one; otherwise a comma does. Splitting
       on both at once cannot express a row that legitimately contains a comma
       ("account -> use the avatar, not an animation"), which a typed plan emits
       one-per-line for exactly that reason. */
    const list = rows[1]
      .split(rows[1].includes('\n') ? /\n/ : /,/)
      .map((row) => row.trim())
      .filter(Boolean)
    return { kind: 'rows', rows: list, count: list.length, end: rows.index + rows[0].length }
  }
  const per = lead.match(SPAWN_PER)
  if (per) return { kind: 'per', count: 0, end: per.index + per[0].length }
  const match = lead.match(SPAWN_PREFIX)
  if (!match) return null
  const count = Number(match[1])
  if (!Number.isFinite(count) || count < 1) return null
  return { kind: 'repeat', count, end: match.index + match[0].length }
}

/**
 * The classifier's plan, written as the sentence this grammar reads exactly.
 *
 * One renderer, so there is no second language: a plan becomes `spawn N @entity
 * <job>` or `spawn per @list @entity <job>`, and everything downstream — the
 * rows, the shares, the cap, the hold — is the ordinary path. The skill prologue
 * is deliberately *not* copied in here: a leading `/workspace:` is carried onto
 * every run by `rewrite`, which is what a fan-out means by it.
 */
function planSentence(plan) {
  if (!plan || !plan.entity) return null
  const job = String(plan.job || '').trim()
  if (!job) return null
  if (plan.mode === 'typed' && plan.rows?.length) {
    /* One row per line, never comma-separated. `SPAWN_ROWS` splits on commas AND
       newlines, so a row of its own cannot be broken by a comma it legitimately
       contains — "account -> use the avatar, not an animation" is ONE page, and
       joining with ", " would render it as two runs on half a sentence each. */
    const rows = plan.rows
      .map((row) => String(row).replace(/\n/g, ' ').trim())
      .filter(Boolean)
    if (rows.length < 2) return null
    return `spawn per [\n${rows.join('\n')}\n] @${plan.entity} ${job}`
  }
  if (plan.mode === 'rows' && plan.list) return `spawn per ${plan.list} @${plan.entity} ${job}`
  const runs = Math.trunc(Number(plan.runs))
  if (!Number.isFinite(runs) || runs < 1) return null
  return `spawn ${Math.min(runs, MAX_SPAWN_RUNS)} @${plan.entity} ${job}`
}

/**
 * One instruction, N sessions. The mention is copied N times so the runs happen
 * in parallel and each gets its own session, answer and card; `share` tells the
 * entity which run it is, which is the only way three answers to the same
 * sentence come out different.
 */
function expandSpawn(segments, spawn) {
  if (!spawn) return segments
  const first = segments.find(
    (segment) => segment.kind === 'entity' && segment.start >= spawn.end,
  )
  if (!first) return segments
  const copies = []
  for (let index = 1; index <= spawn.count; index += 1) {
    copies.push({ ...first, share: [index, spawn.count] })
  }
  const out = [...segments]
  out.splice(out.indexOf(first), 1, ...copies)
  return out
}

/**
 * The plan's own list of runs, as mentions.
 *
 * A plan that says which run does what is not re-read as a sentence: every job
 * is the person's prose, and it may contain an `@`, a newline or a colon the
 * mention grammar would take for syntax — `literalAt` only ever protected one
 * tail. So these segments are built here, and `parse` never sees the plan. The
 * fields are the ordinary ones, which is what keeps the card, the share labels,
 * the run cap and the parent prompt on one path.
 */
function plannedSegments(runs) {
  const total = runs.length
  /* "your instruction is yours alone" is only true when they are not the same
     words: two agents may be handed one sentence on purpose. */
  const distinct = new Set(runs.map((run) => String(run.job || '').trim())).size > 1
  let at = 0
  return runs.map((run, index) => {
    const name = String(run.entity || '').replace(/^@/, '').trim()
    const job = String(run.job || '').trim()
    const raw = `@${name} ${job}`.trim()
    const segment = {
      start: at,
      end: at + raw.length,
      raw,
      kind: 'entity',
      name,
      job,
      query: job,
      local: false,
      share: [index + 1, total],
      plannedJob: distinct,
    }
    at += raw.length + 1
    return segment
  })
}

/**
 * One run for each row a list resolved: the entity mention is copied once per
 * row, and the row travels on the copy so the run, its session, its card and the
 * reply above all say which issue they are about.
 */
function expandFanout(segments, target, items) {
  const count = items.length
  const copies = items.map((item, index) => ({
    ...target,
    row: String(item.label || item.id || item.rel || `row ${index + 1}`),
    rowDetail: String(item.detail || ''),
    rowUrl: String(item.url || ''),
    share: [index + 1, count],
  }))
  const out = [...segments]
  out.splice(out.indexOf(target), 1, ...copies)
  return out
}

/** The run's own instruction: its row first, then the person's words. */
function instructionOf(segment) {
  return segment.row ? `${segment.row}\n\n${segment.job}` : segment.job
}

/** What one run of a fan-out is told about its place in it. */
function shareNote(segment) {
  const share = segment.share
  if (!share || share[1] < 2) return ''
  if (segment.row) {
    return (
      `(Run ${share[0]} of ${share[1]}: your row is "${segment.row}". Do only that row — ` +
      `the other ${share[1] - 1} runs handle the rest, each in its own place, and you cannot see them.)`
    )
  }
  if (segment.plannedJob) {
    return (
      `(Run ${share[0]} of ${share[1]} of this plan, and this instruction is yours alone: ` +
      `the other ${share[1] - 1} runs have their own, different jobs, and you cannot see them.)`
    )
  }
  return (
    `(Run ${share[0]} of ${share[1]} of this same instruction. Produce a distinct result — ` +
    'do not coordinate with the other runs, which you cannot see.)'
  )
}

/** A delegated job may start with a `/workspace:` skill: resolve it here too. */
const QUALIFIED_SKILL = /^\/\/?[a-z0-9][a-z0-9-]*:[A-Za-z0-9._-]+(?:\s|$)/

function resolveSkillInJob(record, text) {
  const job = String(text || '')
  /* Qualified only. A bare `/srv/app` is a path, and a job whose first word
     happens to be a command is not ours to rewrite. */
  if (!QUALIFIED_SKILL.test(job)) return job
  /* required here: `skill-ref` is a sibling, and the mention layer must not add
     a load-time edge to it */
  const skillRef = require('./skill-ref.cjs')
  const ref = skillRef.parse(job)
  if (!ref) return job
  /* The sub-run is local whatever machine the thread is pinned to: the entity
     runs here, so the skill is resolved here. */
  return skillRef.rewrite(record, job, { machine: skillRef.LOCAL_MACHINE, dir: '' }).text
}

/**
 * Every mention in `text`, in order.
 *
 * `literalAt` is where a sentence stops being mention syntax. A classified
 * message arrives as `spawn per […] @coder <the person's words>`, and those
 * words are a *job*: they may legitimately name a repo (`one app: @orca:One`)
 * or contain anything else an `@` can mean in prose. Re-reading them as mention
 * syntax cut every run's job at the next `@` and resolved a reference the plan
 * never made — `@coder For project @orca:entity, …` handed the coder "For
 * project" and threw `@orca:entity, is not a project Orca knows` on the rest.
 * Parallels a rule this grammar already had for a *delegated* job (one ends at
 * the next `@`); the plan is the case where that rule has to stop.
 *
 * The row list is the same kind of data: `spawn per [@scope/pkg, b] @coder …`
 * names a package, not an entity, and `openingProse` already treats a bracketed
 * `@` as a row. So a `@` inside the list `SPAWN_ROWS` reads is a row too, and the
 * entity after the `]` is still a mention. The span is exactly the one that regex
 * matches — not any bracket anywhere, or a stray `[` in ordinary prose would
 * swallow the mentions after it.
 */
function parse(text, { literalAt = Infinity } = {}) {
  const source = String(text || '')
  /* where each `spawn per [ … ]` list starts and ends, so a row's `@` is data */
  const lists = []
  const rowList = new RegExp(SPAWN_ROWS.source, 'gi')
  let rowMatch
  while ((rowMatch = rowList.exec(source))) {
    const open = rowMatch.index + rowMatch[0].indexOf('[')
    lists.push([open, open + 1 + rowMatch[1].length])
  }
  const inList = (at) => lists.some(([open, close]) => at > open && at < close)
  const starts = []
  MENTION_AT.lastIndex = 0
  let match
  while ((match = MENTION_AT.exec(source))) {
    const at = match.index + match[1].length
    if (at >= literalAt) break
    if (inList(at)) continue
    starts.push(at)
  }

  const segments = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : source.length
    const raw = source.slice(start, end).trimEnd()
    segments.push({ start, end, raw, ...parseMention(raw) })
  }
  return { source, segments }
}

function parseMention(raw) {
  const local = raw.startsWith('@@')
  const body = raw.slice(local ? 2 : 1)
  /* Only a colon in the *first word* makes this a namespaced mention.
     `@coder Desk /repo. One task: fix it` is an entity called coder with a
     job; looking at the first colon anywhere turned the job into a namespace
     and silently dropped the mention. */
  const firstWord = body.trim().split(/\s+/)[0] || ''
  const colon = firstWord.indexOf(':')
  if (colon < 0) {
    const [word, ...rest] = body.trim().split(/\s+/)
    /* "ask @secretary." names the entity, not an entity called "secretary.". */
    const name = word.replace(/[.,;!?)\]]+$/, '')
    /* `@secretary, do X` is a job, not a job that begins with a comma. */
    const job = rest.join(' ').trim().replace(/^[,;:–—-]+\s*/, '')
    return { kind: 'entity', name, job, query: job, local }
  }

  const head = body.slice(0, colon).trim().toLowerCase()
  const rest = body.slice(colon + 1)
  if (!KINDS.has(head)) return { kind: 'unknown', name: head, local }

  if (head === 'artifact') return { kind: 'artifact', query: rest.trim(), local }

  /* `@thread:` carries the id and nothing else, so the id is ONE word — the
     composer inserts `@thread:<id>` and the person keeps typing after it.
     Reading the whole rest made "@thread:t_a what did we decide?" a thread id
     and failed the message before it was sent. */
  if (head === 'thread') return { kind: 'thread', id: rest.trim().split(/\s+/)[0] || '', local }

  /* A structured field's colon has to TOUCH its first word. `@orca:maka tell me
     about it` is the maka project plus a sentence; and `@orca:entity this is my
     workflow : https://example.com/a?b=c` is the entity project plus a
     sentence — counting colons anywhere made the whole sentence a project name
     and failed the message before it was sent. */
  const body2 = String(rest || '').replace(/^\s+/, '')
  /* the first token, or the first token *before* the colon when the colon
     touches it (`@youtrack:AC:login bug` → AC) */
  const token = body2.split(/[\s:]+/)[0] || ''
  /* "For project @orca:entity, make sure …" names the project `entity`. The
     comma is the sentence's: a project called `entity,` is how a message that
     reads perfectly became "@orca:entity, is not a project Orca knows". Same
     rule the plain entity name already follows, kept on the *name* so `after`
     still starts where the punctuation does. */
  const word = token.replace(/[.,;!?)\]]+$/, '')
  const after = body2.slice(token.length)
  const structured = after.startsWith(':')
  const tail = structured ? after.slice(1).trim() : ''
  /* everything after the head, word included, and everything after the word */
  const whole = body2.trim()
  const prose = after.replace(/^\s+/, '')

  if (head === 'orca') {
    /* the file is one path token: `@orca:one:src/App.vue the bug is elsewhere` */
    return {
      kind: 'orca',
      project: word,
      /* a file path may contain spaces; it may not contain a new line */
      file: structured ? tail.split('\n')[0].trim() : '',
      local,
    }
  }

  if (head === 'maka') {
    /* `@maka:plan` is a query; `@maka:one:plan` is a vault and a query */
    return structured
      ? { kind: 'maka', vault: word, query: tail, local }
      : { kind: 'maka', vault: '', query: whole, local }
  }

  /* `@habitify:<date>` or `@habitify:<habit>:<date>` — the habit is optional and the
     date is the last segment, which is what makes `@habitify:today` a day and
     `@habitify:Meditate:today` a habit on that day. One object rather than a
     `target`/`query` pair the router has to know about; the account segment every
     other account-bearing head takes is absent here on purpose: one account per
     install, and a mention that names one could never be right on another. */
  if (head === 'habitify') {
    return structured
      ? { kind: 'habitify', target: word, query: tail, local }
      : { kind: 'habitify', target: '', query: whole, local }
  }

  /* `@clockify:<project|login>:<week>` — two segments, and the second is a Monday
     or the words `this week`. A project name may hold spaces in Clockify, but the
     mention keeps the first segment to one word so the week remains findable;
     leaving the week off means this week, the same default the resolver takes. */
  if (head === 'clockify') {
    /* `this week` is TWO words, so the week is a trailing word unless it is that
       phrase — cutting at the first space turned it into a week called "this". */
    const said = tail.trim()
    const week = /^this week\b/i.test(said) ? 'this week' : said.split(/\s+/)[0] || ''
    return structured
      ? { kind: 'clockify', target: word, week, local }
      : { kind: 'clockify', target: whole, week: '', local }
  }

  /* `@opendesign:<what>:<query>` — a reader word, then the rest of the line, which
     may hold spaces. A first word that is not a reader is a search for the whole
     line, because a design artifact's name is more likely to be a bare word than a
     verb this grammar forgot. */
  if (head === 'opendesign') {
    const readers = new Set(['artifact', 'file', 'search'])
    return structured && readers.has(word.toLowerCase())
      ? { kind: 'opendesign', target: word.toLowerCase(), query: tail.split('\n')[0].trim(), local }
      : { kind: 'opendesign', target: '', query: whole.split('\n')[0].trim(), local }
  }

  /* github: everything after the colon is the query — `owner/repo` names one
     repository, anything else is a search. The slash is inside the word, so a
     `:` does not scope it. */
  if (head === 'github') return { kind: 'github', query: whole, local }

  /* ── the account-bearing four: scope is explicit ─────────────────────────
     These connectors are multi-account, so a mention must say **whose** mail:
     `@gmail:work:from:stripe`, or `@gmail:all:from:stripe` for every usable
     account. There is no implicit "no account means all" — that default was what
     made the first word ambiguous (`from:` is a Gmail operator, `work` is an
     account) and it silently read mailboxes nobody asked for.

     **The query is the line.** A Gmail search legitimately holds spaces
     (`invoice march`), and the mention segment otherwise runs to the end of the
     message — so `@gmail:all:invoice march — summarise this` used to send the
     instruction to Google as search text. Stopping at the newline gives both:
     the query may hold spaces, and the sentence after it stays an instruction.
     The same rule `@orca:<project>:<file>` already uses for a path.

         @gmail:all:invoice march
         summarise what is due
         → query "invoice march", instruction "summarise what is due"

     `all` is a reserved scope word, so an account can never be called `all`. */
  if (ACCOUNT_HEADS.has(head)) {
    const kind = ACCOUNT_KIND[head]
    const scope = String(word || '')
    /* No second colon: the scope is missing. A search with no scope is exactly the
       ambiguity this shape exists to remove, so it is an error the resolver states
       in the connector's own words rather than a guess. */
    if (!structured) return { kind, account: '', query: whole, local, missingScope: true }
    return {
      kind,
      account: scope,
      /* the query ends at the newline, so a following sentence is an instruction */
      query: tail.split('\n')[0].trim(),
      local,
      /* everything after the first line is the person's own words */
      instruction: tail.split('\n').slice(1).join('\n').trim(),
    }
  }

  if (head === 'maka') {
    /* `@maka:plan` is a query; `@maka:one:plan` is a vault and a query */
    return structured
      ? { kind: 'maka', vault: word, query: tail, local }
      : { kind: 'maka', vault: '', query: whole, local }
  }

  /* `@habitify:<date>` or `@habitify:<habit>:<date>` — the habit is optional and the
     date is the last segment, which is what makes `@habitify:today` a day and
     `@habitify:Meditate:today` a habit on that day. One object rather than a
     `target`/`query` pair the router has to know about; the account segment every
     other account-bearing head takes is absent here on purpose: one account per
     install, and a mention that names one could never be right on another. */
  if (head === 'habitify') {
    return structured
      ? { kind: 'habitify', target: word, query: tail, local }
      : { kind: 'habitify', target: '', query: whole, local }
  }

  /* `@clockify:<project|login>:<week>` — two segments, and the second is a Monday
     or the words `this week`. A project name may hold spaces in Clockify, but the
     mention keeps the first segment to one word so the week remains findable;
     leaving the week off means this week, the same default the resolver takes. */
  if (head === 'clockify') {
    /* `this week` is TWO words, so the week is a trailing word unless it is that
       phrase — cutting at the first space turned it into a week called "this". */
    const said = tail.trim()
    const week = /^this week\b/i.test(said) ? 'this week' : said.split(/\s+/)[0] || ''
    return structured
      ? { kind: 'clockify', target: word, week, local }
      : { kind: 'clockify', target: whole, week: '', local }
  }

  /* `@opendesign:<what>:<query>` — a reader word, then the rest of the line, which
     may hold spaces. A first word that is not a reader is a search for the whole
     line, because a design artifact's name is more likely to be a bare word than a
     verb this grammar forgot. */
  if (head === 'opendesign') {
    const readers = new Set(['artifact', 'file', 'search'])
    return structured && readers.has(word.toLowerCase())
      ? { kind: 'opendesign', target: word.toLowerCase(), query: tail.split('\n')[0].trim(), local }
      : { kind: 'opendesign', target: '', query: whole.split('\n')[0].trim(), local }
  }

  /* github: everything after the colon is the query — `owner/repo` names one
     repository, anything else is a search. The slash is inside the word, so a
     `:` does not scope it. */
  if (head === 'github') return { kind: 'github', query: whole, local }

  /* `@fitbit:[<reader>:]<date>` — the shape Habitify's day has, with a reader word in
     front instead of a habit name. There is no account segment for the same reason:
     one account per install, so a mention naming one could never be right on another.

     The reader word is checked against a closed list, because it sits where a date
     otherwise would: `@fitbit:today` is a day, `@fitbit:sleep:today` is the sleep
     count of that day, and `@fitbit:sleep` is a reader whose date is left out — which
     means today. A first word that is neither a reader nor a date becomes the date,
     and the resolver refuses it with the rule it broke. */
  if (head === 'fitbit') {
    const readers = new Set(['steps', 'sleep', 'heart', 'devices'])
    /* The reader takes the first word whether or not a date follows it: `@fitbit:
       sleep` with nothing after the colon is today's sleep, and the empty query is
       what says "the current day" — a bare `today` here would be one more word the
       grammar had to know. */
    if (readers.has(word.toLowerCase())) {
      return { kind: 'fitbit', target: word.toLowerCase(), query: tail, local }
    }
    return { kind: 'fitbit', target: '', query: whole, local }
  }

  /* ── the account-bearing four: the account segment LEADS ─────────────────
     These connectors are multi-account by design, so the account is part of the
     address: `@gmail:work:from:stripe` is "the work mailbox, Gmail's from:
     search". A mention with no account segment reads **every** usable account and
     the turn says how many it read.

     The rule that decides the first word, in order:

     1. it names a localpart or address this machine actually has → the account;
     2. it is a search operator (`from`, `has`, `subject`, `is`, …) → not an
        account, so the whole rest is the query;
     3. anything else **after a colon** is an account that does not exist — an
        error, not a silent search. A mistyped account used to become a search for
        the word itself and quietly return unrelated mail; that is the wrong default
        for a multi-account connector, where the first word reads like the account.

     Rule 3 is why the earlier shape was wrong: with one mailbox it looked right
     and was wrong, and with six it would merge mail from accounts nobody meant. */
  if (ACCOUNT_HEADS.has(head)) {
    const kind = ACCOUNT_KIND[head]
    const first = String(word || '')
    const accounts = oauthAccounts.connectedAccounts(connectorOfKind(kind))
    const isAccount = accounts.some((entry) => entry.localpart === first || entry.email === first)
    if (isAccount) return { kind, account: first, query: tail, local }
    if (SEARCH_OPERATORS.has(first.toLowerCase())) return { kind, account: '', query: whole, local }
    /* A colon after an unknown word is a mistyped (or not-yet-connected) account.
       With no accounts at all there is nothing to mistype against, so the mention
       is left as a plain search and the resolver explains what to connect. */
    if (structured && accounts.length) return { kind, account: first, query: tail, local, accountUnknown: true }
    return { kind, account: '', query: whole, local }
  }

  /* youtrack: a project key is short and upper-case; the rest is the query */
  if (structured) return { kind: 'youtrack', project: word, query: tail, local }
  if (/^[A-Z][A-Z0-9]{1,9}$/.test(word)) {
    return { kind: 'youtrack', project: word, query: prose, local }
  }
  return { kind: 'youtrack', project: '', query: whole, local }
}

/** The mention as it would be written on its own — no trailing instruction. */
function tokenOf(segment) {
  const at = segment.local ? '@@' : '@'
  if (segment.kind === 'entity') return `${at}${segment.name}`
  if (segment.kind === 'orca') {
    return `${at}orca:${segment.project}${segment.file ? `:${segment.file}` : ''}`
  }
  if (segment.kind === 'artifact') return `${at}artifact:${segment.query}`
  if (segment.kind === 'thread') return `${at}thread:${segment.id}`
  if (segment.kind === 'opendesign') {
    return `${at}opendesign:${segment.target ? `${segment.target}:` : ''}${segment.query}`
  }
  if (segment.kind === 'habitify') {
    return `${at}habitify:${segment.target ? `${segment.target}:` : ''}${segment.query}`
  }
  if (segment.kind === 'fitbit') {
    return `${at}fitbit:${segment.target ? `${segment.target}:` : ''}${segment.query}`
  }
  if (segment.kind === 'clockify') {
    return `${at}clockify:${segment.target}${segment.week ? `:${segment.week}` : ''}`
  }
  if (segment.kind === 'maka') {
    return segment.vault
      ? `${at}maka:${segment.vault}${segment.query ? `:${segment.query}` : ''}`
      : `${at}maka:${segment.query}`
  }
  if (segment.kind === 'youtrack') {
    return segment.project
      ? `${at}youtrack:${segment.project}${segment.query ? `:${segment.query}` : ''}`
      : `${at}youtrack:${segment.query}`
  }
  if (segment.kind === 'github') return `${at}github:${segment.query}`
  if (ACCOUNT_KIND[headOfKind(segment.kind)]) {
    const head = headOfKind(segment.kind)
    return segment.account
      ? `${at}${head}:${segment.account}${segment.query ? `:${segment.query}` : ''}`
      : `${at}${head}:${segment.query}`
  }
  return segment.raw
}

/* Both local-CLI connectors live in their own folders now — `connectors/orca/` and
   `connectors/github/` — each with the resolver, the binary it runs and its own
   switch. What is kept here are the names this file's callers already use, and the
   dispatch below asks the registry for the resolver like it does for every other
   connector. `githubBinary` is re-exported for `integrations-store`, which probes
   the binary a row would run. */
const orca = require('./connectors/orca/mention.cjs')
const github = require('./connectors/github/mention.cjs')

/* ── what a timed-out run left behind ───────────────────────────────

The deadline kills the harness, and until now the record of an hour's work was
one sentence: "did not answer within 60 minutes". The work itself usually
survives — a worktree with commits on it and files still uncommitted — and the
person a card belongs to needs that more than they need the sentence. So the
last thing a timed-out run does is read three cheap git facts out of the
directory it was working in.

This is a courtesy on a run that has already failed, which fixes all three rules
below: every call is bounded, every failure is swallowed, and the report is
appended to the failure text (`run.error` → `mention.note` → the card and the
parent's digest) rather than replacing any of it. */

/* Two seconds: a salvage read must never be the reason an already-stopped turn
   waits, and a locked index is not evidence worth waiting for. */
const SALVAGE_GIT_MS = 2_000
/* Finding the directory can ask Orca for its worktree list, which carries its own
   ten-second timeout — longer than a turn that just ran an hour should wait to
   hear that it failed. The whole salvage gets a budget, and an expired budget is
   the same as no evidence: no line. */
const SALVAGE_LOOKUP_MS = 5_000
const SALVAGE_ROWS = 5
/** `ENTITY-53` at the head of a job names the row the run was about. */
const TICKET_KEY = /^([A-Z][A-Z0-9]+-\d+)\b/

/** `work()`, or its default when it has not answered inside `ms`. */
function withinMs(ms, work, fallback = '') {
  let timer = null
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([work(), expiry]).finally(() => clearTimeout(timer))
}

/**
 * The directory a timed-out run was working in, or `''` for "do not guess".
 *
 * The order is the point. A run that moved into a child workspace names that
 * path in its own partial report, and a path is per-run — the same reason
 * `worktreeState` reads the record before the ticket key, which a fan-out shares
 * across N cards. Only when the report names nothing is the key matched against
 * Orca's list, and a `gone`/`none` answer is no directory: a salvage report about
 * the parent repo for work that happened in a worktree would be the exact lie the
 * worktree chip exists to prevent.
 */
async function salvageDir({ partial, dir, ticket }) {
  /* The record's own paths are text: reading them costs nothing and works with
     Orca switched off. The fallback asks Orca, so it only runs while the
     connector is on — a card must not spawn a CLI the person turned off. */
  const named = orca.recordPaths(partial)[0]
  if (named) return named
  if (!orca.isActive()) return ''
  const state = await orca.worktreeState({ cwd: dir, ticket, record: partial })
  return state?.path || ''
}

/** One bounded `git` call, as text. The salvage is the only thing here that spawns. */
function gitText(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/**
 * Two lines of git evidence under a dead run's directory, or `''` when nothing
 * resolves. Never throws: the caller has a failure to report either way.
 */
function salvageText({ partial, dir, ticket }) {
  return withinMs(SALVAGE_LOOKUP_MS, async () => {
    const at = await salvageDir({ partial, dir, ticket })
    if (!at) return ''
    /* `null`, not `''`: an empty `git status` is a clean tree, a failed one is
       nothing known, and the two must not print the same sentence. */
    const git = async (...args) => {
      try {
        return String(await gitText(['-C', at, ...args], SALVAGE_GIT_MS)).trim()
      } catch {
        return null
      }
    }
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
    const commits = await git('rev-list', '--count', 'HEAD', '--not', '--remotes')
    const status = await git('status', '--short')
    const subject = await git('log', '--oneline', '-n', '1')
    const rows = status === null ? null : status.split('\n').filter(Boolean)
    const head = []
    /* Commits nobody can fetch are the salvage: they exist only in this
       worktree, so the count is the part that is worth reading. */
    if (commits) head.push(`${commits} commit${commits === '1' ? '' : 's'}${branch ? ` on ${branch}` : ''}`)
    else if (branch) head.push(branch)
    if (rows) head.push(`${rows.length} file${rows.length === 1 ? '' : 's'} uncommitted`)
    if (!head.length) return ''
    const lines = [`salvage: ${head.join(' — ')}`]
    if (subject) lines.push(`  ${subject}`)
    for (const row of (rows || []).slice(0, SALVAGE_ROWS)) lines.push(`  ${row}`)
    return lines.join('\n')
  }).catch(() => '')
}

/** Project names for the composer's `@` menu. */
async function sources() {
  try {
    const repos = await orca.repos()
    return { orca: repos.map((repo) => ({ name: repo.displayName || path.basename(repo.path), path: repo.path })) }
  } catch {
    /* A connector that is off refuses rather than answering, and the menu's
       promise is that nothing Orca runs while it is off: no projects offered,
       no CLI spawned. */
    return { orca: [] }
  }
}

/* ── artifacts ────────────────────────────────────────────────────── */

function walkArtifacts(root, rel = '', depth = 0, out = []) {
  if (out.length >= ARTIFACT_SCAN_CAP || depth > 4) return out
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) walkArtifacts(root, next, depth + 1, out)
    else out.push({ rel: next, abs: path.join(root, next), name: entry.name })
    if (out.length >= ARTIFACT_SCAN_CAP) break
  }
  return out
}

function resolveArtifact(record, query, { limit = MAX_PER_SOURCE } = {}) {
  const root = path.join(record.path, 'artifacts')
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) throw new Error('@artifact: needs something to search for.')
  const hits = walkArtifacts(root).filter((file) =>
    words.every((word) => file.rel.toLowerCase().includes(word)),
  )
  hits.sort((a, b) => {
    const aName = words.some((word) => a.name.toLowerCase().includes(word)) ? 0 : 1
    const bName = words.some((word) => b.name.toLowerCase().includes(word)) ? 0 : 1
    return aName - bName || a.rel.localeCompare(b.rel)
  })
  return hits.slice(0, limit).map((file) => ({
    rel: file.rel,
    abs: file.abs,
    label: `artifact://${file.rel}`,
    detail: file.abs,
  }))
}

/* ── MCP: maka and youtrack ───────────────────────────────────────── */

async function resolveMaka(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const result = await ctx.deps.mcpCall({
    workspace: ctx.record.id,
    server: 'maka',
    tool: 'maka_search_notes',
    arguments: {
      ...(segment.vault ? { vault: segment.vault } : {}),
      query: segment.query,
      limit,
    },
  })
  const rows = result?.data?.results || []
  return rows.map((row) => ({
    path: row.path || row.name || '',
    name: row.name || path.basename(String(row.path || '')),
    label: `${segment.vault ? `${segment.vault} · ` : ''}${row.path || row.name}`,
    detail: row.name && row.path ? row.name : '',
  }))
}

async function resolveYoutrack(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = segment.project
    ? `project: ${segment.project} ${segment.query}`.trim()
    : segment.query
  const result = await ctx.deps.mcpCall({
    workspace: ctx.record.id,
    server: 'youtrack',
    tool: 'search_issues',
    arguments: { query, limit },
  })
  const rows = result?.data?.issuesPage || []
  return rows.map((row) => ({
    id: row.id,
    project: row.project || segment.project || '',
    summary: row.summary || '',
    state: row.customFields?.State || '',
    url: row.url || '',
    label: `${row.id} — ${row.summary}`,
    detail: [row.project || segment.project, row.customFields?.State, row.url]
      .filter(Boolean)
      .join(' · '),
  }))
}

/* ── the account-bearing connectors ───────────────────────────────────
   Gmail, Drive, YouTube and X each answer from the account a mention *names*:
   `@gmail:work:invoice` reads the `work` mailbox only, and `@gmail:invoice` reads
   every usable account and says how many it read. An account whose token Google
   rejected is skipped, not fatal — the same rule the card draws (a skipped account
   is not a failed turn), so a mention never blocks a message over one dead consent.

   The API shape is deliberately narrow: a search that returns rows the block can
   print, and nothing that writes. A resolver attaches *context*; the entity still
   does the reading with its own tools, which is what keeps a mention cheap and a
   scope argument honest. */


/** Gmail: `@gmail:[<account>:]<query>` — Gmail's own search syntax. */
/* ── entity: a mini run, not a path ───────────────────────────────── */

function spawnParse(spec, dir, { record, entity, mcp, onChild = null, job = '' }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnTracked(spec.cmd, spec.argv, {
        cwd: dir,
        env: { ...process.env, ...platform.env({ record, entity }), ...mcp.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        kind: 'mention',
        label: `${entity.name} · mention`,
      })
    } catch (error) {
      resolve({ ok: false, answer: '', error: String(error?.message || error) })
      return
    }

    /* Handed to the caller the moment it exists: a fan-out is seven harnesses
       and the window's Stop has to reach all of them, not just the parent. */
    try {
      onChild?.(child)
    } catch {
      /* a bookkeeping failure must not fail the run */
    }
    const startedMs = Date.now()
    const startedAt = new Date(startedMs).toISOString()
    const timing = { firstStepAt: '', firstTextAt: '' }
    const parser = createParser(entity.harness, {
      onStep: (event) => {
        const at = new Date().toISOString()
        if (!timing.firstStepAt) timing.firstStepAt = at
        if (!timing.firstTextAt && event.step?.type === 'text' && (event.step.content || event.delta)) {
          timing.firstTextAt = at
        }
      },
    })
    let stderr = ''
    let settled = false
    /* set the moment the deadline passes; see the timer below */
    let timedOutText = null
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parsed = parser.finish()
      const endedAt = new Date().toISOString()
      const failed = String(error || parsed.error || '')
      const firstStepMs = timing.firstStepAt
        ? Math.max(0, Date.parse(timing.firstStepAt) - startedMs)
        : null
      const firstTextMs = timing.firstTextAt
        ? Math.max(0, Date.parse(timing.firstTextAt) - startedMs)
        : null
      resolve({
        ok: !failed,
        answer: parsed.answer || '',
        error: failed,
        steps: parsed.steps,
        execution: {
          harness: entity.harness,
          model: parsed.model || entity.model || '',
          cwd: dir,
          startedAt,
          ...(timing.firstStepAt
            ? { firstStepAt: timing.firstStepAt, ttfbMs: firstStepMs }
            : {}),
          ...(timing.firstTextAt
            ? { firstTextAt: timing.firstTextAt, firstTextMs }
            : {}),
          endedAt,
          ms: Date.now() - startedMs,
          status: failed ? 'error' : 'ok',
          ...(parsed.usage ? { usage: parsed.usage } : {}),
          ...(Number.isFinite(parsed.costUsd) ? { costUsd: parsed.costUsd } : {}),
        },
      })
    }
    const timer = setTimeout(() => {
      killTree(child, 'SIGTERM')
      const minutes = Math.round(ENTITY_TIMEOUT_MS / 60_000)
      const deadline = `did not answer within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
      /* `parser.finish()` is safe to read here: the run is over, and calling it a
         second time in `done` returns the same answer and steps. */
      let partial = { answer: '', steps: [] }
      try {
        partial = parser.finish()
      } catch {
        /* no partial text is not a reason to lose the deadline's own sentence */
      }
      /* The kill makes `close` arrive before the salvage reads do, so the text is
         kept as a promise both handlers await: a timed-out run must never be
         reported with the bare exit code of the process the timer just killed. */
      timedOutText = salvageText({
        partial,
        dir,
        ticket: (String(job || '').match(TICKET_KEY) || [])[1] || '',
      }).then((salvage) => (salvage ? `${deadline}\n${salvage}` : deadline))
      timedOutText.then(done)
    }, ENTITY_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (error) =>
      done(
        error?.code === 'ENOENT'
          ? `${spec.cmd} is not installed, or not on PATH.`
          : String(error?.message || error),
      ),
    )
    child.stdout?.on('data', (chunk) => {
      try {
        parser.push(String(chunk))
      } catch {
        /* a malformed line is the parser's business, not the turn's */
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    child.on('close', (code) => {
      if (timedOutText) {
        /* the deadline is authoritative: its own sentence, then whatever the run
           left behind, never the exit code of the kill it asked for */
        timedOutText.then(done)
        return
      }
      done(
        code === 0
          ? ''
          : stderr.trim().split(/\r?\n/).pop() || `exited with code ${code ?? 'unknown'}`,
      )
    })

    try {
      if (spec.stdin) child.stdin.write(spec.stdin)
      child.stdin.end()
    } catch {
      /* the close handler reports it */
    }
  })
}

async function runEntity(record, mentioned, job, { onChild = null } = {}) {
  if (!job) throw new Error(`@${mentioned.name} needs a job after the name.`)
  /* required here, not at the top: `runner-local` owns this module's entry
     points, and a load-time cycle would hand it an empty object */
  const { chatInvocation } = require('./runner-local.cjs')
  try {
    harnesses.assertEnabled(mentioned.harness)
  } catch (error) {
    return { ok: false, answer: '', error: String(error?.message || error) }
  }
  const dir = entities.resolveDir(mentioned)
  const mcp = mcpRuntime.materialise({ record, harness: mentioned.harness })
  try {
    const instructions = platform.compose({
      record,
      entity: mentioned,
      extra:
        'You were mentioned inside another entity\'s chat and are answering one job for it. ' +
        'Complete only that job. Do not ask questions; report what you changed and what you verified.',
    })
    let spec
    try {
      spec = chatInvocation(mentioned.harness, instructions, job, mentioned.model, mcp)
    } catch (error) {
      return { ok: false, answer: '', error: String(error?.message || error) }
    }
    spec.cmd = harnesses.binary(mentioned.harness) || spec.cmd
    return await spawnParse(spec, dir, { record, entity: mentioned, mcp, onChild, job })
  } finally {
    mcp.cleanup?.()
  }
}


/* ── what the composer offers while you type ──────────────────────── */

const SEARCH_CACHE_MS = 30_000
const SEARCH_CACHE_MAX = 300
const searchCache = new Map()

let vaultCache = { at: 0, list: [] }
let projectCache = new Map()

/** A shallow, bounded file listing: the composer needs names, not a tree walk. */
function repoTokens(root, query, cap = 200) {
  const wanted = String(query || '').toLowerCase()
  const hits = []
  const walk = (rel, depth) => {
    if (hits.length >= cap || depth > 3) return
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= cap) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(next, depth + 1)
      else if (!wanted || next.toLowerCase().includes(wanted)) hits.push(next)
    }
  }
  walk('', 0)
  hits.sort((a, b) => {
    const aName = a.toLowerCase().split('/').pop().includes(wanted) ? 0 : 1
    const bName = b.toLowerCase().split('/').pop().includes(wanted) ? 0 : 1
    return aName - bName || a.length - b.length || a.localeCompare(b)
  })
  return hits
}

async function makeVaultList(mcpCall) {
  if (Date.now() - vaultCache.at < 5 * 60_000) return vaultCache.list
  const result = await mcpCall({ server: 'maka', tool: 'maka_list_vaults', arguments: {} })
  const list = (result?.data?.vaults || []).map((vault) => vault.name).filter(Boolean)
  vaultCache = { at: Date.now(), list }
  return list
}

async function youtrackProjects(workspace, query, mcpCall, limit = 5) {
  const key = `${workspace}|${query}`
  const cached = projectCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.list
  const result = await mcpCall({
    workspace,
    server: 'youtrack',
    tool: 'find_projects',
    arguments: { query, limit },
  })
  const rows = Array.isArray(result?.data) ? result.data : result?.data?.projects || []
  const list = rows
    .filter((project) => project.key)
    .map((project) => ({ key: project.key, name: project.name || '' }))
  projectCache.set(key, { at: Date.now(), list })
  return list
}

/**
 * Suggestions for the `@` menu. Same resolvers as the send path, but shaped for
 * picking: `insert` is the mention to put in the draft, `label`/`detail` are for
 * the row. Every call is cached for 30 s, because the composer asks per keystroke
 * (debounced) and a prefix repeats.
 */
/** One page of suggestions, straight from a source. */
const PROJECT_SKIP = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.DS_Store',
])

/** Relative file paths under a project base directory, bounded and shallow. */
function listProjectFiles(root, limit = 800) {
  const out = []
  const walk = (rel, depth) => {
    if (out.length >= limit || depth > 5) return
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (PROJECT_SKIP.has(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(child, depth + 1)
        continue
      }
      if (entry.isFile()) out.push(child)
    }
  }
  walk('', 0)
  out.sort()
  return out
}

async function fetchPage(ctx, kind, fields, limit, offset) {
  const merged = ctx.deps
  const workspace = ctx.workspace

  if (kind === 'file') {
    /* `@file:` is resolved against the thread's base directory; listing it here
       is what turns "type a path" into something a person can pick from. */
    const root = ctx.dir
    if (!root) return { items: [], more: false }
    const query = fields.join(':').trim().toLowerCase()
    const files = listProjectFiles(root)
    const matched = query
      ? files.filter((rel) => rel.toLowerCase().includes(query))
      : files
    return {
      items: matched.slice(offset, offset + limit).map((rel) => ({
        insert: /\s/.test(rel) ? `@file:"${rel}"` : `@file:${rel}`,
        label: rel,
        detail: path.join(root, rel),
      })),
      more: matched.length > offset + limit,
    }
  }

  if (kind === 'artifact') {
    const query = fields.join(':').trim()
    if (!query) return { items: [], more: false }
    const rows = resolveArtifact(ctx.record, query, { limit: offset + limit + 1 })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: `@artifact:${row.rel}`,
        label: row.label.replace('artifact://', ''),
        detail: row.abs,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'thread') {
    /* the picker must never throw: a build with no chat store wired gets an
       empty menu rather than a composer that breaks on `@thread:` */
    if (!merged.threads) return { items: [], more: false }
    const query = fields.join(':').trim().toLowerCase()
    const rows = await merged.threads.list()
    const matched = query
      ? rows.filter((row) =>
          [row.id, row.title, row.entity].some((value) =>
            String(value || '').toLowerCase().includes(query),
          ),
        )
      : rows
    return {
      items: matched.slice(offset, offset + limit).map((row) => ({
        insert: `@thread:${row.id}`,
        label: row.title || row.id,
        detail: `${row.entity} · ${row.queries ?? 0} turns${row.archived ? ' · archived' : ''}`,
      })),
      more: matched.length > offset + limit,
    }
  }

  if (kind === 'orca') {
    const project = String(fields[0] || '').trim()
    const file = fields.slice(1).join(':').trim()
    /* The same refusal `sources()` catches: a menu for a connector that is off is
       an empty menu, never a composer that breaks on the token. */
    let repos = []
    try {
      repos = await merged.orcaRepos()
    } catch {
      return { items: [], more: false }
    }

    if (!fields.length || (fields.length === 1 && !file)) {
      const wanted = project.toLowerCase()
      const matched = repos.filter(
        (repo) =>
          !wanted ||
          String(repo.displayName || path.basename(String(repo.path)))
            .toLowerCase()
            .includes(wanted),
      )
      return {
        items: matched.slice(offset, offset + limit).map((repo) => {
          const name = repo.displayName || path.basename(String(repo.path))
          return { insert: `@orca:${name}`, label: name, detail: repo.path }
        }),
        more: matched.length > offset + limit,
      }
    }

    const repo =
      repos.find(
        (entry) => String(entry.displayName || '').toLowerCase() === project.toLowerCase(),
      ) ||
      repos.find(
        (entry) =>
          path.basename(String(entry.path || '')).toLowerCase() === project.toLowerCase(),
      )
    if (!repo) return { items: [], more: false }
    const root = path.resolve(String(repo.path))
    const rels = repoTokens(root, file, offset + limit + 1)
    return {
      items: rels.slice(offset, offset + limit).map((rel) => ({
        insert: `@orca:${project}:${rel}`,
        label: rel,
        detail: path.join(root, rel),
      })),
      more: rels.length > offset + limit,
    }
  }

  if (kind === 'opendesign') {
    /* One field: a reader word or a query. The suggestions come from the resolver,
       so the menu offers only what a send would resolve. */
    const preview = connectorRegistry.previewFor('opendesign')
    if (!preview) return { items: [], more: false }
    const rows = await preview(fields, { record: ctx.record, limit: offset + limit + 1 })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'habitify') {
    /* One field: the date word, or a habit name for that date. The suggestions come
       from the resolver, so the menu offers only what a send would resolve. */
    const preview = connectorRegistry.previewFor('habitify')
    if (!preview) return { items: [], more: false }
    const rows = await preview(fields, { limit: offset + limit + 1 })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'fitbit') {
    /* One field: the reader word, then the date. The suggestions come from the
       resolver, so the menu offers only what a send would resolve — and it never
       spends an API call to fill itself. */
    const preview = connectorRegistry.previewFor('fitbit')
    if (!preview) return { items: [], more: false }
    const rows = await preview(fields, { limit: offset + limit + 1 })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'threads') {
    /* Two fields: the account, then a reader word or a word from a post. The
       suggestions come from the resolver, so the menu offers only what a send would
       resolve — and it never spends a request to fill itself. */
    const preview = connectorRegistry.previewFor('threads')
    if (!preview) return { items: [], more: false }
    const rows = await preview(fields, { record: ctx.record, limit: offset + limit + 1 })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'clockify') {
    /* One field: the project or member login being typed. The preview comes from
       the resolver itself, so the menu offers only what a send would resolve. */
    const preview = connectorRegistry.previewFor('clockify')
    if (!preview) return { items: [], more: false }
    const rows = await preview(fields, {
      record: ctx.record,
      limit: offset + limit + 1,
    })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'maka') {
    const vault = String(fields[0] || '').trim()
    const query = fields.slice(1).join(':').trim()

    if (!fields.length || (fields.length === 1 && !query)) {
      const names = await makeVaultList((args) => merged.mcpCall({ workspace, ...args }))
      const wanted = vault.toLowerCase()
      const matched = names.filter((name) => !wanted || name.toLowerCase().includes(wanted))
      return {
        items: matched.slice(offset, offset + limit).map((name) => ({
          insert: `@maka:${name}:`,
          label: name,
          detail: 'vault',
        })),
        more: matched.length > offset + limit,
      }
    }

    /* a vault with no query yet: list what is in it, so the menu is never blank */
    const result = await merged.mcpCall({
      workspace,
      server: 'maka',
      tool: query ? 'maka_search_notes' : 'maka_list_notes',
      arguments: {
        ...(vault ? { vault } : {}),
        ...(query ? { query } : {}),
        limit: offset + limit + 1,
      },
    })
    const rows = result?.data?.results || result?.data?.notes || []
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: `@maka:${vault}:${row.name || row.path}`,
        label: row.path || row.name || '',
        detail: row.name || '',
      })),
      more: rows.length > offset + limit,
    }
  }

  if (kind === 'youtrack') {
    const project = String(fields[0] || '').trim()
    const query = fields.slice(1).join(':').trim()

    if (!fields.length || (fields.length === 1 && !query)) {
      const result = await merged.mcpCall({
        workspace,
        server: 'youtrack',
        tool: 'find_projects',
        arguments: { query: project, limit: Math.min(20, offset + limit + 1), offset },
      })
      const rows = Array.isArray(result?.data) ? result.data : result?.data?.projects || []
      return {
        items: rows.slice(0, limit).map((entry) => ({
          insert: `@youtrack:${entry.key}:`,
          label: entry.name ? `${entry.name} · ${entry.key}` : entry.key,
          detail: entry.key,
        })),
        more: rows.length > limit,
      }
    }

    const result = await merged.mcpCall({
      workspace,
      server: 'youtrack',
      tool: 'search_issues',
      arguments: {
        query: project ? `project: ${project} ${query}`.trim() : query,
        /* the tool rejects more than 20 */
        limit: Math.min(20, limit),
        offset,
      },
    })
    const data = result?.data || {}
    const rows = data.issuesPage || []
    return {
      items: rows.map((row) => {
        const where = row.project || project
        return {
          insert: `@youtrack:${where}:${row.id}`,
          label: `${row.summary}${row.customFields?.State ? ` · ${row.customFields.State}` : ''}`,
          detail: row.url || '',
        }
      }),
      /* the server says whether another page exists — believe it */
      more: data.hasNextPage === true,
    }
  }

  if (kind === 'github') {
    /* One page, and it is the resolver's own answer: the repository the person
       named, or the first matches of `gh search repos`. A connector that is off
       refuses the read, and an empty menu is what the switch promised. */
    const preview = connectorRegistry.previewFor('github')
    if (!preview) return { items: [], more: false }
    let rows = []
    try {
      rows = await preview(fields, { limit: offset + limit + 1 })
    } catch {
      return { items: [], more: false }
    }
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: row.mention,
        label: row.label,
        detail: row.detail,
      })),
      more: rows.length > offset + limit,
    }
  }

  /* The account-bearing four: the composer's live preview under `@gmail:…`.
     `fields` is what the person has typed so far, colon-joined (`work:from:str`
     arrives as ['work','from:str']), so the first field is a candidate account and
     the rest is the query — the same rule `parseMention` applies, decided by
     whether that word names a real account. */
  if (isAccountKind(kind)) {
    const head = headOfKind(kind)
    const words = fields.filter(Boolean)
    const accounts = oauthAccounts.connectedAccounts(connectorOfKind(kind))
    /* Nothing typed past the head yet: offer `all` and every account, so the
       scope is something you pick rather than something you have to know. */
    if (!words.length || (words.length === 1 && !words[0])) {
      const items = [
        { insert: `@${head}:all:`, label: 'All connected accounts', detail: `${accounts.length} account${accounts.length === 1 ? '' : 's'}` },
        ...accounts.map((entry) => ({
          insert: `@${head}:${entry.localpart}:`,
          label: entry.email,
          detail: entry.status === 'connected' ? 'connected' : entry.status,
        })),
      ]
      return { items, more: false }
    }
    /* One field, no second colon: the person is **typing the scope**. Offer the
       accounts that match what they have so far, plus `all`. Returning nothing here
       was the bug that made `@gmail:muh` look broken while a shorter prefix
       "worked" — neither completed the account, because the whole branch was
       treated as a half-typed query. */
    /* ── YouTube Studio's second segment is **two things at once** ──────────
       `@youtube-studio:<acct>:<channel>:<what>` — and the composer hands this
       branch at most two words, because its field grouping joins everything after
       the account with a colon: typing `…:acct:agung:s` arrives as
       `['acct', 'agung:s']`. So the second field is split on its **first** colon
       here: before it is the channel being typed, after it is the `what`.

       The old code read `words[2]`, which never exists — that is why a channel
       looked unselectable and then a `what` looked like a failed channel. */
    if (kind === 'youtube-studio' && words.length) {
      const scope = String(words[0] || '')
      if (scope) {
        const joined = String(words[1] ?? '')
        const cut = joined.indexOf(':')
        /* `channel` is what is typed before the colon (possibly nothing), `what`
           is everything after it (possibly nothing). */
        const channel = cut >= 0 ? joined.slice(0, cut) : joined
        const what = cut >= 0 ? joined.slice(cut + 1) : ''
        const hasWhatSegment = cut >= 0

        const channels = await connectorRegistry.channelsFor(kind)(scope)
        const chanNeedle = channel.toLowerCase()
        const chanMatches = channels.filter(
          (entry) =>
            !chanNeedle ||
            entry.slug.startsWith(chanNeedle) ||
            entry.title.toLowerCase().startsWith(chanNeedle) ||
            entry.id.toLowerCase().startsWith(chanNeedle),
        )

        /* A settled channel means the next word is a `what`: offer the vocabulary,
           and never re-ask which channel. */
        if (hasWhatSegment && (chanMatches.length || !chanNeedle)) {
          const whatNeedle = what.toLowerCase()
          const vocab = connectorRegistry.wordsFor(kind).filter((word) => word.startsWith(whatNeedle))
          if (vocab.length) {
            return {
              items: vocab.slice(0, 8).map((word) => ({
                insert: `@${head}:${scope}:${channel}:${word}`,
                label: word,
                detail: 'what to read',
              })),
              more: false,
            }
          }
          /* A `what` that is not a keyword prefix, and a settled channel: the
             resolver answers this better than a menu can. */
          return { items: [], more: false }
        }

        /* No colon yet: could be a `what` being typed on an account whose channel
           is unambiguous, or a channel name. A keyword prefix wins, because that is
           the only thing the account offers by itself. */
        const keywordHits = connectorRegistry.wordsFor(kind).filter((word) => word.startsWith(chanNeedle))
        if (keywordHits.length && !chanNeedle.includes(':')) {
          return {
            items: keywordHits.slice(0, 8).map((word) => ({
              insert: `@${head}:${scope}:${word}`,
              label: word,
              detail: 'what to read',
            })),
            more: false,
          }
        }

        if (chanMatches.length) {
          return {
            items: chanMatches.map((entry) => ({
              insert: `@${head}:${scope}:${entry.slug}:`,
              label: entry.title,
              detail: entry.id,
            })),
            more: false,
          }
        }

        /* Neither a keyword nor a channel: say what exists, and offer nothing that
           can be inserted. */
        return {
          items: [
            {
              insert: '',
              label: `No channel or reader matches “${joined}”`,
              detail: channels.length
                ? `Channels: ${channels.map((entry) => entry.slug).join(', ')} · readers: ${connectorRegistry.wordsFor(kind).join(', ')}`
                : `Readers: ${connectorRegistry.wordsFor(kind).join(', ')}`,
            },
          ],
          more: false,
        }
      }
    }

    if (words.length < 2) {
      const needle = String(words[0] || '').toLowerCase()
      const items = []
      if ('all'.startsWith(needle)) {
        items.push({
          insert: `@${head}:all:`,
          label: 'All connected accounts',
          detail: `${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
        })
      }
      for (const entry of accounts) {
        if (entry.localpart.toLowerCase().startsWith(needle) || entry.email.toLowerCase().startsWith(needle)) {
          items.push({
            insert: `@${head}:${entry.localpart}:`,
            label: entry.email,
            detail: entry.status === 'connected' ? 'connected' : entry.status,
          })
        }
      }
      if (items.length) return { items, more: false }
      /* Nothing matches and no account is even close: say what the shape is rather
         than showing an empty menu with no explanation. */
      return {
        items: [
          {
            insert: `@${head}:`,
            label: `No account matches “${words[0] || ''}”`,
            detail: accounts.length
              ? `This machine has: ${accounts.map((entry) => entry.localpart).join(', ')}`
              : 'No account is connected yet — add one on the connector page',
          },
        ],
        more: false,
      }
    }
    const scope = words[0]
    const query = words.slice(1).join(':')
    const known =
      scope === 'all' || accounts.some((entry) => entry.localpart === scope || entry.email === scope)
    /* An unknown scope offers nothing: the turn would reject it, so the composer
       must not preview a search it cannot run. */
    if (!known) return { items: [], more: false }
    if (!query.trim()) return { items: [], more: false }
    const segment = { account: scope, query }
    const resolver = connectorRegistry.resolverFor(kind)
    /* A preview never throws the picker away: no account connected, or an API
       that is off, simply offers nothing rather than an error under the cursor. */
    let rows = []
    try {
      rows = await resolver(ctx, segment, { limit: offset + limit })
    } catch {
      return { items: [], more: false }
    }
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        /* A result carries its id, so picking it names the *thing*, not a search
           for its words: one direct read at turn time instead of a second query.
           The readable label and link ride along for the chip and its dialog. */
        /* Only a row whose id is a *target* becomes an `id:` mention. A comment
           thread id is not — `@…:id:<comment>` would have nothing to read. */
        insert: row.pick
          ? `@${head}:${scope}:id:${row.pick}`
          : row.id && !row.notPicked
            ? `@${head}:${scope}:id:${row.id}`
            : `@${head}:${scope}:${queryInsert(row.label.split(' — ')[0])}`,
        label: row.label,
        detail: row.detail,
        /* what the chip shows and the dialog links to */
        id: row.id || '',
        url: row.url || '',
        account: row.account || '',
      })),
      more: rows.length > offset + limit,
    }
  }

  return { items: [], more: false }
}

/**
 * Suggestions for the `@` menu, one page at a time. Pages are cached for 30 s,
 * so backspacing over a prefix is free and "Show more" costs one call.
 */
async function search({ record, kind, fields = [], limit = 10, offset = 0, dir = '', deps = {} } = {}) {
  const ctx = { record, workspace: record?.id, dir: String(dir || ''), deps: { ...defaultDeps, ...deps } }
  /* `thread` is scoped to the workspace, so the id is part of the key: without
     it one workspace's thread titles would answer another workspace's picker. */
  const key = `${kind}|${ctx.workspace || ''}|${ctx.dir}|${fields.join(':')}|${offset}|${limit}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.value
  const value = await fetchPage(ctx, kind, fields, limit, offset)
  searchCache.set(key, { at: Date.now(), value })
  if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value)
  return value
}

const defaultDeps = {
  orcaRepos: orca.repos,
  execGithub: github.run,
  mcpCall: mcpTools.callTool,
  runEntity,
}

/**
 * What one thread can say about itself inside another thread's prompt: its
 * title, the questions it was asked and its last answer.
 *
 * Deliberately NOT the transcript. `sent` on a message holds the foreign
 * context that turn already resolved (`@orca:`, `@maka:`, another `@thread:`);
 * copying that into this turn would launder someone else's resolved sources as
 * if they were ours. Same reason the steps, tool output and `mentions` are
 * unread — only the words the person and the agent typed.
 */
function threadDigest(
  thread,
  { askCount = 3, askChars = 200, answerChars = 1200, totalChars = 2000 } = {},
) {
  const squeeze = (text) => String(text || '').replace(/\s+/g, ' ').trim()
  const messages = Array.isArray(thread.messages) ? thread.messages : []
  const questions = messages.filter((message) => message.who === 'me' && !message.error)
  const asked = questions.slice(-askCount).map((message) => squeeze(message.text).slice(0, askChars))
  const lastAnswer = [...messages].reverse().find((message) => message.who === 'agent')
  const concluded = lastAnswer ? squeeze(lastAnswer.text).slice(0, answerChars) : ''
  /* A digest is bounded by characters, not by messages: three terse questions
     and three essays cost very different prompt space. Oldest questions go
     first — the newest one is what the mention was about. With the defaults the
     budget cannot bite (3 × 200 + 1200 < 2000); it is the guard for a caller
     that widens `askCount`, not a live path. */
  let truncated = false
  while (asked.length && asked.join('').length + concluded.length > totalChars) {
    asked.shift()
    truncated = true
  }
  return {
    title: String(thread.title || '').trim(),
    entity: thread.entity,
    turns: messages.filter((message) => message.who === 'agent').length,
    asked,
    concluded,
    truncated,
    /* counted for the block only: one row says how much is missing */
    hidden: questions.length - asked.length,
  }
}

/* ── what a delegated run knows about where it came from ─────────── */

/** A message's words, without a context block a previous hand-off put there. */
function withoutDelegationContext(text) {
  const source = String(text || '')
  const at = source.indexOf(DELEGATION_CONTEXT)
  return (at >= 0 ? source.slice(0, at) : source).replace(/\s+/g, ' ').trim()
}

/** `~/…` back to the path a harness or a `read` tool can open. */
function expandHome(value) {
  const source = String(value || '')
  return source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source
}

/** The distinct `artifact://` names a piece of prose points at, in order. */
function artifactRefs(text) {
  const seen = new Set()
  const out = []
  const scan = new RegExp(ARTIFACT_REF.source, 'g')
  let match
  while ((match = scan.exec(String(text || ''))) && out.length < CONTEXT_ARTIFACTS) {
    const rel = match[1].replace(/[.,;:!?)\]"']+$/, '').replace(/\*+$/, '').trim()
    if (!rel || seen.has(rel.toLowerCase())) continue
    seen.add(rel.toLowerCase())
    out.push(rel)
  }
  return out
}

/**
 * The real path behind each `artifact://` name, so the run can open one.
 *
 * The notation is the transcript's (`artifact://plan.md`); a child cannot use it
 * — it has no mention layer — but it can read a path. Both shelves are searched
 * (yours and the workspace's) through the artifact store, because the plan a
 * delegation refers to is usually a personal file. A name that resolves to
 * nothing is dropped: a wrong path is worse than a name the run can grep for.
 */
function artifactPathsFor(record, text) {
  const refs = artifactRefs(text)
  if (!refs.length) return []
  let items = []
  try {
    /* required here: the mention layer runs in the CLI and in tests where the
       artifact store's profile may not be wired. A context block is never a
       reason for a delegation to fail. */
    items = require('./artifact-store.cjs').list({ workspace: record.id }).items || []
  } catch {
    return []
  }
  const out = []
  for (const rel of refs) {
    const want = rel.toLowerCase()
    const hit =
      items.find((item) => String(item.id).toLowerCase() === want) ||
      items.find((item) => String(item.name).toLowerCase() === want) ||
      items.find((item) => String(item.id).toLowerCase().endsWith(`/${want}`))
    if (!hit) continue
    /* A file in the shared tree that no share ever claimed is reported as
       unclaimed, and the store's own path for it points at the personal shelf
       (it is *reported* as yours). The file is where it is, so the path is the
       shared tree — `walk` already treats that as the one place it could be. */
    const abs = hit.unclaimed
      ? path.join(record.path, 'artifacts', String(hit.id))
      : expandHome(hit.path)
    out.push({ rel: String(hit.id), abs })
  }
  return out
}

/**
 * The block a delegated run is handed about the conversation that asked for it.
 *
 * A child session starts with a fresh transcript, so "implement A" had no
 * referent: the definition lived in this thread and never travelled. The last
 * exchange is the part that carries it — the ask before this turn, the answer
 * to it (where the plan usually is), and the real paths of any artifact that
 * answer names, because the run has to be able to open one.
 *
 * Bounded on purpose, and never the current turn's own message: the job already
 * carries that, and repeating it would make the run think it was asked twice.
 */
async function buildDelegationContext(ctx) {
  if (!ctx.deps.threads || !ctx.threadId) return ''
  let thread = null
  try {
    thread = await ctx.deps.threads.read(ctx.threadId)
  } catch {
    return ''
  }
  if (!thread) return ''
  const messages = Array.isArray(thread.messages) ? thread.messages : []
  const opening = String(ctx.opening || '').replace(/\s+/g, ' ').trim()
  const asks = messages
    .filter((message) => message.who === 'me' && !message.error)
    .map((message) => withoutDelegationContext(message.text))
    /* the store writes this turn's question before the turn runs, so the
       trailing `me` is the message being answered right now */
    .filter((text) => text && text !== opening)
  const lastAsk = asks[asks.length - 1] || ''
  const replied = [...messages].reverse().find((message) => message.who === 'agent' && !message.error)
  const answer = replied ? withoutDelegationContext(replied.text) : ''
  if (!lastAsk && !answer) return ''
  /* The artifact list is read from the whole exchange, not from the clipped
     text above: the plan's name is usually the first thing the answer says and
     the details come later, so a cut prompt still points at the file. This
     turn's own words count too — a person can name the file right before the
     mention, and the plan only copies the job out of it. */
  const artifacts = artifactPathsFor(ctx.record, `${ctx.opening}\n${lastAsk}\n${answer}`)
  const clip = (text, max) => {
    const words = String(text || '')
    return words.length > max ? `${words.slice(0, max).trimEnd()} …` : words
  }
  /* One field per line, labels on their own line: a 2 000-character answer with
     a label glued to its front is a paragraph nobody can scan, and this block is
     read by a person before a run. */
  const lines = [`${DELEGATION_CONTEXT} — background, not your task.`, '']
  const title = String(thread.title || '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_TITLE_CHARS)
  if (title) lines.push(`Conversation: ${title}`, '')
  if (lastAsk) lines.push('Earlier ask:', clip(lastAsk, CONTEXT_ASK_CHARS), '')
  if (answer) lines.push('Last answer there:', clip(answer, CONTEXT_ANSWER_CHARS), '')
  if (artifacts.length) {
    lines.push('Artifacts named there (open the one your job refers to):')
    for (const artifact of artifacts) lines.push(`- artifact://${artifact.rel} → ${artifact.abs}`)
  }
  return lines.join('\n').trimEnd()
}

/** One read per turn, whichever run asks first — and never a reason to fail. */
function delegationContext(ctx) {
  if (!ctx.delegationBlock) {
    ctx.delegationBlock = buildDelegationContext(ctx).catch(() => '')
  }
  return ctx.delegationBlock
}

/* ── one ceiling for the whole app ────────────────────────────────────

`MAX_ENTITY_RUNS` and `MAX_SPAWN_RUNS` are per message, which is the right rule
for one person's sentence and no rule at all for the machine: ten threads
fanning out at once each start ten harnesses, and the app falls over somewhere
between twenty and thirty processes.

This is the second number, and it is *additional*, not a replacement — the caps
above still decide how many runs one message may plan. A run waits here before
its harness process exists, so the ceiling counts work that is actually running
rather than work that has been decided.

The ceiling is a preference, shaped like `turn-timeout-store.cjs`: one small file
in `~/.entity/`, `ENTITY_MAX_RUNS` winning over it, a missing or malformed file
meaning the default rather than an error. Read on every acquisition, so lowering
it lands on the next run instead of on the next restart. */
const DEFAULT_MAX_RUNS = 4
/* One is a serial queue a person can still work in; twelve is more harnesses
   than this machine's window has ever painted rows for. */
const RUNS_RANGE = { min: 1, max: 12 }
const CONCURRENCY_FILE = 'concurrency.json'

/** The file's own number, or the default when it is absent or unreadable. */
function fileCeiling() {
  const root = process.env.ENTITY_HOME
    ? path.resolve(process.env.ENTITY_HOME)
    : path.join(os.homedir(), '.entity')
  try {
    return Number(JSON.parse(fs.readFileSync(path.join(root, CONCURRENCY_FILE), 'utf8'))?.max)
  } catch {
    return DEFAULT_MAX_RUNS
  }
}

/** How many delegated runs may hold a harness at once. Never zero, never a throw. */
function runsCeiling() {
  const env = Number(process.env.ENTITY_MAX_RUNS)
  const wanted = Number.isFinite(env) && env > 0 ? env : fileCeiling()
  const n = Math.round(wanted)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RUNS
  return Math.min(RUNS_RANGE.max, Math.max(RUNS_RANGE.min, n))
}

let activeRuns = 0
const waitingRuns = []

/** Start every waiting job a free slot can hold, oldest first. */
function pumpRuns() {
  const ceiling = runsCeiling()
  while (activeRuns < ceiling && waitingRuns.length) {
    const entry = waitingRuns.shift()
    /* A stop lands between two runs, not only inside one. Nothing has been
       spawned for this row yet, so a stopped turn drops it here rather than
       leaving a job that starts minutes later, after the person stopped. */
    if (entry.stopped?.()) {
      entry.drop()
      continue
    }
    activeRuns += 1
    entry.start()
  }
}

/**
 * `job()`, once a slot is free — the app-wide ceiling in front of every spawn.
 *
 * `onQueued` fires only when the job has to wait, and `onStart` fires as the
 * slot is granted: those two are the card's `Queued` → `Working…` transition,
 * and they travel into `runEntity`'s options so a stubbed run in a test sees the
 * same shape the real one does. `{ dropped: true }` means the turn was stopped
 * while the job waited, which is not a failure of the job.
 */
async function withRunSlot({ stopped, onQueued = null, onStart = null, job }) {
  if (stopped?.()) return { dropped: true }
  const started = await new Promise((resolve) => {
    waitingRuns.push({ stopped, start: () => resolve(true), drop: () => resolve(false) })
    if (activeRuns >= runsCeiling()) onQueued?.()
    pumpRuns()
  })
  if (!started) return { dropped: true }
  onStart?.()
  try {
    return { dropped: false, result: await job({ onQueued, onStart }) }
  } finally {
    /* the slot is given back however the run ended, including a throw: a leaked
       slot would shrink the ceiling by one for the rest of the process */
    activeRuns -= 1
    pumpRuns()
  }
}

/** A row that never ran because the person stopped the turn. */
function stoppedMention(segment, mentioned) {
  return {
    kind: 'entity',
    raw: segment.raw,
    token: tokenOf(segment),
    name: mentioned.name,
    job: instructionOf(segment),
    ...(segment.row ? { row: segment.row } : {}),
    ...(segment.rowUrl ? { rowUrl: segment.rowUrl } : {}),
    items: [],
    answer: '',
    note: 'stopped by you',
    status: 'error',
  }
}

async function resolveOne(ctx, segment) {
  const started = Date.now()
  try {
    if (segment.kind === 'entity') {
      const mentioned = ctx.entities.get(String(segment.name || '').toLowerCase())
      if (!mentioned) {
        throw new Error(`@${segment.name} is not an entity in this workspace.`)
      }
      /* A name with no job after it is a reference, not a delegation. The
         sentence around it may be a request about the entity ("delete @x"),
         and failing the whole message because there is nothing to run was the
         wrong answer. */
      if (!segment.job) {
        segment.mention = {
          kind: 'entity',
          raw: segment.raw,
          token: tokenOf(segment),
          name: mentioned.name,
          job: '',
          items: [],
          answer: '',
          note: '',
          status: 'ok',
          reference: true,
        }
        return
      }
      /* The run's own instruction: its row first, so a session says which issue
         it is about, then the person's words. The session and the card keep this
         — a spawned run is one of N, and it is told which one, because answers
         to a shared sentence only differ if each knows it must. */
      segment.runName = mentioned.name
      if (!segment.runStatus) segment.runStatus = 'queued'
      /* A stop lands between two runs, not only inside one: seven queued jobs
         must not start after the person pressed Stop. */
      if (ctx.stopped?.()) {
        segment.runStatus = 'error'
        segment.mention = stoppedMention(segment, mentioned)
        ctx.report()
        return
      }
      const instruction = instructionOf(segment)
      /* The skill is resolved on the person's words, not on the row-prefixed
         instruction: `use this skill <path>` has to stay the first line for the
         harness to load it. The row reaches the run through the note below. A
         skill that led the *message* and was turned into this fan-out by
         `intent-ref` is carried on the segment, because a fan-out routes each
         run and the prologue must lead every job, not the parent's. */
      const resolved = resolveSkillInJob(ctx.record, segment.job)
      /* A carried skill leads every job, but never twice: a job that already has
         its own `/workspace:` reference keeps that one. */
      /* A field the person answered already holds the block (task + context),
         so it is not appended a second time. Otherwise the run is handed the
         turn's block here, which is also the headless path. */
      const context = segment.prompted
        ? ''
        : (segment.context ?? (await delegationContext(ctx)))
      const job = [
        segment.carriedSkill && !/^use this skill /i.test(resolved)
          ? segment.carriedSkill
          : '',
        resolved,
        shareNote(segment),
        /* The job is the task; this is where the words in it came from. Last on
           purpose — the first line has to stay the instruction itself. */
        context,
      ]
        .filter(Boolean)
        .join('\n\n')
      /* The row is `Queued` until a slot is actually free: the queue starts the
         harness, so it is the queue that knows when this row stops waiting. A
         transition reports to the window as it happens, which is the difference
         between a card that says `Working…` for ten minutes and one that says
         `Queued` because it is. */
      const queued = await withRunSlot({
        stopped: ctx.stopped,
        onQueued: () => {
          segment.runStatus = 'queued'
          ctx.report()
        },
        onStart: () => {
          segment.runStatus = 'running'
          ctx.report()
        },
        job: ({ onQueued, onStart }) =>
          ctx.deps.runEntity(ctx.record, mentioned, job, {
            onChild: ctx.onChild,
            onQueued,
            onStart,
          }),
      })
      if (queued.dropped) {
        /* the turn was stopped while this row waited, and nothing was spawned */
        segment.runStatus = 'error'
        segment.mention = stoppedMention(segment, mentioned)
        ctx.report()
        return
      }
      const run = queued.result
      segment.runStatus = run.ok ? 'ok' : 'error'
      segment.mention = {
        kind: 'entity',
        raw: segment.raw,
        token: tokenOf(segment),
        name: mentioned.name,
        job: instruction,
        ...(segment.row ? { row: segment.row } : {}),
        /* the row's source survives into the transcript, so the card that lands
           after Run still links to the issue the row was */
        ...(segment.rowUrl ? { rowUrl: segment.rowUrl } : {}),
        ...(segment.share && segment.share[1] > 1
          ? { share: `${segment.share[0]}/${segment.share[1]}` }
          : {}),
        items: [],
        /* The session and the card are the record of a delegated job, and a
           real report (seven tasks, seven READY lines) runs to a few thousand
           characters. Cutting it at 1200 truncated the very line that says what
           was verified; the reply above reads its own 400-char digest anyway. */
        answer: String(run.answer || '').slice(0, MAX_DELEGATION_ANSWER),
        note: run.ok ? '' : `@${mentioned.name} failed: ${run.error}`,
        status: run.ok ? 'ok' : 'error',
        ...(run.execution ? { execution: run.execution } : {}),
        ...(Array.isArray(run.steps) && run.steps.length ? { steps: run.steps } : {}),
      }
      if (!run.ok) {
        /* A note is one row of the parent's digest, and a salvage report is
           several lines: flattened here so the digest stays a list instead of
           turning one failed run into five unstyled rows. */
        ctx.notes.push(segment.mention.note.replace(/\s+/g, ' ').trim())
      }
      ctx.report()
      return
    }

    if (segment.kind === 'orca') {
      const resolve = connectorRegistry.resolverFor('orca')
      const items = await resolve(ctx, segment, { limit: ctx.rowLimit || MAX_PER_SOURCE })
      segment.mention = { kind: 'orca', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      return
    }

    if (segment.kind === 'artifact') {
      const items = resolveArtifact(ctx.record, segment.query, {
        limit: ctx.rowLimit || MAX_PER_SOURCE,
      })
      segment.mention = { kind: 'artifact', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@artifact:${segment.query} matched no file in this workspace`)
      return
    }

    if (segment.kind === 'thread') {
      /* no reader wired (a test seam, or a build without a chat store) is a
         wiring fault, not a missing thread — it must be loud */
      if (!ctx.deps.threads) throw new Error('@thread: has no thread reader wired.')
      if (!segment.id) {
        ctx.errors.push('@thread: needs a thread id.')
        return
      }
      /* Deduped before the first await on purpose: every mention resolves in
         one Promise.all, so a check after the read would inject both copies. */
      if (ctx.seenThreads.has(segment.id)) {
        ctx.notes.push(`@thread:${segment.id} mentioned twice; injected once`)
        return
      }
      ctx.seenThreads.add(segment.id)
      /* read() throws on a malformed id and answers null for anything it may
         not show; both become the same sentence, so a mention can never be used
         to learn whether another account's thread exists. */
      let thread = null
      try {
        thread = await ctx.deps.threads.read(segment.id)
      } catch {
        thread = null
      }
      if (!thread) {
        ctx.errors.push(`@thread:${segment.id} is not a thread in this workspace.`)
        return
      }
      if (segment.id === ctx.threadId) {
        /* no mention on the segment, so the token stays plain text */
        ctx.notes.push(`@thread:${segment.id} is this conversation; nothing to inject`)
        return
      }
      const digest = threadDigest(thread)
      segment.mention = {
        kind: 'thread',
        raw: segment.raw,
        token: tokenOf(segment),
        status: 'ok',
        threadId: segment.id,
        title: digest.title,
        entity: digest.entity,
        turns: digest.turns,
        truncated: digest.truncated,
        items: [
          {
            label: digest.title
              ? `“${digest.title}” · ${digest.entity} · ${digest.turns} turns`
              : segment.id,
            detail: segment.id,
          },
        ],
        note: '',
      }
      /* The digest rides on the segment, not on the mention: the block is what
         gets sent, and `message.mentions` stays a small card. */
      segment.digest = digest
      if (!digest.concluded) ctx.notes.push(`@thread:${segment.id} has no answer yet`)
      return
    }

    if (segment.kind === 'opendesign') {
      const resolve = connectorRegistry.resolverFor('opendesign')
      const items = await resolve(ctx, segment, {
        limit: ctx.rowLimit || connectorRegistry.rowCeiling('opendesign', MAX_PER_SOURCE),
      })
      segment.mention = { kind: 'opendesign', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`${tokenOf(segment)} found nothing in the design workspace`)
      return
    }

    if (segment.kind === 'habitify') {
      const resolve = connectorRegistry.resolverFor('habitify')
      const items = await resolve(ctx, segment, {
        limit: ctx.rowLimit || connectorRegistry.rowCeiling('habitify', MAX_PER_SOURCE),
      })
      segment.mention = { kind: 'habitify', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`${tokenOf(segment)} found no habit`)
      return
    }

    if (segment.kind === 'fitbit') {
      /* One account per install, so there is no account segment and no fan-out: the
         registry dispatches the resolver like the rest. Five calls, whatever the
         reader word — the reader narrows the answer, not the read. */
      const resolve = connectorRegistry.resolverFor('fitbit')
      const items = await resolve(ctx, segment, {
        limit: ctx.rowLimit || connectorRegistry.rowCeiling('fitbit', MAX_PER_SOURCE),
      })
      segment.mention = { kind: 'fitbit', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`${tokenOf(segment)} found no day`)
      return
    }

    if (segment.kind === 'clockify') {
      /* A token connector has no account segment: one key for the whole workspace,
         so the resolver is dispatched by the registry like the rest. */
      const resolve = connectorRegistry.resolverFor('clockify')
      const items = await resolve(ctx, segment, {
        limit: ctx.rowLimit || connectorRegistry.rowCeiling('clockify', MAX_PER_SOURCE),
      })
      segment.mention = { kind: 'clockify', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`${tokenOf(segment)} found no tracked hours`)
      return
    }

    if (segment.kind === 'maka') {
      const items = await resolveMaka(ctx, segment, { limit: ctx.rowLimit || MAX_PER_SOURCE })
      segment.mention = { kind: 'maka', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@maka:${segment.query} found no note`)
      return
    }

    if (segment.kind === 'youtrack') {
      const items = await resolveYoutrack(ctx, segment, {
        limit: ctx.rowLimit || MAX_PER_SOURCE,
      })
      segment.mention = { kind: 'youtrack', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@youtrack:${segment.query} found no issue`)
      return
    }

    if (segment.kind === 'github') {
      const resolve = connectorRegistry.resolverFor('github')
      const items = await resolve(ctx, segment, { limit: ctx.rowLimit || MAX_PER_SOURCE })
      segment.mention = { kind: 'github', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@github:${segment.query} matched no repository`)
      return
    }

    if (isAccountKind(segment.kind)) {
      const head = headOfKind(segment.kind)
      /* A missing or mistyped scope is an error before the turn runs, not a search
         that quietly answers something else. */
      if (segment.missingScope) {
        ctx.errors.push(
          `@${head}: needs a scope. Write @${head}:all:<query> for every connected account, or @${head}:<account>:<query> for one.`,
        )
        return
      }
      if (segment.accountUnknown) {
        accountScope(connectorOfKind(segment.kind), segment.account, head)
      }
      const resolve = connectorRegistry.resolverFor(segment.kind)
      /* A report-shaped source sets its own ceiling: `summary` is four KPI tiles
         plus a video list, and truncating it to three rows hides the numbers the
         report exists for. Every other source keeps the shared cap. */
      const items = await resolve(ctx, segment, {
        limit: ctx.rowLimit || connectorRegistry.rowCeiling(segment.kind, MAX_PER_SOURCE),
      })
      segment.mention = {
        kind: segment.kind,
        raw: segment.raw,
        token: tokenOf(segment),
        items,
        note: '',
      }
      if (!items.length) ctx.notes.push(`${tokenOf(segment)} found nothing`)
      /* A dead account is skipped, not fatal — but the turn should say so rather
         than silently reading fewer mailboxes than the person meant. */
      if (segment.skipped?.length) {
        ctx.notes.push(
          `${tokenOf(segment)} skipped ${segment.skipped.join(', ')} — needs a sign-in`,
        )
      }
    }
  } catch (error) {
    const message = String(error?.message || error)
    /* names are hard errors; a search that failed is a note */
    if (segment.kind === 'entity' || segment.kind === 'orca' || segment.kind === 'thread') {
      ctx.errors.push(message)
    } else ctx.notes.push(message)
  } finally {
    if (segment.mention) segment.mention.ms = Date.now() - started
  }
}

/**
 * Did the person ask for the reads themselves and nothing else?
 *
 * `@youtube-studio:avery:summary` on its own line is a whole question: the rows
 * resolved above ARE what was asked for. With no sentence around them the turn
 * has no instruction to give a harness, and a harness asked for one invents it —
 * a YouTrack-first agent went looking for an issue about a video instead of
 * reading the subscriber count it had been handed.
 *
 * Only the *shape* is read here: every mention is a read, no word of the message
 * sits outside one, and nothing follows a mention on its own line.
 * `@gmail:all:invoice march` followed by `summarise what is due` is a read *and*
 * an instruction, so it is not one — and neither is a delegated `@coder …` or a
 * reference, which need the turn they ask for.
 */
function askedOnlyReads(source, segments) {
  if (!segments.length) return false
  const text = String(source || '')
  let at = 0
  for (const segment of segments) {
    if (text.slice(at, segment.start).trim()) return false
    if (segment.kind === 'entity' || segment.kind === 'unknown') return false
    /* One line, because a second line is a sentence. `@gmail:all:invoice march`
       followed by `summarise what is due` is a read *and* an instruction, and
       the mention's own query stops at that newline for exactly that reason. */
    if (String(segment.raw || '').includes('\n')) return false
    at = segment.end
  }
  return !text.slice(at).trim()
}

/**
 * What a message that asked only for reads gets back.
 *
 * Markdown, because this is the answer and not a prompt: one heading per
 * mention, one bullet per row, and the reader's own words for anything that
 * went wrong (`needs a sign-in`, `found no issue`). The `notes` a resolver left
 * are folded in only when no row already says the same thing.
 */
function answerFor(segments, notes = []) {
  const out = []
  const tokens = new Set()
  for (const segment of segments) {
    const mention = segment.mention
    if (!mention) continue
    const token = mention.token || mention.raw || ''
    tokens.add(token)
    out.push(`\`${token}\``)
    if (mention.kind === 'thread') {
      /* A thread is read for its digest, not for the one row naming it. */
      const digest = segment.digest || { asked: [], concluded: '' }
      const where = [mention.entity || 'thread', `${mention.turns || 0} turns`].join(' · ')
      out.push(`- ${mention.title ? `“${mention.title}” · ` : ''}${where}`)
      for (const asked of digest.asked || []) out.push(`- asked: ${asked}`)
      out.push(`- concluded: ${digest.concluded || '(no answer yet)'}`)
      continue
    }
    const items = Array.isArray(mention.items) ? mention.items : []
    if (!items.length) {
      out.push(`- ${mention.note || 'nothing found'}`)
      continue
    }
    for (const item of items) {
      out.push(`- ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    }
    if (mention.note) out.push(`- note: ${mention.note}`)
  }
  for (const note of notes) {
    /* `@x found nothing` is already the row under its own heading */
    if ([...tokens].some((token) => note === `${token} found nothing`)) continue
    out.push(`- note: ${note}`)
  }
  return out.join('\n')
}

function blockFor(segments, notes) {
  const rows = []
  for (const segment of segments) {
    const mention = segment.mention
    if (!mention) continue
    /* A fanned-out list is not a result to repeat: each run below names its own
       row, which is the same information once instead of twice. */
    if (mention.fanout) continue
    if (mention.kind === 'entity') {
      if (mention.reference) {
        rows.push(
          `- ${mention.token || mention.raw} (entity ${mention.name}) → named only; no job was given`,
        )
        continue
      }
      /* Both ends, because a row's verdict ("still running: …", "unverified:
         …") is the last thing it said: a head-only digest showed seven setups
         and none of the seven endings. */
      const flat = String(mention.answer || '')
        .replace(/\s+/g, ' ')
        .trim()
      const answer = mention.answer
        ? flat.length <= 400
          ? flat
          : `${flat.slice(0, 240)} … ${flat.slice(-160)}`
        : mention.note || 'no answer'
      /* A row is what a run is about, and the only label that tells seven
         answers apart; without one, the share is. */
      if (mention.row) {
        rows.push(`- ${mention.row} (${mention.name}) → answer: ${answer}`)
        continue
      }
      const which = mention.share ? ` run ${mention.share}` : ''
      rows.push(
        `- ${mention.token || mention.raw} (entity ${mention.name}${which}) → answer: ${answer}`,
      )
      continue
    }
    if (mention.kind === 'thread') {
      /* One row per mention, multi-line: a digest is a paragraph, and a row per
         question would eat `MAX_BLOCK_ROWS` out of the whole block. */
      const digest = segment.digest || { asked: [], concluded: '', hidden: 0 }
      const which = digest.title ? `“${digest.title}”` : mention.threadId || mention.raw
      const lines = [
        `- ${mention.token || mention.raw} → ${which} (${mention.entity || 'thread'} · ${
          mention.turns || 0
        } turns)`,
      ]
      /* the sample in the plan puts the missing count on its own line, under the
         answer, so the question list stays a list */
      if (digest.asked.length) lines.push(`  asked: ${digest.asked.join('; ')}`)
      lines.push(`  concluded: ${digest.concluded || '(no answer yet)'}`)
      if (digest.hidden > 0) lines.push(`  (+${digest.hidden} earlier questions not shown)`)
      rows.push(lines.join('\n'))
      continue
    }
    if (!mention.items.length) {
      rows.push(`- ${mention.token || mention.raw} → nothing found`)
      continue
    }
    for (const item of mention.items) {
      rows.push(`- ${mention.token || mention.raw} → ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    }
  }

  const kept = rows.slice(0, MAX_BLOCK_ROWS)
  const dropped = rows.length - kept.length
  if (dropped > 0) kept.push(`- (+${dropped} more resolved)`)
  for (const note of notes) kept.push(`- note: ${note}`)
  if (!kept.length) return ''
  return [
    'Resolved mentions — use these; the @tokens are references to them.',
    ...kept,
  ].join('\n')
}

/* ── the plan a person approves ───────────────────────────────────── */

/**
 * What a held turn would do, read *before* any of it happens: every run the
 * message plans, where it would start, and every read that already ran.
 *
 * The folder is `entities.resolveDir`, the same call `runEntity` makes, so the
 * card cannot name a directory the harness will not start in. A row whose
 * entity has no folder says so instead of throwing here — its run still fails
 * the way it always has.
 */
/**
 * One card, from one run.
 *
 * A held plan and a re-plan (`chat.replan`, after the person edits the
 * delegation instruction) both paint this shape, so the two cannot disagree
 * about what a card is: the run's own instruction, the conversation block it
 * was built from, and where it would start.
 */
function planRow(mentioned, run, index, total, context) {
  let dir = ''
  let note = ''
  try {
    dir = mentioned ? entities.resolveDir(mentioned) : ''
  } catch {
    note = 'no folder set'
  }
  return {
    index,
    total,
    name: run.name || mentioned?.name || '',
    /* the instruction, and the conversation block the engine appends to it.
       Both are on the row because the card is the form: a prompt the person
       approves with half of itself hidden is not the prompt that runs. */
    context: String(context || ''),
    row: run.row || '',
    /* the source the read that resolved this row found, so the card can link
       to the issue instead of only naming it */
    rowUrl: String(run.rowUrl || ''),
    job: String(run.job || ''),
    share: run.share || (total > 1 ? `${index + 1}/${total}` : ''),
    harness: String(mentioned?.harness || ''),
    model: String(mentioned?.model || ''),
    dir,
    shownDir: tilde(dir),
    note,
    status: 'queued',
    answer: '',
    ms: 0,
  }
}

function planFor(ctx, segments) {
  const rows = ctx.runs.map((segment, index) =>
    planRow(
      ctx.entities.get(String(segment.name || '').toLowerCase()) || null,
      {
        name: segment.runName || segment.name || '',
        row: segment.row,
        rowUrl: segment.rowUrl,
        job: instructionOf(segment),
        share: segment.share ? `${segment.share[0]}/${segment.share[1]}` : '',
      },
      index,
      ctx.runs.length,
      segment.context,
    ),
  )
  /* A read is what makes the gate credible: it names work that already happened
     so the hold only ever covers work that has not. */
  const reads = segments
    .filter((segment) => segment.mention && segment.mention.kind !== 'entity')
    .map((segment) => {
      const mention = segment.mention
      const items = Array.isArray(mention.items) ? mention.items : []
      return {
        token: String(segment.token || segment.raw || ''),
        kind: String(mention.kind || ''),
        count: items.length,
        detail: String(
          items[0]?.label || items[0]?.path || mention.digest?.title || '',
        ).slice(0, 90),
      }
    })
  const dirs = [...new Set(rows.map((row) => row.dir).filter(Boolean))]
  const dir = dirs.length === 1 ? dirs[0] : ''
  return {
    rows,
    /* The delegation instruction: what the person actually sent. The child
       instructions on the rows were derived from it, and editing it asks the
       classifier again (`chat.replan`) — seeded from one child's job it would
       be a second, shorter message that re-plans something else. */
    instruction: String(ctx.opening || ''),
    reads,
    dir,
    shownDir: dir ? tilde(dir) : '',
    /* one folder stated once when every run agrees; otherwise each row says its
       own */
    dirMixed: dirs.length > 1,
    timeoutMs: ctx.timeoutMs,
  }
}

/**
 * The same plan shape, from runs alone.
 *
 * `chat.replan` has no mention segments to read: the classifier handed back a
 * list of runs and that is all there is. The conversation context is the one
 * the held card already carries — editing the delegation instruction does not
 * change the conversation behind it.
 */
function planOfRuns(record, runs, { instruction = '', context = '', timeoutMs = ENTITY_TIMEOUT_MS } = {}) {
  const listed = entities.list(record.id)
  const rows = runs.map((run, index) => {
    const mentioned =
      listed.find((item) => item.name.toLowerCase() === String(run.entity).toLowerCase()) ||
      null
    return planRow(
      mentioned,
      { name: mentioned?.name || run.entity, job: run.job },
      index,
      runs.length,
      context,
    )
  })
  const dirs = [...new Set(rows.map((row) => row.dir).filter(Boolean))]
  const dir = dirs.length === 1 ? dirs[0] : ''
  return {
    rows,
    instruction,
    reads: [],
    dir,
    shownDir: dir ? tilde(dir) : '',
    dirMixed: dirs.length > 1,
    timeoutMs,
  }
}

/**
 * The person edited the plan: apply the count and the words they left on screen
 * before the first harness starts.
 *
 * `rows[i]` is card `i`'s text, already row-stripped; `segment.row` is kept, so
 * `instructionOf` puts the row back for the run that has one. `count` is the
 * number of cards, clamped to what the engine allows. With neither, this is a
 * plain Run and the turn is today's path byte for byte.
 *
 * ponytail: edits are applied once, at Run. A per-keystroke `chat.plan` write is
 * the upgrade path if a second window ever has to see an edit.
 */
function applyPlanRevision(ctx, segments, entityNow, decision) {
  let runList = entityNow
  const rows = Array.isArray(decision?.rows) ? decision.rows : null
  const band = String(decision?.instruction ?? '').trim()
  if (rows) {
    for (let index = 0; index < rows.length; index += 1) {
      const segment = ctx.runs[index]
      if (!segment) continue
      const text = String(rows[index] ?? '').trim()
      /* A trust boundary even though the card refuses to send an empty one: an
         empty run would start a session with no question. */
      if (!text) throw new Error(`run ${index + 1} has no instruction. Nothing was sent.`)
      segment.job = text
      /* The field held the whole prompt; the block is inside it now. */
      segment.prompted = true
    }
  } else if (band) {
    /* One band, no per-card rows: every run gets the same task, and the turn's
       context still rides with it — the band is a task, not a prompt. */
    for (const segment of ctx.runs) {
      segment.job = segment.context ? `${band}\n\n${segment.context}` : band
      segment.prompted = true
    }
  }
  const before = ctx.runs.length
  const wanted = Number.isInteger(decision?.count)
    ? Math.min(MAX_SPAWN_RUNS, Math.max(1, decision.count))
    : before
  /* Fewer: the tail goes, everywhere it is read — the plan, the block and the
     runs themselves. */
  while (ctx.runs.length > wanted) {
    const dropped = ctx.runs.pop()
    const at = segments.indexOf(dropped)
    if (at >= 0) segments.splice(at, 1)
    const runAt = runList.indexOf(dropped)
    if (runAt >= 0) runList.splice(runAt, 1)
  }
  /* More: the last card is copied, because a blank one would block Run on the
     common path. ponytail: one entity segment is exact for `spawn N @x`; a
     fan-out of several entities changing its count is not modelled. */
  while (ctx.runs.length < wanted && ctx.runs.length) {
    const last = ctx.runs[ctx.runs.length - 1]
    const clone = { ...last, mention: { ...(last.mention || {}) } }
    /* A card the person edited after `+` still runs its own words: the row for
       the new index wins over the copy it grew from. */
    if (rows) {
      const text = String(rows[ctx.runs.length] ?? '').trim()
      if (text) clone.job = text
      else if (rows[ctx.runs.length] !== undefined) {
        throw new Error(`run ${ctx.runs.length + 1} has no instruction. Nothing was sent.`)
      }
    }
    const after = segments.lastIndexOf(last)
    segments.splice(after >= 0 ? after + 1 : segments.length, 0, clone)
    ctx.runs.push(clone)
    const runAt = runList.indexOf(last)
    runList.splice(runAt >= 0 ? runAt + 1 : runList.length, 0, clone)
  }
  /* A trimmed plan reads `1/2`, not `1/4`. */
  if (wanted !== before) {
    ctx.runs.forEach((segment, index) => {
      segment.share = [index + 1, ctx.runs.length]
    })
  }
  return runList
}

/**
 * Nothing started, and the turn ends the way a stopped one does: a note and the
 * app's own **Retry**. `hold` on the error is what lets the caller write the
 * sentence without the harness-error prefix, and what the transcript keeps so
 * the settled block can say which of the three it was.
 */
function holdError(decision, ctx) {
  const reason = ['expired', 'interrupted'].includes(decision?.reason)
    ? decision.reason
    : 'cancelled'
  const who = [...new Set(ctx.runs.map((segment) => `@${segment.runName || segment.name}`))]
  const message =
    reason === 'expired'
      ? 'The plan expired before it was answered — nothing was started.'
      : reason === 'interrupted'
        ? 'The window closed before the plan was answered — nothing was started.'
        : `Delegation cancelled — nothing was sent to ${who.join(', ')}.`
  const error = new Error(message)
  error.hold = reason
  return error
}

/**
 * One classified message, on the ordinary fan-out path.
 *
 * The classifier (`intent-ref`) has already answered "several sessions" and
 * named the plan; this only has to turn that into the sentence the grammar reads
 * and let the rest of `rewrite` run unchanged. The leading skill comes along: a
 * fan-out routes each *run*, so the prologue `skill-ref` put at the front of the
 * message is carried onto every job instead of being refused. A plan naming an
 * entity this workspace does not have plans nothing — the ordinary path would
 * refuse it after the person had already read a card.
 *
 * The classified message replaces the person's, so a mention that only the
 * *sentence* carried (`… on @youtrack:ENTITY:ENTITY-37 …`) is not resolved: the
 * card's **Read:** line says work already happened, and inventing a read the
 * plan does not have would be the lie that line exists to prevent. What the run
 * must know travels in the job, which is why the classifier copies the person's
 * words rather than rewriting them.
 */
async function delegatePlan(record, source, plan, addressed = null) {
  if (!plan) return null
  const workspaceEntities = entities.list(record.id)
  /* Every agent the plan names has to exist here: a card naming an entity the
     workspace does not have would be refused further down, after the person had
     already read it. */
  const known = (name) =>
    workspaceEntities.some((item) => item.name.toLowerCase() === String(name).toLowerCase())
  /* ...and it has to be an agent the message actually addressed. A plan is a
     reading of this message, not a place to start a session nobody asked for. */
  const mentioned = addressed?.length
    ? new Set(addressed.map((segment) => String(segment.name).toLowerCase()))
    : null
  const target = (name) =>
    known(name) && (!mentioned || mentioned.has(String(name).toLowerCase()))
  /* Two mentions with their own jobs are two runs the grammar read exactly, so a
     plan that collapses them into one would delete work off the card. */
  const collapsed = (count) =>
    Boolean(mentioned && addressed.length > 1 && count < addressed.length)
  if (plan.mode === 'runs') {
    const runs = Array.isArray(plan.runs) ? plan.runs : []
    if (runs.length < 1) return null
    if (runs.some((run) => !target(run.entity))) return null
    if (collapsed(runs.length)) return null
    /* A `/workspace:` that led the message routes every run of it, exactly as it
       does for a rendered plan. */
    const prologue = String(source || '').match(SKILL_PROLOGUE)
    return { runs, carriedSkill: prologue ? prologue[0].trim() : '' }
  }
  if (!plan.entity || !target(plan.entity)) return null
  if (mentioned && addressed.length > 1) return null
  const sentence = planSentence(plan)
  if (!sentence) return null
  const prologue = String(source || '').match(SKILL_PROLOGUE)
  const lead = prologue ? `${prologue[0].trim()}\n\n` : ''
  const whole = `${lead}${sentence}`
  /* `planSentence` always puts the job last, so the run's instruction begins at
     the tail of the sentence being rendered. Everything from there is the
     person's words, not mention syntax — see `parse`'s `literalAt`. */
  const job = String(plan.job || '').trim()
  return {
    source: whole,
    carriedSkill: prologue ? prologue[0].trim() : '',
    literalAt: whole.length - job.length,
  }
}

/**
 * Resolve every mention in `text` and return the prompt to send.
 *
 * `deps` is a test seam only: production callers pass nothing and get the real
 * Orca CLI, the real MCP client, and a real entity sub-run.
 */
async function rewrite(
  record,
  text,
  {
    entity = null,
    machine = 'local',
    localOnly = false,
    /* the conversation this turn belongs to: `@thread:<this one>` is a no-op */
    threadId = '',
    deps = {},
    onProgress = null,
    onChild = null,
    stopped = null,
    /* the plan gate: present only for a person's own top-level turn */
    hold = null,
    /* The classifier: one call per message the grammar could not read, answering
       a plan (`intent-ref.reader`) — absent in tests, the CLI and a spawned
       session, which run only what the grammar reads exactly. */
    intent = null,
  } = {},
) {
  let source = String(text || '')
  /* A `/workspace:` that led the message moves onto every run it produces:
     `skill-ref` resolved it for the message, and a fan-out routes each run. */
  let carriedSkill = ''
  /* Where a classified plan's job starts; `Infinity` for a message a person
     typed, whose every `@` is mention syntax. */
  let literalAt = Infinity
  /* The plan's own list of runs, when it answered with one. */
  let planned = null
  /* The grammar first, for free — but it is only asked whether the message
     *delegates*, never whether it read the instruction. A job the grammar splits
     off is not a job it understood: `let's spawn 2 @coder:` over two lines that
     each order something else produced two runs of the same paragraph, because a
     grammar cannot see that the bullets are different jobs. Every message that
     hands work to an entity is classified, whatever prefix it carries; a message
     that delegates nothing (`Take your time.`, a bare read) costs no call, which
     is what keeps chat off the slow path. */
  const grammar = parse(source)
  const delegations = grammar.segments.filter(
    (segment) => segment.kind === 'entity' && String(segment.job || '').trim(),
  )
  const barePrefix = spawnPrefix(source)
  /* `unreadableJob` is the other reason to classify, and the one this layer kept
     getting wrong: the grammar can always *split* an `@entity` from its job, so
     it never demoted itself — even when the split threw the instruction away.
     `spawn 1 @designer on @orca:entity I want to redesign this page` reads as the
     job "on" because a delegated job ends at the next `@`, and the person's real
     sentence lives past it. That is not the grammar reading the message exactly;
     it is the grammar reading it wrong, so the model is asked — and its plan
     (`spawn 1 @designer <the real ask>`) is the one the card confirms. */
  const unreadableJob = openingProseHasUnreadableJob(source)
  if (intent && (delegations.length > 0 || barePrefix !== null || unreadableJob) && !stopped?.()) {
    let plan = null
    try {
      plan = await intent(source)
    } catch {
      /* a reader that throws is a reader with nothing to say */
      plan = null
    }
    const delegated = plan ? await delegatePlan(record, source, plan, delegations) : null
    if (delegated?.runs) {
      /* Built from the plan, not parsed back out of it — see `plannedSegments`. */
      planned = delegated.runs
      carriedSkill = delegated.carriedSkill || ''
    } else if (delegated) {
      source = delegated.source
      carriedSkill = delegated.carriedSkill
      literalAt = delegated.literalAt ?? Infinity
    }
  }
  /* A runs plan has no prefix and nothing to expand: its runs are already one
     per entry, with their own words. */
  const spawn = planned ? null : spawnPrefix(source)
  const parsed = parse(source, { literalAt })
  let segments = planned ? plannedSegments(planned) : parsed.segments
  if (!segments.length) return { text: source, mentions: [] }
  if (spawn?.kind === 'repeat' && spawn.count > MAX_SPAWN_RUNS) {
    throw new Error(
      `spawn ${spawn.count} is more than ${MAX_SPAWN_RUNS} runs. Nothing was sent — lower the number.`,
    )
  }
  let listSegment = null
  let target = null
  if (spawn?.kind === 'rows') {
    target = segments.find((segment) => segment.kind === 'entity' && segment.start >= spawn.end)
    if (!target) {
      throw new Error(
        'spawn per needs an entity to run: `spawn per [row, row] @designer <job>`. ' +
          'Nothing was sent.',
      )
    }
    if (!spawn.rows.length) {
      throw new Error('spawn per has an empty row list: `[a, b, c]`. Nothing was sent.')
    }
    if (spawn.rows.length > MAX_FANOUT_ROWS) {
      throw new Error(
        `spawn per lists ${spawn.rows.length} rows and runs one per row, at most ` +
          `${MAX_FANOUT_ROWS}. Nothing was sent — split the list across two messages.`,
      )
    }
  }

  if (spawn?.kind === 'per') {
    target = segments.find((segment) => segment.kind === 'entity' && segment.start >= spawn.end)
    if (!target) {
      throw new Error(
        'spawn per needs an entity to run: `spawn per @youtrack:<project>:<query> @coder <job>`. ' +
          'Nothing was sent.',
      )
    }
    listSegment =
      segments.find(
        (segment) =>
          segment !== target &&
          segment.start >= spawn.end &&
          segment.start < target.start &&
          segment.kind !== 'unknown' &&
          segment.kind !== 'entity',
      ) || null
    if (!listSegment) {
      throw new Error(
        'spawn per needs the list before the entity: ' +
          '`spawn per @youtrack:ENTITY:relates to: ENTITY-21 #Unresolved @coder <job>`. ' +
          'One run per row it resolves. Nothing was sent.',
      )
    }
  }
  if (spawn?.kind === 'repeat') segments = expandSpawn(segments, spawn)
  /* every run of a carried skill is routed by it, and it stays the first line */
  if (carriedSkill) for (const segment of segments) segment.carriedSkill = carriedSkill
  const rowsUntilRun =
    spawn?.kind === 'rows' ? expandFanout(segments, target, spawn.rows.map((label) => ({ label }))) : null
  if (spawn?.kind === 'rows') segments = rowsUntilRun
  const runCap = planned
    ? planned.length
    : spawn?.kind === 'per' || spawn?.kind === 'rows'
      ? MAX_FANOUT_ROWS
      : spawn?.kind === 'repeat'
        ? Math.max(MAX_ENTITY_RUNS, spawn.count)
        : MAX_ENTITY_RUNS

  const ctx = {
    record,
    machine,
    entity,
    /* the conversation this turn belongs to: `@thread:<this one>` is a no-op */
    threadId: String(threadId || ''),
    deps: { ...defaultDeps, ...deps },
    notes: [],
    errors: [],
    /* thread ids already injected in this message; see the dedupe in resolveOne */
    seenThreads: new Set(),
    /* this turn's own message, so the context block never repeats it back to
       the run as "the earlier ask" */
    opening: String(text || ''),
    /* memoised `buildDelegationContext` for this turn; see `delegationContext` */
    delegationBlock: null,
    onChild,
    stopped,
    hold,
    /* the plan's ceiling is the run's ceiling, not a second number the card
       could disagree with */
    timeoutMs: ENTITY_TIMEOUT_MS,
    /* the entity segments of this message, in order: what a progress row is
       about, and what the window paints while they run */
    runs: [],
    entities: new Map(
      entities.list(record.id).map((item) => [item.name.toLowerCase(), item]),
    ),
  }
  /* One event carries every row, so the window never has to patch a list it
     has to guess the shape of. At most eight rows — small enough for that. */
  ctx.report = () => {
    if (!onProgress || !ctx.runs.length) return
    try {
      onProgress({
        total: ctx.runs.length,
        rows: ctx.runs.map((segment, index) => ({
          index,
          total: ctx.runs.length,
          name: segment.runName || segment.name || '',
          row: segment.row || '',
          /* the live card must name the row, or ten runs of one instruction
             read as ten identical lines until they settle */
          rowUrl: String(segment.rowUrl || ''),
          job: instructionOf(segment),
          share: segment.share ? `${segment.share[0]}/${segment.share[1]}` : '',
          status: segment.runStatus || 'queued',
          answer: String(segment.mention?.answer || ''),
          note: String(segment.mention?.note || ''),
          ms: segment.mention?.ms || 0,
        })),
      })
    } catch {
      /* the window may be gone; the turn itself must not care */
    }
  }

  /* A delegated job ends at the next `@`. `@coder fix it in @orca:entity` hands
     the coder "fix it in" and turns the repo into a mention of its own, whose
     resolved path only the parent ever reads — so the run would ask which repo
     it is working in. Say it rather than let that happen quietly. */
  if (spawn) {
    const anchor = target || segments.find((segment) => segment.kind === 'entity')
    for (const segment of segments) {
      if (segment.kind === 'entity' || segment === listSegment || !anchor) continue
      if (segment.start <= anchor.start) continue
      ctx.notes.push(
        `${segment.raw} is a mention of its own, so the delegated job stopped before it and ` +
          'the run cannot read its value. Write the repo, path or file in the job’s words.',
      )
    }
  }

  /* A job that is *nothing but* a preposition still slips through when nothing
     classified the message — the CLI, a spawned session, a test, or a reader that
     answered `{spawn: false}`. Then the run would be handed `"on"` and file a
     session under that title, so it is refused instead.
     
     This is the **fallback**, not the answer: `rewrite` asks the classifier
     whenever the job is unreadable (`openingProseHasUnreadableJob`), and a plan
     from it replaces the message before this code ever sees the split. Only a
     turn with no classifier reaches here, and for that turn nothing can recover
     the instruction. */
  for (const segment of segments) {
    if (segment.kind !== 'entity') continue
    if (segment === listSegment || !DANGLING_JOB.test(String(segment.job || '').trim())) continue
    const after = segments.find((entry) => entry.start > segment.start)
    if (!after) continue
    /* the next segment's *token*, not its whole rest-of-message: the sentence
       after it is the instruction the run is missing, and quoting it back in a
       refusal makes the refusal longer than the fix. */
    const nextToken = String(after.raw || '').trim().split(/\s+/)[0]
    ctx.errors.push(
      `${segment.raw} has no job — only "${String(segment.job).trim()}", because the ` +
        `sentence continues after ${nextToken} and a delegated job stops at the next ` +
        'mention. Put the instruction in words the run can read, before any other mention.',
    )
  }

  /* One row, one run: the list is resolved before any run exists, because the
     number of runs is what it returns. Its failure is a hard error — spawning
     nothing while the parent talks as if it had is worse than stopping. */
  if (listSegment) {
    ctx.rowLimit = MAX_FANOUT_ROWS
    await resolveOne(ctx, listSegment)
    if (ctx.errors.length) {
      throw new Error(
        `${ctx.errors.join('\n')}\nFix the list or remove it — nothing was sent.`,
      )
    }
    const rows = listSegment.mention?.items || []
    if (rows.length > MAX_FANOUT_ROWS) {
      throw new Error(
        `spawn per resolved ${rows.length} rows and runs one per row, at most ${MAX_FANOUT_ROWS}. ` +
          'Narrow the query — nothing was sent.',
      )
    }
    if (!rows.length) {
      /* No rows, no runs: a delegatee with the instruction but no row would pick
         one and be wrong, and the parent would read it as a real answer. */
      ctx.notes.push(
        `spawn per ran nothing: ${listSegment.raw} resolved no row, so ${target.raw} did not run`,
      )
      segments = segments.filter((segment) => segment !== target)
    } else {
      listSegment.mention.fanout = rows.length
      segments = expandFanout(segments, target, rows)
    }
  }

  const candidates = localOnly ? segments.filter((segment) => segment.local) : segments
  for (const segment of candidates) {
    if (segment.kind !== 'unknown') continue
    ctx.errors.push(
      `@${segment.name}: is not a mention kind. Use @orca:, @artifact:, @maka:, @youtrack: or ` +
        '@thread:, or write the entity name without a colon.',
    )
  }
  const entitiesToRun = candidates.filter((segment) => segment.kind === 'entity')
  const skipped = entitiesToRun.slice(runCap)
  for (const segment of skipped) {
    ctx.notes.push(
      `${segment.raw} skipped: at most ${runCap} entity ${runCap === 1 ? 'mention' : 'mentions'} per message`,
    )
  }

  const runNow = candidates.filter(
    (segment) =>
      segment.kind !== 'unknown' && segment !== listSegment && !skipped.includes(segment),
  )
  ctx.runs = runNow.filter(
    (segment) =>
      segment.kind === 'entity' &&
      /* A name with no job after it is a reference, not a delegation: the
         sentence may be *about* the entity ("delete @x"), so it asks nothing
         and must never open a gate. */
      Boolean(String(segment.job || '').trim()),
  )
  /* A name that does not exist is a refusal, and a gate behind a refusal trains
     people to click Run on messages that cannot run: it is an error here, before
     a plan is drawn, exactly as it would have been after the run. */
  for (const segment of ctx.runs) {
    if (!ctx.entities.get(String(segment.name || '').toLowerCase())) {
      ctx.errors.push(`@${segment.name} is not an entity in this workspace.`)
    }
  }
  if (ctx.errors.length) {
    throw new Error(
      `${ctx.errors.join('\n')}\nFix the mention or remove it — nothing was sent.`,
    )
  }
  /* Before the first harness exists: the window shows every row as queued, so a
     fan-out that takes minutes never looks like a hang. */
  ctx.report()

  /* Reads first, and entirely: the card's "Read:" line has to be true before a
     person approves anything, and a read that throws is the turn's existing hard
     error, which must never open a gate behind it. */
  const reads = runNow.filter((segment) => segment.kind !== 'entity')
  let entityNow = runNow.filter((segment) => segment.kind === 'entity')
  await Promise.all(reads.map((segment) => resolveOne(ctx, segment)))
  if (ctx.errors.length) {
    throw new Error(
      `${ctx.errors.join('\n')}\nFix the mention or remove it — nothing was sent.`,
    )
  }

  /* The hold: one awaited promise per turn, answered by the window (Run /
     Cancel / Stop / expiry). Absent — tests, the CLI, a spawned child session —
     every run starts as it always has, which is what keeps a headless run from
     asking a question nobody can see. */
  if (ctx.hold && ctx.runs.length) {
    /* Built before the card, not inside the run: the block is part of the
       prompt, and the person approves the prompt. One read for the whole turn. */
    const block = await delegationContext(ctx)
    for (const segment of ctx.runs) segment.context = block
    const decision = await ctx.hold(planFor(ctx, segments))
    if (!decision || decision.action !== 'run') throw holdError(decision, ctx)
    /* The form the person answered is the plan that runs: count and words are
       applied once, here, before the first harness exists. */
    entityNow = applyPlanRevision(ctx, segments, entityNow, decision)
  }

  /* `entityNow` includes the references: they resolve here and run nothing, and
     their row in the block still says the name went nowhere. */
  await Promise.all(entityNow.map((segment) => resolveOne(ctx, segment)))

  if (ctx.errors.length) {
    throw new Error(
      `${ctx.errors.join('\n')}\nFix the mention or remove it — nothing was sent.`,
    )
  }

  /* The runs that actually answered, in order: the reply above reads them, and
     their count is what the prompt states. A reference is not a run. */
  const runs = segments.filter(
    (segment) => segment.mention?.kind === 'entity' && !segment.mention.reference,
  )
  const block = blockFor(segments, ctx.notes)
  /* A fan-out is done by the time the parent reads its prompt: the runs already
     happened. Handing it the raw `spawn per … @coder …` sentence invites a
     parent that delegates — or works — a second time, which for a routing skill
     means an extra worktree. The transcript keeps the person's words; the prompt
     states what was done.
     
     `spawn 1` is the same deal and used to slip through: `spawn.count > 1` was
     the only test, so one requested run read as "not a fan-out" and the parent
     was handed the instruction as its own job — it then did the work a second
     time, at full length, after the child had already answered. A count of one
     is still a delegated run, and the sentence that delegated it is not the
     parent's task. */
  const fanned =
    runs.length >= 1 &&
    Boolean(planned || (spawn && (spawn.kind === 'per' || spawn.count >= 1)))
  const rowsAbove = runs.some((run) => run.row)
  const ownJobs = runs.some((run) => run.plannedJob)
  const arrangement = rowsAbove
    ? 'one per row above'
    : ownJobs
      ? 'each with its own instruction above'
      : 'all of the same instruction'
  const prompt = fanned
    ? runs.length === 1
      ? `The run of ${tokenOf(target || runs[0])} above has already happened and its answer is ` +
        'in the list. That was the work this message asked for; read it and answer from what it ' +
        'found. Do not repeat it yourself and do not delegate it again.'
      : `${runs.length} runs of ${tokenOf(target || runs[0])}, ${arrangement}. They have already ` +
        'run and their answers are in the list. Write one short paragraph saying what each run did ' +
        'and which one still needs something; do not run them again and do not do their work yourself.'
    : source
  const resolved = segments
    .filter((segment) => segment.mention)
    .map((segment) => segment.mention)
  /* A message that asked for nothing but the reads is already answered, and
     writing that answer here is what keeps a harness out of it — see
     `answerFor`. An empty answer falls back to the ordinary turn. */
  const answer = askedOnlyReads(source, segments) ? answerFor(segments, ctx.notes) : ''
  return {
    text: block ? `${block}\n\n${prompt}` : prompt,
    mentions: resolved,
    ...(answer ? { readsOnly: true, answer } : {}),
  }
}

module.exports = {
  rewrite,
  parse,
  parseMention,
  planOfRuns,
  tokenOf,
  sources,
  search,
  /* Orca's own module, under the names `integrations-store` and the call table
     already ask for. The worktree reader here is the primitive: the surfaces that
     ask it (`mention.worktree`, the salvage above) check the switch first. */
  orcaRepos: orca.repos,
  orcaWorktrees: orca.worktrees,
  orcaBinary: orca.binary,
  worktreeState: orca.worktreeState,
  githubBinary: github.githubBinary,
  resolveArtifact,
  blockFor,
  listProjectFiles,
}
