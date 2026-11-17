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
const { spawnTracked, killTree } = require('./child-registry.cjs')
const entities = require('./entity-store.cjs')
const harnesses = require('./harness-store.cjs')
const mcpTools = require('./mcp-tools.cjs')
const mcpRuntime = require('./mcp-runtime.cjs')
const platform = require('./platform-brief.cjs')
const { createParser } = require('./chat-transcript.cjs')

const KINDS = new Set(['orca', 'artifact', 'maka', 'youtrack'])

const MAX_PER_SOURCE = 3
const MAX_BLOCK_ROWS = 8
const ORCA_TIMEOUT_MS = 10_000
const ORCA_CACHE_MS = 60_000
/* A delegated job is real work — reading a brief, editing files, running the
   test suite — not a search. Two minutes killed the very delegation this
   feature exists for. An hour, because a job that has to be *finished* is not
   one pass: a first pass that goes green, a fix round and a screenshot took 28
   minutes on a real issue. Still bounded, and a person can cancel the turn. */
const MENTION_TIMEOUT_MS = Number(process.env.ENTITY_MENTION_TIMEOUT_MS)
const ENTITY_TIMEOUT_MS = MENTION_TIMEOUT_MS > 0 ? MENTION_TIMEOUT_MS : 60 * 60_000
const MAX_ENTITY_RUNS = 2
/* `spawn N @entity …` is an explicit ask for N parallel runs of one instruction,
   so its own cap is what the person wrote — still bounded, because a typo is not
   a reason to start forty harnesses. */
const MAX_SPAWN_RUNS = 5
/* `spawn per` is one run for each row the list resolved. Eight, because the
   block the reply reads holds eight rows and each run owns one: a ninth answer
   would be dropped by a ceiling nobody chose. */
const MAX_FANOUT_ROWS = 8
/* What one delegated run may report back. The card and the session show this
   text; the parent's prompt gets a digest of it. */
const MAX_DELEGATION_ANSWER = 8_000
const ARTIFACT_SCAN_CAP = 2000

/* ── parsing ──────────────────────────────────────────────────────── */

