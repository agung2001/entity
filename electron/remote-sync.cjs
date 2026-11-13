/**
 * Remote workspace sync — the local half.
 *
 * A connected workspace keeps a **two-way** copy of a workspace that lives on
 * another machine. The unit of exchange is a content-addressed manifest of:
 *
 *   entities/**            Markdown instruction files
 *   artifacts/**           documents, images, whatever the workspace keeps
 *   workspace.json         label, context, mcpStrict, members   (virtual)
 *   mcp.json               enabled servers only, secrets redacted (virtual)
 *   skills.json            attached names + harness            (virtual)
 *
 * The three-way diff is `base` (the manifest after the last successful sync)
 * against `local` and `remote`. That is what makes incremental sync and
 * conflict detection possible without a clock both machines agree on:
 *
 *   local == base, remote changed   → pull
 *   remote == base, local changed   → push
 *   both changed                     → conflict: keep both, remote in place
 *   one side deleted, other unchanged→ delete on the other side (to trash)
 *   new on both with different bytes → conflict
 *
 * Nothing is pushed until every pulled text blob passed the guard
 * (`remote-guard.cjs`). A high-severity finding aborts the sync *before any
 * write* and leaves the connection in `blocked`, which is the only honest
 * response to "the remote told the agent to export its key".
 *
 * Safety rails:
 *   - no path outside `entities/` or `artifacts/` is ever written
 *   - deletions go to `<ws>/.remote-trash/<timestamp>/` on both sides
 *   - pushes are conditional (`x-entity-base`), so a concurrent edit wins and
 *     the next pass resolves it instead of being clobbered
 *   - MCP servers new to this machine land in `disabled[]` (quarantine): a
 *     remote `command` is code, and running it stays a local decision
 *   - the bearer token is stored 0600, the password never at all
 */
const fs = require('node:fs')
const path = require('node:path')
const guard = require('./remote-guard.cjs')
const harnessReview = require('./harness-review.cjs')
const harnessStore = require('./harness-store.cjs')
const manifest = require('./remote-manifest.cjs')
const workspaces = require('./workspace-store.cjs')

const STATE_FILE = '.remote.json'
const TOKEN_FILE = '.remote.token'
const TRASH_DIR = '.remote-trash'
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_GUARD = { enabled: false, harness: '', model: '' }
const LOCAL_DEBOUNCE_MS = 2500
const PULL_TOTAL_CAP = 250 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 120_000

/* Sync state is per workspace. A second manual click while a sync is running
   joins the first instead of starting a racing writer. */
const running = new Map()
const debounce = new Map()
/* A local edit that arrives while a pass is running must not be lost to the
   six-hour poll; it is re-queued when the pass settles. */
const pending = new Set()
/* A disconnect while a pass is in flight must win: the pass may not write the
   state file back and silently reconnect the workspace. */
const disconnected = new Set()
let interval = null

function statePath(record) {
  return path.join(record.path, STATE_FILE)
}

function tokenPath(record) {
  return path.join(record.path, TOKEN_FILE)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value, { mode } = {}) {
  manifest.writeAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), {
    mode,
  })
  return value
}

/** Sync state carries a roster, hashes and guard excerpts; keep it private. */
const writeState = (record, value) => writeJson(statePath(record), value, { mode: 0o600 })

function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  /* millisecond precision: two trash copies of the same path in one second must
     not overwrite each other */
  return new Date().toISOString().replace(/[-:.]/g, '')
}

function normaliseServerUrl(value) {
  let text = String(value || '').trim()
  if (!text) throw new Error('Enter the remote server URL.')
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('That is not a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The remote URL must be http:// or https://.')
  }
  if (url.username || url.password) throw new Error('Do not put credentials in the URL.')
  if (url.search || url.hash) throw new Error('The remote URL cannot carry a query or fragment.')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function readState(record) {
  const raw = readJson(statePath(record), null)
  if (!raw || raw.schema !== 1 || !raw.serverUrl || !raw.remoteWorkspace) return null
  return {
    ...raw,
    base: raw.base && typeof raw.base === 'object' ? raw.base : {},
    approved: raw.approved && typeof raw.approved === 'object' ? raw.approved : {},
  }
}

function publicState(record, state) {
  if (!state) return { connected: false, workspace: record.id }
  return {
    connected: true,
    workspace: record.id,
    serverUrl: state.serverUrl,
    remoteWorkspace: state.remoteWorkspace,
    accountEmail: state.accountEmail,
    label: state.label,
    connectedAt: state.connectedAt,
    lastSyncAt: state.lastSyncAt || '',
    lastRev: state.lastRev || '',
    status: state.status || 'idle',
    lastError: state.lastError || '',
    lastReason: state.lastReason || '',
    summary: state.lastSummary || null,
    blocked: state.blocked || null,
    quarantined: state.quarantined || [],
    mcpDiverged: state.mcpDiverged || [],
    guard: normaliseGuard(state.guard, { validate: false }),
    pendingConflicts: state.pendingConflicts || [],
    auto: state.auto !== false,
    intervalMs: state.intervalMs || DEFAULT_INTERVAL_MS,
    counts: {
      tracked: Object.keys(state.base || {}).length,
      approved: Object.keys(state.approved || {}).length,
    },
  }
}

