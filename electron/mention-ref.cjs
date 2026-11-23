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

const MAX_PER_SOURCE = 3
const MAX_BLOCK_ROWS = 12
const ORCA_TIMEOUT_MS = 10_000
const ORCA_CACHE_MS = 60_000
/* A child workspace path as Orca writes it in a run's report. */
const ORCA_WORKSPACE_PATH = /[^\s"'`()<>]*[\\/]orca[\\/]workspaces[\\/][^\s"'`()<>]+/gi
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
   text; the parent's prompt gets a digest of it. */
const MAX_DELEGATION_ANSWER = 8_000
const ARTIFACT_SCAN_CAP = 2000

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

function parse(text) {
  const source = String(text || '')
  const starts = []
  MENTION_AT.lastIndex = 0
  let match
  while ((match = MENTION_AT.exec(source))) starts.push(match.index + match[1].length)

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
  const word = body2.split(/[\s:]+/)[0] || ''
  const after = body2.slice(word.length)
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

  /* github: everything after the colon is the query — `owner/repo` names one
     repository, anything else is a search. The slash is inside the word, so a
     `:` does not scope it. */
  if (head === 'github') return { kind: 'github', query: whole, local }

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
  return segment.raw
}

/* ── orca ─────────────────────────────────────────────────────────── */

let orcaCache = { at: 0, repos: [] }

function orcaBinary() {
  if (process.env.ENTITY_ORCA_BIN) return process.env.ENTITY_ORCA_BIN
  const app = '/Applications/Orca.app/Contents/Resources/bin/orca'
  return fs.existsSync(app) ? app : 'orca'
}

function execFileText(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(
          new Error(
            error?.code === 'ENOENT'
              ? 'orca is not installed, or not on PATH.'
              : String(error?.message || error).slice(0, 200),
          ),
        )
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/**
 * `gh`, resolved once. A missing binary is a miss the mention reports rather than
 * a silent empty list: `harnesses.which` is the same PATH walk the Harnesses
 * page uses, so the two agree on what is installed.
 */
let githubBinCache = ''

function githubBinary() {
  if (process.env.ENTITY_GH_BIN) return process.env.ENTITY_GH_BIN
  if (githubBinCache) return githubBinCache
  githubBinCache = harnesses.which('gh') || 'gh'
  return githubBinCache
}

async function execGithub(args) {
  try {
    return await execFileText(githubBinary(), args, ORCA_TIMEOUT_MS)
  } catch (error) {
    const message = String(error?.message || error)
    throw new Error(
      /not installed, or not on PATH/.test(message)
        ? 'gh is not installed, or not on PATH.'
        : `gh ${args[0] || ''} failed: ${message}`,
    )
  }
}

/** The repos Orca knows, cached for a minute: one CLI spawn per burst of mentions. */
async function orcaRepos({ force = false } = {}) {
  if (!force && Date.now() - orcaCache.at < ORCA_CACHE_MS) return orcaCache.repos
  const raw = await execFileText(orcaBinary(), ['repo', 'list', '--json'], ORCA_TIMEOUT_MS)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('orca repo list did not return JSON.')
  }
  const repos = parsed?.result?.repos || parsed?.repos || []
  orcaCache = { at: Date.now(), repos }
  return repos
}

let worktreeCache = { at: 0, list: [] }

/** Child and main worktrees Orca knows, cached like the repo list. */
async function orcaWorktrees({ force = false } = {}) {
  if (!force && Date.now() - worktreeCache.at < ORCA_CACHE_MS) return worktreeCache.list
  const raw = await execFileText(orcaBinary(), ['worktree', 'list', '--json'], ORCA_TIMEOUT_MS)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('orca worktree list did not return JSON.')
  }
  const list = parsed?.result?.worktrees || parsed?.worktrees || []
  worktreeCache = { at: Date.now(), list }
  return list
}

/**
 * clean | dirty | gone | none — the worktree a delegated row works in, as it is
 * *now*. A field stored at run time would freeze at "clean, exists" and lie in
 * exactly the case this exists for: the row was merged and the worktree removed.
 *
 * The run's own record comes first: a fan-out shares a cwd and a ticket key, so
 * the key alone paints one word on N cards. A delegated run that worked in a
 * child workspace names that path in its report, and a path is per-run. The
 * renderer sends the record, the ticket key and the run's cwd; every path this
 * reads or stats came out of `orca worktree list`, never out of the message.
 */
