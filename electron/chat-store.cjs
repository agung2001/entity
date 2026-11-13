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
const mcpRuntime = require('./mcp-runtime.cjs')
const { chatInvocation } = require('./runner-local.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const auth = require('./auth-store.cjs')
const platform = require('./platform-brief.cjs')
const { createParser } = require('./chat-transcript.cjs')

/* a generous cap: the renderer only paints the newest turns, but the file is
   the conversation and should survive a long session */
const MAX_THREADS_SCANNED = 400
const MAX_OUTPUT_CHARS = 240_000
const MAX_PROMPT_CHARS = 48_000
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

function normaliseExecution(raw) {
  if (!raw || typeof raw !== 'object') return null
  const execution = {}
  for (const key of ['id', 'harness', 'model', 'command', 'cwd', 'startedAt', 'endedAt', 'status']) {
    if (raw[key] !== undefined && raw[key] !== null) execution[key] = String(raw[key])
  }
  for (const key of ['ms', 'exitCode']) {
    if (Number.isFinite(raw[key])) execution[key] = raw[key]
  }
  if (raw.usage && typeof raw.usage === 'object') execution.usage = raw.usage
  if (Number.isFinite(raw.costUsd)) execution.costUsd = raw.costUsd
  /* what the turn ran with, and what it resolved before running — both survive
     a reload so the answer's fold still explains itself tomorrow */
  if (Array.isArray(raw.mcp)) execution.mcp = raw.mcp.map(String)
  if (typeof raw.mcpNote === 'string' && raw.mcpNote) execution.mcpNote = raw.mcpNote
  if (Array.isArray(raw.mentions)) execution.mentions = raw.mentions
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
    /* files the harness put on the artifact shelf during this turn */
    ...(linkedArtifacts.length ? { artifacts: linkedArtifacts } : {}),
  }
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
    /* chat history is private to the account that started it */
    user: threadOwner(raw, record),
    title: String(raw.title || ''),
    pinned: Boolean(raw.pinned),
    createdAt: raw.createdAt || now(),
    updatedAt: raw.updatedAt || raw.createdAt || now(),
    messages: Array.isArray(raw.messages) ? raw.messages.map(normaliseMessage).filter(Boolean) : [],
  }
}

