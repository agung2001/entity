/**
 * Conversations are workspace files.
 *
 *   <ws>/chats/<threadId>.json
 *
 * A thread pins the three things that give it meaning — entity, machine and
 * harness — the moment it is created. Once the user has sent a message the
 * context is locked, so an old answer can never be re-labelled as if it came
 * from a different entity, machine or harness.
 *
 * Sending a message is a real harness invocation, not a scripted reply. The
 * thread keeps the transcript and every request passes the conversation back to
 * the harness, so the next turn has the same context the window shows.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const entities = require('./entity-store.cjs')
const workspaces = require('./workspace-store.cjs')
const skillRef = require('./skill-ref.cjs')
const mentionRef = require('./mention-ref.cjs')
const intentRef = require('./intent-ref.cjs')
const attachmentRef = require('./attachment-ref.cjs')
const remoteRunner = require('./remote-runner.cjs')
const mcpRuntime = require('./mcp-runtime.cjs')
const { chatInvocation } = require('./runner-local.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const auth = require('./auth-store.cjs')
const platform = require('./platform-brief.cjs')
const { createParser } = require('./chat-transcript.cjs')
const { expandHome } = require('./frontmatter.cjs')

/* a generous cap: the renderer only paints the newest turns, but the file is
   the conversation and should survive a long session */
const MAX_THREADS_SCANNED = 400
const MAX_OUTPUT_CHARS = 240_000
const MAX_PROMPT_CHARS = 48_000
const MAX_TAGS = 12
const MAX_TAG_CHARS = 32
/* The longest a single turn may run, whatever the harness is doing. The idle
   timer below only catches a *silent* harness, and a harness that keeps printing
   thinking steps is never silent — one turn here printed every 80ms for 7.5 hours
   before somebody pressed Stop. A delegated run gets its own hour
   (`ENTITY_MENTION_TIMEOUT_MS`); a turn that contains delegations must outlive
   them, so this is deliberately larger than one run and smaller than a working
   day. `ENTITY_TURN_TIMEOUT_MS` overrides it. */
const HARNESS_TURN_MS = (() => {
  const configured = Number(process.env.ENTITY_TURN_TIMEOUT_MS)
  return configured > 0 ? configured : 90 * 60 * 1000
})()
const HARNESS_IDLE_MS = 15 * 60 * 1000
const THREAD_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i

const sending = new Map()
/** threadId → live harness process, so a quit mid-answer takes it down too */
const inFlight = new Map()
/* A fan-out is up to eight harnesses that exist before the parent turn starts.
   The window's Stop has to reach them, so they are held per thread. */
const mentionChildren = new Map()
/** thread ids the person explicitly stopped; close is not a harness failure */
const canceling = new Set()
/* threadId → the plan a person has not answered yet. In memory on purpose: a
   reload or a quit leaves the turn interrupted, and nothing starts. */
const holds = new Map()
/* Ten minutes. A turn that can wait forever is a leaked promise and a card that
   lies about still thinking; a seven-row fan-out takes less than that to read. */
const HOLD_MS = 10 * 60_000
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

const clean = (value) => String(value || '').replace(ANSI, '').trim()

/** A CLI's stderr is not a UI message: keep the cause, drop the wall of retries. */
function friendlyError(value, cmd) {
  const text = clean(value)
  if (/\b401\b|unauthoriz|authenticat|oauth|not signed in|log ?in/i.test(text)) {
    return `${cmd} is not signed in on this machine. Sign in with its CLI, then send again.`
  }
  if (!text) return `${cmd} exited without a response.`
  return text.length > 1400 ? `${text.slice(0, 1400)}\n…` : text
}

function chatsDir(record) {
  return path.join(record.path, 'chats')
}

function now() {
  return new Date().toISOString()
}

/* ── the plan gate ────────────────────────────────────────────────── */

/**
 * One promise per turn, resolved by the window (`chat.delegate`) or the clock.
 * `emitHold` paints the plan; nothing here decides anything itself.
 */
function openHold(threadId, plan, emitHold) {
  return new Promise((resolve) => {
    const settle = (decision) => {
      const held = holds.get(threadId)
      if (!held) return
      holds.delete(threadId)
      if (held.timer) clearTimeout(held.timer)
      resolve(decision)
    }
    /* `unref` so a held turn never keeps a CLI process alive on its own */
    const timer = setTimeout(() => settle({ action: 'cancel', reason: 'expired' }), HOLD_MS)
    try {
      timer.unref?.()
    } catch {
      /* not a Node timer (a test double) */
    }
    holds.set(threadId, { plan, timer, settle })
    try {
      emitHold(plan)
    } catch {
      /* the window may be gone; the turn waits for its ten minutes regardless */
    }
  })
}

/** The plan a thread is waiting on, if any. */
function heldPlan(threadId) {
  return holds.get(threadId)?.plan || null
}

/**
 * Run or cancel a held turn. Returns `none` when nothing is held — a reloaded
 * window asking about a turn that died with its plan, or a double click.
 */
function decideHold({ workspace, id, action } = {}) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  const held = holds.get(id)
  if (!held) return { decided: 'none' }
  const wanted = action === 'cancel' ? 'cancel' : 'run'
  held.settle(wanted === 'run' ? { action: 'run' } : { action: 'cancel', reason: 'cancelled' })
  return { decided: wanted, runs: held.plan.rows.length }
}

/* The desktop resolves the account from `auth.json`. The server build has a
   different user per request, so `createRpc` installs an identity resolver that
   reads the request's signed-in user. Without it every teammate would share the
   first account's threads. */
let identityResolver = null
function setIdentityResolver(resolver) {
  identityResolver = typeof resolver === 'function' ? resolver : null
}

/** One stable key per signed-in account. No account means tests/CLI local mode. */
function currentUser() {
  const user = identityResolver ? identityResolver() : auth.get()
  return String(user?.email || user?.username || '').trim().toLowerCase()
}

/** A legacy thread belongs to the workspace owner, never to whoever opens it. */
function threadOwner(raw, record) {
  return String(
    raw?.user || record.owner?.email || record.owner?.name || '',
  )
    .trim()
    .toLowerCase()
}

function canAccess(thread) {
  const user = currentUser()
  if (!user) return true
  return thread.user === user
}

