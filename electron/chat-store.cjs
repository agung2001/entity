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
const HARNESS_IDLE_MS = 15 * 60 * 1000
const THREAD_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i

const sending = new Map()
/** threadId → live harness process, so a quit mid-answer takes it down too */
const inFlight = new Map()
/** thread ids the person explicitly stopped; close is not a harness failure */
const canceling = new Set()
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
  const kind = ['entity', 'orca', 'artifact', 'maka', 'youtrack'].includes(raw.kind)
    ? raw.kind
    : 'unknown'
  return {
    kind,
    ...(typeof raw.raw === 'string' ? { raw: raw.raw } : {}),
    ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.job === 'string' ? { job: raw.job } : {}),
    ...(Array.isArray(raw.items) ? { items: raw.items } : {}),
    ...(typeof raw.answer === 'string' ? { answer: raw.answer } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
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

function normaliseThread(raw, record) {
  if (!raw || raw.schema !== 1 || typeof raw.id !== 'string') return null
  const entity = String(raw.entity || '')
  if (!entity) return null
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
    tags: normaliseTags(raw.tags),
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
  const file = threadFile(record, thread.id)
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(thread, null, 2)}\n`, 'utf8')
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
    tags: thread.tags || [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    queries,
    replies,
    messageCount: queries + replies,
    working: sending.has(thread.id),
    failed: Boolean(lastMessage?.who === 'sys' && lastMessage.error),
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
  try {
    shelf = artifacts.list({ workspace: thread.workspace }).items || []
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

/** Everything a turn says, for the looser naming rule. */
function turnText(turn) {
  return [
    turn?.text || '',
    ...(turn?.steps || []).map((step) =>
      [
        step.content || '',
        step.output || '',
        step.input && typeof step.input === 'object' ? JSON.stringify(step.input) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n')
}

function mentionsArtifact(turn, item) {
  const text = turnText(turn)
  return (
    text.includes(`artifact://${item.id}`) ||
    text.includes(`artifact://${item.name}`) ||
    text.includes(item.name)
  )
}

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
 *  1. **the turn says so** — `artifact://<id>`, the relative id in the answer,
 *     a write tool with that path, or a shell write operator beside it. Strong
 *     enough to win even when another turn overlaps;
 *  2. **the folder the turn wrote into** — a render batch is one deliverable:
 *     the page it edited and the PNG beside it belong to the same turn, even
 *     when the answer only links one of them. Only for files whose window has
 *     exactly one owner, so two conversations in one folder cannot both claim
 *     a fresh file;
 *  3. **a file at the shelf root**, same single-owner condition. There is no
 *     folder to be wrong about, so the window is the best available signal.
 *
 * Everything else stays on the shelf. An unattached file costs a click; a file
 * attached to the wrong design costs trust in every card in the app.
 */
function claimsFor(window, items, windows, { remote = false, cache, taken = new Set(), alsoNamed = [] } = {}) {
  const owned = new Set()
  if (remote) {
    /* staging rewrites every mtime: only what the turn names is its own */
    for (const item of items) {
      if (mentionsArtifact(window.turn, item)) owned.add(item.id)
    }
    return owned
  }

  const named = new Set()
  const within = (item) => item.ms >= window.start && item.ms < window.end
  /* Naming is precise — a full relative id or a path the turn wrote — so it
     needs no window and no first-come rule: the turn that created a file and
     the turn that revised it both did work the card should show. */
  for (const item of items) {
    if (!wroteArtifact(window, item, cache || new Map())) continue
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

  for (const item of items) {
    if (owned.has(item.id)) continue
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
  try {
    shelf = artifacts.list({ workspace: thread.workspace }).items || []
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
  const claimed = new Set()

  for (const window of windows) {
    if (window.threadId !== thread.id) continue
    const owned = claimsFor(window, available, windows, { remote, cache: evidence, taken: claimed })
    const found = available.filter((item) => owned.has(item.id))
    if (!found.length) continue
    const target = window.turn || window.request
    target.artifacts = [...(target.artifacts || []), ...found.map(({ ms, ...item }) => item)]
    for (const item of found) claimed.add(item.id)
  }
  return thread
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
    let timedOut = false
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        stopProcess(child)
      }, HARNESS_IDLE_MS)
      if (typeof idleTimer.unref === 'function') idleTimer.unref()
    }

    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
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
        timedOut ? new Error('The harness produced no output for 15 minutes.') : null,
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
  /* What the person's metadata looked like before this turn touched anything. */
  const baseline = metadataOf(thread)

  const retryTurn = Boolean(retry)
  let turnMentions = []
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
    const mentioned = await mentionRef.rewrite(record, applied.text, {
      entity,
      machine: thread.machine,
      localOnly: thread.machine !== 'local',
    })
    turnMentions = mentioned.mentions
    const userMessageId = `m_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    thread.messages.push({
      who: 'me',
      id: userMessageId,
      text: message,
      at: now(),
      /* A local skill returns `ref`; a remote skill returns `skill` after it
         has been installed on the host. Both mean the prompt was rewritten. */
      ...(applied.ref || applied.skill || mentioned.mentions.length || resolvedAttachments.length
        ? { sent: mentioned.text }
        : {}),
      ...(mentioned.mentions.length ? { mentions: mentioned.mentions } : {}),
      ...(resolvedAttachments.length ? { attachments: resolvedAttachments } : {}),
      ...(applied.skill ? { skill: applied.skill } : {}),
    })
  }
  thread.updatedAt = now()
  saveTurn(record, thread, baseline)

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
    turnMessage = {
      who: 'sys',
      id: messageId,
      text: `Harness error: ${error?.message || error}`,
      at: now(),
      error: true,
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
  const child = inFlight.get(thread.id)
  if (!child) return { canceled: false, reason: 'not running' }
  canceling.add(thread.id)
  stopProcess(child)
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
  tags,
  remove,
  send,
  cancel,
  summarise,
  /** Quitting with an answer in flight must not leave the harness running. */
  closeAll: () => {
    for (const child of inFlight.values()) killTree(child, 'SIGTERM')
    inFlight.clear()
    canceling.clear()
  },
  activeCount: () => inFlight.size,
}
