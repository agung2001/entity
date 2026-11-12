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
import { call } from '@/composables/localBridge'
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

/* Three levels, one account on this machine. The role travels with the session
   so the rail can say what this person may do without showing an email. */
export const ROLES = [
  {
    id: 'owner',
    label: 'Owner',
    desc: 'Created this workspace. Full control: entities, machines, skills and account.',
  },
  {
    id: 'admin',
    label: 'Admin',
    desc: 'Manages the workspace — machines, skills, MCP servers and account settings.',
  },
  {
    id: 'member',
    label: 'Member',
    desc: 'Uses entities and chats with them, but cannot delete or change workspace settings.',
  },
]

export const roleById = (id) => ROLES.find((role) => role.id === id) || ROLES[0]
export const roleLabel = (id) => roleById(id).label

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
      /* records written before the account menu shipped have no email or role */
      if (typeof raw.email !== 'string') raw.email = `${raw.username}@studio-mac`
      if (!ROLES.some((role) => role.id === raw.role)) raw.role = 'owner'
      return storeCredentials(raw)
    }
  } catch {
    /* unreadable record — reseed below */
  }
  return storeCredentials({
    username: DEFAULT_ADMIN.username,
    email: DEFAULT_EMAIL,
    role: 'owner',
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
    role: record.role || 'owner',
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
    const session = { ...hub.session, user: next.username, email: next.email, role: next.role }
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
    if (!ROLES.some((role) => role.id === raw.role)) raw.role = record.role || 'owner'
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
  /** the harness libraries on this machine, for the `/` menu (not workspace scope) */
  harnessSkills: [],
  /** recent runs, newest first */
  runs: [],
  /** advisory notes that are not tied to one entity (machines, skills) */
  activity: [],

  /* --- ui ------------------------------------------------------------ */
  entityFilter: 'all',
  palette: { open: false, query: '', active: 0 },
  wizard: { open: false },
  toast: { open: false, message: '' },

  /* --- consoles ------------------------------------------------------ */
  /* Chat threads are files in the workspace. `summaries` is the history list;
     `threads` holds the full transcript of anything opened in this session. */
  chat: {
    loading: false,
    loaded: false,
    error: '',
    workspace: '',
    summaries: [],
    threads: {},
    active: '',
    sending: false,
    filters: { entity: 'all', machine: 'all', harness: 'all' },
    last: { entity: '', machine: 'local', harness: 'claude', model: '' },
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

  hub.chat.loading = false
  hub.chat.loaded = false
  hub.chat.error = ''
  hub.chat.workspace = ''
  hub.chat.summaries = []
  hub.chat.threads = {}
  hub.chat.active = ''
  hub.chat.sending = false
  hub.chat.filters = { entity: 'all', machine: 'all', harness: 'all' }
  hub.chat.last = {
    entity: agents[0]?.id || '',
    machine: machines[0]?.id || 'local',
    harness: agents[0]?.harness || 'claude',
    model: agents[0]?.model || '',
  }
}

/**
 * The machine-wide harness libraries, kept off the workspace scope on purpose:
 * attaching a skill is a workspace decision, but what the harnesses have
 * installed is a fact about this machine and survives a workspace switch.
 */
export function applyLibrary(items = []) {
  hub.harnessSkills = (Array.isArray(items) ? items : []).map((item) => ({
    name: String(item?.name || ''),
    harness: String(item?.harness || ''),
    harnessLabel: String(item?.harnessLabel || item?.harness || ''),
  }))
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
export function signIn(
  user = credentials().username,
  email = credentials().email,
  role = credentials().role,
) {
  const session = { user, email, role: role || 'owner', at: new Date().toISOString() }
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

/* ── new workspace ────────────────────────────────────────────────── */
export function openWizard() {
  hub.wizard.open = true
}

export function closeWizard() {
  hub.wizard.open = false
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
    model: String(c.model || agent?.model || ''),
  }
}

export const askAgent = () => agentById(askSession().entity)

/* A reference is typed, so a skill whose name is not a token cannot be offered
   in the menu — the backend uses the same grammar and would reject it. */
const SKILL_REF_NAME = /^[A-Za-z0-9._-]+$/

/* slash-command menu — one shape for both composers.
 *
 * A skill is addressed by where it lives, because that is what the backend has
 * to resolve to a path:
 *
 *   /workspace:<name>   a skill attached to this workspace
 *   /<harness>:<name>   a skill in that harness's own library
 *
 * The entity's own `skills:` come first, then the rest of the workspace, then
 * the harness library — a name attached to the workspace is never also offered
 * as a harness skill, because it is the same file. */
export function slashMenu(value, agent) {
  const parts = String(value || '').split(/\s/)
  if (!value?.startsWith('/') || parts.length !== 1) return []
  const q = parts[0].slice(1).toLowerCase()
  const own = new Set((agent?.skills || []).map((name) => name.toLowerCase()))

  const items = BUILTIN_CMDS.map((command) => ({ ...command, kind: 'command' }))

  const attached = hub.skills
    .filter((skill) => !skill.missing && SKILL_REF_NAME.test(skill.name))
    .map((skill) => skill.name)
  const ordered = [
    ...attached.filter((name) => own.has(name.toLowerCase())),
    ...attached.filter((name) => !own.has(name.toLowerCase())),
  ]
  for (const name of ordered) {
    items.push({
      name: `/workspace:${name}`,
      desc: own.has(name.toLowerCase())
        ? 'Skill this entity carries'
        : 'Skill attached to this workspace',
      kind: 'skill',
    })
  }

  /* Every harness library is offered, not only the entity's own harness: a
     `/claude:<name>` reference is valid from a pi or codex thread too, because
     the backend resolves the namespace to that harness's library. The current
     harness's skills come first, then the rest. */
  const harnessOrder = [...new Set([agent?.harness, ...HARNESSES.map((h) => h.id)])]
  const rank = (id) => {
    const at = harnessOrder.indexOf(id)
    return at < 0 ? harnessOrder.length : at
  }
  const harnessSkills = hub.harnessSkills
    .filter((skill) => SKILL_REF_NAME.test(skill.name))
    .filter(
      (skill) => !ordered.some((name) => name.toLowerCase() === skill.name.toLowerCase()),
    )
    .sort(
      (a, b) =>
        rank(a.harness) - rank(b.harness) ||
        a.name.localeCompare(b.name) ||
        a.harness.localeCompare(b.harness),
    )

  for (const skill of harnessSkills) {
    items.push({
      name: `/${skill.harness}:${skill.name}`,
      desc: `${skill.harnessLabel} skill on this machine`,
      kind: 'harness',
    })
  }

  /* A bare `/` should still reach the harness libraries. The old seven-row cap
     let four commands plus a few workspace skills hide them completely, so the
     list is long enough to hold a whole machine library and scrolls inside the
     composer menu. */
  return items.filter((item) => item.name.slice(1).toLowerCase().startsWith(q)).slice(0, 100)
}

/* ── chat ─────────────────────────────────────────────────────────── */
/* Threads live in <workspace>/chats. The renderer keeps the summaries for the
   history list and lazily reads one full transcript when it is opened. */

async function refreshChatList() {
  if (!hub.workspace) return []
  hub.chat.summaries = await call('chat.list', { workspace: hub.workspace })
  return hub.chat.summaries
}

export async function loadChats(workspaceId = hub.workspace) {
  if (!workspaceId) {
    hub.chat.summaries = []
    hub.chat.threads = {}
    hub.chat.active = ''
    hub.chat.loaded = true
    hub.chat.workspace = ''
    return []
  }
  hub.chat.loading = true
  hub.chat.error = ''
  try {
    const list = await call('chat.list', { workspace: workspaceId })
    hub.chat.workspace = workspaceId
    hub.chat.summaries = list
    hub.chat.loaded = true
    if (hub.chat.active && !list.some((thread) => thread.id === hub.chat.active)) {
      hub.chat.active = ''
    }
    return list
  } catch (error) {
    hub.chat.error = error?.message || 'Could not read the conversation history.'
    hub.chat.summaries = []
    hub.chat.loaded = false
    return []
  } finally {
    hub.chat.loading = false
  }
}

export async function ensureChats() {
  if (hub.chat.loaded && hub.chat.workspace === hub.workspace) return hub.chat.summaries
  return loadChats()
}

export const visibleThreads = () => {
  const f = hub.chat.filters
  return hub.chat.summaries.filter(
    (thread) =>
      (f.entity === 'all' || thread.entity === f.entity) &&
      (f.machine === 'all' || thread.machine === f.machine) &&
      (f.harness === 'all' || thread.harness === f.harness),
  )
}

export const activeThread = () => hub.chat.threads[hub.chat.active] || null

export const threadContext = () => {
  const thread = activeThread()
  return thread
    ? {
        entity: thread.entity,
        machine: thread.machine,
        harness: thread.harness,
        model: thread.model || '',
      }
    : hub.chat.last
}

export const threadStarted = (thread = activeThread()) =>
  Boolean(thread?.messages?.some((message) => message.who === 'me'))

export const summaryFor = (id) => hub.chat.summaries.find((thread) => thread.id === id) || null

export async function openThread(id) {
  if (!id || !hub.workspace) return null
  const thread = await call('chat.read', { workspace: hub.workspace, id })
  if (!thread) throw new Error('That thread no longer exists.')
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: thread }
  hub.chat.active = thread.id
  hub.chat.last = {
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
    model: thread.model || '',
  }
  return thread
}

export async function selectThread(id) {
  return openThread(id)
}

export function setChatFilter(kind, value) {
  hub.chat.filters[kind] = value
}

function remember(thread) {
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: thread }
  hub.chat.active = thread.id
  hub.chat.last = {
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
    model: thread.model || '',
  }
}

export async function createThread(overrides = {}) {
  const previous = hub.chat.last || {}
  const entity = overrides.entity || previous.entity || hub.agents[0]?.id
  if (!entity) throw new Error('Create an entity before starting a chat.')
  const machine = overrides.machine || previous.machine || hub.machines[0]?.id || 'local'
  const harness =
    overrides.harness || previous.harness || agentById(entity)?.harness || 'claude'
  const agent = agentById(entity)
  const model =
    overrides.model !== undefined
      ? String(overrides.model || '')
      : agent?.harness === harness
        ? String(agent.model || '')
        : ''
  const thread = await call('chat.create', {
    workspace: hub.workspace,
    entity,
    machine,
    harness,
    model,
  })
  remember(thread)
  await refreshChatList()
  return thread
}

/* kept for the views that used the old in-memory name */
export const newThread = createThread

/** Route into an entity's thread — opens the newest one, or starts a fresh one. */
export async function chatFocusEntity(id) {
  await ensureChats()
  const existing = hub.chat.summaries.find((thread) => thread.entity === id)
  if (existing) await openThread(existing.id)
  else await createThread({ entity: id })
}

/** Title and pin are metadata — editable after the conversation started. */
export async function renameThread(id, title) {
  const updated = await call('chat.rename', { workspace: hub.workspace, id, title })
  /* metadata on an inactive row must not switch the open thread */
  if (hub.chat.threads[id]) {
    hub.chat.threads = { ...hub.chat.threads, [id]: updated }
  }
  await refreshChatList()
  return updated
}

export async function pinThread(id, pinned) {
  const updated = await call('chat.pin', { workspace: hub.workspace, id, pinned })
  if (hub.chat.threads[id]) {
    hub.chat.threads = { ...hub.chat.threads, [id]: updated }
  }
  await refreshChatList()
  return updated
}

export async function removeThread(id) {
  await call('chat.remove', { workspace: hub.workspace, id })
  const nextThreads = { ...hub.chat.threads }
  delete nextThreads[id]
  hub.chat.threads = nextThreads
  if (hub.chat.active === id) hub.chat.active = ''
  await refreshChatList()
  if (!hub.chat.active && hub.chat.summaries.length) {
    await selectThread(hub.chat.summaries[0].id)
  }
}

/** Context moves only before the first question. The server enforces the same rule. */
export async function setThreadContext(kind, value) {
  const thread = activeThread()
  if (!thread || threadStarted(thread)) return
  const next = {
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
    [kind]: value,
  }
  try {
    const updated = await call('chat.update', {
      workspace: hub.workspace,
      id: thread.id,
      entity: next.entity,
      machine: next.machine,
      harness: next.harness,
    })
    remember(updated)
    await refreshChatList()
  } catch (error) {
    toast(error?.message || 'The thread context could not be changed.')
  }
}

export async function chatSend(text) {
  const thread = activeThread()
  if (!thread || hub.chat.sending) return
  const message = String(text || '').trim()
  if (!message) return

  /* paint the question immediately; the harness answer arrives when it arrives */
  const optimistic = {
    ...thread,
    messages: [
      ...thread.messages,
      { who: 'me', text: message, at: new Date().toISOString() },
    ],
  }
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: optimistic }
  hub.chat.sending = true
  hub.chat.error = ''

  try {
    const updated = await call('chat.send', {
      workspace: hub.workspace,
      id: thread.id,
      text: message,
    })
    remember(updated)
    await refreshChatList()
    return updated
  } catch (error) {
    hub.chat.error = error?.message || 'The message could not be sent.'
    toast(hub.chat.error)
    try {
      await openThread(thread.id)
      await refreshChatList()
    } catch {
      /* the list keeps the last readable state */
    }
  } finally {
    hub.chat.sending = false
  }
}

export const threadCounts = (thread) => {
  if (!thread) return { q: 0, r: 0 }
  const messages = thread.messages || []
  return {
    q: messages.filter((message) => message.who === 'me').length,
    r: messages.filter((message) => message.who === 'agent').length,
  }
}

export const snippet = (text) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > 74 ? s.slice(0, 73) + '…' : s
}