/* A mention starts at `@` after start/space/(/[ so `me@example.com` stays text. */
const MENTION_AT = /(^|[\s(\[])@(?=@?[A-Za-z0-9._-])/g

/* `spawn 3 @secretary …` and `spawn per @youtrack:… @coder …`, right at the start
   of the message. Both only count when a mention follows, so "spawn 3 tasks in
   the backlog" stays prose. */
const SPAWN_PREFIX = /^\s*spawn\s+(\d{1,2})\s+(?=@)/
const SPAWN_PER = /^\s*spawn\s+per\s+(?=@)/i
/* `skill-ref` replaces a leading `/workspace:x` with this line before we see the
   prompt, so a skill at the front of a fan-out arrives as a prologue. */
const SKILL_PROLOGUE = /^use this skill \S+\s*\n+/i
const SPAWN_AFTER_SKILL = /^\s*spawn\s+(?:per\b|\d{1,2}\s+@)/i

function spawnPrefix(source) {
  const text = String(source || '')
  const per = text.match(SPAWN_PER)
  if (per) return { kind: 'per', count: 0, end: per[0].length }
  const match = text.match(SPAWN_PREFIX)
  if (!match) return null
  const count = Number(match[1])
  if (!Number.isFinite(count) || count < 1) return null
  return { kind: 'repeat', count, end: match[0].length }
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

  const parts = rest.split(':')
  const first = (parts[0] || '').trim()
  const tail = parts.slice(1).join(':').trim()
  /* The structured field is ONE word: `@orca:maka tell me about it` is the maka
     project plus a sentence, not a project called "maka tell me about it". */
  const word = first.split(/\s+/)[0] || ''
  const afterWord = first.slice(word.length).trim()

  if (head === 'orca') {
    return { kind: 'orca', project: parts.length > 1 ? first : word, file: tail, local }
  }

  if (head === 'maka') {
    /* `@maka:plan` is a query; `@maka:one:plan` is a vault and a query */
    return parts.length > 1
      ? { kind: 'maka', vault: first, query: tail, local }
      : { kind: 'maka', vault: '', query: rest.trim(), local }
  }

  /* youtrack: a project key is short and upper-case; the rest is the query */
  if (parts.length > 1) return { kind: 'youtrack', project: first, query: tail, local }
  if (/^[A-Z][A-Z0-9]{1,9}$/.test(word)) {
    return { kind: 'youtrack', project: word, query: afterWord, local }
  }
  return { kind: 'youtrack', project: '', query: rest.trim(), local }
}

/** The mention as it would be written on its own — no trailing instruction. */
function tokenOf(segment) {
  const at = segment.local ? '@@' : '@'
  if (segment.kind === 'entity') return `${at}${segment.name}`
  if (segment.kind === 'orca') {
    return `${at}orca:${segment.project}${segment.file ? `:${segment.file}` : ''}`
  }
  if (segment.kind === 'artifact') return `${at}artifact:${segment.query}`
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

  return { items: [], more: false }
}

/**
 * Suggestions for the `@` menu, one page at a time. Pages are cached for 30 s,
 * so backspacing over a prefix is free and "Show more" costs one call.
 */
async function search({ record, kind, fields = [], limit = 10, offset = 0, dir = '', deps = {} } = {}) {
  const ctx = { record, workspace: record?.id, dir: String(dir || ''), deps: { ...defaultDeps, ...deps } }
  const key = `${kind}|${ctx.dir}|${fields.join(':')}|${offset}|${limit}`
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
  runEntity,
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
          job: segment.row ? `${segment.row}\n\n${segment.job}` : segment.job,
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
      const instruction = segment.row ? `${segment.row}\n\n${segment.job}` : segment.job
      /* The skill is resolved on the person's words, not on the row-prefixed
         instruction: `use this skill <path>` has to stay the first line for the
         harness to load it. The row reaches the run through the note below. */
      const job = [resolveSkillInJob(ctx.record, segment.job), shareNote(segment)]
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
    }
  } catch (error) {
    const message = String(error?.message || error)
    /* names are hard errors; a search that failed is a note */
    if (segment.kind === 'entity' || segment.kind === 'orca') ctx.errors.push(message)
    else ctx.notes.push(message)
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
      const answer = mention.answer
        ? mention.answer.replace(/\s+/g, ' ').slice(0, 400)
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
    deps = {},
    onProgress = null,
    onChild = null,
    stopped = null,
  } = {},
) {
  const source = String(text || '')
  const spawn = spawnPrefix(source)
  const parsed = parse(source)
  if (!parsed.segments.length) return { text: source, mentions: [] }
  /* A fan-out routes each run, not the message. A leading `/workspace:` reaches
     us as `use this skill <path>` in front of the prefix, which used to leave the
     parent to create one desk for the whole message — the exact opposite. */
  const prologue = source.match(SKILL_PROLOGUE)
  if (prologue && SPAWN_AFTER_SKILL.test(source.slice(prologue[0].length))) {
    throw new Error(
      'A fan-out routes each run, not the message: put the skill inside the job — ' +
        '`spawn per @youtrack:… @coder /workspace:orca-worktree …` — so every run gets its own. ' +
        'Nothing was sent.',
    )
  }
  if (spawn?.kind === 'repeat' && spawn.count > MAX_SPAWN_RUNS) {
    throw new Error(
      `spawn ${spawn.count} is more than ${MAX_SPAWN_RUNS} runs. Nothing was sent — lower the number.`,
    )
  }
  let segments = parsed.segments
  let listSegment = null
  let target = null
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
  const runCap =
    spawn?.kind === 'per'
      ? MAX_FANOUT_ROWS
      : spawn?.kind === 'repeat'
        ? Math.max(MAX_ENTITY_RUNS, spawn.count)
        : MAX_ENTITY_RUNS

  const ctx = {
    record,
    machine,
    entity,
    deps: { ...defaultDeps, ...deps },
    notes: [],
    errors: [],
    onChild,
    stopped,
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
          job: segment.row ? segment.job : segment.job || '',
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
      `@${segment.name}: is not a mention kind. Use @orca:, @artifact:, @maka: or @youtrack:, ` +
        'or write the entity name without a colon.',
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
  ctx.runs = runNow.filter((segment) => segment.kind === 'entity')
  /* Before the first harness exists: the window shows every row as queued, so a
     fan-out that takes minutes never looks like a hang. */
  ctx.report()

  await Promise.all(runNow.map((segment) => resolveOne(ctx, segment)))

  if (ctx.errors.length) {
    throw new Error(
      `${ctx.errors.join('\n')}\nFix the mention or remove it — nothing was sent.`,
    )
  }

  const block = blockFor(segments, ctx.notes)
  /* A fan-out is done by the time the parent reads its prompt: the runs already
     happened. Handing it the raw `spawn per … @coder …` sentence invites a
     parent that delegates — or works — a second time, which for a routing skill
     means an extra worktree. The transcript keeps the person's words; the prompt
     states what was done. */
  const runs = segments.filter(
    (segment) => segment.mention?.kind === 'entity' && !segment.mention.reference,
  )
  const fanned = spawn && (spawn.kind === 'per' || spawn.count > 1) && runs.length > 1
  const prompt = fanned
    ? `${runs.length} runs of ${tokenOf(target || runs[0])}, one per row above. They have already ` +
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
  resolveArtifact,
  blockFor,
  listProjectFiles,
}
