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
const { chatInvocation } = require('./runner-local.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const platform = require('./platform-brief.cjs')
const { createParser } = require('./chat-transcript.cjs')

/* a generous cap: the renderer only paints the newest turns, but the file is
   the conversation and should survive a long session */
const MAX_THREADS_SCANNED = 400
const MAX_OUTPUT_CHARS = 240_000
const MAX_PROMPT_CHARS = 48_000
const HARNESS_TIMEOUT_MS = 10 * 60 * 1000
const THREAD_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i

const sending = new Map()
/** threadId → live harness process, so a quit mid-answer takes it down too */
const inFlight = new Map()
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
  return Object.keys(execution).length ? execution : null
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
        return thread ? summarise(thread) : null
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
  return readThread(record, id)
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
  if (!thread) throw new Error('That thread no longer exists.')
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
  if (!thread) throw new Error('That thread no longer exists.')
  thread.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

function pin({ workspace, id, pinned }) {
  const record = workspaces.open(workspace)
  const thread = readThread(record, id)
  if (!thread) throw new Error('That thread no longer exists.')
  thread.pinned = Boolean(pinned)
  thread.updatedAt = now()
  writeThread(record, thread)
  return thread
}

function remove({ workspace, id }) {
  const record = workspaces.open(workspace)
  const file = threadFile(record, id)
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file, { force: true })
  return { removed: existed }
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
function runHarness(entity, thread, prompt, { onStart = () => {}, onStep = () => {} } = {}) {
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
    try {
      const instructions = platform.compose({
        record,
        entity,
        extra: artifacts.brief(thread.workspace),
      })
      spec = chatInvocation(thread.harness, instructions, prompt, model)
      spec.cmd = harnesses.binary(thread.harness) || spec.cmd
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

    const startedMs = Date.now()
    const startedAt = now()
    const execution = {
      harness: thread.harness,
      model: String(model || ''),
      command: commandPreview(spec),
      cwd: dir,
      startedAt,
      status: 'running',
    }
    onStart(execution)

    let child
    try {
      /* Same contract as a run: tracked, and its whole tree is ours to stop. */
      child = spawnTracked(spec.cmd, spec.argv, {
        cwd: dir,
        env: { ...process.env, ...platform.env({ record, entity }) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        kind: 'chat',
        label: `${entity.name} · ${thread.harness}`,
      })
    } catch (error) {
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

    /** Graceful first, then the group, so no helper survives the answer. */
    const stop = () => {
      killTree(child, 'SIGTERM')
      const escalate = setTimeout(() => killTree(child, 'SIGKILL'), 3000)
      if (typeof escalate.unref === 'function') escalate.unref()
    }

    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (inFlight.get(thread.id) === child) inFlight.delete(thread.id)
      const parsed = parser.finish()
      const endedAt = now()
      const failed = error ? String(error?.message || error) : parsed.error
      const exitFailure =
        !failed && typeof code === 'number' && code !== 0
          ? friendlyError(err || parsed.answer || out, spec.cmd)
          : ''
      resolve({
        ok: !failed && !exitFailure,
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
          status: failed || exitFailure ? 'error' : 'ok',
        },
      })
    }

    const timer = setTimeout(() => {
      stop()
      finish(null, new Error('The harness did not answer within 10 minutes.'))
    }, HARNESS_TIMEOUT_MS)

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
    })
    child.stderr?.on('data', (chunk) => {
      err += String(chunk)
      if (err.length > MAX_OUTPUT_CHARS) err = err.slice(-MAX_OUTPUT_CHARS)
    })
    child.on('close', (code) => finish(typeof code === 'number' ? code : null))

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
  if (!thread) throw new Error('That thread no longer exists.')

  const retryTurn = Boolean(retry)
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
    /* `/workspace:<skill>` or `/<harness>:<skill>` becomes
       `use this skill <path>` — resolved before anything is written, so a typo
       leaves no half-turn in the transcript */
    const applied = skillRef.rewrite(record, message)
    thread.messages.push({
      who: 'me',
      text: message,
      at: now(),
      ...(applied.ref ? { sent: applied.text } : {}),
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
    const run = await runHarness(entity, thread, prompt, {
      onStart: (execution) => emitTurn('start', { execution }),
      onStep,
    })
    flushStep()

    const at = now()
    const execution = { ...run.execution, id: messageId, harness: thread.harness }
    turnMessage = run.ok
      ? {
          who: 'agent',
          id: messageId,
          text: run.answer || '(no output)',
          at,
          steps: run.steps,
          execution,
        }
      : {
          who: 'sys',
          id: messageId,
          text: `Harness error: ${run.error || 'the harness exited without a response.'}`,
          at,
          error: true,
          steps: run.steps,
          execution,
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

module.exports = {
  list,
  read,
  create,
  update,
  rename,
  pin,
  remove,
  send,
  summarise,
  /** Quitting with an answer in flight must not leave the harness running. */
  closeAll: () => {
    for (const child of inFlight.values()) killTree(child, 'SIGTERM')
    inFlight.clear()
  },
  activeCount: () => inFlight.size,
}