function readToken(record) {
  try {
    return fs.readFileSync(tokenPath(record), 'utf8').trim()
  } catch {
    return ''
  }
}

function writeToken(record, token) {
  const file = tokenPath(record)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* filesystems without modes */
  }
}

function clearToken(record) {
  try {
    fs.rmSync(tokenPath(record), { force: true })
  } catch {
    /* already gone */
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────── */

async function request(record, state, route, { method = 'GET', body, headers = {}, raw = false, timeout } = {}) {
  const token = readToken(record)
  if (!token) throw Object.assign(new Error('This workspace is not signed in to its server.'), {
    code: 'unauthorized',
  })
  const url = `${state.serverUrl}/api${route}`
  const response = await fetch(url, {
    method,
    headers: {
      accept: raw ? '*/*' : 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(timeout || REQUEST_TIMEOUT_MS),
  })

  if (response.status === 401) {
    throw Object.assign(new Error('The remote server rejected this session. Reconnect.'), {
      code: 'unauthorized',
    })
  }
  if (raw) {
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Remote request failed (${response.status}).`)
    }
    return { buffer: Buffer.from(await response.arrayBuffer()), response }
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error || `Remote request failed (${response.status}).`)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

async function login(serverUrl, email, password) {
  const response = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-entity-client': 'sync',
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || `Sign-in failed (${response.status}).`)
  }
  return payload
}

async function discover({ serverUrl, email, password } = {}) {
  const baseUrl = normaliseServerUrl(serverUrl)
  const account = String(email || '').trim()
  if (!account) throw new Error('Enter the email or handle for the remote server.')
  if (!password) throw new Error('Enter the password for the remote server.')
  const session = await login(baseUrl, account, password)
  const list = await remoteWorkspaceList(baseUrl, session.token)
  return {
    serverUrl: baseUrl,
    account: {
      email: session.user?.email || account,
      name: session.user?.name || '',
      role: session.user?.role || '',
    },
    workspaces: list.map((entry) => ({
      id: String(entry.id),
      label: String(entry.label || entry.id),
      kind: String(entry.kind || ''),
      owner: entry.owner || null,
      members: Array.isArray(entry.members) ? entry.members : [],
      counts: entry.counts || null,
      updatedAt: entry.updatedAt || '',
    })),
  }
}

async function remoteWorkspaceList(serverUrl, token) {
  const response = await fetch(`${serverUrl}/api/workspaces`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `Could not list workspaces (${response.status}).`)
  return Array.isArray(payload.workspaces) ? payload.workspaces : []
}

/* ── local workspace helpers ──────────────────────────────────────── */

function updateLocalMeta(record, meta) {
  const file = path.join(record.path, 'workspace.json')
  const raw = readJson(file, {}) || {}
  const owner = meta.owner || raw.owner || record.owner || null
  const members = Array.isArray(meta.members)
    ? [...meta.members]
    : raw.members || record.members || []
  if (owner && (owner.email || owner.name)) {
    const key = String(owner.email || owner.name).toLowerCase()
    if (!members.some((entry) => String(entry.email || entry.name).toLowerCase() === key)) {
      members.unshift({ name: owner.name || owner.email, email: owner.email || '', role: 'owner' })
    }
  }
  const next = {
    ...raw,
    schema: 1,
    id: record.id,
    label: String(meta.label || record.label),
    kind: 'remote',
    createdAt: record.createdAt,
    mcpStrict: meta.mcpStrict !== false,
    context: String(meta.context || ''),
    ...(owner ? { owner } : {}),
    members,
  }
  writeJson(file, next)
  mergeMembers(record, next.owner, next.members)
  return next
}

/** Keep `members.json` — the file the UI reads — in step with the shared roster. */
function mergeMembers(record, owner, members) {
  const file = path.join(record.path, 'members.json')
  const current = readJson(file, null)
  const list = Array.isArray(members) ? members : []
  const seen = new Set()
  const roster = []
  const push = (entry, role) => {
    if (!entry || (!entry.email && !entry.name)) return
    const key = String(entry.email || entry.name).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roster.push({
      name: String(entry.name || entry.email || ''),
      email: String(entry.email || ''),
      role: ['owner', 'admin', 'member'].includes(role) ? role : 'member',
    })
  }
  if (owner) push(owner, 'owner')
  for (const entry of list) push(entry, entry.role)
  writeJson(file, {
    schema: 1,
    workspace: record.id,
    owner: owner || current?.owner || null,
    members: roster,
    updatedAt: nowIso(),
  })
}

const mergeServer = manifest.mergeServer

/**
 * Applying `mcp.json` is a merge, not an overwrite:
 *   - a server the machine already has keeps its local secret values
 *   - a server that is new to this machine is parked in `disabled[]` until a
 *     person enables it (the definition is still there to review)
 *   - local-only servers survive, so the next push offers them to the server
 */
function applyRemoteMcp(record, incoming) {
  const file = path.join(record.path, 'mcp.json')
  const current = readJson(file, { schema: 1, servers: {}, disabled: {} })
  const servers = current?.servers && typeof current.servers === 'object' ? { ...current.servers } : {}
  const disabled = current?.disabled && typeof current.disabled === 'object' ? { ...current.disabled } : {}
  const remoteServers = incoming?.servers && typeof incoming.servers === 'object' ? incoming.servers : {}
  const quarantined = []
  const diverged = []

  for (const [name, entry] of Object.entries(remoteServers)) {
    if (!entry || (!entry.command && !entry.url)) continue
    if (servers[name]) {
      /* An enabled server is code this machine will spawn. A shared workspace
         must not be able to repoint an existing `command`, `args` or `url` at
         something new; that is a remote-code-execution path, not a settings
         update. The local definition wins and the divergence is reported. */
      const changed = ['command', 'url', 'transport'].some(
        (key) => String(entry[key] || '') !== String(servers[name][key] || ''),
      ) || JSON.stringify(entry.args || []) !== JSON.stringify(servers[name].args || [])
      if (changed) {
        diverged.push(name)
        continue
      }
      servers[name] = mergeServer(servers[name], entry)
      continue
    }
    if (disabled[name]) {
      disabled[name] = mergeServer(disabled[name], entry)
      continue
    }
    disabled[name] = { ...entry, __remote: true, __remoteAt: nowIso() }
    quarantined.push(name)
  }

  writeJson(file, { schema: 1, servers, disabled }, { mode: 0o600 })
  return { quarantined, diverged }
}

/** Attach what this machine's libraries can satisfy; report the rest honestly. */
function applyRemoteSkills(record, incoming) {
  const wanted = manifest.normaliseSkills(incoming?.skills)
  const attached = new Set(
    manifest.readAttachedSkills(record.path).map((entry) => entry.name.toLowerCase()),
  )
  const missing = []
  const attachedNow = []
  for (const entry of wanted) {
    if (attached.has(entry.name.toLowerCase())) continue
    try {
      workspaces.attachSkill({ id: record.id, name: entry.name, harness: entry.harness })
      attached.add(entry.name.toLowerCase())
      attachedNow.push(entry.name)
    } catch {
      missing.push(entry.name)
    }
  }
  return { missing, attached: attachedNow }
}

function trashLocal(record, rel, buffer) {
  if (!buffer) return ''
  const stampDir = path.join(record.path, TRASH_DIR, stamp())
  const file = manifest.absoluteFor(stampDir, rel)
  manifest.writeAtomic(file, buffer)
  return path.relative(record.path, file).split(path.sep).join('/')
}

function conflictName(rel) {
  const parsed = path.posix.parse(rel)
  return `artifacts/conflicts/${parsed.dir}/${parsed.name}.${stamp()}.local${parsed.ext}`
}

function applyPull(record, rel, buffer, { conflict }) {
  if (rel === 'workspace.json') {
    let parsed
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new Error('The server sent an unreadable workspace.json.')
    }
    updateLocalMeta(record, parsed)
    return { quarantined: [], diverged: [] }
  }
  if (rel === 'mcp.json') {
    let parsed
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new Error('The server sent an unreadable mcp.json.')
    }
    return applyRemoteMcp(record, parsed)
  }
  if (rel === 'skills.json') {
    let parsed
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new Error('The server sent an unreadable skills.json.')
    }
    return { quarantined: [], diverged: [], ...applyRemoteSkills(record, parsed) }
  }
  if (conflict) {
    /* Preserve the local bytes before the remote version takes the path. */
    try {
      const local = fs.readFileSync(manifest.absoluteFor(record.path, rel))
      const target = manifest.absoluteFor(record.path, conflictName(rel))
      manifest.writeAtomic(target, local)
    } catch {
      /* the local side may already be gone */
    }
  }
  manifest.writeAtomic(manifest.absoluteFor(record.path, rel), buffer)
  return { quarantined: [] }
}

/* ── diff ─────────────────────────────────────────────────────────── */

function diff(base, localFiles, remoteFiles) {
  const paths = new Set([
    ...Object.keys(base || {}),
    ...localFiles.keys(),
    ...remoteFiles.keys(),
  ])
  const plan = {
    pull: [],
    push: [],
    deleteRemote: [],
    deleteLocal: [],
    same: [],
    conflict: [],
  }
  for (const rel of [...paths].sort()) {
    const l = localFiles.get(rel)?.sha256
    const r = remoteFiles.get(rel)?.sha256
    const b = base?.[rel]
    if (l === r) {
      if (l) plan.same.push(rel)
      continue
    }
    if (b !== undefined && l === b && r === undefined) {
      plan.deleteLocal.push({ path: rel, base: b })
      continue
    }
    if (b !== undefined && r === b && l === undefined) {
      plan.deleteRemote.push({ path: rel, base: b })
      continue
    }
    if (b !== undefined && l === b && r !== undefined) {
      plan.pull.push({ path: rel, sha256: r })
      continue
    }
    if (b !== undefined && r === b && l !== undefined) {
      plan.push.push({ path: rel, sha256: l, base: b })
      continue
    }
    if (l === undefined) {
      plan.pull.push({ path: rel, sha256: r })
      continue
    }
    if (r === undefined) {
      plan.push.push({ path: rel, sha256: l, base: b ?? '' })
      continue
    }
    /* Configuration is merged, never conflicted. A new clone has a local
       workspace.json/mcp.json of its own, so "both sides changed" is the normal
       first state; applyPull knows how to merge the roster, the MCP pool and
       the skill list. */
    if (manifest.isVirtual(rel)) {
      plan.pull.push({ path: rel, sha256: r })
      continue
    }
    /* Both sides have different bytes and neither equals the base (or there is
       no base): keep both. Remote takes the path; the local bytes are parked in
       artifacts/conflicts and pushed on the next pass. */
    plan.conflict.push({ path: rel, local: l, remote: r })
    plan.pull.push({ path: rel, sha256: r, conflict: true })
  }
  return plan
}

/* ── the sync ─────────────────────────────────────────────────────── */

async function readRemoteManifest(record, state) {
  return request(record, state, `/workspaces/${encodeURIComponent(state.remoteWorkspace)}/manifest`)
}

async function fetchBlob(record, state, rel, expected = '') {
  const query = `?path=${encodeURIComponent(rel)}`
  const { buffer } = await request(
    record,
    state,
    `/workspaces/${encodeURIComponent(state.remoteWorkspace)}/blob${query}`,
    { raw: true, timeout: TRANSFER_TIMEOUT_MS },
  )
  if (expected && manifest.sha256(buffer) !== expected) {
    throw new Error(`${rel}: the server sent bytes that do not match its manifest.`)
  }
  return buffer
}

async function pushBlob(record, state, rel, buffer, baseSha) {
  const query = `?path=${encodeURIComponent(rel)}`
  return request(record, state, `/workspaces/${encodeURIComponent(state.remoteWorkspace)}/blob${query}`, {
    method: 'PUT',
    body: buffer,
    headers: {
      'content-type': 'application/octet-stream',
      'x-entity-base': baseSha === undefined || baseSha === null ? '' : baseSha,
      'x-entity-sha256': manifest.sha256(buffer),
    },
    timeout: TRANSFER_TIMEOUT_MS,
  })
}

async function deleteRemote(record, state, rel, baseSha) {
  const query = `?path=${encodeURIComponent(rel)}`
  return request(record, state, `/workspaces/${encodeURIComponent(state.remoteWorkspace)}/blob${query}`, {
    method: 'DELETE',
    headers: { 'x-entity-base': baseSha },
  })
}

function guardPayload(entry) {
  if (entry.path === 'skills.json') return null
  if (entry.path === 'mcp.json') {
    try {
      const parsed = JSON.parse(entry.buffer.toString('utf8'))
      const servers = {}
      for (const [name, server] of Object.entries(parsed.servers || {})) {
        servers[name] = {
          command: server.command || '',
          args: Array.isArray(server.args) ? server.args : [],
          url: server.url || '',
          transport: server.transport || '',
        }
      }
      return { ...entry, buffer: Buffer.from(JSON.stringify({ servers }, null, 2)) }
    } catch {
      return entry
    }
  }
  if (entry.path === 'workspace.json') {
    try {
      const parsed = JSON.parse(entry.buffer.toString('utf8'))
      return {
        ...entry,
        buffer: Buffer.from(`${parsed.label || ''}\n${parsed.context || ''}`, 'utf8'),
      }
    } catch {
      return entry
    }
  }
  return entry
}

function summarise(plan, applied) {
  return {
    pulled: applied.pulled,
    pushed: applied.pushed,
    deletedLocal: applied.deletedLocal,
    deletedRemote: applied.deletedRemote,
    conflicts: applied.conflicts,
    skipped: applied.skipped,
    quarantined: applied.quarantined,
    mcpDiverged: applied.mcpDiverged,
    missingSkills: applied.missingSkills,
    pulledFiles: plan.pull.map((entry) => entry.path),
    pushedFiles: plan.push.map((entry) => entry.path),
  }
}

async function performSync(record, state, reason) {
  const remote = await readRemoteManifest(record, state)
  const remoteFiles = new Map(
    (Array.isArray(remote.files) ? remote.files : []).map((entry) => [
      String(entry.path),
      { ...entry, sha256: String(entry.sha256) },
    ]),
  )
  const local = await manifest.manifestForRecord(record)
  const plan = diff(state.base, local.byPath, remoteFiles)

  /* ---- pulls: fetch + guard everything before writing anything ---- */
  const pulls = []
  const blockedEntries = []
  let pullBytes = 0
  for (const entry of plan.pull) {
    if (manifest.isVirtual(entry.path)) {
      /* virtual entries are small; always fetched so the local file reflects
         the server's canonical form, not a cached one */
      const buffer = await fetchBlob(record, state, entry.path, entry.sha256)
      pulls.push({ ...entry, buffer })
      continue
    }
    if (pullBytes + (remoteFiles.get(entry.path)?.size || 0) > PULL_TOTAL_CAP) {
      blockedEntries.push(`${entry.path}: pull cap reached; will continue on the next sync`)
      continue
    }
    const buffer = await fetchBlob(record, state, entry.path, entry.sha256)
    pullBytes += buffer.length
    pulls.push({ ...entry, buffer })
  }

  /* Scan what a harness could read as instructions. An MCP definition's env
     *names* are not a payload (a token key is expected); its command and args
     are, so those are scanned without the key names. The shared workspace meta
     is scanned as label + context. */
  const guardInput = pulls
    .map((entry) => guardPayload(entry))
    .filter(Boolean)
  const inspected = guard.inspect(guardInput, { approved: state.approved })
  let ai = { enabled: false, findings: [], error: '' }
  if (state.guard?.enabled) {
    if (guardInput.length) {
      /* Fail closed: a configured evaluator that cannot run stops the pass
         before a write, rather than pretending the review happened. */
      const review = await harnessReview.reviewWithHarness(guardInput, state.guard)
      ai = {
        enabled: true,
        error: '',
        findings: review.findings.map((finding) => ({
          ...finding,
          rule: 'harness-review',
          title: `Agent reviewer (${review.harness})`,
          message: finding.reason,
          excerpt: '',
        })),
      }
    } else {
      ai = { enabled: true, findings: [], error: '' }
    }
  } else {
    ai = await guard.reviewWithModel(guardInput)
  }
  const aiFindings = (ai.findings || []).map((finding) => {
    const entry = guardInput.find((item) => item.path === finding.path)
    const approval = entry ? state.approved[entry.path] : undefined
    return {
      ...finding,
      sha256: entry ? manifest.sha256(entry.buffer) : '',
      blocked: finding.severity === 'high' && (!entry || approval !== manifest.sha256(entry.buffer)),
    }
  })
  const findings = [...inspected.findings, ...aiFindings]
  const blocked = findings.filter((finding) => finding.blocked)

  if (blocked.length) {
    const next = {
      ...state,
      status: 'blocked',
      lastError: '',
      lastSyncAt: state.lastSyncAt || '',
      blocked: {
        at: nowIso(),
        findings: findings.map((finding) => ({
          path: finding.path,
          severity: finding.severity,
          rule: finding.rule,
          title: finding.title,
          message: finding.message,
          excerpt: finding.excerpt,
          sha256: finding.sha256 || '',
        })),
        ai: ai.enabled
          ? {
              error: ai.error || '',
              harness: state.guard?.enabled ? state.guard.harness : 'api',
              model: state.guard?.enabled ? state.guard.model : '',
            }
          : null,
      },
    }
    writeState(record, next)
    return {
      workspace: record.id,
      ok: false,
      blocked: true,
      findings: next.blocked.findings,
      ai: next.blocked.ai,
      summary: { pulled: 0, pushed: 0 },
    }
  }

  /* ---- apply pulls ---- */
  const applied = {
    pulled: 0,
    pushed: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: [],
    skipped: [...(local.skipped || []), ...(remote.skipped || []), ...blockedEntries],
    quarantined: [],
    mcpDiverged: [],
    missingSkills: [],
  }
  const nextBase = { ...state.base }
  /* A path both sides already agree on becomes part of the base too; otherwise
     a later deletion of that path could not be told apart from a new file. */
  for (const rel of plan.same) {
    if (!(rel in nextBase)) {
      const sha = local.byPath.get(rel)?.sha256
      if (sha) nextBase[rel] = sha
    }
  }

  for (const entry of pulls) {
    const appliedPull = applyPull(record, entry.path, entry.buffer, {
      conflict: Boolean(entry.conflict),
    })
    nextBase[entry.path] = entry.sha256
    applied.pulled += 1
    if (entry.conflict) applied.conflicts.push(entry.path)
    if (appliedPull.quarantined?.length) applied.quarantined.push(...appliedPull.quarantined)
    if (appliedPull.diverged?.length) applied.mcpDiverged.push(...appliedPull.diverged)
    if (appliedPull.missing?.length) applied.missingSkills.push(...appliedPull.missing)
  }

  /* ---- local deletions, after pulls so a delete/pull race cannot lose data -- */
  for (const entry of plan.deleteLocal) {
    if (manifest.isVirtual(entry.path)) continue
    let buffer = null
    try {
      buffer = fs.readFileSync(manifest.absoluteFor(record.path, entry.path))
    } catch {
      /* already gone */
    }
    const moved = trashLocal(record, entry.path, buffer)
    try {
      fs.rmSync(manifest.absoluteFor(record.path, entry.path), { force: true })
    } catch {
      /* already gone */
    }
    applied.deletedLocal += 1
    if (moved) applied.skipped.push(`${entry.path}: deleted locally → ${moved}`)
    delete nextBase[entry.path]
  }

  /* ---- push: recompute so merges and conflict copies are included ---- */
  const after = await manifest.manifestForRecord(record)
  const pushPlan = diff(nextBase, after.byPath, remoteFiles)
  const pushes = [...pushPlan.push]
  /* A virtual file whose local form is a union (local secret extras, skills the
     server did not know) differs from the server without being "changed"; it is
     still a legitimate push. Only push virtuals when both sides have content. */
  for (const rel of manifest.VIRTUAL) {
    if (pushes.some((entry) => entry.path === rel)) continue
    const l = after.byPath.get(rel)?.sha256
    const r = remoteFiles.get(rel)?.sha256
    if (l && r && l !== r) pushes.push({ path: rel, sha256: l, base: r })
  }

  for (const entry of pushes) {
    if (entry.path === 'mcp.json') {
      /* Merge redacted secrets with the local copy before sending. */
      const localRaw = readJson(path.join(record.path, 'mcp.json'), { schema: 1, servers: {} })
      const buffer = after.virtual['mcp.json'] || Buffer.from(
        `${JSON.stringify(manifest.sanitizeMcp(localRaw), null, 2)}\n`,
        'utf8',
      )
      try {
        const result = await pushBlob(record, state, entry.path, buffer, entry.base ?? '')
        nextBase[entry.path] = result.sha256 || manifest.sha256(buffer)
        applied.pushed += 1
      } catch (error) {
        if (error.status === 409) applied.conflicts.push(entry.path)
        else throw error
      }
      continue
    }
    let buffer
    if (manifest.isVirtual(entry.path)) {
      buffer = after.virtual[entry.path]
    } else {
      try {
        buffer = fs.readFileSync(manifest.absoluteFor(record.path, entry.path))
      } catch {
        applied.skipped.push(`${entry.path}: vanished before it could be pushed`)
        continue
      }
    }
    if (!buffer) continue
    try {
      const result = await pushBlob(record, state, entry.path, buffer, entry.base ?? '')
      nextBase[entry.path] = result.sha256 || manifest.sha256(buffer)
      applied.pushed += 1
    } catch (error) {
      if (error.status === 409) {
        /* Someone edited the server between the manifest and this write. Leave
           the base alone; the next pass sees both changes and resolves them. */
        applied.conflicts.push(entry.path)
        continue
      }
      throw error
    }
  }

  /* ---- remote deletions ---- */
  for (const entry of plan.deleteRemote) {
    if (manifest.isVirtual(entry.path)) continue
    try {
      await deleteRemote(record, state, entry.path, entry.base ?? '')
      delete nextBase[entry.path]
      applied.deletedRemote += 1
    } catch (error) {
      if (error.status === 409) applied.conflicts.push(entry.path)
      else throw error
    }
  }

  /* Skills that the server has and this machine's libraries do not are reported
     once per sync, never silently pretended to work. */
  const wanted = pulls.find((entry) => entry.path === 'skills.json')
  if (wanted) {
    try {
      const parsed = JSON.parse(wanted.buffer.toString('utf8'))
      const attached = new Set(
        manifest
          .readAttachedSkills(record.path)
          .map((entry) => entry.name.toLowerCase()),
      )
      for (const skill of manifest.normaliseSkills(parsed.skills)) {
        if (!attached.has(skill.name.toLowerCase())) applied.missingSkills.push(skill.name)
      }
    } catch {
      /* already validated */
    }
  }

  applied.conflicts = [...new Set(applied.conflicts)]
  applied.quarantined = [...new Set(applied.quarantined)]
  applied.mcpDiverged = [...new Set(applied.mcpDiverged)]
  applied.missingSkills = [...new Set(applied.missingSkills)]

  const nextState = {
    ...state,
    status: 'idle',
    lastSyncAt: nowIso(),
    lastRev: remote.rev || '',
    lastReason: reason || 'manual',
    lastError: '',
    blocked: null,
    base: nextBase,
    approved: state.approved,
    lastSummary: summarise(plan, applied),
    quarantined: applied.quarantined,
    mcpDiverged: applied.mcpDiverged,
    pendingConflicts: applied.conflicts,
  }
  if (disconnected.has(record.id)) {
    return { workspace: record.id, ok: false, error: 'The workspace was disconnected during this sync.' }
  }
  writeState(record, nextState)
  return {
    workspace: record.id,
    ok: true,
    summary: applied,
    quarantined: applied.quarantined,
    mcpDiverged: applied.mcpDiverged,
  }
}

/* ── public API ───────────────────────────────────────────────────── */

function findRecord(id) {
  return workspaces.open(id)
}

function normaliseGuard(value, { validate = false } = {}) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_GUARD }
  const enabled = Boolean(value.enabled)
  const harness = String(value.harness || '').trim()
  const model = String(value.model || '').trim().slice(0, 160)
  if (enabled) {
    const meta = harnessStore.META.find((entry) => entry.id === harness)
    if (!meta) {
      if (validate) throw new Error('Choose a local harness for the sync evaluator.')
      /* Status reads stay non-throwing; the evaluator itself reports the real
         "not installed / not known" error on the next sync. */
      return { enabled, harness, model }
    }
    if (validate) {
      const installed = harnessStore.list().find((entry) => entry.id === harness)
      if (!installed?.installed) {
        throw new Error(
          `The sync evaluator is set to ${meta.label}, but its CLI is not installed on this machine.`,
        )
      }
    }
  }
  return { enabled, harness, model }
}

async function connect(
  { serverUrl, email, password, remoteWorkspace = '', label = '', auto = true, guard: guardConfig } = {},
  { emit = () => {} } = {},
) {
  const baseUrl = normaliseServerUrl(serverUrl)
  const account = String(email || '').trim()
  if (!account) throw new Error('Enter the email or handle for the remote server.')
  if (!password) throw new Error('Enter the password for the remote server.')

  const session = await login(baseUrl, account, password)
  const remoteList = await remoteWorkspaceList(baseUrl, session.token)
  if (!remoteList.length) {
    throw new Error('That account has no workspace on this server.')
  }
  const wanted = String(remoteWorkspace || '').trim()
  const target = wanted
    ? remoteList.find((entry) => entry.id === wanted)
    : remoteList.length === 1
      ? remoteList[0]
      : null
  if (!target) {
    const ids = remoteList.map((entry) => `${entry.id} (${entry.label})`).join(', ')
    throw new Error(`Choose a workspace to connect: ${ids}.`)
  }

  /* Connecting the same remote workspace twice is a reconnect, not a second
     clone: the base manifest is what makes the sync incremental, and losing it
     because the user clicked the button again would be a regression. */
  const already = list().find(
    (entry) =>
      entry.serverUrl === baseUrl && entry.remoteWorkspace === String(target.id),
  )
  if (already) {
    const record = findRecord(already.workspace)
    const state = readState(record)
    disconnected.delete(record.id)
    writeToken(record, session.token)
    writeState(record, {
      ...state,
      serverUrl: baseUrl,
      remoteWorkspace: String(target.id),
      accountEmail: account,
      label: String(target.label || target.id),
      ...(guardConfig ? { guard: normaliseGuard(guardConfig, { validate: true }) } : {}),
      status: 'idle',
      lastError: '',
    })
    const result = await sync({ id: record.id, reason: 'connect' }, { emit })
    const fresh = workspaces.open(record.id)
    return {
      record: fresh,
      state: publicState(fresh, readState(fresh)),
      result,
      existing: true,
    }
  }

  /* A local clone gets its own id. `team` stays `team` when free, otherwise
     `team-<server>`, then `team-<server>-2`, … The remote id lives in
     `.remote.json`, never in the path. */
  const baseLabel = String(label || target.label || target.id).trim() || target.id
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.split('.')[0] || 'remote'
    } catch {
      return 'remote'
    }
  })()
  const candidates = [baseLabel, `${baseLabel}-${host}`]
  for (let n = 2; n < 50; n += 1) candidates.push(`${baseLabel}-${host}-${n}`)

  let record = null
  let lastError = null
  for (const candidate of candidates) {
    try {
      record = workspaces.create({
        label: candidate,
        machines: ['local'],
        skills: [],
        owner: { name: account.split('@')[0], email: account },
      })
      break
    } catch (error) {
      if (!/already exists/i.test(error.message)) throw error
      lastError = error
    }
  }
  if (!record) throw lastError || new Error('No free local name for this workspace.')

  /* Mark it remote before the first pull so a concurrent read sees the truth. */
  const workspaceFile = path.join(record.path, 'workspace.json')
  const raw = readJson(workspaceFile, {}) || {}
  writeJson(workspaceFile, {
    ...raw,
    schema: 1,
    id: record.id,
    label: raw.label || record.label,
    kind: 'remote',
    createdAt: record.createdAt,
    mcpStrict: true,
    members: raw.members || [],
  })
  disconnected.delete(record.id)
  writeToken(record, session.token)

  const state = {
    schema: 1,
    serverUrl: baseUrl,
    remoteWorkspace: String(target.id),
    accountEmail: account,
    label: String(target.label || target.id),
    connectedAt: nowIso(),
    lastSyncAt: '',
    lastRev: '',
    status: 'idle',
    lastError: '',
    lastReason: 'connect',
    base: {},
    approved: {},
    lastSummary: null,
    blocked: null,
    quarantined: [],
    pendingConflicts: [],
    auto,
    guard: normaliseGuard(guardConfig, { validate: true }),
    intervalMs: intervalMs(),
  }
  writeState(record, state)

  const result = await sync({ id: record.id, reason: 'connect' }, { emit })
  const fresh = workspaces.open(record.id)
  emit({
    kind: 'remote-sync',
    workspace: record.id,
    status: result.ok ? 'connected' : 'blocked',
    summary: result.summary || null,
    findings: result.findings || [],
  })
  return { record: fresh, state: publicState(fresh, readState(fresh)), result }
}

async function sync({ id, reason = 'manual' } = {}, { emit = () => {} } = {}) {
  const record = findRecord(id)
  const state = readState(record)
  if (!state) throw new Error('This workspace is not connected to a remote server.')

  if (running.has(record.id)) return running.get(record.id)

  const task = (async () => {
    const mark = (patch) => {
      if (disconnected.has(record.id)) return
      const current = readState(record) || state
      writeState(record, { ...current, ...patch })
    }
    mark({ status: 'syncing', lastReason: reason, lastError: '' })
    emit({ kind: 'remote-sync', workspace: record.id, status: 'syncing', reason })
    try {
      const result = await performSync(record, readState(record) || state, reason)
      if (result.ok) {
        emit({
          kind: 'remote-sync',
          workspace: record.id,
          status: 'idle',
          reason,
          summary: result.summary,
          quarantined: result.quarantined || [],
          mcpDiverged: result.mcpDiverged || [],
        })
      } else {
        emit({
          kind: 'remote-sync',
          workspace: record.id,
          status: 'blocked',
          reason,
          findings: result.findings || [],
        })
      }
      return result
    } catch (error) {
      const unauthorized = error?.code === 'unauthorized'
      mark({
        status: unauthorized ? 'unauthorized' : 'error',
        lastError: String(error?.message || error),
      })
      emit({
        kind: 'remote-sync',
        workspace: record.id,
        status: unauthorized ? 'unauthorized' : 'error',
        reason,
        error: String(error?.message || error),
      })
      return { workspace: record.id, ok: false, error: String(error?.message || error) }
    } finally {
      running.delete(record.id)
      if (pending.delete(record.id)) noteLocalChange(record.id)
    }
  })()
  running.set(record.id, task)
  return task
}

/** Refresh the bearer token without re-cloning the local workspace. */
/** Change the second-opinion evaluator without reconnecting. */
function setGuard({ id, guard: value } = {}) {
  const record = findRecord(id)
  const state = readState(record)
  if (!state) throw new Error('This workspace is not connected to a remote server.')
  const next = normaliseGuard(value, { validate: true })
  writeState(record, { ...state, guard: next, lastError: '', status: state.status === 'error' ? 'idle' : state.status })
  return publicState(record, readState(record))
}

async function reconnect({ id, password } = {}, { emit = () => {} } = {}) {
  const record = findRecord(id)
  const state = readState(record)
  if (!state) throw new Error('This workspace is not connected to a remote server.')
  if (!password) throw new Error('Enter the password for the remote server.')
  const session = await login(state.serverUrl, state.accountEmail, password)
  disconnected.delete(record.id)
  writeToken(record, session.token)
  writeState(record, {
    ...state,
    status: 'idle',
    lastError: '',
    lastReason: 'reconnect',
  })
  return sync({ id: record.id, reason: 'reconnect' }, { emit })
}

function status({ id } = {}) {
  const record = findRecord(id)
  return publicState(record, readState(record))
}

function list() {
  return workspaces
    .list()
    .map((record) => {
      const state = readState(record)
      return state ? publicState(record, state) : null
    })
    .filter(Boolean)
}

async function disconnect({ id, forget = true } = {}) {
  const record = findRecord(id)
  const state = readState(record)
  if (!state) return { disconnected: false }
  disconnected.add(record.id)
  clearToken(record)
  if (forget) {
    /* Leave the local files in place: a person disconnecting a shared workspace
       usually wants to keep what is already checked out. It becomes an ordinary
       local workspace again, which is also what the card should say. */
    try {
      fs.rmSync(statePath(record), { force: true })
    } catch {
      /* already gone */
    }
    const file = path.join(record.path, 'workspace.json')
    const raw = readJson(file, {}) || {}
    const attached = workspaces.machines(record.id).some((machine) => machine.id !== 'local')
    writeJson(file, {
      ...raw,
      schema: 1,
      id: record.id,
      kind: attached ? 'self-hosted' : 'local',
    })
  } else {
    writeState(record, { ...state, auto: false, status: 'paused', lastError: '' })
  }
  return { disconnected: true, workspace: record.id }
}

/** Explicit user approval for exact content hashes the guard flagged. */
async function approve({ id, items = [] } = {}) {
  const record = findRecord(id)
  /* An approval applied while a blocked pass is still fetching would be read by
     that pass as "no approval" and block again. Let it settle first. */
  if (running.has(record.id)) await running.get(record.id).catch(() => {})
  const state = readState(record)
  if (!state) throw new Error('This workspace is not connected to a remote server.')
  const approved = { ...state.approved }
  for (const item of Array.isArray(items) ? items : []) {
    const rel = manifest.safeRel(item?.path)
    const sha = String(item?.sha256 || '')
    if (!rel || !/^[a-f0-9]{64}$/i.test(sha)) continue
    approved[rel] = sha.toLowerCase()
  }
  writeState(record, { ...state, approved, status: 'idle', blocked: null, lastError: '' })
  return sync({ id: record.id, reason: 'approved' })
}

function noteLocalChange(id) {
  const record = workspaces.list().find((entry) => entry.id === id)
  if (!record) return
  const state = readState(record)
  if (!state || state.status === 'blocked' || state.auto === false) return
  if (running.has(record.id)) {
    pending.add(record.id)
    return
  }
  clearTimeout(debounce.get(record.id))
  const timer = setTimeout(() => {
    debounce.delete(record.id)
    sync({ id: record.id, reason: 'local-change' }).catch(() => {})
  }, LOCAL_DEBOUNCE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  debounce.set(record.id, timer)
}

function intervalMs() {
  const value = Number(process.env.ENTITY_SYNC_INTERVAL_MS)
  return Number.isFinite(value) && value >= 60_000 ? value : DEFAULT_INTERVAL_MS
}

/**
 * Pull-side schedule. Local edits push through `noteLocalChange`; this timer
 * also runs a manifest-only pass so a change made on the server arrives without
 * the user pressing anything. Six hours by default, overridable for a test.
 */
function start({ emit = () => {} } = {}) {
  if (interval) return
  const tick = () => {
    for (const entry of list()) {
      if (entry.auto === false || entry.status === 'blocked' || entry.status === 'unauthorized') {
        continue
      }
      sync({ id: entry.workspace, reason: 'poll' }, { emit }).catch(() => {})
    }
  }
  interval = setInterval(tick, intervalMs())
  if (typeof interval.unref === 'function') interval.unref()
  const warm = setTimeout(tick, 12_000)
  if (typeof warm.unref === 'function') warm.unref()
}

function stop() {
  if (interval) clearInterval(interval)
  interval = null
  for (const timer of debounce.values()) clearTimeout(timer)
  debounce.clear()
  pending.clear()
}
module.exports = {
  STATE_FILE,
  TOKEN_FILE,
  DEFAULT_INTERVAL_MS,
  normaliseServerUrl,
  discover,
  connect,
  reconnect,
  setGuard,
  sync,
  status,
  list,
  disconnect,
  approve,
  noteLocalChange,
  start,
  stop,
  publicState,
  readState,
  diff,
  mergeServer,
  applyRemoteMcp,
}
