/**
 * The hub's view model for this session.
 *
 * The data itself belongs to the active workspace and is read from disk by the
 * Electron call table (`electron/rpc.cjs`). `src/stores/workspaces.js` opens a
 * workspace and pushes the result in here through `applyScope()`; views read
 * `hub` and call the actions below, and nothing reaches into another
 * component's state.
 *
 * The arrays start empty on purpose: a hub with no workspace is not a hub with
 * sample data, it is a hub that should be at /setup.
 */
import { reactive } from 'vue'
import { BUILTIN_CMDS, HARNESSES } from '@/data/mock'

const SESSION_KEY = 'entity.session'
const WORKSPACE_KEY = 'entity.workspace'
const CREDENTIALS_KEY = 'entity.credentials'

/*
 * The hub ships with one admin account. These constants are a seed, not a
 * source of truth: on first run they are written into `entity.credentials`, and
 * from then on the stored record is what counts. The first sign-in is forced
 * through a password change, and once that lands the shipped password is
 * ignored for good — `admin` / `123456` stops working.
 */
export const DEFAULT_ADMIN = { username: 'admin', password: '123456' }
/* sha256('123456') — the seed is compared as a hash, never as plain text */
const DEFAULT_ADMIN_HASH = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92'
const DEFAULT_EMAIL = 'admin@studio-mac'

function storeCredentials(record) {
  try {
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(record))
  } catch {
    /* the change still holds for this run */
  }
  return record
}

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(String(password))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The stored record wins; the shipped admin is seeded once and then ignored. */
export function credentials() {
  try {
    const raw = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || 'null')
    if (raw && typeof raw.username === 'string' && typeof raw.hash === 'string') {
      /* records written before the account menu shipped have no email */
      if (typeof raw.email !== 'string') {
        raw.email = `${raw.username}@studio-mac`
        storeCredentials(raw)
      }
      return raw
    }
  } catch {
    /* unreadable record — reseed below */
  }
  return storeCredentials({
    username: DEFAULT_ADMIN.username,
    email: DEFAULT_EMAIL,
    hash: DEFAULT_ADMIN_HASH,
    mustChange: true,
    updatedAt: null,
  })
}

export async function verifyCredentials(handle, password) {
  const record = credentials()
  const username = String(handle || '').trim()
  if (username.toLowerCase() !== record.username.toLowerCase()) {
    return { ok: false, message: 'No account with that handle on this hub.' }
  }
  if ((await hashPassword(password)) !== record.hash) {
    return { ok: false, message: 'That password does not match.' }
  }
  return {
    ok: true,
    username: record.username,
    email: record.email,
    mustChange: Boolean(record.mustChange),
  }
}

/** Stores the new hash and clears the must-change flag for this account. */
export async function setPassword(password) {
  const record = credentials()
  return storeCredentials({
    ...record,
    hash: await hashPassword(password),
    mustChange: false,
    updatedAt: new Date().toISOString(),
  })
}

/** Updates the handle and email; the password hash travels untouched. */
export function updateAccount({ username, email }) {
  const handle = String(username || '').trim()
  if (!handle) throw new Error('A username is required.')
  const record = credentials()
  const next = storeCredentials({
    ...record,
    username: handle,
    email: String(email || '').trim(),
    updatedAt: new Date().toISOString(),
  })
  if (hub.session) {
    const session = { ...hub.session, user: next.username, email: next.email }
    hub.session = session
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      /* the session still holds for this run */
    }
  }
  return next
}

/** Verifies the current password before replacing it. */
export async function changePassword(current, nextPassword) {
  const record = credentials()
  if (!current) return { ok: false, message: 'Enter the current password.' }
  if ((await hashPassword(current)) !== record.hash) {
    return { ok: false, message: 'That password does not match the current one.' }
  }
  if (String(nextPassword).length < 6) {
    return { ok: false, message: 'Use at least 6 characters.' }
  }
  if (nextPassword === DEFAULT_ADMIN.password) {
    return { ok: false, message: 'That is the password this hub shipped with — choose a different one.' }
  }
  const updated = storeCredentials({
    ...record,
    hash: await hashPassword(nextPassword),
    mustChange: false,
    updatedAt: new Date().toISOString(),
  })
  return { ok: true, record: updated }
}

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    if (!raw || !raw.user) return null
    /* one account per hub: a session for another handle came from the old
       credentials model and is dropped */
    const record = credentials()
    if (raw.user.toLowerCase() !== record.username.toLowerCase()) return null
    if (typeof raw.email !== 'string' || !raw.email) raw.email = record.email || ''
    return raw
  } catch {
    return null
  }
}