async function worktreeState({ cwd = '', ticket = '', record = '' } = {}) {
  const key = String(ticket || '').trim().toLowerCase()
  const named = recordPaths(record)
  /* Nothing said about a worktree, and no key to guess from. */
  if (!key && !named.length) return { state: 'none' }
  const dir = cwd ? path.resolve(String(cwd)) : ''
  const inside = (root, at) => {
    if (!at) return false
    const base = path.resolve(String(root || '.'))
    return at === base || at.startsWith(base + path.sep)
  }
  const worktrees = await orcaWorktrees()
  /* The record's own evidence, kept only where Orca itself lists that path. */
  const listed = new Map(worktrees.map((worktree) => [path.resolve(String(worktree.path || '.')), worktree]))
  /* A run on another machine names *that* machine's path, which this machine's
     list will never contain — a remote report is not evidence of a removal.
     Keep a named path only where its worktree base (`…/orca/workspaces/<repo>`)
     is a base this Orca lists, and drop the rest before anything is called gone. */
  const bases = new Set([...listed.keys()].map((at) => path.dirname(at)))
  const local = named.filter((at) => bases.has(path.dirname(at)))
  const mine = local.map((at) => listed.get(at)).filter(Boolean)
  let hit = mine.find((worktree) => matchesKey(worktree, key)) || mine[0]
  /* A record that names a workspace this Orca no longer lists is `gone` — that is
     the difference between "merged and removed" and "never created". */
  if (!hit && local.length) return { state: 'gone', name: path.basename(local[0]) }
  if (!hit) {
    /* The cwd *narrows* the search when it names a repo, and only when it does:
       an entity whose `dir` is `~` runs outside every checkout, and returning
       `none` there would hide the chip for exactly the rows that have a worktree.
       Narrowing is a nicety (one repo's keys), not the boundary — the boundary is
       that `hit.path` below is Orca's word, and `git` is run against nothing else. */
    const repos = await orcaRepos()
    let scope = repos.find((entry) => inside(entry.path, dir))
    if (!scope) {
      /* a run pointed *at* a child worktree names its repo the same way */
      const at = worktrees.find((worktree) => inside(worktree.path, dir))
      if (at) scope = repos.find((entry) => entry.id === at.repoId)
    }
    /* The same match the `orca-worktree` skill uses to reuse a child workspace:
       the ticket key in its branch or display name. */
    hit = worktrees
      .filter((worktree) => !worktree.isMainWorktree && (!scope || worktree.repoId === scope.id))
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0))
      .find((worktree) => matchesKey(worktree, key))
  }
  /* A run that names no workspace and matches no key shows no chip: absence is
     not evidence, and a guess here is the lie the chip exists to prevent. */
  if (!hit) return { state: 'none' }
  if (!fs.existsSync(String(hit.path))) return { state: 'gone', name: worktreeName(hit) }
  let files = 0
  try {
    files = String(
      await execFileText('git', ['-C', String(hit.path), 'status', '--porcelain'], ORCA_TIMEOUT_MS),
    )
      .split('\n')
      .filter(Boolean).length
  } catch {
    /* `execFileText` says "orca is not installed" on ENOENT, which is not what
       went wrong for git — swallow it rather than paint a project state. */
    return { state: 'unknown' }
  }
  return {
    state: files ? 'dirty' : 'clean',
    files,
    name: worktreeName(hit),
    path: String(hit.path),
    branch: String(hit.branch || '').replace(/^refs\/heads\//, ''),
  }
}

/** `ENTITY-53` in a worktree's branch or display name, the skill's own match. */
function matchesKey(worktree, key) {
  if (!key) return false
  return `${worktree.branch || ''} ${worktree.displayName || ''}`.toLowerCase().includes(key)
}

/** The workspace's own name: what the chip paints, so N runs read as N names. */
function worktreeName(worktree) {
  if (!worktree) return ''
  const raw = String(worktree.branch || '').replace(/^refs\/heads\//, '') || String(worktree.displayName || '') || String(worktree.path || '')
  return raw ? path.basename(raw) : ''
}

/** Every `…/orca/workspaces/<repo>/<name>` path a run's record names. */
function recordPaths(record) {
  const text = typeof record === 'string' ? record : JSON.stringify(record || '')
  const out = []
  for (const [raw] of String(text || '').matchAll(ORCA_WORKSPACE_PATH)) {
    /* a report writes its paths in prose: "…/card, then merged" */
    const at = path.resolve(raw.replace(/[.,;:!?]+$/, ''))
    if (!out.includes(at)) out.push(at)
  }
  return out
}

/** Project names for the composer's `@` menu. */
async function sources() {
  try {
    const repos = await orcaRepos()
    return { orca: repos.map((repo) => ({ name: repo.displayName || path.basename(repo.path), path: repo.path })) }
  } catch {
    return { orca: [] }
  }
}

async function resolveOrca(ctx, segment) {
  const repos = await ctx.deps.orcaRepos()
  const wanted = String(segment.project || '').toLowerCase()
  const repo =
    repos.find((entry) => String(entry.displayName || '').toLowerCase() === wanted) ||
    repos.find((entry) => path.basename(String(entry.path || '')).toLowerCase() === wanted)
  if (!repo) {
    throw new Error(`@orca:${segment.project} is not a project Orca knows.`)
  }
  const root = path.resolve(String(repo.path))
  if (!segment.file) {
    return [{ label: root, detail: repo.displayName || path.basename(root) }]
  }
  const target = path.resolve(root, segment.file)
  /* a mention must not walk out of the repo it named */
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`@orca:${segment.project}:${segment.file} points outside that project.`)
  }
  return [{ label: target, detail: fs.existsSync(target) ? '' : 'does not exist yet' }]
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

