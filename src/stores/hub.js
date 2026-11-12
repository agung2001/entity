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
import { harnesses } from '@/stores/harnesses'

const SESSION_KEY = 'entity.session'
const WORKSPACE_KEY = 'entity.workspace'
const CREDENTIALS_KEY = 'entity.credentials' /* legacy renderer store, migrated once */

/*
 * The account belongs to the machine, not to a browser profile. The file is
 * `~/.entity/auth.json`; the renderer only ever sees the public identity.
 * `bootstrap` remains available for a hub with no account and no workspace.
 */
export const DEFAULT_ADMIN = { username: 'admin', password: '123456' }
const DEFAULT_ADMIN_HASH = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92'
const DEFAULT_EMAIL = 'admin@studio-mac'
export const DEFAULT_ACCOUNT_EMAIL = DEFAULT_EMAIL

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

/** The old renderer credential, read only so it can be moved into auth.json. */
function readLegacyCredentials() {
  try {
    const raw = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || 'null')
    if (!raw || typeof raw.username !== 'string' || typeof raw.hash !== 'string') return null
    if (typeof raw.email !== 'string') raw.email = `${raw.username}@studio-mac`
    if (!ROLES.some((role) => role.id === raw.role)) raw.role = 'owner'
    if (typeof raw.registered !== 'boolean') {
      raw.registered = !(
        raw.username === DEFAULT_ADMIN.username &&
        raw.email === DEFAULT_EMAIL &&
        raw.hash === DEFAULT_ADMIN_HASH
      )
    }
    return raw
  } catch {
    return null
  }
}

let accountLoaded = false
let accountPending = null

/**
 * Read the account file once. On the first call an old localStorage credential
 * is imported into `~/.entity/auth.json`; the untouched shipped seed is dropped
 * instead, so a fresh hub can still adopt its first workspace creator.
 */
export async function loadAccount({ force = false } = {}) {
  if (accountLoaded && !force) return { exists: Boolean(hub.account), user: hub.account }
  if (accountPending && !force) return accountPending
  accountPending = (async () => {
    try {
      let status = await call('auth.status')
      if (!status.exists) {
        const legacy = readLegacyCredentials()
        if (legacy && legacy.registered !== false) {
          try {
            await call('auth.importLegacy', legacy)
            status = await call('auth.status')
          } catch {
            /* a malformed old record falls through to bootstrap */
          }
        }
        try {
          localStorage.removeItem(CREDENTIALS_KEY)
        } catch {
          /* private mode */
        }
      }
      try {
        localStorage.removeItem(CREDENTIALS_KEY)
      } catch {
        /* private mode */
      }
      hub.account = status.user || null
      accountLoaded = true
      return status
    } catch (error) {
      hub.account = null
      accountLoaded = true
      return {
        exists: false,
        user: null,
        error: error?.message || 'The account file could not be read.',
      }
    } finally {
      accountPending = null
    }
  })()
  return accountPending
}

export function accountExists() {
  return Boolean(hub.account)
}

/** Public identity only. Never a password hash, cipher or plaintext. */
export function credentials() {
  return hub.account || {
    username: '',
    email: '',
    role: 'owner',
    registered: false,
  }
}

export function accountRecord() {
  return hub.account
}

export async function verifyCredentials(handle, password) {
  const result = await call('auth.verify', { ident: handle, password })
  if (!result?.ok) return result || { ok: false, message: 'That password does not match.' }
  if (result.user) {
    hub.account = result.user
    accountLoaded = true
  }
  return {
    ok: true,
    username: result.user?.username || '',
    email: result.user?.email || '',
    role: result.user?.role || 'owner',
    mustChange: Boolean(result.mustChange),
  }
}

/**
 * The first workspace creator becomes the account for this machine. If there is
 * no account yet, a workspace owner read from disk seeds one with the documented
 * default password. A real, registered account is never replaced.
 */