function readWorkspaceId() {
  try {
    return localStorage.getItem(WORKSPACE_KEY) || ''
  } catch {
    return ''
  }
}

export const hub = reactive({
  /* --- session ------------------------------------------------------- */
  session: readSession(),

  /* --- workspace data (filled by stores/workspaces.js) --------------- */
  /** `id` of the active workspace, or '' before setup */
  workspace: readWorkspaceId(),
  /** label + kind of the active workspace, mirrored for headings */
  workspaceLabel: '',
  workspaceKind: 'local',
  workspacePath: '',
  /** entities of the active workspace */
  agents: [],
  /** machines this workspace may use (local + attached ssh aliases) */
  machines: [],
  /** skills attached to the active workspace */
  skills: [],
  /** recent runs, newest first */
  runs: [],
  /** advisory notes that are not tied to one entity (machines, skills) */
  activity: [],

  /* --- ui ------------------------------------------------------------ */
  entityFilter: 'all',
  drawer: { open: false, agentId: '', tab: 'overview' },
  palette: { open: false, query: '', active: 0 },
  account: { open: false },
  settings: { open: false, tab: 'machines' },
  wizard: { open: false },
  toast: { open: false, message: '' },

  /* --- consoles ------------------------------------------------------ */
  ask: { threads: {}, counts: {} },
  chat: {
    built: false,
    sessions: [],
    active: null,
    seq: 0,
    filters: { entity: 'all', machine: 'all', harness: 'all' },
    last: { entity: '', machine: 'local', harness: 'claude' },
  },
})

/* ── scope: what one workspace owns ───────────────────────────────── */

/**
 * Replaces every workspace-scoped array in one move. Called after a workspace
 * opens or reloads, so no view keeps data from the previous scope — and the
 * console threads are dropped, because a thread that references a foreign
 * entity name would be a quiet lie.
 */
export function applyScope({ agents = [], machines = [], skills = [], runs = [], activity = [] } = {}) {
  hub.agents = agents
  hub.machines = machines
  hub.skills = skills
  hub.runs = runs
  hub.activity = activity

  hub.entityFilter = 'all'
  if (!agents.some((agent) => agent.id === hub.drawer.agentId)) {
    hub.drawer.open = false
    hub.drawer.agentId = agents[0]?.id || ''
    hub.drawer.tab = 'overview'
  }

  hub.ask.threads = {}
  hub.ask.counts = {}
  hub.chat.built = false
  hub.chat.sessions = []
  hub.chat.active = null
  hub.chat.seq = 0
  hub.chat.filters = { entity: 'all', machine: 'all', harness: 'all' }
  hub.chat.last = {
    entity: agents[0]?.id || '',
    machine: machines[0]?.id || 'local',
    harness: agents[0]?.harness || 'claude',
  }

  if (hub.drawer.agentId) hub.drawer.agentId = agents.some((a) => a.id === hub.drawer.agentId) ? hub.drawer.agentId : ''
}

/** The run table paints its own state; this is where it lands on the entity. */
export function applyRunState(latest = {}) {
  hub.runs = Object.values(latest).sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
  )
  for (const agent of hub.agents) {
    const run = latest[agent.name]
    if (!run) {
      agent.status = 'sleep'
      agent.last = 'never'
      agent.exitCode = null
      agent.runError = ''
      continue
    }
    agent.lastAt = run.startedAt || null
    agent.last = run.startedAt ? ago(run.startedAt) : 'never'
    agent.lastRunId = run.id
    agent.exitCode = run.exitCode
    agent.status =
      run.status === 'running'
        ? 'running'
        : run.status === 'ok'
          ? 'idle'
          : run.status === 'canceled'
            ? 'sleep'
            : 'error'
    /* a failed run is not a problem with the file — keep the two apart so the
       entity's `problems[]` still means "this file cannot resolve" */
    agent.runError = run.status === 'error' ? run.error || 'the run exited non-zero' : ''
  }
}

