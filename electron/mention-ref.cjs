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
const ENTITY_TIMEOUT_MS = 120_000
const MAX_ENTITY_RUNS = 2
const ARTIFACT_SCAN_CAP = 2000

/* ── parsing ──────────────────────────────────────────────────────── */

/* A mention starts at `@` after start/space/(/[ so `me@example.com` stays text. */
const MENTION_AT = /(^|[\s(\[])@(?=[A-Za-z0-9._-])/g

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
  const body = raw.slice(1)
  const colon = body.indexOf(':')
  if (colon < 0) {
    const [name, ...rest] = body.trim().split(/\s+/)
    return { kind: 'entity', name, job: rest.join(' ').trim(), query: rest.join(' ').trim() }
  }

  const head = body.slice(0, colon).trim().toLowerCase()
  const rest = body.slice(colon + 1)
  if (!KINDS.has(head)) return { kind: 'unknown', name: head }

  if (head === 'artifact') return { kind: 'artifact', query: rest.trim() }

  const parts = rest.split(':')
  const first = (parts[0] || '').trim()
  const tail = parts.slice(1).join(':').trim()
  /* The structured field is ONE word: `@orca:maka tell me about it` is the maka
     project plus a sentence, not a project called "maka tell me about it". */
  const word = first.split(/\s+/)[0] || ''
  const afterWord = first.slice(word.length).trim()

  if (head === 'orca') {
    return { kind: 'orca', project: parts.length > 1 ? first : word, file: tail }
  }

  if (head === 'maka') {
    /* `@maka:plan` is a query; `@maka:one:plan` is a vault and a query */
    return parts.length > 1
      ? { kind: 'maka', vault: first, query: tail }
      : { kind: 'maka', vault: '', query: rest.trim() }
  }

  /* youtrack: a project key is short and upper-case; the rest is the query */
  if (parts.length > 1) return { kind: 'youtrack', project: first, query: tail }
  if (/^[A-Z][A-Z0-9]{1,9}$/.test(word)) {
    return { kind: 'youtrack', project: word, query: afterWord }
  }
  return { kind: 'youtrack', project: '', query: rest.trim() }
}

/** The mention as it would be written on its own — no trailing instruction. */
function tokenOf(segment) {
  if (segment.kind === 'entity') return `@${segment.name}`
  if (segment.kind === 'orca') {
    return `@orca:${segment.project}${segment.file ? `:${segment.file}` : ''}`
  }
  if (segment.kind === 'artifact') return `@artifact:${segment.query}`
  if (segment.kind === 'maka') {
    return segment.vault
      ? `@maka:${segment.vault}${segment.query ? `:${segment.query}` : ''}`
      : `@maka:${segment.query}`
  }
  if (segment.kind === 'youtrack') {
    return segment.project
      ? `@youtrack:${segment.project}${segment.query ? `:${segment.query}` : ''}`
      : `@youtrack:${segment.query}`
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

function spawnParse(spec, dir, { record, entity, mcp }) {
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

    const parser = createParser(entity.harness)
    let stderr = ''
    let settled = false
    const done = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parsed = parser.finish()
      resolve({
        ok: !error && !parsed.error,
        answer: parsed.answer || '',
        error: String(error || parsed.error || ''),
      })
    }
    const timer = setTimeout(() => {
      killTree(child, 'SIGTERM')
      done('did not answer within 2 minutes')
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

async function runEntity(record, mentioned, job) {
  if (!job) throw new Error(`@${mentioned.name} needs a job after the name.`)
  /* required here, not at the top: `runner-local` owns this module's entry
     points, and a load-time cycle would hand it an empty object */
  const { chatInvocation } = require('./runner-local.cjs')
  const dir = entities.resolveDir(mentioned)
  const mcp = mcpRuntime.materialise({ record, entity: mentioned, harness: mentioned.harness })
  try {
    const instructions = platform.compose({
      record,
      entity: mentioned,
      extra:
        'You were mentioned inside another entity\'s chat and are answering one job for it. ' +
        'Answer only that job, in a short paragraph. Do not ask questions.',
    })
    let spec
    try {
      spec = chatInvocation(mentioned.harness, instructions, job, mentioned.model, mcp)
    } catch (error) {
      return { ok: false, answer: '', error: String(error?.message || error) }
    }
    spec.cmd = harnesses.binary(mentioned.harness) || spec.cmd
    return await spawnParse(spec, dir, { record, entity: mentioned, mcp })
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
async function fetchPage(ctx, kind, fields, limit, offset) {
  const merged = ctx.deps
  const workspace = ctx.workspace

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
async function search({ record, kind, fields = [], limit = 10, offset = 0, deps = {} } = {}) {
  const ctx = { record, workspace: record?.id, deps: { ...defaultDeps, ...deps } }
  const key = `${kind}|${fields.join(':')}|${offset}|${limit}`
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
      const run = await ctx.deps.runEntity(ctx.record, mentioned, segment.job)
      segment.mention = {
        kind: 'entity',
        raw: segment.raw,
        token: tokenOf(segment),
        name: mentioned.name,
        items: [],
        answer: String(run.answer || '').slice(0, 1200),
        note: run.ok ? '' : `@${mentioned.name} failed: ${run.error}`,
      }
      if (!run.ok) ctx.notes.push(segment.mention.note)
      return
    }

    if (segment.kind === 'orca') {
      const items = await resolveOrca(ctx, segment)
      segment.mention = { kind: 'orca', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      return
    }

    if (segment.kind === 'artifact') {
      const items = resolveArtifact(ctx.record, segment.query)
      segment.mention = { kind: 'artifact', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@artifact:${segment.query} matched no file in this workspace`)
      return
    }

    if (segment.kind === 'maka') {
      const items = await resolveMaka(ctx, segment)
      segment.mention = { kind: 'maka', raw: segment.raw, token: tokenOf(segment), items, note: '' }
      if (!items.length) ctx.notes.push(`@maka:${segment.query} found no note`)
      return
    }

    if (segment.kind === 'youtrack') {
      const items = await resolveYoutrack(ctx, segment)
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
    if (mention.kind === 'entity') {
      const answer = mention.answer
        ? mention.answer.replace(/\s+/g, ' ').slice(0, 400)
        : mention.note || 'no answer'
      rows.push(`- ${mention.token || mention.raw} (entity ${mention.name}) → answer: ${answer}`)
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
async function rewrite(record, text, { entity = null, machine = 'local', deps = {} } = {}) {
  const source = String(text || '')
  const { segments } = parse(source)
  if (!segments.length) return { text: source, mentions: [] }

  const ctx = {
    record,
    machine,
    entity,
    deps: { ...defaultDeps, ...deps },
    notes: [],
    errors: [],
    entities: new Map(
      entities.list(record.id).map((item) => [item.name.toLowerCase(), item]),
    ),
  }

  const entitiesToRun = segments.filter((segment) => segment.kind === 'entity')
  const skipped = entitiesToRun.slice(MAX_ENTITY_RUNS)
  for (const segment of skipped) ctx.notes.push(`${segment.raw} skipped: at most ${MAX_ENTITY_RUNS} entity mentions per message`)

  await Promise.all(
    segments
      .filter((segment) => segment.kind !== 'unknown' && !skipped.includes(segment))
      .map((segment) => resolveOne(ctx, segment)),
  )

  if (ctx.errors.length) {
    throw new Error(
      `${ctx.errors.join('\n')}\nFix the mention or remove it — nothing was sent.`,
    )
  }

  const block = blockFor(segments, ctx.notes)
  return {
    text: block ? `${block}\n\n${source}` : source,
    mentions: segments
      .filter((segment) => segment.mention)
      .map((segment) => segment.mention),
  }
}

module.exports = { rewrite, parse, parseMention, tokenOf, sources, search, orcaRepos, resolveArtifact, blockFor }