/**
 * `@github:` — one repository by `owner/repo`, or a repository search.
 *
 * ponytail: two shapes only (a repo and a search over repos), because issues and
 * PRs already have their own MCP server surface; widening it means a third
 * dispatch on `gh search issues` / `gh search prs` once someone asks for it.
 *
 * A manually typed token resolves here whatever the Account → Integrations
 * switch says: that switch decides whether the composer *offers* the token, not
 * whether a resolver refuses one a person wrote out in full.
 */
async function resolveGithub(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@github: needs a repository (owner/repo) or a search query.')
  const run = ctx.deps.execGithub
  /* `owner/repo` is a whole query with one slash — the shape `gh api` takes */
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query)) {
    const raw = await run(['api', `repos/${query}`])
    let repo = null
    try {
      repo = JSON.parse(raw)
    } catch {
      throw new Error(`@github:${query} did not resolve to a repository Gh could read.`)
    }
    if (!repo?.full_name) throw new Error(`@github:${query} is not a repository Gh knows.`)
    return [
      {
        id: repo.full_name,
        label: `${repo.full_name} — ${repo.description || 'a repository'}`,
        detail: [repo.language, repo.private ? 'private' : 'public', repo.html_url]
          .filter(Boolean)
          .join(' · '),
        url: repo.html_url || `https://github.com/${repo.full_name}`,
      },
    ]
  }
  const raw = await run(['search', 'repos', '--limit', String(limit), '--json', 'fullName,description,url', query])
  let rows = []
  try {
    rows = JSON.parse(raw)
  } catch {
    throw new Error('gh search repos did not return JSON.')
  }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.fullName || '',
    label: `${row.fullName || ''} — ${row.description || 'a repository'}`,
    detail: row.url || '',
    url: row.url || '',
  }))
}

/* ── entity: a mini run, not a path ───────────────────────────────── */