/* ── lookups ──────────────────────────────────────────────────────── */
export const agentById = (id) => hub.agents.find((a) => a.id === id) || null
export const machineById = (id) => hub.machines.find((m) => m.id === id) || null
export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || HARNESSES[0]
export const skillByName = (name) => hub.skills.find((s) => s.name === name) || null

export const skillOwners = (name) => hub.agents.filter((a) => a.skills.includes(name))
export const skillMachineIds = (name) => [
  ...new Set(skillOwners(name).flatMap((a) => a.machines)),
]

/** A workspace skill is in place exactly once: on the machine you are using. */
export function skillCoverage(name) {
  const present = hub.skills.some((skill) => skill.name === name && !skill.missing)
  return hub.machines.map((machine) => ({
    machine,
    version: present ? 'installed' : null,
    state: present ? 'installed' : 'none',
    last: '—',
  }))
}

/** Sandbox-relevant summary shown on the overview: entities with a real problem. */
export const agentsWithProblems = () => hub.agents.filter((agent) => agent.problems?.length)
export const problemCount = () =>
  hub.agents.reduce((sum, agent) => sum + (agent.problems?.length || 0), 0)

/* ── mark rule parsing ────────────────────────────────────────────── */
export function mdRules(agent) {
  if (Array.isArray(agent?.rules)) return agent.rules
  return []
}

export const entityMd = (agent) =>
  agent?.instructions || `# ${agent?.name || 'entity'}\n\nNo instructions yet.`

export const initials = (name) => String(name || '').replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase()

export function ago(iso) {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'never'
  const ms = Date.now() - then
  if (ms < 0) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* ── toast ────────────────────────────────────────────────────────── */
let toastTimer = 0
export function toast(message) {
  hub.toast.message = message
  hub.toast.open = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    hub.toast.open = false
  }, 2600)
}

/* ── session ──────────────────────────────────────────────────────── */
export function signIn(user = credentials().username, email = credentials().email) {
  const session = { user, email, at: new Date().toISOString() }
  hub.session = session
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    /* the old pre-fill key is no longer read anywhere */
    localStorage.removeItem('entity:last-user')
  } catch {
    /* the session still holds for this run */
  }
  return session
}

export function signOut() {
  hub.session = null
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing to clear */
  }
}

/* ── entity drawer ────────────────────────────────────────────────── */
export function openDrawer(agentId, tab = 'overview') {
  if (!agentById(agentId)) return
  hub.drawer.agentId = agentId
  hub.drawer.tab = tab
  hub.drawer.open = true
}

export function closeDrawer() {
  hub.drawer.open = false
}

/* ── workspace settings ───────────────────────────────────────────── */
export function openSettings(tab = 'machines') {
  hub.settings.tab = tab
  hub.settings.open = true
}

export function closeSettings() {
  hub.settings.open = false
}

/* ── new workspace ────────────────────────────────────────────────── */
export function openWizard() {
  hub.wizard.open = true
}

export function closeWizard() {
  hub.wizard.open = false
}

/* ── account settings ─────────────────────────────────────────────── */
export function openAccount() {
  hub.account.open = true
}

export function closeAccount() {
  hub.account.open = false
}

/* ── the console: a reader over the entity's own record ───────────── */
function defaultAsk() {
  const agent = hub.agents[0]
  return { entity: agent?.id || '', machine: 'local', harness: agent?.harness || 'claude' }
}

/** The console joins the session you already initiated — it cannot retarget one. */
export function askSession() {
  const c = hub.chat.last || defaultAsk()
  const agent = agentById(c.entity) || hub.agents[0]
  return {
    entity: agent?.id || '',
    machine: machineById(c.machine)?.id || hub.machines[0]?.id || 'local',
    harness: HARNESSES.some((h) => h.id === c.harness) ? c.harness : agent?.harness || 'claude',
  }
}

export const askKey = () => {
  const s = askSession()
  return `${s.entity}|${s.machine}|${s.harness}`
}

export const askAgent = () => agentById(askSession().entity)
export const askMachine = () => machineById(askSession().machine) || hub.machines[0] || null
export const askHarnessFn = () => harnessById(askSession().harness)