function newThreadId() {
  return `t_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function assertThreadId(id) {
  const value = String(id || '')
  if (!THREAD_ID.test(value)) throw new Error('That is not a thread id.')
  return value
}

function threadFile(record, id) {
  return path.join(chatsDir(record), `${assertThreadId(id)}.json`)
}

function normaliseStep(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const type = ['thinking', 'text', 'tool_use', 'tool_result', 'error'].includes(raw.type)
    ? raw.type
    : 'text'
  const step = {
    seq: Number(raw.seq) || index + 1,
    type,
    at: String(raw.at || ''),
  }
  for (const key of ['tool', 'callId', 'content', 'output', 'endedAt']) {
    if (raw[key] !== undefined && raw[key] !== null) step[key] = String(raw[key])
  }
  if (raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)) {
    step.input = raw.input
  }
  if (Number.isFinite(raw.durationMs)) step.durationMs = raw.durationMs
  if (Number.isFinite(raw.exitCode)) step.exitCode = raw.exitCode
  if (raw.isError) step.isError = true
  return step
}

function normaliseMention(raw) {
  if (!raw || typeof raw !== 'object') return null
  /* a `thread` mention is another conversation, shown as a card not a run */
  const kind = ['entity', 'orca', 'artifact', 'maka', 'youtrack', 'thread'].includes(raw.kind)
    ? raw.kind
    : 'unknown'
  return {
    kind,
    ...(typeof raw.raw === 'string' ? { raw: raw.raw } : {}),
    ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.job === 'string' ? { job: raw.job } : {}),
    ...(typeof raw.share === 'string' ? { share: raw.share } : {}),
    /* the row a fanned-out run is about — an issue id and its title */
    ...(typeof raw.row === 'string' && raw.row ? { row: raw.row } : {}),
    ...(Array.isArray(raw.items) ? { items: raw.items } : {}),
    ...(typeof raw.answer === 'string' ? { answer: raw.answer } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
    ...(Number.isFinite(raw.ms) ? { ms: raw.ms } : {}),
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(raw.execution && typeof raw.execution === 'object'
      ? { execution: { ...raw.execution } }
      : {}),
    ...(Array.isArray(raw.steps)
      ? { steps: raw.steps.map(normaliseStep).filter(Boolean) }
      : {}),
  }
}

function normaliseExecution(raw) {
  if (!raw || typeof raw !== 'object') return null
  const execution = {}
  for (const key of [
    'id',
    'harness',
    'model',
    'command',
    'cwd',
    'startedAt',
    'firstStepAt',
    'firstTextAt',
    'endedAt',
    'status',
  ]) {
    if (raw[key] !== undefined && raw[key] !== null) execution[key] = String(raw[key])
  }
  for (const key of ['ms', 'exitCode', 'ttfbMs', 'firstTextMs']) {
    if (Number.isFinite(raw[key])) execution[key] = raw[key]
  }
  if (raw.usage && typeof raw.usage === 'object') execution.usage = raw.usage
  if (Number.isFinite(raw.costUsd)) execution.costUsd = raw.costUsd
  /* what the turn ran with, and what it resolved before running — both survive
     a reload so the answer's fold still explains itself tomorrow */
  if (Array.isArray(raw.mcp)) execution.mcp = raw.mcp.map(String)
  if (typeof raw.mcpNote === 'string' && raw.mcpNote) execution.mcpNote = raw.mcpNote
  if (Array.isArray(raw.mentions)) {
    execution.mentions = raw.mentions.map(normaliseMention).filter(Boolean)
  }
  return Object.keys(execution).length ? execution : null
}

function normaliseArtifact(raw) {
  if (!raw || typeof raw !== 'object') return null
  let id = String(raw.id || '').replace(/\\/g, '/')
  const marker = '/artifacts/'
  const at = id.indexOf(marker)
  if (at >= 0) id = id.slice(at + marker.length)
  if (id.startsWith('artifacts/')) id = id.slice('artifacts/'.length)
  id = id
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
  if (!id) return null
  const name = String(raw.name || id.split('/').pop() || 'artifact').slice(0, 180)
  return {
    id: id.slice(0, 500),
    name,
    kind: ['image', 'text', 'pdf', 'archive', 'audio', 'video', 'file'].includes(raw.kind)
      ? raw.kind
      : 'file',
    mime: String(raw.mime || 'application/octet-stream').slice(0, 120),
    ...(Number.isFinite(raw.size) ? { size: raw.size } : {}),
    ...(raw.modifiedAt ? { modifiedAt: String(raw.modifiedAt) } : {}),
  }
}

/**
 * A settled plan, kept on the turn's error row so the block still says *what*
 * never started after a reload. No answers: nothing ran.
 */
function normaliseHold(raw) {
  if (!raw || typeof raw !== 'object') return null
  const settled = ['cancelled', 'expired', 'interrupted'].includes(raw.settled)
    ? raw.settled
    : ''
  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .filter((row) => row && typeof row === 'object')
    .slice(0, 12)
    .map((row) => ({
      name: String(row.name || '').slice(0, 80),
      row: String(row.row || '').slice(0, 200),
      job: String(row.job || '').slice(0, 400),
      share: String(row.share || '').slice(0, 40),
      harness: String(row.harness || '').slice(0, 40),
      model: String(row.model || '').slice(0, 80),
      shownDir: String(row.shownDir || row.dir || '').slice(0, 300),
      note: String(row.note || '').slice(0, 80),
    }))
  if (!settled || !rows.length) return null
  return { settled, rows }
}

function normaliseMessage(message) {
  if (!message || typeof message !== 'object') return null
  const who = ['me', 'agent', 'sys'].includes(message.who) ? message.who : 'sys'
  const text = String(message.text || '')
  if (!text) return null
  const steps = Array.isArray(message.steps)
    ? message.steps.map(normaliseStep).filter(Boolean)
    : []
  const execution = normaliseExecution(message.execution)
  const linkedArtifacts = Array.isArray(message.artifacts)
    ? message.artifacts.map(normaliseArtifact).filter(Boolean)
    : []
  const hold = normaliseHold(message.hold)
  return {
    who,
    text,
    at: message.at || now(),
    ...(typeof message.id === 'string' && message.id ? { id: message.id } : {}),
    /* a skill reference is resolved once, when it is sent: the transcript keeps
       what was typed, `sent` keeps what the harness received, and a replayed
       turn does not have to resolve a skill that may since have been detached */
    ...(who === 'me' && typeof message.sent === 'string' && message.sent
      ? { sent: message.sent }
      : {}),
    ...(message.error ? { error: true } : {}),
    /* a held turn that nobody answered: the block says which outcome, and which
       rows never ran */
    ...(hold ? { hold } : {}),
    ...(steps.length ? { steps } : {}),
    ...(execution ? { execution } : {}),
    ...(Array.isArray(message.mentions)
      ? { mentions: message.mentions.map(normaliseMention).filter(Boolean) }
      : {}),
    /* files the harness put on the artifact shelf during this turn */
    ...(linkedArtifacts.length ? { artifacts: linkedArtifacts } : {}),
    ...(Array.isArray(message.attachments) && message.attachments.length
      ? { attachments: message.attachments.filter((entry) => entry && entry.kind) }
      : {}),
  }
}

/**
 * Tags are a short label list, not prose. The dialog sends comma-separated
 * text, and the file may have been written by hand: trim, drop empties,
 * collapse duplicates case-insensitively and cap both count and length so a
 * pasted paragraph cannot turn a history row into a wall of chips.
 */
function normaliseTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    const tag = String(entry || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_CHARS)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * A spawn link is one optional pair of ids: the workspace and thread this
 * conversation was started from. Both directions are derived — a parent's
 * children are the rows whose `spawnedFrom.id` is the parent — so there is no
 * children array to keep in sync and no run id stored.
 */
function spawnedFromOf(raw) {
  const value = raw || {}
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const workspace = typeof value.workspace === 'string' ? value.workspace.trim() : ''
  if (!id || !workspace || !THREAD_ID.test(id)) return null
  return { workspace, id }
}

function normaliseThread(raw, record) {
  if (!raw || raw.schema !== 1 || typeof raw.id !== 'string') return null
  const entity = String(raw.entity || '')
  if (!entity) return null
  const spawned = spawnedFromOf(raw.spawnedFrom)
  return {
    schema: 1,
    id: assertThreadId(raw.id),
    workspace: record.id,
    entity,
    machine: String(raw.machine || 'local'),
    harness: String(raw.harness || 'claude'),
    /* a thread may pin a model independently of the entity file; '' means the
       harness default (or the entity's own model, see runHarness) */
    model: String(raw.model || ''),
    /* optional base directory: skills and `@file:` paths start here */
    ...(typeof raw.dir === 'string' && raw.dir ? { dir: String(raw.dir) } : {}),
    attachmentsEnabled: Boolean(raw.attachmentsEnabled),
    /* chat history is private to the account that started it */
    user: threadOwner(raw, record),
    title: String(raw.title || ''),
    /* Who set the title: the person or the first message. A title the person
       wrote (or cleared) is never re-derived by a later turn. */
    titleSource: raw.titleSource === 'user' || raw.titleSource === 'auto' ? raw.titleSource : '',
    pinned: Boolean(raw.pinned),
    /* Archiving is a reversible state of the same record, not a move: the thread
       keeps its file, its messages and its pin. A read always answers `true` or
       `false`; `writeThread` is what keeps the key out of a file that never had
       it (see there). */
    archived: Boolean(raw.archived),
    ...(raw.archivedAt && raw.archived ? { archivedAt: String(raw.archivedAt) } : {}),
    tags: normaliseTags(raw.tags),
    ...(spawned ? { spawnedFrom: spawned } : {}),
    createdAt: raw.createdAt || now(),
    updatedAt: raw.updatedAt || raw.createdAt || now(),
    messages: Array.isArray(raw.messages) ? raw.messages.map(normaliseMessage).filter(Boolean) : [],
  }
}

/** The fields a turn must never overwrite on its own. */
function metadataOf(thread) {
  return {
    title: thread.title,
    titleSource: thread.titleSource,
    pinned: thread.pinned,
    archived: thread.archived,
    tags: thread.tags,
    dir: thread.dir,
    attachmentsEnabled: thread.attachmentsEnabled,
  }
}

/**
 * Save a turn without taking the person's metadata with it.
 *
 * The thread this turn holds was read before the harness started; `baseline` is
 * what those fields said then. Anything the file has changed since — a rename,
 * a pin, a tag, a base directory, the attachment switch — is newer than this
 * copy and wins. Nothing that merely differs from the turn's own edits is
 * adopted, so the automatic title the turn just derived survives.
 */
function saveTurn(record, thread, baseline) {
  const current = readThread(record, thread.id)
  if (current && baseline) {
    if (current.title !== baseline.title || current.titleSource !== baseline.titleSource) {
      thread.title = current.title
      thread.titleSource = current.titleSource
    }
    if (current.pinned !== baseline.pinned) thread.pinned = current.pinned
    /* archive/restore from another window wins over this turn's copy */
    if (current.archived !== baseline.archived) {
      thread.archived = current.archived
      if (current.archivedAt) thread.archivedAt = current.archivedAt
      else delete thread.archivedAt
    }
    if (JSON.stringify(current.tags) !== JSON.stringify(baseline.tags)) thread.tags = current.tags
    if (current.dir !== baseline.dir) thread.dir = current.dir
    if (current.attachmentsEnabled !== baseline.attachmentsEnabled) {
      thread.attachmentsEnabled = current.attachmentsEnabled
    }
  }
  return writeThread(record, thread)
}

function writeThread(record, thread) {
  windowCache.delete(record.id)
  artifactIndexCache.delete(record.id)
  const file = threadFile(record, thread.id)
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  /* Absent means active. A read answers `false`, but writing that back would put
     `"archived": false` into every thread a rename, a pin or a turn touches — the
     one shape ENTITY-18 promised never to produce. */
  const document = { ...thread }
  if (!document.archived) {
    delete document.archived
    delete document.archivedAt
  }
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return thread
}

function readThread(record, id) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(threadFile(record, id), 'utf8'))
  } catch {
    return null
  }
  return normaliseThread(raw, record)
}

function stopProcess(child) {
  if (!child) return
  killTree(child, 'SIGTERM')
  const escalate = setTimeout(() => killTree(child, 'SIGKILL'), 3000)
  if (typeof escalate.unref === 'function') escalate.unref()
}

function previewOf(thread) {
  const spoken = [...thread.messages].reverse().find((message) => message.who !== 'sys')
  return spoken ? spoken.text.replace(/\s+/g, ' ').trim().slice(0, 180) : ''
}

/** A thread title is the opening question until someone renames it. */
function titleOf(thread) {
  const asked = thread.messages.find((message) => message.who === 'me' && !message.error)
  return asked ? asked.text.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

function summarise(thread) {
  const queries = thread.messages.filter((message) => message.who === 'me').length
  const replies = thread.messages.filter((message) => message.who === 'agent').length
  const lastMessage = thread.messages[thread.messages.length - 1]
  return {
    id: thread.id,
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
    model: thread.model || '',
    /* The row needs the base directory: reopening a thread restores its project
       skills and `@file:` scope from this summary. */
    dir: thread.dir || '',
    title: thread.title || titleOf(thread),
    pinned: Boolean(thread.pinned),
    archived: Boolean(thread.archived),
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
    tags: thread.tags || [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    queries,
    replies,
    messageCount: queries + replies,
    working: sending.has(thread.id),
    /* A plan that was cancelled or expired is the person's decision, not a
       failure: the row keeps its Retry, the rail does not paint it red. */
    failed: Boolean(lastMessage?.who === 'sys' && lastMessage.error && !lastMessage.hold),
    /* the rail labels the child and the parent counts its children from this,
       in the same list the window already subscribes to */
    spawnedFrom: thread.spawnedFrom || null,
    preview: previewOf(thread),
    /* A summary is a row, not the transcript: do not ship every thinking block
       and tool output through the history list. */
    last: (() => {
      const message = [...thread.messages].reverse().find((entry) => entry.who !== 'sys')
      return message ? { who: message.who, text: message.text, at: message.at } : null
    })(),
  }
}

function list({ workspace }) {
  const record = workspaces.open(workspace)
  let files = []
  try {
    files = fs
      .readdirSync(chatsDir(record))
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  } catch {
    return []
  }

  /* A thread whose entity was deleted has nowhere to run. Keep the file on
     disk, but leave it out of the history list instead of offering a row that
     cannot answer. */
  let known = null
  try {
    known = new Set(entities.list(record.id).map((item) => item.name))
  } catch {
    /* an unreadable entity dir must not hide the whole history */
  }

  const newest = files
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(path.join(chatsDir(record), file)).mtimeMs }
      } catch {
        return { file, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_THREADS_SCANNED)
    .map((entry) => entry.file)

  return newest
    .map((file) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(chatsDir(record), file), 'utf8'))
        const thread = normaliseThread(raw, record)
        if (!thread || !canAccess(thread)) return null
        if (known && !known.has(thread.entity)) return null
        return summarise(thread)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    )
}

function read({ workspace, id }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  return thread && canAccess(thread) ? attachArtifactsByTurn(thread) : null
}

/** An optional working directory, only for runs on this machine. */
function checkBaseDir(dir, machine) {
  const value = String(dir || '').trim()
  if (!value) return ''
  if (machine && machine !== 'local') {
    throw new Error('A base directory is only available on this machine.')
  }
  if (!path.isAbsolute(value)) {
    throw new Error('The base directory must be an absolute path.')
  }
  let stat
  try {
    stat = fs.statSync(value)
  } catch {
    throw new Error(`The base directory does not exist: ${value}`)
  }
  if (!stat.isDirectory()) throw new Error('The base directory is not a folder.')
  return path.resolve(value)
}

function checkEntity(workspace, name) {
  const entity = entities.read(workspace, name)
  if (!entity) throw new Error(`No entity called "${name}" in this workspace.`)
  return entity
}

function checkHarness(harness, entity) {
  const value = String(harness || entity.harness || '')
  if (!entities.HARNESSES.includes(value)) {
    throw new Error(`The harness "${value || 'unknown'}" cannot be used here.`)
  }
  return value
}

function checkMachine(record, machine, harness) {
  const value = String(machine || 'local')
  if (value === 'local') return value
  const facts = workspaces.machineFacts(record.id).hosts[value]
  if (!facts) {
    throw new Error(`${value} has no capability snapshot. Run Test & scan on the Fleet page first.`)
  }
  if (!(facts.harnesses || []).some((entry) => entry.id === harness)) {
    throw new Error(`${harness} is not installed on ${value}.`)
  }
  return value
}

/**
 * A delegation is a conversation too.
 *
 * `@entity <job>` runs inside the turn — that is what lets the reply above it
 * use the answer — and it now also leaves a real thread: the job, the answer,
 * its steps and its timing, linked to the thread it came from. The card in the
 * transcript offers to continue there; the parent's rail row counts the
 * sessions; nothing else is stored about the run.
 *
 * The session runs on **this** machine even when the parent thread is remote: a
 * mention is resolved by the app, not by the host (see `mention-ref`).
 */
function spawnMentionSession(record, parent, mention) {
  if (!mention || mention.kind !== 'entity' || mention.reference) return null
  if (!mention.name || !String(mention.job || '').trim()) return null
  const execution = mention.execution && typeof mention.execution === 'object' ? mention.execution : {}
  const startedAt = execution.startedAt || now()
  const endedAt = execution.endedAt || startedAt
  const stamp = () => `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job = String(mention.job).replace(/\s+/g, ' ').trim()
  /* A row is the best title a session can have — seven sessions of one fan-out
     read as seven issues. Failing that, `spawn 3` gives three sessions the same
     instruction, and the share is what tells them apart. */
  const title = (mention.row || (mention.share ? `${job} · ${mention.share}` : job)).slice(0, 120)
  const failed = mention.status === 'error'
  const thread = {
    schema: 1,
    id: newThreadId(),
    workspace: record.id,
    entity: mention.name,
    machine: 'local',
    /* the harness and model that actually answered, so continuing answers in
       the same voice instead of guessing from the entity file */
    harness: String(execution.harness || 'claude'),
    model: String(execution.model || ''),
    attachmentsEnabled: false,
    user: parent.user,
    title,
    titleSource: 'auto',
    pinned: false,
    tags: [],
    spawnedFrom: { workspace: record.id, id: parent.id },
    createdAt: startedAt,
    updatedAt: endedAt,
    messages: [
      { who: 'me', id: stamp(), text: String(mention.job), at: startedAt },
      failed
        ? {
            who: 'sys',
            id: stamp(),
            text: String(mention.note || `${mention.name} did not answer.`),
            at: endedAt,
            error: true,
          }
        : {
            who: 'agent',
            id: stamp(),
            text: String(mention.answer || ''),
            at: endedAt,
            ...(Array.isArray(mention.steps) && mention.steps.length
              ? { steps: mention.steps.map(normaliseStep).filter(Boolean) }
              : {}),
            ...(Object.keys(execution).length ? { execution: { ...execution } } : {}),
          },
    ],
  }
  writeThread(record, thread)
  return thread
}