function writeThread(record, thread) {
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
    title: thread.title || titleOf(thread),
    pinned: Boolean(thread.pinned),
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
        return thread && canAccess(thread) ? summarise(thread) : null
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

function create({ workspace, entity, machine = 'local', harness, model = '', message }) {
  const record = workspaces.open(workspace)
  const agent = checkEntity(workspace, entity)
  const thread = {
    schema: 1,
    id: newThreadId(),
    workspace: record.id,
    entity: agent.name,
    machine: String(machine || 'local'),
    harness: checkHarness(harness, agent),
    model: String(model || '').trim(),
    user: currentUser() || threadOwner(null, record),
    title: '',
    pinned: false,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
  }
  const intro = normaliseMessage(message)
  if (intro) thread.messages.push(intro)
  writeThread(record, thread)
  return thread
}

/** Context can only move before the first question — after that it is history. */
function update({ workspace, id, entity, machine, harness, model }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  if (thread.messages.some((message) => message.who === 'me')) {
    throw new Error('This thread has already started. Its context is locked.')
  }
  const previousHarness = thread.harness
  if (entity && entity !== thread.entity) {
    const agent = checkEntity(workspace, entity)
    thread.entity = agent.name
    thread.harness = checkHarness(thread.harness, agent)
  }
  if (machine) thread.machine = String(machine)
  if (harness) thread.harness = checkHarness(harness, checkEntity(workspace, thread.entity))
  if (model !== undefined) thread.model = String(model || '').trim()
  /* a model belongs to its harness: changing the harness without naming a new
     model drops the old one instead of passing an incompatible name through */
  else if (thread.harness !== previousHarness) thread.model = ''
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

/** Renaming and pinning are metadata: they stay editable after the first turn. */
function rename({ workspace, id, title }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')
  thread.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
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

function remove({ workspace, id }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) return { removed: false }
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
    kind: item.kind,
    mime: item.mime,
    size: item.size,
    modifiedAt: item.modifiedAt,
  }
}

/** A screenshot is part of the answer even when the harness never names it. */
function turnArtifacts(workspace, sinceMs, answer) {
  const linked = artifactRefs(answer)
  return artifacts
    .recent({ workspace, since: sinceMs, limit: 16 })
    .filter((item) => !linked.has(item.id))
    .map(artifactSummary)
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
function attachArtifactsByTurn(thread) {
  const requests = thread.messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.who === 'me')
  if (!requests.length) return thread

  let shelf = []
  try {
    shelf = artifacts.list({ workspace: thread.workspace }).items || []
  } catch {
    return thread
  }
  if (!shelf.length) return thread

  const claimed = new Set()
  for (const message of thread.messages) {
    for (const artifact of message.artifacts || []) claimed.add(artifact.id)
  }
  const available = shelf
    .map((item) => ({ ...artifactSummary(item), ms: timeOf(item.modifiedAt) }))
    .filter((item) => item.ms > 0 && !claimed.has(item.id))

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

    let end = nextStart
    if (turn?.who === 'agent') {
      const ended = timeOf(turn.execution?.endedAt)
      if (ended >= start) end = Math.min(end, ended + 5000)
    }

    const found = available.filter((item) => item.ms >= start && item.ms < end)
    if (!found.length) continue

    const target = turn || request
    target.artifacts = [...(target.artifacts || []), ...found.map(({ ms, ...item }) => item)]
    for (const item of found) {
      claimed.add(item.id)
      const at = available.findIndex((entry) => entry.id === item.id)
      if (at >= 0) available.splice(at, 1)
    }
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
function runHarness(entity, thread, prompt, { onStart = () => {}, onStep = () => {}, mentions = [] } = {}) {
  return new Promise((resolve) => {
    let dir
    try {
      dir = entities.resolveDir(entity)
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
    /* The workspace pool filtered to what this entity names. Resolved from the
       files on disk on every turn, so an edit in $EDITOR lands on the next
       message and a shared server is never a copy of a secret. */
    let mcp = { servers: [], files: [], argv: [], env: {}, notes: [], cleanup() {} }
    try {
      mcp = mcpRuntime.materialise({ record, entity, harness: thread.harness })
      const instructions = platform.compose({
        record,
        entity,
        extra: artifacts.brief(thread.workspace),
      })
      spec = chatInvocation(thread.harness, instructions, prompt, model, mcp)
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

    const parser = createParser(thread.harness, { onStep })
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

async function send({ workspace, id, text, emit = () => {}, retry = false }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread || !canAccess(thread)) throw new Error('That thread no longer exists.')

  const retryTurn = Boolean(retry)
  let turnMentions = []
  const message = String(text || '').trim()
  if (!retryTurn && !message) throw new Error('Write a message first.')
  if (thread.machine !== 'local') {
    throw new Error(
      `This thread is pinned to ${thread.machine}. Remote chat is not wired yet — pick local for a new thread.`,
    )
  }
  if (sending.has(thread.id)) throw new Error('This thread is already answering.')

  const entity = checkEntity(workspace, thread.entity)

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
    if (!thread.title) thread.title = titleOf({ messages: [{ who: 'me', text: message }] })
    /* `/workspace:<skill>`, `/<harness>:<skill>` or a bare `/<skill>` becomes
       `use this skill <path>` — resolved on the machine this thread is pinned to,
       before anything is written, so a typo leaves no half-turn in the
       transcript */
    const applied = skillRef.rewrite(record, message, { machine: thread.machine })
    /* `@…` mentions resolve after the skill reference, so the block lands above
       the prompt and the `/skill` rewrite keeps its anchor at the start */
    const mentioned = await mentionRef.rewrite(record, applied.text, {
      entity,
      machine: thread.machine,
    })
    turnMentions = mentioned.mentions
    thread.messages.push({
      who: 'me',
      text: message,
      at: now(),
      ...(applied.ref || mentioned.mentions.length ? { sent: mentioned.text } : {}),
      ...(mentioned.mentions.length ? { mentions: mentioned.mentions } : {}),
    })
  }
  thread.updatedAt = now()
  writeThread(record, thread)

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
     paint the live trace at human speed. */
  let stepEmittedAt = 0
  let pendingStep = null
  let stepTimer = null
  const flushStep = () => {
    if (stepTimer) {
      clearTimeout(stepTimer)
      stepTimer = null
    }
    if (pendingStep) {
      emitTurn('step', pendingStep)
      pendingStep = null
      stepEmittedAt = Date.now()
    }
  }
  const onStep = (event) => {
    const now = Date.now()
    if (event.action === 'add' || now - stepEmittedAt >= 80) {
      flushStep()
      emitTurn('step', event)
      stepEmittedAt = now
      return
    }
    pendingStep = event
    if (!stepTimer) {
      stepTimer = setTimeout(() => {
        stepTimer = null
        if (pendingStep) {
          emitTurn('step', pendingStep)
          pendingStep = null
          stepEmittedAt = Date.now()
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
    })
    flushStep()

    const at = now()
    const createdArtifacts = turnArtifacts(record.id, turnStartedMs, run.answer)
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
    sending.delete(thread.id)
    thread.updatedAt = now()
    writeThread(record, thread)
    if (turnMessage) emitTurn('done', { message: turnMessage })
  }

  return thread
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