export function greeting(agent) {
  if (!agent) return 'No entity yet. Create one in this workspace to give the console a subject.'
  const rules = mdRules(agent).length
  return `${agent.desc || 'No description in the file yet.'} ${agent.skills.length} ${
    agent.skills.length === 1 ? 'skill' : 'skills'
  } and ENTITY.md (${rules} ${rules === 1 ? 'rule' : 'rules'}) travel with me.`
}

export function askThread() {
  const key = askKey()
  const agent = askAgent()
  if (!hub.ask.threads[key]) {
    hub.ask.threads[key] = [
      { who: 'sys', text: `run → ${askMachine()?.label || 'local'} · ${askHarnessFn().label}` },
      { who: 'agent', text: greeting(agent) },
    ]
  }
  return hub.ask.threads[key]
}

export function askCounts() {
  const key = askKey()
  if (!hub.ask.counts[key]) hub.ask.counts[key] = { sent: 0, got: 0 }
  return hub.ask.counts[key]
}

export function askSend(text) {
  const agent = askAgent()
  if (!agent) return
  const log = askThread()
  log.push({ who: 'me', text })
  log.push({ who: 'agent', text: askReply(agent, askMachine(), askHarnessFn(), text) })
  const counts = askCounts()
  counts.sent += 1
  counts.got += 1
}

/**
 * A deterministic answer read out of the entity's own file. It is not a model
 * call: the hub does not pretend to be the harness. `run.start` is where real
 * work happens.
 */
export function askReply(agent, machine, harness, question) {
  const rules = mdRules(agent)
  const guard = rules.length
    ? `ENTITY.md guard: ${rules[0]}`
    : 'ENTITY.md has no guards written yet.'
  const t = String(question || '').toLowerCase()
  const where = agent.machines.length
    ? agent.machines.map((id) => machineById(id)?.label || id).join(' and ')
    : 'no machine'

  if (String(question).startsWith('/')) {
    const name = String(question).split(/\s+/)[0]
    const skill = name.slice(1)
    if (BUILTIN_CMDS.some((c) => c.name === name))
      return `${name} → ${agent.name} · ${machine?.label || 'local'} · ${harness.label}.\nBuilt into ${harness.label}, so there is nothing to install. ${guard}`
    if (agent.skills.includes(skill))
      return `${name} → ${agent.name} · ${machine?.label || 'local'} · ${harness.label}.\n${skill} is attached to this workspace, so the harness can load it from its own library. ${guard}`
    return `No command or skill called ${name} on ${agent.name}.\nAttached: ${agent.skills
      .map((s) => '/' + s)
      .join(', ') || 'none'}. Built in: ${BUILTIN_CMDS.map((c) => c.name).join(', ')}.`
  }
  if (/where|machine|server|local|host/.test(t))
    return `I run on ${where}. Working directory: ${agent.dir || 'not set'}. This session is ${harness.label}.`
  if (/skill|carry|tool|able/.test(t))
    return agent.skills.length
      ? `This workspace attaches ${agent.skills.length}: ${agent.skills.join(', ')}. Type / here to run one.`
      : 'No skills attached to this entity yet — attach them to the workspace first.'
  if (/entity|\.md|instruction|rule/.test(t))
    return `ENTITY.md is ${agent.displayPath}. ${rules.length} rules. ${guard}`
  if (/model|runtime|size|harness|dir/.test(t))
    return `${agent.harness} · ${agent.model || 'harness default model'} · in ${agent.dir || 'an unset directory'}.`
  if (/^(hi|hello|hey)\b/.test(t))
    return `I am ${agent.name} on ${machine?.label || 'local'}. Ask about my skills, my ENTITY.md, or where I run.`
  return `I only answer from my own record: ${agent.name}, ${agent.skills.length} skills, ${agent.dir || 'no dir'}. Try “where do you run”, “what do you carry”, or type / for a command.`
}

/* slash-command menu — one shape for both composers */
export function slashMenu(value, agent) {
  const parts = String(value || '').split(/\s/)
  if (!value?.startsWith('/') || parts.length !== 1) return []
  const q = parts[0].slice(1).toLowerCase()
  const all = BUILTIN_CMDS.concat(
    (agent?.skills || []).map((s) => ({ name: '/' + s, desc: `Skill attached to this workspace`, skill: true })),
  )
  return all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 7)
}