function create({ workspace, entity, machine = 'local', harness, model = '', dir = '', message, attachmentsEnabled = false }) {
  const record = workspaces.open(workspace)
  const agent = checkEntity(workspace, entity)
  const chosenHarness = checkHarness(harness, agent)
  const chosenMachine = checkMachine(record, machine, chosenHarness)
  const baseDir = checkBaseDir(dir, chosenMachine)
  const thread = {
    schema: 1,
    id: newThreadId(),
    workspace: record.id,
    entity: agent.name,
    machine: chosenMachine,
    harness: chosenHarness,
    model: String(model || '').trim(),
    ...(baseDir ? { dir: baseDir } : {}),
    attachmentsEnabled: Boolean(attachmentsEnabled),
    user: currentUser() || threadOwner(null, record),
    title: '',
    pinned: false,
    tags: [],
    createdAt: now(),
    updatedAt: now(),
    messages: [],
  }
  const intro = normaliseMessage(message)
  if (intro) thread.messages.push(intro)
  writeThread(record, thread)
  return thread
}

/**
 * Context can only move before the first question — after that it is history.
 * The model is the exception: the harness and its session stay the same, and
 * the next turn simply runs with a different model.
 */
function update({ workspace, id, entity, machine, harness, model, dir, attachmentsEnabled }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  const started = thread.messages.some((message) => message.who === 'me')
  if (started) {
    const moved =
      (entity && entity !== thread.entity) ||
      (machine && machine !== thread.machine) ||
      (harness && harness !== thread.harness) ||
      (dir !== undefined && dir !== (thread.dir || ''))
    if (moved) {
      throw new Error(
        'This thread has already started. Only the model can change; start a new thread for another entity, machine or harness.',
      )
    }
  }
  const previousHarness = thread.harness
  if (entity && entity !== thread.entity) {
    const agent = checkEntity(workspace, entity)
    thread.entity = agent.name
    thread.harness = checkHarness(thread.harness, agent)
  }
  if (harness) thread.harness = checkHarness(harness, checkEntity(workspace, thread.entity))
  if (machine) thread.machine = checkMachine(record, machine, thread.harness)
  if (dir !== undefined) {
    const baseDir = checkBaseDir(dir, thread.machine)
    if (baseDir) thread.dir = baseDir
    else delete thread.dir
  }
  if (model !== undefined) thread.model = String(model || '').trim()
  if (typeof attachmentsEnabled === 'boolean') thread.attachmentsEnabled = attachmentsEnabled
  /* a model belongs to its harness: changing the harness without naming a new
     model drops the old one instead of passing an incompatible name through */
  else if (thread.harness !== previousHarness) thread.model = ''
  /* A model change is not a new message; it must not move the thread to the
     top of the history. */
  if (!started) thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

/** Renaming and pinning are metadata: they stay editable after the first turn. */
function rename({ workspace, id, title }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  thread.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  /* Even an empty title is a decision: a later turn must not fill it in. */
  thread.titleSource = 'user'
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

function pin({ workspace, id, pinned }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  thread.pinned = Boolean(pinned)
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

/**
 * Archive or restore. One reversible write, no guard: the thread stays on disk
 * with everything in it, and the action carries an Undo.
 *
 * Restoring **deletes** both keys instead of writing `archived: false`, so a
 * thread that was never archived and one that was and came back are the same
 * bytes — `grep 'archived: false'` over a workspace stays empty.
 *
 * The call is **idempotent, and `archivedAt` is stamped once**, on the
 * false→true transition. A click would survive re-stamping; a scheduled pass
 * would not. Retention counts *days in the archive* (`archivedAt` → deletion),
 * so a sweep that re-archived an already-archived thread would push its date
 * forward on every tick and the delete would never come due. Nothing is written
 * when the state already matches, so a pass over a quiet workspace touches no
 * files at all.
 */
function archive({ workspace, id, archived }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  const wanted = Boolean(archived)
  if (wanted === Boolean(thread.archived)) return thread
  if (wanted) {
    thread.archived = true
    thread.archivedAt = now()
  } else {
    delete thread.archived
    delete thread.archivedAt
  }
  /* `updatedAt` is the row's age, not a place in the archive order: keep it, so
     restoring a thread does not make it look freshly used. */
  writeThread(record, thread)
  return thread
}

/** Tags are editable at any time, like the title and the pin. */
function tags({ workspace, id, tags: nextTags }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  thread.tags = normaliseTags(nextTags)
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

function remove({ workspace, id }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) return { removed: false }
  /* A live turn still holds the thread file; deleting it now would let the
     final write recreate the row a moment later. Stop it first. */
  if (sending.has(thread.id)) {
    throw new Error('This thread is still answering. Stop the turn before deleting it.')
  }
  const file = threadFile(record, id)
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file, { force: true })
  return { removed: existed }
}

/**
 * Erase the whole history of this workspace (settings → Chats → Erase all).
 *
 * One row at a time is `remove`; this is the same write applied to every thread
 * the signed-in account can read, archived ones included — the archive is a
 * state of a thread, not a second store, so leaving it behind would make the
 * erase a half-truth. A thread that belongs to another account is not this
 * person's history and stays.
 *
 * A turn still answering aborts the whole erase before the first file is
 * removed: its final write would put one thread back, and a history that is
 * empty except for a resurrected row is worse than one that was never erased.
 */
function eraseAll({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const dir = chatsDir(record)
  let files = []
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  } catch {
    /* no chats folder yet: nothing to erase, and not an error */
    files = []
  }

  const targets = []
  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    /* an unreadable file is still this workspace's data: erase it rather than
       leave an orphan nobody can list */
    const thread = readThread(record, id)
    if (thread && !canAccess(thread)) continue
    if (sending.has(id)) {
      throw new Error('A thread is still answering. Stop the turn before erasing the history.')
    }
    targets.push(path.join(dir, file))
  }

  let bytes = 0
  for (const file of targets) {
    try {
      bytes += fs.statSync(file).size
    } catch {
      /* a file removed mid-walk costs a byte count, never the erase */
    }
    fs.rmSync(file, { force: true })
  }

  windowCache.delete(record.id)
  artifactIndexCache.delete(record.id)
  return { removed: targets.length, bytes }
}

/** `artifact://shots/page.png` in the answer is already rendered by the body. */
function artifactRefs(text) {
  const ids = new Set()
  const pattern = /artifact:\/\/([^\s<>()]+)|\/artifacts\/([^\s<>()]+)/gi
  let match
  while ((match = pattern.exec(String(text || '')))) {
    let id = (match[1] || match[2] || '').replace(/[.,;:!?]+$/, '').split(/[?#]/)[0]
    try {
      id = decodeURIComponent(id)
    } catch {
      /* keep the raw id */
    }
    const marker = '/artifacts/'
    const at = id.indexOf(marker)
    if (at >= 0) id = id.slice(at + marker.length)
    if (id.startsWith('artifacts/')) id = id.slice('artifacts/'.length)
    if (id) ids.add(id.replace(/^\/+/, ''))
  }
  return ids
}

function artifactSummary(item) {
  return {
    id: item.id,
    name: item.name,
    ext: item.ext,
    kind: item.kind,
    mime: item.mime,
    size: item.size,
    modifiedAt: item.modifiedAt,
    /* What the card may offer besides Download, decided by the extension. */
    ...(Array.isArray(item.capabilities) ? { capabilities: item.capabilities } : {}),
  }
}

/** A screenshot is part of the answer even when the harness never names it. */
/**
 * The files the *running* turn wrote, computed once when it ends.
 *
 * Same rule as the read-time rebuild (`claimsFor`): evidence first, folder
 * second, never the clock alone. The old version took everything on the shelf
 * modified since the question, which is how four conversations came to claim the
 * same thirteen files — and how a turn about one design displayed another
 * design's screenshots.
 */
function turnArtifacts(thread, turnStartedMs, answer, steps = []) {
  const linked = artifactRefs(answer)
  let shelf = []
  let stamped = {}
  try {
    shelf = artifacts.list({ workspace: thread.workspace }).items || []
    stamped = artifacts.origins({ workspace: thread.workspace }) || {}
  } catch {
    return []
  }
  const self = {
    threadId: thread.id,
    seq: -1,
    start: turnStartedMs,
    /* the turn is still running: it has no end yet, and no grace period either */
    end: Infinity,
    hard: Infinity,
    turn: { text: answer, steps },
  }
  const windows = [self, ...otherWindows(thread)]
  const remote = Boolean(thread.machine && thread.machine !== 'local')
  const evidence = new Map()
  const candidates = shelf
    .map((item) => ({ ...item, ms: timeOf(item.modifiedAt) }))
    .filter((item) => item.ms > 0 && item.ms >= turnStartedMs && !linked.has(item.id))
  const owned = claimsFor(self, candidates, windows, {
    remote,
    cache: evidence,
    alsoNamed: linked,
    stamped,
  })
  return candidates
    .filter((item) => owned.has(item.id))
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    .slice(0, 16)
    .map(({ ms, ...item }) => artifactSummary(item))
}

function timeOf(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Older threads were written before turns carried artifact metadata. Match the
 * shelf against the request windows instead of making the person hunt for a
 * screenshot they already see in the transcript.
 *
 * A turn owns the time from its question until the next question. A successful
 * answer caps the window at its own end (plus a few seconds for the final
 * write); an error or an unanswered request keeps the whole window, because the
 * harness may have saved the file before it failed or while the person retried.
 */
/**
 * A mention is not a claim.
 *
 * A turn that *read* a file mentions it exactly as much as the turn that wrote
 * it, so attribution cannot look at names alone. Evidence is:
 *
 *  - the answer saying `artifact://<id>` (or the full relative id) — the agent
 *    telling the person what it saved;
 *  - a write-shaped step: a `write`/`edit` tool with a path, or a shell command
 *    whose write operator (`>`, `tee`, `cp`, `--out`, …) sits next to the file.
 *
 * Remote turns keep the looser rule: staging rewrites every mtime there, so a
 * named file is all the evidence that exists.
 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'create',
  'str_replace',
  'str_replace_editor',
  'apply_patch',
  'multi_edit',
  'notebook_edit',
])
const WRITE_OPERATOR = /(?:^|[^>])>>?(?!>)|\btee\b|\bcp\b|\bmv\b|\brsync\b|\bsips\b|\bconvert\b|--out(?:put)?\b|(?:^|\s)-o\s/
const GLOBAL_WRITE_OPERATOR = new RegExp(WRITE_OPERATOR.source, 'g')
const WRITE_PATH_KEYS = ['path', 'file_path', 'file', 'target', 'notebook_path', 'to']

/** The snippets of a turn that look like they write a file. Cached per turn. */
function writeEvidence(window, cache) {
  const key = `${window.threadId}:${window.seq}`
  if (cache.has(key)) return cache.get(key)
  const turn = window.turn || {}
  const writes = []
  for (const step of turn.steps || []) {
    const tool = String(step.tool || '').toLowerCase()
    const input = step.input && typeof step.input === 'object' ? step.input : null
    if (WRITE_TOOLS.has(tool) && input) {
      for (const field of WRITE_PATH_KEYS) {
        if (typeof input[field] === 'string' && input[field]) writes.push(input[field])
      }
    }
    const command = typeof input?.command === 'string' ? input.command : ''
    if (!command) continue
    for (const match of command.matchAll(GLOBAL_WRITE_OPERATOR)) {
      writes.push(command.slice(Math.max(0, match.index - 80), match.index + 240))
    }
  }
  const evidence = { answer: String(turn.text || ''), writes }
  cache.set(key, evidence)
  return evidence
}

/**
 * The sync engine's conflict copies live in the shelf (`artifacts/conflicts/…`)
 * but they are not deliverables: no turn wrote one, and they are what you open
 * the Artifacts page to resolve. The page still lists them; attribution never
 * sees them.
 */
const isSyncCopy = (id) => /^conflicts\//.test(String(id))

function wroteArtifact(window, item, cache) {
  const evidence = writeEvidence(window, cache)
  if (
    evidence.answer.includes(`artifact://${item.id}`) ||
    evidence.answer.includes(`artifact://${item.name}`) ||
    evidence.answer.includes(item.id)
  ) {
    return true
  }
  /* A bare basename is too weak for a name like `spec.md`: three folders hold
     one. Match the path when there is one, and the basename only for a file at
     the shelf root. */
  const needle = item.id.includes('/') ? item.id : item.name
  return evidence.writes.some(
    (snippet) => snippet.includes(needle) || snippet.includes(`artifacts/${needle}`),
  )
}

function threadWindows(thread) {
  const updated = timeOf(thread.updatedAt)
  const requests = thread.messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.who === 'me')
  const windows = []
  for (let r = 0; r < requests.length; r += 1) {
    const { message: request, index } = requests[r]
    const next = requests[r + 1] || null
    const start = timeOf(request.at)
    const nextStart = next ? timeOf(next.message.at) : Infinity
    let turn = null
    for (let i = index + 1; i < (next ? next.index : thread.messages.length); i += 1) {
      const candidate = thread.messages[i]
      if (candidate.who === 'agent' || candidate.who === 'sys') {
        turn = candidate
        break
      }
    }
    /* `end` carries a grace period: the last write of a turn often lands a
       second after the answer. `hard` is the turn itself, and only `hard`
       decides whether two turns *could* both have written a file — the grace
       must not make an old turn look like a candidate for the next turn's
       output. */
    let end = nextStart
    let hard = nextStart
    if (turn?.who === 'agent') {
      const ended = timeOf(turn.execution?.endedAt)
      if (ended >= start) {
        hard = Math.min(hard, ended)
        end = Math.min(end, ended + 5000)
      }
    }
    if (!Number.isFinite(hard)) hard = updated && updated >= start ? updated : start
    if (!Number.isFinite(end)) end = updated ? Math.max(start, updated + 5000) : start
    windows.push({ threadId: thread.id, seq: index, start, end, hard, request, turn })
  }
  return windows
}

/**
 * The windows of every *other* thread in the workspace.
 *
 * The shelf belongs to the workspace, not to a conversation: while one turn
 * runs, another thread in the same room may be writing files too. Splitting a
 * shared shelf needs to know about those, so attribution reads the siblings.
 */
const windowCache = new Map()
/* Thread id → how many artifacts it saved. Filled by the attribution pass below
   and read by chat retention's protection ③. */
const artifactIndexCache = new Map()
const ARTIFACT_INDEX_MS = 5000
const WINDOW_CACHE_MS = 1000

function workspaceWindows(thread) {
  const key = thread.workspace
  const hit = windowCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < WINDOW_CACHE_MS) return hit.windows

  const windows = []
  let record
  let files = []
  try {
    record = workspaces.open(thread.workspace)
    files = fs
      .readdirSync(chatsDir(record))
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  } catch {
    return []
  }
  for (const file of files) {
    try {
      const other = normaliseThread(
        JSON.parse(fs.readFileSync(path.join(chatsDir(record), file), 'utf8')),
        record,
      )
      if (!other) continue
      windows.push(...threadWindows(other))
    } catch {
      /* a thread that cannot be read cannot claim a file */
    }
  }
  /* Attribution runs on every read; a second of staleness costs nothing and
     saves parsing every thread file on each message. */
  windowCache.set(key, { at: now, windows })
  return windows
}

function otherWindows(thread) {
  return workspaceWindows(thread).filter((window) => window.threadId !== thread.id)
}

/**
 * The files one turn owns.
 *
 * Time is **never** enough on its own. The shelf is shared with this machine:
 * the person's own render, another app, a second turn in another conversation or
 * a background script all write into it, and none of them is in the transcript.
 * "Only one turn ran in those minutes, so it must be that turn's" is how a
 * turn about one design came to display another design's screenshots.
 *
 * What counts as evidence, in order:
 *
 *  1. **the store wrote it down** — when a turn ends it stamps the files it
 *     produced (`.origin.json`). That is a record, not an inference, so it wins,
 *     and a file stamped to another session is unreachable by 2 and 3 below;
 *  2. **the turn says so** — `artifact://<id>`, the relative id in the answer,
 *     a write tool with that path, or a shell write operator beside it. Strong
 *     enough to win even when another turn overlaps;
 *  3. **the folder the turn wrote into** — a render batch is one deliverable:
 *     the page it edited and the PNG beside it belong to the same turn, even
 *     when the answer only links one of them. Only for files whose window has
 *     exactly one owner, so two conversations in one folder cannot both claim
 *     a fresh file;
 *  4. **a file at the shelf root**, same single-owner condition. There is no
 *     folder to be wrong about, so the window is the best available signal.
 *
 * Everything else stays on the shelf. An unattached file costs a click; a file
 * attached to the wrong design costs trust in every card in the app.
 *
 * A stamp is the store's own record of who *created* a file, written when that
 * turn ended. It is the one claim that needs no inference, so it decides two
 * things:
 *
 *  - a file stamped to this session is this session's, whatever the clock says;
 *  - a file stamped to **another** session is off-limits to every inference
 *    below — a folder or a shelf root must never take a file out of the
 *    conversation that produced it.
 *
 * A stamp is authorship, not custody: the turn that *names* a file it revised
 * still shows it (`wroteArtifact` is evidence, and a person expects the card
 * beside the answer that talks about it). What the stamp forbids is guessing.
 */
function stampOwner(stamped, id) {
  return String((stamped || {})[id] || '')
}

/** An inference may only reach a file no session has claimed yet. */
const unclaimed = (stamped, window) => (item) => {
  const owner = stampOwner(stamped, item.id)
  return !owner || owner === window.threadId
}

function claimsFor(
  window,
  items,
  windows,
  { remote = false, cache, taken = new Set(), alsoNamed = [], stamped = {} } = {},
) {
  const owned = new Set()

  if (remote) {
    /* Staging rewrites every mtime, so the window says nothing here: the turn's
       own evidence is the only claim. It must be *evidence* — a path it wrote, or
       an `artifact://` reference — because "the filename appears somewhere in the
       turn" was satisfied by a directory listing: a `find` over the staged shelf
       chipped every file it printed, conflict copies included. */
    for (const item of items) {
      if (stampOwner(stamped, item.id) === window.threadId) owned.add(item.id)
      else if (wroteArtifact(window, item, cache || new Map())) owned.add(item.id)
    }
    return owned
  }

  const named = new Set()
  const within = (item) => item.ms >= window.start && item.ms < window.end
  /* Naming is precise — a full relative id or a path the turn wrote — so it
     needs no window and no first-come rule: the turn that created a file and
     the turn that revised it both did work the card should show. A stamp this
     session wrote counts the same way, and survives the turn ageing out of the
     transcript. */
  for (const item of items) {
    const mine = stampOwner(stamped, item.id) === window.threadId
    if (!mine && !wroteArtifact(window, item, cache || new Map())) continue
    owned.add(item.id)
    named.add(item.id)
  }

  /* the folders this turn demonstrably produced into — including a file the
     answer links, which the live path keeps out of the card because the answer
     already renders it */
  const dirs = new Set()
  for (const id of [...named, ...alsoNamed]) {
    const cut = String(id).lastIndexOf('/')
    if (cut > 0) dirs.add(String(id).slice(0, cut))
  }

  const mayInfer = unclaimed(stamped, window)
  for (const item of items) {
    if (owned.has(item.id)) continue
    /* Another session produced this file: the clock and the folder are both
       weaker than that, so they do not argue with it. */
    if (!mayInfer(item)) continue
    /* An inferred claim is first come, first served: two turns writing into one
       folder must not both list the same PNG. */
    if (taken.has(item.id)) continue
    if (!within(item)) continue
    /* Another turn could have written it: the window is not an argument.
       Judged on the turn itself (`hard`), never on the grace period, and asked
       as "is anyone else a candidate" — a file written in the last millisecond
       before the answer is still this turn's, and it has no other owner. */
    const rival = windows.some(
      (candidate) =>
        (candidate.threadId !== window.threadId || candidate.seq !== window.seq) &&
        item.ms >= candidate.start &&
        item.ms < candidate.hard,
    )
    if (rival) continue

    const cut = item.id.lastIndexOf('/')
    if (cut <= 0) {
      /* the shelf root: no folder to be wrong about */
      owned.add(item.id)
      continue
    }
    const dir = item.id.slice(0, cut)
    for (const base of dirs) {
      if (dir === base || dir.startsWith(`${base}/`)) {
        owned.add(item.id)
        break
      }
    }
  }
  return owned
}

function attachArtifactsByTurn(thread) {
  let shelf = []
  let stamped = {}
  try {
    shelf = artifacts.list({ workspace: thread.workspace }).items || []
    stamped = artifacts.origins({ workspace: thread.workspace }) || {}
  } catch {
    /* an unreadable shelf must not erase what the transcript already says */
    return thread
  }

  /* Rebuild rather than top up. A chip written by an older, purely time-based
     read is a guess, and keeping it would block the turn that really wrote the
     file forever. */
  for (const message of thread.messages) delete message.artifacts
  if (!shelf.length) return thread

  const remote = Boolean(thread.machine && thread.machine !== 'local')
  const windows = [...threadWindows(thread), ...otherWindows(thread)]
  const evidence = new Map()
  const available = shelf
    .map((item) => ({ ...artifactSummary(item), ms: timeOf(item.modifiedAt) }))
    .filter((item) => item.ms > 0)
    .filter((item) => !isSyncCopy(item.id))
  const claimed = new Set()

  for (const window of windows) {
    if (window.threadId !== thread.id) continue
    const owned = claimsFor(window, available, windows, {
      remote,
      cache: evidence,
      taken: claimed,
      stamped,
    })
    const found = available.filter((item) => owned.has(item.id))
    if (!found.length) continue
    const target = window.turn || window.request
    target.artifacts = [...(target.artifacts || []), ...found.map(({ ms, ...item }) => item)]
    for (const item of found) claimed.add(item.id)
  }
  return thread
}

/**
 * Which threads have saved an artifact.
 *
 * Protection ③ is "never delete a thread that saved an artifact", and the honest
 * answer is the one the chat already shows: the chips on a turn. Attribution is
 * per thread (`claimsFor` is called with the whole window list but only ever
 * assigns the windows of the thread it is given), so running the existing pass
 * per thread produces exactly the transcript's answer — no second rule, no
 * heuristic on timestamps.
 *
 * The shelf is read once, and the result is cached for a few seconds because the
 * settings card asks on every keystroke while a number is being typed.
 */

function threadsWithArtifacts({ workspace } = {}) {
  const key = String(workspace || '')
  const hit = artifactIndexCache.get(key)
  const nowMs = Date.now()
  if (hit && nowMs - hit.at < ARTIFACT_INDEX_MS) return hit.value

  const value = { threads: 0, files: new Map(), total: 0 }
  let record = null
  let files = []
  try {
    record = workspaces.open(key)
    files = fs.readdirSync(chatsDir(record)).filter((file) => file.endsWith('.json'))
  } catch {
    artifactIndexCache.set(key, { at: nowMs, value })
    return value
  }

  for (const file of files) {
    const thread = readThread(record, file.replace(/\.json$/, ''))
    if (!thread || !canAccess(thread)) continue
    let marked = thread
    try {
      marked = attachArtifactsByTurn(thread)
    } catch {
      continue
    }
    const found = new Set()
    for (const message of marked.messages) {
      for (const artifact of message.artifacts || []) if (artifact?.id) found.add(artifact.id)
    }
    if (!found.size) continue
    value.threads += 1
    value.files.set(thread.id, found.size)
    value.total += found.size
  }
  artifactIndexCache.set(key, { at: nowMs, value })
  return value
}

function promptFor(messages) {
  const turns = messages.filter(
    (message) => (message.who === 'me' || message.who === 'agent') && !message.error,
  )
  const latest = turns[turns.length - 1]
  if (!latest) return ''
  if (turns.length === 1) return latest.sent || latest.text

  let text = [
    'Continue this conversation. Answer the latest user message as the assistant.',
    '',
    ...turns.map(
      (message) =>
        `${message.who === 'me' ? 'User' : 'Assistant'}: ${message.sent || message.text}`,
    ),
  ].join('\n\n')

  if (text.length > MAX_PROMPT_CHARS) {
    text = `(Earlier turns were trimmed.)\n\n${text.slice(-MAX_PROMPT_CHARS)}`
  }
  return text
}

/** The command in the transcript is useful; the system prompt in it is not. */
function commandPreview(spec) {
  return [spec.cmd, ...spec.argv]
    .map((arg) => {
      const text = String(arg)
      if (text.length > 120 || text.includes('\n')) return '<…>'
      return /\s/.test(text) ? JSON.stringify(text) : text
    })
    .join(' ')
}

/**
 * Run one chat turn and keep the stream.
 *
 * The return value is deliberate: a failed harness still carries the steps it
 * managed to produce, so the transcript is available even when the answer is
 * not. Only an unexpected programming error rejects.
 */
async function runRemoteHarness(entity, thread, prompt, { onStart, onStep, mentions, attachments }) {
  let record
  try {
    record = workspaces.open(thread.workspace)
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      answer: '',
      steps: [],
      execution: { harness: thread.harness, status: 'error', startedAt: now() },
    }
  }
  try {
    const result = await remoteRunner.run({
      record,
      entity,
      thread,
      prompt,
      attachments,
      onStart,
      onStep,
      onChild: (child) => inFlight.set(thread.id, child),
    })
    return result
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      answer: '',
      steps: [],
      execution: {
        harness: thread.harness,
        machine: thread.machine,
        remote: true,
        status: 'error',
        startedAt: now(),
        ...(mentions?.length ? { mentions } : {}),
      },
    }
  } finally {
    inFlight.delete(thread.id)
  }
}