export async function adoptWorkspaceOwner(owner, password = DEFAULT_ADMIN.password) {
  const email = String(owner?.email || '').trim()
  if (!email || accountExists()) return hub.account
  const user = await call('auth.adopt', {
    email,
    name: owner?.name || email.split('@')[0],
    password,
    role: 'owner',
  })
  if (user) {
    hub.account = user
    accountLoaded = true
  }
  return user
}

/** Bootstrap before a workspace exists: the email is the handle and password. */
export async function registerAccount({ email, name = '', password, role = 'owner' }) {
  const user = await call('auth.register', { email, name, password, role })
  hub.account = user
  accountLoaded = true
  return user
}

/** Used after a verified sign-in (the old forced-change flow). */
export async function setPassword(password) {
  const user = await call('auth.setPassword', { password })
  hub.account = user
  accountLoaded = true
  return user
}

/** Updates the public identity; the password verifier travels untouched. */
export async function updateAccount({ username, email }) {
  const user = await call('auth.update', { username, email })
  hub.account = user
  accountLoaded = true
  syncSession(user)
  return user
}

/** Verifies the current password before replacing it. */
export async function changePassword(current, nextPassword) {
  const result = await call('auth.changePassword', { current, next: nextPassword })
  if (result?.ok && result.user) {
    hub.account = result.user
    accountLoaded = true
    syncSession(result.user)
  }
  return result || { ok: false, message: 'The password could not be changed.' }
}

function persistSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* the session still holds for this run */
  }
}

function syncSession(user) {
  if (!hub.session || !user) return
  hub.session = {
    ...hub.session,
    user: user.username,
    email: user.email,
    role: user.role,
  }
  persistSession(hub.session)
}

/** Validate a remembered session against auth.json before the router trusts it. */
export async function restoreSession() {
  const status = await loadAccount()
  if (!hub.session) return null
  if (!status.user) {
    hub.session = null
    persistSession(null)
    return null
  }
  const name = String(hub.session.user || '').toLowerCase()
  const mail = String(hub.session.email || '').toLowerCase()
  if (
    name !== String(status.user.username || '').toLowerCase() &&
    (!mail || mail !== String(status.user.email || '').toLowerCase())
  ) {
    hub.session = null
    persistSession(null)
    return null
  }
  syncSession(status.user)
  return hub.session
}

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    if (!raw || !raw.user) return null
    if (!ROLES.some((role) => role.id === raw.role)) raw.role = 'owner'
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
  /* --- account + session --------------------------------------------- */
  /** public identity from ~/.entity/auth.json (never a password) */
  account: null,
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
  /* the second tier can temporarily show the workspace list instead of the
     current section's list; it is navigation state, not a route */
  rail: { entities: false, artifacts: false },
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
    stopping: false,
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
  hub.chat.stopping = false
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
    /* the resolved target and the entry path, so the composer can tell that a
       workspace symlink and a harness skill are the same file */
    absolutePath: String(item?.absolutePath || ''),
    realPath: String(item?.realPath || item?.absolutePath || ''),
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
export const harnessById = (id) =>
  harnesses.items.find((h) => h.id === id) ||
  { id: String(id || ''), label: String(id || 'no harness') }
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
  persistSession(session)
  try {
    /* the old pre-fill key is no longer read anywhere */
    localStorage.removeItem('entity:last-user')
  } catch {
    /* private mode */
  }
  return session
}

export function signOut() {
  hub.session = null
  persistSession(null)
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
    harness: harnesses.items.some((h) => h.id === c.harness)
      ? c.harness
      : agent?.harness || 'claude',
    model: String(c.model || agent?.model || ''),
  }
}

export const askAgent = () => agentById(askSession().entity)

/* A reference is typed, so a skill whose name is not a token cannot be offered
   in the menu — the backend uses the same grammar and would reject it. */
const SKILL_REF_NAME = /^[A-Za-z0-9._-]+$/