function spawnParse(spec, dir, { record, entity, mcp, onChild = null }) {
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
      done(`did not answer within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`)
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
    return await spawnParse(spec, dir, { record, entity: mentioned, mcp, onChild })
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
    const repos = await merged.orcaRepos()

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
    /* The composer offers a whole query, so there is one page: the repo the
       person named, or the first `limit` matches of `gh search repos`. */
    const query = fields.join(':').trim()
    if (!query) return { items: [], more: false }
    const rows = await resolveGithub(ctx, { query }, { limit: offset + limit })
    return {
      items: rows.slice(offset, offset + limit).map((row) => ({
        insert: `@github:${row.id}`,
        label: row.label,
        detail: row.detail,
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
  orcaRepos,
  mcpCall: mcpTools.callTool,
  execGithub,
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
        segment.mention = {
          kind: 'entity',
          raw: segment.raw,
          token: tokenOf(segment),
          name: mentioned.name,
          job: instructionOf(segment),
          ...(segment.row ? { row: segment.row } : {}),
          items: [],
          answer: '',
          note: 'stopped by you',
          status: 'error',
        }
        ctx.report()
        return
      }
      segment.runStatus = 'running'
      ctx.report()
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
      const job = [
        segment.carriedSkill && !/^use this skill /i.test(resolved)
          ? segment.carriedSkill
          : '',
        resolved,
        shareNote(segment),
      ]
        .filter(Boolean)
        .join('\n\n')
      const run = await ctx.deps.runEntity(ctx.record, mentioned, job, {
        onChild: ctx.onChild,
      })
      segment.runStatus = run.ok ? 'ok' : 'error'
      segment.mention = {
        kind: 'entity',
        raw: segment.raw,
        token: tokenOf(segment),
        name: mentioned.name,
        job: instruction,
        ...(segment.row ? { row: segment.row } : {}),
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
      if (!run.ok) ctx.notes.push(segment.mention.note)
      ctx.report()
      return
    }

    if (segment.kind === 'orca') {
      const items = await resolveOrca(ctx, segment)
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
      const items = await resolveGithub(ctx, segment, { limit: ctx.rowLimit || MAX_PER_SOURCE })
      segment.mention = { kind: 'github', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@github:${segment.query} matched no repository`)
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
function planFor(ctx, segments) {
  const rows = ctx.runs.map((segment, index) => {
    const mentioned = ctx.entities.get(String(segment.name || '').toLowerCase()) || null
    let dir = ''
    let note = ''
    try {
      dir = mentioned ? entities.resolveDir(mentioned) : ''
    } catch {
      note = 'no folder set'
    }
    return {
      index,
      total: ctx.runs.length,
      name: segment.runName || segment.name || '',
      row: segment.row || '',
      job: instructionOf(segment),
      share: segment.share ? `${segment.share[0]}/${segment.share[1]}` : '',
      harness: String(mentioned?.harness || ''),
      model: String(mentioned?.model || ''),
      dir,
      shownDir: tilde(dir),
      note,
      status: 'queued',
      answer: '',
      ms: 0,
    }
  })
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
async function delegatePlan(record, source, plan) {
  if (!plan?.entity) return null
  const known = entities
    .list(record.id)
    .some((item) => item.name.toLowerCase() === String(plan.entity).toLowerCase())
  if (!known) return null
  const sentence = planSentence(plan)
  if (!sentence) return null
  const prologue = String(source || '').match(SKILL_PROLOGUE)
  return {
    source: prologue ? `${prologue[0].trim()}\n\n${sentence}` : sentence,
    carriedSkill: prologue ? prologue[0].trim() : '',
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
  /* The grammar first, for free — but only when it is the whole story. A message
     opening with a prefix it reads exactly is never second-guessed: the person's
     own count is a better answer than anything a model could return.

     Except when the message also enumerates items. `let's spawn 4 @coder …` over
     a four-item bullet list is four DIFFERENT pages, and reading just the count
     gives four agents one sentence — four redesigns of one page, the failure
     this layer exists to stop. The grammar cannot see a list, so that message is
     classified: it is the one case where a written count is not the whole ask. */
  const barePrefix = spawnPrefix(source)
  /* required here, not imported at load: `intent-ref` is a sibling that already
     requires this module, and a load-time edge would be a cycle. */
  const enumerates =
    barePrefix !== null && require('./intent-ref.cjs').listedItems(source).length >= 2
  /* `unreadableJob` is the third reason to classify, and the one this layer kept
     getting wrong: the grammar can always *split* an `@entity` from its job, so
     it never demoted itself — even when the split threw the instruction away.
     `spawn 1 @designer on @orca:entity I want to redesign this page` reads as the
     job "on" because a delegated job ends at the next `@`, and the person's real
     sentence lives past it. That is not the grammar reading the message exactly;
     it is the grammar reading it wrong, so the model is asked — and its plan
     (`spawn 1 @designer <the real ask>`) is the one the card confirms. */
  const unreadableJob = openingProseHasUnreadableJob(source)
  if (intent && (barePrefix === null || enumerates || unreadableJob) && !stopped?.()) {
    let plan = null
    try {
      plan = await intent(source)
    } catch {
      /* a reader that throws is a reader with nothing to say */
      plan = null
    }
    const delegated = plan ? await delegatePlan(record, source, plan) : null
    if (delegated) {
      source = delegated.source
      carriedSkill = delegated.carriedSkill
    }
  }
  const spawn = spawnPrefix(source)
  const parsed = parse(source)
  if (!parsed.segments.length) return { text: source, mentions: [] }
  if (spawn?.kind === 'repeat' && spawn.count > MAX_SPAWN_RUNS) {
    throw new Error(
      `spawn ${spawn.count} is more than ${MAX_SPAWN_RUNS} runs. Nothing was sent — lower the number.`,
    )
  }
  let segments = parsed.segments
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
  const runCap =
    spawn?.kind === 'per' || spawn?.kind === 'rows'
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
  const entityNow = runNow.filter((segment) => segment.kind === 'entity')
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
    const decision = await ctx.hold(planFor(ctx, segments))
    if (!decision || decision.action !== 'run') throw holdError(decision, ctx)
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
    spawn && (spawn.kind === 'per' || spawn.count >= 1) && runs.length >= 1
  const prompt = fanned
    ? runs.length === 1
      ? `The run of ${tokenOf(target || runs[0])} above has already happened and its answer is ` +
        'in the list. That was the work this message asked for; read it and answer from what it ' +
        'found. Do not repeat it yourself and do not delegate it again.'
      : `${runs.length} runs of ${tokenOf(target || runs[0])}, one per row above. They have already ` +
        'run and their answers are in the list. Write one short paragraph saying what each run did ' +
        'and which one still needs something; do not run them again and do not do their work yourself.'
    : source
  return {
    text: block ? `${block}\n\n${prompt}` : prompt,
    mentions: segments
      .filter((segment) => segment.mention)
      .map((segment) => segment.mention),
  }
}

module.exports = {
  rewrite,
  parse,
  parseMention,
  tokenOf,
  sources,
  search,
  orcaRepos,
  orcaWorktrees,
  orcaBinary,
  worktreeState,
  resolveArtifact,
  blockFor,
  listProjectFiles,
}