function runHarness(
  entity,
  thread,
  prompt,
  { onStart = () => {}, onStep = () => {}, mentions = [], attachments = [], mcpOnly = null } = {},
) {
  if (thread.machine !== 'local') {
    return runRemoteHarness(entity, thread, prompt, { onStart, onStep, mentions, attachments })
  }
  return new Promise((resolve) => {
    let dir
    try {
      dir = thread.dir || entities.resolveDir(entity)
      if (thread.dir && !fs.existsSync(dir)) {
        throw new Error(`The base directory for this thread no longer exists: ${dir}`)
      }
    } catch (error) {
      resolve({
        ok: false,
        error: String(error?.message || error),
        answer: '',
        steps: [],
        execution: { harness: thread.harness, status: 'error', startedAt: now() },
      })
      return
    }

    const model = thread.model || (thread.harness === entity.harness ? entity.model : '')
    /* The workspace record carries the context that applies to every entity in
       it. A chat turn is the same agent with the same file, so it must be told
       the same things a run is — including how to reach the `entity` CLI. */
    let record = null
    try {
      record = workspaces.open(thread.workspace)
    } catch {
      record = null
    }
    let spec
    /* The workspace's MCP pool — all of it, for every turn. Read from disk on
       every turn, so an edit in $EDITOR lands on the next message and a shared
       server is never a copy of a secret. `only` is an attachment the person
       named in this prompt, not a restriction the entity carries. */
    let mcp = { servers: [], files: [], argv: [], env: {}, notes: [], cleanup() {} }
    try {
      mcp = mcpRuntime.materialise({
        record,
        harness: thread.harness,
        only: mcpOnly || null,
      })
      const instructions = platform.compose({
        record,
        entity,
        extra: artifacts.brief(thread.workspace),
        /* The turn is stopped by `deadlineTimer` below. Telling the harness how
           long it has is the only thing that changes its shape: a bounded turn
           must land the deliverable before it refines it. */
        budget: platform.turnBudget(HARNESS_TURN_MS / 60_000),
      })
      const attachmentText = attachmentsBlock(attachments)
      const runPrompt = attachmentText ? `${prompt.trim()}\n\n${attachmentText}` : prompt
      spec = chatInvocation(thread.harness, instructions, runPrompt, model, mcp)
      spec.cmd = harnesses.binary(thread.harness) || spec.cmd
    } catch (error) {
      mcp.cleanup?.()
      resolve({
        ok: false,
        error: String(error?.message || error),
        answer: '',
        steps: [],
        execution: { harness: thread.harness, status: 'error', startedAt: now() },
      })
      return
    }

    const startedMs = Date.now()
    const startedAt = now()
    const execution = {
      harness: thread.harness,
      model: String(model || ''),
      command: commandPreview(spec),
      cwd: dir,
      startedAt,
      status: 'running',
      /* what actually reached the harness, and what did not and why */
      ...(mcp.servers.length ? { mcp: mcp.servers } : {}),
      ...(mcp.notes.length ? { mcpNote: mcp.notes.join(' · ') } : {}),
      ...(mentions.length ? { mentions } : {}),
    }
    onStart(execution)

    let child
    try {
      /* Same contract as a run: tracked, and its whole tree is ours to stop. */
      child = spawnTracked(spec.cmd, spec.argv, {
        cwd: dir,
        env: { ...process.env, ...platform.env({ record, entity }), ...mcp.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        kind: 'chat',
        label: `${entity.name} · ${thread.harness}`,
      })
    } catch (error) {
      mcp.cleanup?.()
      resolve({
        ok: false,
        error: String(error?.message || error),
        answer: '',
        steps: [],
        execution: { ...execution, status: 'error', endedAt: now(), ms: Date.now() - startedMs },
      })
      return
    }

    const timing = { firstStepAt: '', firstTextAt: '' }
    const parser = createParser(thread.harness, {
      onStep: (event) => {
        const at = now()
        if (!timing.firstStepAt) timing.firstStepAt = at
        if (!timing.firstTextAt && event.step?.type === 'text' && (event.step.content || event.delta)) timing.firstTextAt = at
        onStep(event)
      },
    })
    let out = ''
    let err = ''
    let settled = false
    inFlight.set(thread.id, child)

    let idleTimer = null
    let deadlineTimer = null
    let timedOut = false
    let overdue = false
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        stopProcess(child)
      }, HARNESS_IDLE_MS)
      if (typeof idleTimer.unref === 'function') idleTimer.unref()
    }
    /* Armed once, at spawn: progress does not extend it. `armIdle` is reset by
       every byte, so a harness that keeps talking can run forever — which is
       what happened. */
    deadlineTimer = setTimeout(() => {
      overdue = true
      stopProcess(child)
    }, HARNESS_TURN_MS)
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref()

    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(deadlineTimer)
      /* the config file is a secret; it outlives the process only if this line
         is skipped, which is why it is here and not in a finally */
      mcp.cleanup?.()
      if (inFlight.get(thread.id) === child) inFlight.delete(thread.id)
      const canceled = canceling.delete(thread.id)
      const parsed = parser.finish()
      const endedAt = now()
      const failed = canceled ? '' : error ? String(error?.message || error) : parsed.error
      const exitFailure =
        !canceled && !failed && typeof code === 'number' && code !== 0
          ? friendlyError(err || parsed.answer || out, spec.cmd)
          : ''
      const firstStepMs = timing.firstStepAt
        ? Math.max(0, Date.parse(timing.firstStepAt) - startedMs)
        : null
      const firstTextMs = timing.firstTextAt
        ? Math.max(0, Date.parse(timing.firstTextAt) - startedMs)
        : null
      resolve({
        ok: !canceled && !failed && !exitFailure,
        canceled,
        answer: parsed.answer,
        error: failed || exitFailure,
        steps: parsed.steps,
        execution: {
          ...execution,
          model: parsed.model || execution.model,
          ...(parsed.usage ? { usage: parsed.usage } : {}),
          ...(Number.isFinite(parsed.costUsd) ? { costUsd: parsed.costUsd } : {}),
          ...(timing.firstStepAt
            ? { firstStepAt: timing.firstStepAt, ttfbMs: firstStepMs }
            : {}),
          ...(timing.firstTextAt
            ? { firstTextAt: timing.firstTextAt, firstTextMs }
            : {}),
          endedAt,
          ms: Date.now() - startedMs,
          exitCode: typeof code === 'number' ? code : null,
          status: canceled ? 'canceled' : failed || exitFailure ? 'error' : 'ok',
        },
      })
    }

    armIdle()

    child.on('error', (error) => {
      finish(
        null,
        new Error(
          error?.code === 'ENOENT'
            ? `${spec.cmd} is not installed on this machine, or not on PATH.`
            : String(error?.message || error),
        ),
      )
    })
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      out += text
      if (out.length > MAX_OUTPUT_CHARS) out = out.slice(-MAX_OUTPUT_CHARS)
      parser.push(text)
      armIdle()
    })
    child.stderr?.on('data', (chunk) => {
      err += String(chunk)
      if (err.length > MAX_OUTPUT_CHARS) err = err.slice(-MAX_OUTPUT_CHARS)
      armIdle()
    })
    child.on('close', (code) =>
      finish(
        typeof code === 'number' ? code : null,
        /* The deadline is the honest message: saying "no output" about a harness
           that was talking the whole time sends the reader looking for the wrong
           bug. */
        overdue
          ? new Error(
              `The turn ran past its ${Math.round(HARNESS_TURN_MS / 60_000)}-minute limit and was stopped.`,
            )
          : timedOut
            ? new Error('The harness produced no output for 15 minutes.')
            : null,
      ),
    )

    child.stdin?.on('error', () => {
      /* a harness that exits before reading stdin is reported by `close` */
    })
    try {
      child.stdin?.write(spec.stdin)
      child.stdin?.end()
    } catch (error) {
      finish(null, error)
    }
  })
}