/* slash menu — one shape for both composers.
 *
 * The menu is a skill picker and nothing else. A skill is addressed by where it
 * lives, because that is what the backend has to resolve to a path:
 *
 *   /workspace:<name>   a skill attached to this workspace
 *   /<harness>:<name>   a skill in that harness's own library
 *   /<name>             any of them, when exactly one library has that name
 *
 * The entity's own `skills:` come first, then the rest of the workspace, then
 * the harness libraries — and a skill attached to the workspace is not offered
 * twice when it is the same file as a harness one (deduped on the resolved
 * path, not the name: a copied skill is a different file and stays visible).
 *
 * `machine` is the thread's machine. Only this machine's libraries can be read,
 * so a thread pinned anywhere else gets an empty menu and the composer's own
 * one-line explanation instead of a list of local paths. */
export function slashMenu(value, agent, machine = 'local') {
  const parts = String(value || '').split(/\s/)
  if (!value?.startsWith('/') || parts.length !== 1) return []
  if (machine && machine !== 'local') return []

  const q = parts[0].slice(1).toLowerCase()
  const own = new Set((agent?.skills || []).map((name) => name.toLowerCase()))

  const attachedItems = hub.skills.filter(
    (skill) => !skill.missing && SKILL_REF_NAME.test(skill.name),
  )
  const attached = attachedItems.map((skill) => skill.name)
  const attachedPaths = new Set(
    attachedItems
      .map((skill) => skill.realPath || skill.absolutePath || '')
      .filter(Boolean),
  )

  const items = []
  const workspaceNames = [
    ...attached.filter((name) => own.has(name.toLowerCase())),
    ...attached.filter((name) => !own.has(name.toLowerCase())),
  ]
  for (const name of workspaceNames) {
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
  const harnessOrder = [...new Set([agent?.harness, ...harnesses.items.map((h) => h.id)])]
  const rank = (id) => {
    const at = harnessOrder.indexOf(id)
    return at < 0 ? harnessOrder.length : at
  }
  const harnessSkills = hub.harnessSkills
    .filter((skill) => SKILL_REF_NAME.test(skill.name))
    .filter((skill) => !attachedPaths.has(skill.realPath || skill.absolutePath || ''))
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

  /* A bare `/` should reach the harness libraries, so the cap is high enough to
     hold a whole machine library; the menu scrolls and offers to expand. */
  return items.filter((item) => item.name.slice(1).toLowerCase().includes(q)).slice(0, 100)
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

export async function chatSend(text, { retry = false } = {}) {
  const thread = activeThread()
  if (!thread || hub.chat.sending) return
  const message = String(text || '').trim()
  if (!retry && !message) return

  /* A retry re-runs the same turn: drop the trailing error row, never add a
     second copy of the question. The backend does the same before prompting. */
  const base = retry
    ? thread.messages.filter(
        (entry, index) =>
          !(index === thread.messages.length - 1 && entry.who === 'sys' && entry.error),
      )
    : thread.messages
  const optimistic = {
    ...thread,
    messages: retry
      ? base
      : [...base, { who: 'me', text: message, at: new Date().toISOString() }],
  }
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: optimistic }
  hub.chat.sending = true
  hub.chat.stopping = false
  hub.chat.error = ''

  try {
    const updated = await call('chat.send', {
      workspace: hub.workspace,
      id: thread.id,
      text: message,
      retry,
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
    hub.chat.stopping = false
  }
}

/** Stop the active turn. The backend marks the turn canceled, not failed. */
export async function cancelChat() {
  const thread = activeThread()
  if (!thread || !hub.chat.sending || hub.chat.stopping) return
  hub.chat.stopping = true
  try {
    const result = await call('chat.cancel', { workspace: hub.workspace, id: thread.id })
    if (!result?.canceled) {
      hub.chat.stopping = false
      toast('That turn is already finishing.')
    }
  } catch (error) {
    hub.chat.stopping = false
    toast(error?.message || 'The turn could not be stopped.')
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