/* ── chat ─────────────────────────────────────────────────────────── */
export function buildChat() {
  if (hub.chat.built) return
  hub.chat.sessions = hub.agents.map((agent) => ({
    id: `t-${agent.id}`,
    entity: agent.id,
    machine: hub.machines[0]?.id || 'local',
    harness: agent.harness,
    when: agent.last && agent.last !== 'never' ? agent.last : 'never',
    msgs: [{ who: 'agent', text: greeting(agent) }],
  }))
  hub.chat.active = hub.chat.sessions[0]?.id || null
  if (hub.chat.sessions[0]) {
    const first = hub.chat.sessions[0]
    hub.chat.last = { entity: first.entity, machine: first.machine, harness: first.harness }
  }
  hub.chat.built = true
}

export const visibleThreads = () => {
  const f = hub.chat.filters
  return hub.chat.sessions.filter(
    (s) =>
      (f.entity === 'all' || s.entity === f.entity) &&
      (f.machine === 'all' || s.machine === f.machine) &&
      (f.harness === 'all' || s.harness === f.harness),
  )
}

export const activeThread = () =>
  hub.chat.sessions.find((s) => s.id === hub.chat.active) || null

export const threadContext = () => {
  const s = activeThread()
  return s ? { entity: s.entity, machine: s.machine, harness: s.harness } : hub.chat.last
}

export function selectThread(id) {
  const s = hub.chat.sessions.find((x) => x.id === id)
  if (!s) return
  hub.chat.active = s.id
  hub.chat.last = { entity: s.entity, machine: s.machine, harness: s.harness }
}

export function setChatFilter(kind, value) {
  hub.chat.filters[kind] = value
}

export function setThreadContext(kind, value) {
  const s = activeThread()
  if (!s) return
  if (kind === 'entity') {
    if (s.entity === value) return
    const existing = hub.chat.sessions.find((x) => x.entity === value)
    if (existing) {
      selectThread(existing.id)
    } else {
      newThread({ entity: value })
    }
    return
  }
  if (kind === 'machine' && s.machine !== value) {
    s.machine = value
    s.msgs.push({
      who: 'sys',
      text: `machine → ${machineById(value)?.label || value} · ${harnessById(s.harness).label}`,
    })
  }
  if (kind === 'harness' && s.harness !== value) {
    s.harness = value
    s.msgs.push({
      who: 'sys',
      text: `harness → ${harnessById(value).label} · ${machineById(s.machine)?.label || s.machine}`,
    })
  }
  hub.chat.last = { entity: s.entity, machine: s.machine, harness: s.harness }
}

export function newThread(overrides = {}) {
  const prev = hub.chat.last
  const entity = overrides.entity || prev.entity
  const machine = overrides.machine || prev.machine
  const harness = overrides.harness || prev.harness
  hub.chat.seq += 1
  const thread = {
    id: `n${hub.chat.seq}`,
    entity,
    machine,
    harness,
    when: 'now',
    msgs: [{ who: 'agent', text: greeting(agentById(entity)) }],
  }
  hub.chat.sessions.unshift(thread)
  hub.chat.active = thread.id
  hub.chat.last = { entity, machine, harness }
  return thread
}

/** Route into an entity's thread — opens the one it already has, or starts one. */
export function chatFocusEntity(id) {
  buildChat()
  const existing = hub.chat.sessions.find((s) => s.entity === id)
  if (existing) selectThread(existing.id)
  else newThread({ entity: id })
}

export function chatSend(text) {
  const s = activeThread()
  if (!s) return
  const agent = agentById(s.entity)
  if (!agent) return
  s.msgs.push({ who: 'me', text })
  s.msgs.push({
    who: 'agent',
    text: askReply(agent, machineById(s.machine), harnessById(s.harness), text),
  })
  s.when = 'now'
  hub.chat.last = { entity: s.entity, machine: s.machine, harness: s.harness }
}

export const threadCounts = (thread) => {
  if (!thread) return { q: 0, r: 0 }
  return {
    q: thread.msgs.filter((m) => m.who === 'me').length,
    /* every thread opens with one greeting — that is the opening line, not a reply */
    r: Math.max(0, thread.msgs.filter((m) => m.who === 'agent').length - 1),
  }
}

export const snippet = (text) => {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > 74 ? s.slice(0, 73) + '…' : s
}