function resolveAttachments(record, list, baseDir = '') {
  const out = []
  const seen = new Set()
  const pool = workspaces.mcp(record.id)
  let tempDir = ''
  let tempIndex = 0
  const materialise = (name, data) => {
    const buffer = Buffer.from(String(data || ''), 'base64')
    if (!buffer.length) throw new Error('An attached file is empty.')
    if (buffer.length > 25 * 1024 * 1024) throw new Error('An attached file is over 25 MB.')
    if (!tempDir) {
      tempDir = fs.mkdtempSync(path.join(record.path, 'runs', '.attach-'))
      fs.chmodSync(tempDir, 0o700)
    }
    const safe = String(name || 'file')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || `file-${tempIndex}`
    const target = path.join(tempDir, `${tempIndex++}-${safe}`)
    fs.writeFileSync(target, buffer, { mode: 0o600 })
    return target
  }
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || !entry.kind) continue
    if (entry.kind === 'mcp') {
      const name = String(entry.value || entry.name || '').trim()
      if (!name) continue
      if (!pool.servers?.[name]) {
        throw new Error(`@mcp:${name} is not an enabled server in this workspace's MCP pool.`)
      }
      const key = `mcp:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: 'mcp', name })
      continue
    }
    if (entry.kind !== 'file') continue
    let file = ''
    if (entry.data) {
      file = materialise(entry.name, entry.data)
    } else {
      const raw = String(entry.value || entry.path || '').trim()
      if (!raw) continue
      const absolute = expandHome(raw)
      const candidates = path.isAbsolute(absolute)
        ? [absolute]
        : [
            ...(baseDir ? [path.resolve(baseDir, absolute)] : []),
            path.resolve(record.path, absolute),
            path.resolve(process.cwd(), absolute),
          ]
      file = candidates.find((candidate) => {
        try {
          return fs.statSync(candidate).isFile()
        } catch {
          return false
        }
      })
      if (!file) throw new Error(`Attached file does not exist: ${raw}`)
      const stat = fs.statSync(file)
      if (stat.size > 25 * 1024 * 1024) throw new Error(`Attached file is over 25 MB: ${raw}`)
    }
    const key = `file:${file}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'file', path: file, name: entry.name || path.basename(file) })
  }
  return { attachments: out, tempDir }
}

function attachmentsBlock(attachments) {
  const files = (attachments || []).filter((entry) => entry.kind === 'file' && entry.path)
  if (!files.length) return ''
  return [
    'Attached files (available on this machine):',
    ...files.map((entry) => `- ${entry.path}`),
  ].join('\n')
}

async function send({ workspace, id, text, emit = () => {}, retry = false, attachments = [], attachmentsEnabled = false }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  /* Answering brings a thread back into the working list. The archive is a quiet
     place, not a lock: an archived thread is unreachable from the rail's working
     list but a deep link still opens it, and replying there must not leave a live
     conversation in the archive where retention is counting days toward deleting
     it.
     
     Written **here**, before the turn's metadata baseline, so the saves that
     follow compare against a file that already agrees: a later `saveTurn` would
     otherwise read the still-archived file, decide another window must have done
     it, and adopt the archive straight back. */
  if (thread.archived) {
    delete thread.archived
    delete thread.archivedAt
    writeThread(record, thread)
  }
  /* What the person's metadata looked like before this turn touched anything. */
  const baseline = metadataOf(thread)

  const retryTurn = Boolean(retry)
  let turnMentions = []
  /* The plan the window is holding, kept here so the settled row can still say
     what never ran after the turn is written to disk. */
  let turnPlan = null
  let appliedText = ''
  const message = String(text || '').trim()
  if (!retryTurn && !message) throw new Error('Write a message first.')
  if (sending.has(thread.id)) throw new Error('This thread is already answering.')

  const entity = checkEntity(workspace, thread.entity)
  const enabled =
    typeof attachmentsEnabled === 'boolean' ? attachmentsEnabled : Boolean(thread.attachmentsEnabled)
  const typed = enabled ? attachmentRef.extract(message) : { text: message, attachments: [] }
  const resolved = enabled
    ? resolveAttachments(
        record,
        [...typed.attachments, ...(Array.isArray(attachments) ? attachments : [])],
        thread.dir || '',
      )
    : { attachments: [], tempDir: '' }
  const resolvedAttachments = resolved.attachments
  const turnText = typed.text || (resolvedAttachments.length ? 'Use the attached resources.' : '')
  if (thread.machine !== 'local' && resolvedAttachments.some((entry) => entry.kind === 'mcp')) {
    throw new Error('MCP attachments are not available on a remote host yet.')
  }
  thread.attachmentsEnabled = enabled

  /* The turn's own id and its one emitter, created before any mention resolves:
     a fan-out runs for minutes, and the live surface has to know which turn it
     belongs to while it runs, not after it lands. */
  const messageId = `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const emitTurn = (phase, data) => {
    try {
      emit({
        kind: 'chat.turn',
        workspace: record.id,
        threadId: thread.id,
        entity: thread.entity,
        title: thread.title || '',
        messageId,
        phase,
        data,
      })
    } catch {
      /* the window may have closed; the thread file is the record */
    }
  }

  /* The question is written by whichever path ends the turn, so a stopped
     fan-out keeps its question instead of leaving only "Stopped by you." */
  const writeUserRow = (skillApplied, resolved) => {
    const rewritten = Boolean(skillApplied.ref || skillApplied.skill)
    thread.messages.push({
      who: 'me',
      id: `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: message,
      at: now(),
      /* A local skill returns `ref`; a remote skill returns `skill` after it
         has been installed on the host. Both mean the prompt was rewritten. */
      ...(rewritten || resolved.mentions.length || resolvedAttachments.length
        ? { sent: resolved.text }
        : {}),
      ...(resolved.mentions.length ? { mentions: resolved.mentions } : {}),
      ...(resolvedAttachments.length ? { attachments: resolvedAttachments } : {}),
      ...(skillApplied.skill ? { skill: skillApplied.skill } : {}),
    })
  }

  if (retryTurn) {
    const last = thread.messages[thread.messages.length - 1]
    if (!last || last.who !== 'sys' || !last.error) {
      throw new Error('Only a failed turn can be retried.')
    }
    if (!thread.messages.some((entry) => entry.who === 'me')) {
      throw new Error('There is no question to retry.')
    }
    /* The failed row is replaced by the new answer. Keeping it would make the
       transcript claim two answers to one question. */
    thread.messages.pop()
  } else {
    if (!thread.title && thread.titleSource !== 'user') {
      thread.title = titleOf({ messages: [{ who: 'me', text: message }] })
      thread.titleSource = 'auto'
    }
    /* `/workspace:<skill>`, `/<harness>:<skill>` or a bare `/<skill>` becomes
       `use this skill <path>` — resolved on the machine this thread is pinned to,
       before anything is written, so a typo leaves no half-turn in the
       transcript */
    const applied =
      thread.machine === 'local'
        ? skillRef.rewrite(record, turnText, { machine: thread.machine, dir: thread.dir || '' })
        : await remoteRunner.rewriteSkill(record, turnText, {
            machine: thread.machine,
            harness: thread.harness,
          })
    /* `@…` mentions resolve after the skill reference, so the block lands above
       the prompt and the `/skill` rewrite keeps its anchor at the start */
    appliedText = applied.text
    let mentioned
    try {
      mentioned = await mentionRef.rewrite(record, applied.text, {
        entity,
        machine: thread.machine,
        localOnly: thread.machine !== 'local',
        threadId: thread.id,
        /* The grammar cannot read a `spawn` with no count, and that shape used to
           run once — silently. Ask the harness that is about to answer what was
           meant, and hand mention-ref back a `spawn per …` it already knows; the
           rows, the cap and the hold below stay the ordinary ones. Local only:
           a remote thread's harness is not here to ask, and its message is
           forwarded untouched rather than guessed at. */
        intent:
          thread.machine === 'local' &&
          (thread.spawnedFrom ? false : intentRef.wantsFanout(applied.text)) &&
          intentRef.reader({
            harness: thread.harness,
            model: thread.model,
            entities: entities.list(record.id).map((item) => item.name),
          }),
        /* `@thread:` reads through the store's own list/read, so `canAccess` and
           the entity filter are the whole privacy story — mention-ref never opens
           a chat file itself. */
        deps: {
          threads: {
            list: () => list({ workspace: record.id }),
            read: (id) => {
              const found = read({ workspace: record.id, id })
              /* the auto title is derived, not stored; a digest is useless without
                 it, so it is filled in here as the history list already does */
              return found && !found.title ? { ...found, title: titleOf(found) } : found
            },
          },
        },
        /* rows as they are queued, start and settle — the window paints the
           delegation cards from these, so seven runs never look like a hang */
        onProgress: (data) => emitTurn('delegating', data),
        /* The gate, and only for a person's own turn: a spawned session belongs to
           a run that is headless and told not to ask, so it inherits the answer it
           was given and starts immediately — a hold there is a hang. */
        hold: thread.spawnedFrom
          ? null
          : (plan) => {
              turnPlan = plan
              return openHold(thread.id, plan, (data) => emitTurn('hold', data))
            },
        onChild: (child) => {
          const held = mentionChildren.get(thread.id) || new Set()
          held.add(child)
          mentionChildren.set(thread.id, held)
        },
        stopped: () => canceling.has(thread.id),
      })
    } catch (error) {
      /* A plan nobody ran still ends the turn, in the transcript: the question,
         the settled block, and the app's own Retry — the same grammar a stopped
         turn uses. Every other mention error keeps its behaviour (a refusal is a
         toast and nothing written). */
      if (!error?.hold) throw error
      const at = now()
      thread.messages.push({
        who: 'me',
        id: `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text: message,
        at,
        ...(appliedText && appliedText !== message ? { sent: appliedText } : {}),
      })
      const settled = {
        who: 'sys',
        id: messageId,
        text: String(error.message),
        at,
        error: true,
        ...(turnPlan ? { hold: { settled: error.hold, rows: turnPlan.rows } } : {}),
      }
      thread.messages.push(settled)
      thread.updatedAt = at
      saveTurn(record, thread, baseline)
      emitTurn('done', { message: settled })
      return readThread(record, thread.id)
    }
    mentionChildren.delete(thread.id)
    turnMentions = mentioned.mentions
    /* Stopped while the runs were going: the turn ends here, with the same row
       a stopped harness leaves, and no sessions for runs that never finished.
       Nothing is sent to the parent. */
    if (canceling.delete(thread.id)) {
      const at = now()
      /* Keep the runs that finished before the stop — their answers are real
         work. A killed harness is not a failure to report: "Stopped by you." is
         the whole story, and a red card would blame the agent for the clock. */
      writeUserRow(applied, {
        ...mentioned,
        mentions: mentioned.mentions.filter((mention) => mention.status === 'ok'),
      })
      const stopped = { who: 'sys', id: messageId, text: 'Stopped by you.', at }
      thread.messages.push(stopped)
      thread.updatedAt = at
      saveTurn(record, thread, baseline)
      emitTurn('done', { message: stopped })
      return readThread(record, thread.id)
    }
    /* One session per delegated entity mention. A session that cannot be written
       must not fail the turn that already ran, so each is its own try. */
    for (const mention of turnMentions) {
      try {
        const session = spawnMentionSession(record, thread, mention)
        if (session) mention.threadId = session.id
      } catch {
        /* the answer is still in the transcript above the reply */
      }
    }
    writeUserRow(applied, mentioned)
  }
  thread.updatedAt = now()
  saveTurn(record, thread, baseline)

  const baseExecution = {
    harness: thread.harness,
    model: thread.model || (thread.harness === entity.harness ? entity.model : ''),
    startedAt: now(),
    status: 'running',
  }
  /* Token-level streams can emit thousands of updates. Store every step, but
     paint the live trace at human speed. Text and thinking updates travel as
     deltas; the renderer merges them, so an answer does not resend its whole
     accumulated body on every tick. */
  let stepEmittedAt = 0
  let pendingStep = null
  let stepTimer = null
  const publicStep = (event) => {
    if (!event.delta) return event
    const { content: _content, ...step } = event.step || {}
    return { action: event.action, step, delta: event.delta }
  }
  const emitStep = (event) => {
    emitTurn('step', publicStep(event))
    stepEmittedAt = Date.now()
  }
  const flushStep = () => {
    if (stepTimer) {
      clearTimeout(stepTimer)
      stepTimer = null
    }
    if (pendingStep) {
      emitStep(pendingStep)
      pendingStep = null
    }
  }
  const onStep = (event) => {
    const at = Date.now()
    if (event.action === 'add' || at - stepEmittedAt >= 80) {
      flushStep()
      emitStep(event)
      return
    }
    if (
      pendingStep &&
      event.delta &&
      pendingStep.delta &&
      pendingStep.step?.seq === event.step?.seq
    ) {
      pendingStep = { ...pendingStep, delta: pendingStep.delta + event.delta }
    } else {
      flushStep()
      pendingStep = event
    }
    if (!stepTimer) {
      stepTimer = setTimeout(() => {
        stepTimer = null
        if (pendingStep) {
          emitStep(pendingStep)
          pendingStep = null
        }
      }, 80)
    }
  }

  sending.set(thread.id, true)
  let turnMessage = null
  try {
    const prompt = promptFor(thread.messages)
    const turnStartedMs = Date.now()
    const run = await runHarness(entity, thread, prompt, {
      onStart: (execution) => emitTurn('start', { execution }),
      onStep,
      mentions: turnMentions,
      attachments: resolvedAttachments,
      mcpOnly: resolvedAttachments.find((entry) => entry.kind === 'mcp')?.name || null,
    })
    if (thread.machine !== 'local') run.canceled = canceling.delete(thread.id)
    flushStep()

    const at = now()
    const createdArtifacts = turnArtifacts(thread, turnStartedMs, run.answer, run.steps)
    /* Write down who produced these files, now, while the evidence is in hand.
       Attribution on a later read is an inference from clocks and folder shapes;
       a second conversation finishing at the same time defeats it. The stamp is
       what keeps each deliverable in the session that made it. Best-effort: a
       shelf this process cannot write is still one it can read. */
    try {
      artifacts.stampOrigins({
        workspace: thread.workspace,
        threadId: thread.id,
        ids: createdArtifacts.map((item) => item.id),
      })
    } catch {
      /* the inference below is the fallback, never the other way round */
    }
    const execution = { ...run.execution, id: messageId, harness: thread.harness }
    turnMessage = run.canceled
      ? {
          who: 'sys',
          id: messageId,
          text: 'Stopped by you.',
          at,
          steps: run.steps,
          execution,
          ...(createdArtifacts.length ? { artifacts: createdArtifacts } : {}),
        }
      : run.ok
      ? {
          who: 'agent',
          id: messageId,
          text: run.answer || '(no output)',
          at,
          steps: run.steps,
          execution,
          ...(createdArtifacts.length ? { artifacts: createdArtifacts } : {}),
        }
      : {
          who: 'sys',
          id: messageId,
          text: `Harness error: ${run.error || 'the harness exited without a response.'}`,
          at,
          error: true,
          steps: run.steps,
          execution,
          ...(createdArtifacts.length ? { artifacts: createdArtifacts } : {}),
        }
    thread.messages.push(turnMessage)
  } catch (error) {
    /* A plan that nobody ran still keeps its question: the runs never started,
       and a message that vanishes from the transcript on reload is worse than
       the note that explains it. A retry already has its question. */
    if (error?.hold && !retryTurn) {
      thread.messages.push({
        who: 'me',
        id: `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text: message,
        at: now(),
        ...(appliedText && appliedText !== message ? { sent: appliedText } : {}),
      })
    }
    turnMessage = {
      who: 'sys',
      id: messageId,
      /* a held plan's sentence is the whole story — no harness ran, so the
         harness-error prefix would blame the wrong thing */
      text: error?.hold ? String(error.message) : `Harness error: ${error?.message || error}`,
      at: now(),
      error: true,
      ...(error?.hold && turnPlan
        ? { hold: { settled: error.hold, rows: turnPlan.rows } }
        : {}),
      steps: [],
      execution: { ...baseExecution, status: 'error', endedAt: now() },
    }
    thread.messages.push(turnMessage)
  } finally {
    flushStep()
    if (resolved.tempDir) {
      try {
        fs.rmSync(resolved.tempDir, { recursive: true, force: true })
      } catch {
        /* the OS temp cleaner is the backstop */
      }
    }
    sending.delete(thread.id)
    thread.updatedAt = now()
    saveTurn(record, thread, baseline)
    if (turnMessage) emitTurn('done', { message: turnMessage })
  }

  /* A turn that saved a screenshot or a document should show it without the
     person reloading the thread. `read` attaches by turn window; doing it here
     means the returned snapshot already carries the files this turn wrote. */
  return attachArtifactsByTurn(thread)
}

function cancel({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  /* A held turn has no process to kill and no child to reach: Cancel and Stop
     are the same act, so both answer the plan and start nothing. */
  const held = holds.get(thread.id)
  if (held) {
    held.settle({ action: 'cancel', reason: 'cancelled' })
    return { canceled: true, held: true }
  }
  const child = inFlight.get(thread.id)
  const kids = mentionChildren.get(thread.id)
  if (!child && !(kids && kids.size)) return { canceled: false, reason: 'not running' }
  canceling.add(thread.id)
  if (child) stopProcess(child)
  /* A fan-out has no parent harness yet: the delegated runs are the turn, and
     the flag is what keeps the queued ones from starting. */
  for (const kid of kids || []) {
    try {
      killTree(kid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  return { canceled: true }
}

module.exports = {
  setIdentityResolver,
  list,
  read,
  create,
  update,
  rename,
  pin,
  archive,
  threadsWithArtifacts,
  tags,
  remove,
  eraseAll,
  send,
  cancel,
  /* the plan gate's one answer, from the window */
  decideHold,
  /** A held turn, for the tests that pin the plan and the clock. */
  heldPlan,
  /** A delegated mention's own thread; exported for the tests that pin it. */
  spawnMentionSession,
  summarise,
  /** Quitting with an answer in flight must not leave the harness running. */
  closeAll: () => {
    /* A held plan is in memory: answering it as interrupted is what lets the
       turn write its own row instead of vanishing with the process. */
    for (const held of [...holds.values()]) held.settle({ action: 'cancel', reason: 'interrupted' })
    holds.clear()
    for (const child of inFlight.values()) killTree(child, 'SIGTERM')
    for (const kids of mentionChildren.values()) {
      for (const kid of kids) killTree(kid, 'SIGTERM')
    }
    inFlight.clear()
    mentionChildren.clear()
    canceling.clear()
  },
  /* Delegated runs are work in flight: quitting must not orphan them, and the
     count is what the app checks before it closes. */
  activeCount: () =>
    inFlight.size + [...mentionChildren.values()].reduce((sum, kids) => sum + kids.size, 0),
}
