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
 * sample data, it is a hub that should be at /welcome.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { harnesses } from '@/stores/harnesses'
import { createDraftBook, normaliseDraft } from '@/lib/drafts'

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
  /** the local execution target; ssh hosts live in the fleet store */
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
  rail: { entities: false, artifacts: false, drawer: false },
  toast: { open: false, message: '', actionLabel: '' },

  /* --- consoles ------------------------------------------------------ */
  /* Chat threads are files in the workspace. `summaries` is the history list;
     `threads` holds the full transcript of anything opened in this session. */
  /* The artifact page as a dialog over the conversation: `open` is the id of
     the file being previewed, empty when nothing is open. */
  artifact: {
    open: '',
  },
  chat: {
    loading: false,
    loaded: false,
    error: '',
    workspace: '',
    /* A message another page prepared (artifact annotations) and the chat
       consumes once the composer exists. Empty means nothing is waiting.
       `draftThread` says which conversation wrote it: notes taken on an artifact
       in one turn must never land in another's composer. */
    draft: '',
    draftThread: '',
    /* threadId → the text still sitting in that thread's composer. Unsent text
       is the thread's, not the one box's: switching away used to drop it. */
    drafts: {},
    summaries: [],
    threads: {},
    active: '',
    /* The thread a `chat.read` is in flight for. A conversation not yet in
       memory has nothing to paint, so the view says it is opening instead of
       showing an empty page (or the one you just left) and then snapping. */
    opening: '',
    /* per-thread turn state: a map so A and B can answer at the same time */
    sending: {},
    /* Threads this window has watched settle: the summary may still say
       `working` until the list is re-read, and a memory that disagrees with
       disk is exactly what `isSending` needs to be able to overrule. */
    settled: {},
    stopping: {},
    /* threadId → the live trace while its turn runs */
    live: {},
    /* threadId → how many runs a plan is holding, so the rail can say it */
    holding: {},
    filters: { entity: 'all', machine: 'all', harness: 'all' },
    last: { entity: '', machine: 'local', harness: 'claude', model: '' },
  },
})

/* ── unsent text, per thread ──────────────────────────────────────── */

/**
 * The composer is one box for every conversation, and text typed into it used
 * to live exactly as long as that conversation stayed open. A draft belongs to
 * the thread it was typed in, so it is keyed that way and persisted (unsent
 * text has to survive a reload) without ever touching the workspace files.
 */
const draftBook = createDraftBook({
  storage: typeof window !== 'undefined' ? window.localStorage : null,
})
hub.chat.drafts = draftBook.all()

/* A quit happens between two debounced writes as easily as between two turns. */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => draftBook.flush())
}

/** The text waiting in `id`'s composer — the active thread unless told otherwise. */
export const chatDraft = (id = hub.chat.active) => (id ? hub.chat.drafts[id] || '' : '')

/* `id` is explicit because a failed send restores text to the thread that was
   sent from, which the reader may have left while it ran. */
export function setChatDraft(text, id = hub.chat.active) {
  if (!id) return ''
  draftBook.set(id, text)
  hub.chat.drafts = draftBook.all()
  return normaliseDraft(text)
}

/** A thread that no longer exists cannot hold text. */
export function dropChatDraft(id) {
  draftBook.drop(id)
  hub.chat.drafts = draftBook.all()
}

/** Every draft in this workspace belongs to a thread that is about to be gone. */
export function clearChatDrafts() {
  for (const id of Object.keys(hub.chat.drafts)) draftBook.drop(id)
  hub.chat.drafts = draftBook.all()
  draftBook.flush()
}

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
  hub.chat.draft = ''
  hub.chat.draftThread = ''
  hub.chat.sending = {}
  hub.chat.settled = {}
  hub.chat.stopping = {}
  hub.chat.live = {}
  hub.chat.holding = {}
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
       a legacy workspace symlink and a harness skill are the same file */
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
/* The action belongs to the toast that was open when it was set: a later
   message without one must not keep offering the previous Undo. */
let toastAction = null
/** Open the artifact page as a dialog over the chat (image, page, document). */
export function openArtifactPreview(id) {
  hub.artifact.open = String(id || '')
}

export function closeArtifactPreview() {
  hub.artifact.open = ''
}

/**
 * A preview belongs to the conversation it was opened in.
 *
 * An artifact is a file in the workspace, but the page over it is a view of one
 * turn: its notes go to that thread's composer. `hub.artifact` is global — the
 * dialog lives in `ChatView` — so switching threads used to leave the previous
 * conversation's screenshot open over the new transcript, which reads as the
 * file having followed the person. Close it on every thread change.
 */
export function closeArtifactForThreadChange() {
  if (hub.artifact.open) hub.artifact.open = ''
}

/**
 * One message, optionally with one action.
 *
 * A reversible write needs an Undo where the person is already looking, and the
 * toast is that place — no second component, no dialog. It lives longer (5 s)
 * because a one-word button is not readable in two and a half.
 */
export function toast(message, { actionLabel = '', onAction = null } = {}) {
  hub.toast.message = message
  hub.toast.actionLabel = actionLabel && typeof onAction === 'function' ? actionLabel : ''
  toastAction = hub.toast.actionLabel ? onAction : null
  hub.toast.open = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(closeToast, hub.toast.actionLabel ? 5000 : 2600)
}

export function closeToast() {
  clearTimeout(toastTimer)
  toastAction = null
  hub.toast.open = false
  hub.toast.actionLabel = ''
}

/** Run the toast's action once, then get out of the way. */
export function runToastAction() {
  const action = toastAction
  closeToast()
  if (action) action()
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
 * Workspace skills come first, then the harness libraries — and a skill
 * attached to the workspace is not offered twice when it is the same file as a
 * harness one (deduped on the resolved path, not the name: a copied skill is a
 * different file and stays visible). Every entity sees the same list: nothing
 * here is granted or filtered by what one entity "carries", because no entity
 * carries a skill of its own. The one per-entity ordering is the entity's own
 * `prefer:` list — a starting point at the top of the workspace group, never a
 * grant and never a filter.
 *
 * `machine` is the thread's machine. Only this machine's libraries can be read,
 * so a thread pinned anywhere else gets an empty menu and the composer's own
 * one-line explanation instead of a list of local paths. */
export function slashMenu(
  value,
  agent,
  machine = 'local',
  remoteItems = [],
  localPrefix = false,
  projectItems = [],
) {
  const raw = String(value || '')
  const parts = raw.split(/\s/)
  if (!raw.startsWith('/') || parts.length !== 1) return []

  const prefix = localPrefix || raw.startsWith('//') ? '//' : '/'
  const q = raw.slice(prefix.length).toLowerCase()
  const remote = machine !== 'local' && prefix === '/'

  if (remote) {
    return (remoteItems || [])
      .filter((skill) => `${skill.harness}:${skill.name}`.toLowerCase().includes(q))
      .map((skill) => ({
        name: `/${skill.harness}:${skill.name}`,
        desc: `${skill.harnessLabel || skill.harness} skill on ${machine}`,
        kind: 'harness',
      }))
      .slice(0, 500)
  }

  const attachedItems = hub.skills.filter(
    (skill) => !skill.missing && SKILL_REF_NAME.test(skill.name),
  )
  const attached = attachedItems.map((skill) => skill.name)
  const attachedPaths = new Set(
    attachedItems
      .map((skill) => skill.realPath || skill.absolutePath || '')
      .filter(Boolean),
  )

  /* The entity's bookmarks, in the entity's own order, kept only when the skill
     really is attached here and can be typed as a reference. Never a grant: a
     name the workspace lacks is simply not offered. */
  const attachedSet = new Set(attached)
  const preferred = (Array.isArray(agent?.prefer) ? agent.prefer : []).filter(
    (name) => attachedSet.has(name) && SKILL_REF_NAME.test(name),
  )

  const items = []
  /* A bookmark is the one per-entity ordering: it starts the menu, then the rest
     of the workspace group follows in the same order as before. `preferred` is a
     flag rather than a sentence in the description, because the row has a badge
     for it and the description has to stay the same text for every row. */
  for (const name of preferred) {
    items.push({
      name: `${prefix}workspace:${name}`,
      desc: 'Skill attached to this workspace',
      kind: 'skill',
      preferred: true,
    })
  }

  /* Skills that ship with the thread's base directory come next: they are the
     closest thing to "this project's instructions". */
  for (const skill of projectItems || []) {
    if (!SKILL_REF_NAME.test(skill.name)) continue
    items.push({
      name: `${prefix}project:${skill.name}`,
      desc: skill.harnessLabel || 'This directory',
      kind: 'project',
    })
  }

  for (const name of attached) {
    /* already offered at the top as a bookmark — never twice */
    if (preferred.includes(name)) continue
    items.push({
      name: `${prefix}workspace:${name}`,
      desc: 'Skill attached to this workspace',
      kind: 'skill',
    })
  }

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
      name: `${prefix}${skill.harness}:${skill.name}`,
      desc: `${skill.harnessLabel} skill on this machine`,
      kind: 'harness',
    })
  }

  return items
    .filter((item) => item.name.slice(prefix.length).toLowerCase().includes(q))
    .slice(0, 500)
}

/* ── chat ─────────────────────────────────────────────────────────── */
/* Threads live in <workspace>/chats. The renderer keeps the summaries for the
   history list and lazily reads one full transcript when it is opened. */

async function refreshChatList() {
  if (!hub.workspace) return []
  hub.chat.summaries = await call('chat.list', { workspace: hub.workspace })
  return hub.chat.summaries
}

/**
 * A finished turn changes one row. Re-read every thread file only when the
 * operation actually changes the set (create, rename, pin, delete) — a send
 * should not parse the whole history just to update its own timestamp.
 */
function patchChatSummary(thread) {
  if (!thread?.id || !Array.isArray(hub.chat.summaries)) return false
  const old = hub.chat.summaries.find((row) => row.id === thread.id)
  if (!old) return false
  const messages = thread.messages || []
  const queries = messages.filter((message) => message.who === 'me').length
  const replies = messages.filter((message) => message.who === 'agent').length
  const lastMessage = messages[messages.length - 1]
  const spoken = [...messages].reverse().find((message) => message.who !== 'sys')
  const firstAsk = messages.find((message) => message.who === 'me')
  const preview = spoken
    ? String(spoken.text || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    : ''
  const next = {
    ...old,
    title:
      thread.title ||
      old.title ||
      (firstAsk ? String(firstAsk.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''),
    updatedAt: thread.updatedAt,
    queries,
    replies,
    messageCount: queries + replies,
    working: false,
    failed: Boolean(lastMessage?.who === 'sys' && lastMessage.error),
    preview,
    last: spoken ? { who: spoken.who, text: spoken.text, at: spoken.at } : null,
  }
  hub.chat.summaries = hub.chat.summaries
    .map((row) => (row.id === thread.id ? next : row))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    )
  /* this window watched it land, so the summary can no longer claim it runs */
  hub.chat.settled = { ...hub.chat.settled, [thread.id]: true }
  return true
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
    chatsEntitiesKey = entityNamesKey()
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

let chatsEntitiesKey = ''

function entityNamesKey() {
  return (hub.agents || [])
    .map((agent) => agent.name)
    .sort()
    .join('|')
}

/**
 * The history is cached per workspace, but an entity can be deleted from
 * another window: its threads then belong to nothing and the list must drop
 * them. The entity names are a cheap signature of that change.
 */
export async function ensureChats() {
  if (
    hub.chat.loaded &&
    hub.chat.workspace === hub.workspace &&
    chatsEntitiesKey === entityNamesKey()
  ) {
    return hub.chat.summaries
  }
  return loadChats()
}

/** Threads whose entity still exists. A deleted entity's history is hidden. */
export const liveSummaries = () => {
  const names = new Set((hub.agents || []).map((agent) => agent.name))
  return (hub.chat.summaries || []).filter((thread) => names.has(thread.entity))
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
        dir: thread.dir || '',
      }
    : { ...hub.chat.last, dir: '' }
}

export const threadStarted = (thread = activeThread()) =>
  Boolean(thread?.messages?.some((message) => message.who === 'me'))

/**
 * Is this thread's turn still running?
 *
 * Two readers answer one question, and they must never disagree:
 *
 *   - `hub.chat.sending` is this window's own memory — set when *this* window
 *     sent, cleared when its event stream says `done`;
 *   - the summary's `working` field is the main process's answer, written to
 *     disk with the turn and read back by `chat.list`.
 *
 * Only the union is safe. A refresh (or a second window) starts with an empty
 * `sending` map, so a turn that is genuinely still running — a delegated child
 * can outlive the app that started it — would read as idle: no live bubble, no
 * Stop, and a composer that would happily start a second turn racing the first
 * on one file. The reverse direction matters too: a summary read moments before
 * the turn settled still says `working`, so memory has to be able to say it is
 * done. `stamped` is that memory, and it only ever clears.
 */
export const isSending = (id = hub.chat.active) => {
  if (!id) return false
  if (hub.chat.sending[id]) return true
  if (hub.chat.settled?.[id]) return false
  /* The summary is the main process's own answer, read back from the file. */
  return Boolean((hub.chat.summaries || []).find((row) => row.id === id)?.working)
}
export const isStopping = (id = hub.chat.active) => Boolean(hub.chat.stopping[id])

/**
 * This window saw the thread's turn settle: whatever the last list said, the
 * turn is over. Called from the one place that learns it first-hand — the
 * `done` event — so a summary read before that moment cannot keep a thread
 * looking live forever.
 */
export function markSettled(id) {
  if (!id) return
  if (hub.chat.settled[id]) return
  hub.chat.settled = { ...hub.chat.settled, [id]: true }
}
/** Runs a plan is holding for `id`; 0 when nothing is waiting. */
export const heldRuns = (id = hub.chat.active) => Number(hub.chat.holding[id]) || 0
export function setHeldRuns(id, count) {
  if (!id) return
  const holding = { ...hub.chat.holding }
  if (count > 0) holding[id] = count
  else delete holding[id]
  hub.chat.holding = holding
}

/**
 * Wait for a thread's turn to finish.
 *
 * A cancel is not synchronous with the send it cancels: `chat.cancel` returns
 * as soon as the harness was signalled, while `chat.send` settles a moment
 * later and clears the flag. Voice mode interrupts by cancelling and then
 * sending again, so it has to wait for the flag rather than race it. Returns
 * false if the turn is still running at the deadline.
 */
export async function waitForTurn(id = hub.chat.active, { timeout = 15_000, step = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (isSending(id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  return !isSending(id)
}

export const summaryFor = (id) => hub.chat.summaries.find((thread) => thread.id === id) || null

/** Which read is the current one: a second click must not be un-flagged by the
    slower answer of the first. */
let threadReadSeq = 0

/**
 * One disk read, with the transcript told that it is coming.
 *
 * `opening` is cleared only by the newest read, so two quick clicks leave the
 * flag on the thread the reader asked for last. A failure still clears it: the
 * caller's catch turns that into a toast, not a stranded skeleton.
 */
async function readThread(id) {
  const seq = (threadReadSeq += 1)
  hub.chat.opening = id
  try {
    return await call('chat.read', { workspace: hub.workspace, id })
  } finally {
    if (seq === threadReadSeq) hub.chat.opening = ''
  }
}

export async function openThread(id) {
  if (!id || !hub.workspace) return null
  const thread = await readThread(id)
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

/**
 * Switching to a thread that is already in memory paints it immediately and
 * refreshes it underneath. Waiting for the disk read before showing anything
 * made every switch feel like a load, even one made a second earlier.
 */
export async function selectThread(id) {
  if (!id || !hub.workspace) return null
  const known = hub.chat.threads[id]
  if (!known) return openThread(id)

  const previous = hub.chat.active
  activate(known)
  try {
    const fetched = await readThread(id)
    if (!fetched) throw new Error('That thread no longer exists.')
    /* Identical content is not worth a second render of every message. */
    const same =
      fetched.updatedAt === known.updatedAt && fetched.messages?.length === known.messages?.length
    if (!same) {
      hub.chat.threads = { ...hub.chat.threads, [fetched.id]: fetched }
      activate(fetched)
    }
    return hub.chat.threads[id]
  } catch (error) {
    hub.chat.active = previous
    throw error
  }
}

export function setChatFilter(kind, value) {
  hub.chat.filters[kind] = value
}

function activate(thread) {
  hub.chat.active = thread.id
  hub.chat.last = {
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
    model: thread.model || '',
  }
}

/**
 * Keep a thread's newest content in memory *without* claiming the screen.
 *
 * A turn settles whenever the harness finishes, which has nothing to do with
 * where the reader is. Moving `active` here is what pulled people out of the
 * conversation they were reading the moment somebody else's turn completed.
 */
function store(thread) {
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: thread }
}

/** Remember a thread this window just opened or created: content and screen. */
function remember(thread) {
  store(thread)
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
  const agent = agentById(entity)
  const harness = overrides.harness || agent?.harness || previous.harness || 'claude'
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
    dir: String(overrides.dir || ''),
  })
  remember(thread)
  await refreshChatList()
  return thread
}

/** Route into an entity's thread — opens the newest one, or starts a fresh one. */
export async function chatFocusEntity(id) {
  await ensureChats()
  const existing = hub.chat.summaries.find((thread) => thread.entity === id && !thread.spawnedFrom)
  if (existing) await openThread(existing.id)
  else await createThread({ entity: id })
}

/**
 * The conversation a row was spawned from, or null when it is a root (or the
 * parent is gone). A session's only way home is this link.
 */
export const parentOf = (row) => {
  const id = row?.spawnedFrom?.id
  if (!id) return null
  return (hub.chat.summaries || []).find((entry) => entry.id === id) || null
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

/**
 * Archive or restore a thread — optimistic, because the row has to leave the
 * list in the same frame the click lands, and reversible, because the write is.
 *
 * The summary is patched in place rather than re-read: a round trip before the
 * row moves makes the action feel unconfirmed, and the list would flash its old
 * order while the file is written. A failure puts the row back and says so.
 */
export async function archiveThread(id, archived, { silent = false } = {}) {
  const row = hub.chat.summaries.find((thread) => thread.id === id)
  if (!row) return null
  const before = { archived: row.archived, archivedAt: row.archivedAt }
  const patch = (next) => {
    hub.chat.summaries = hub.chat.summaries.map((thread) =>
      thread.id === id ? { ...thread, ...next } : thread,
    )
  }
  patch(
    archived
      ? { archived: true, archivedAt: new Date().toISOString() }
      : { archived: false, archivedAt: undefined },
  )
  try {
    const updated = await call(archived ? 'chat.archive' : 'chat.restore', {
      workspace: hub.workspace,
      id,
    })
    const row2 = hub.chat.summaries.find((thread) => thread.id === id)
    if (row2) patch({ archived: Boolean(updated.archived), archivedAt: updated.archivedAt })
    if (hub.chat.threads[id]) {
      hub.chat.threads = { ...hub.chat.threads, [id]: updated }
    }
    if (!silent) {
      toast(archived ? 'Thread archived' : 'Thread restored', {
        actionLabel: 'Undo',
        onAction: () => {
          archiveThread(id, !archived, { silent: true }).catch((error) => {
            toast(error?.message || 'The thread could not be moved back.')
          })
        },
      })
    }
    return updated
  } catch (error) {
    patch(before)
    if (!silent) toast(error?.message || 'The thread could not be archived.')
    throw error
  }
}

/**
 * The header counts what the working list holds, never the archive too — and
 * never a delegated session: those are not rows.
 */
export const activeSummaryCount = () =>
  liveSummaries().filter((thread) => !thread.archived && !thread.spawnedFrom).length

/** Tags are thread metadata, editable at any time like the title and the pin. */
export async function setThreadTags(id, tags) {
  const updated = await call('chat.tags', { workspace: hub.workspace, id, tags })
  if (hub.chat.threads[id]) {
    hub.chat.threads = { ...hub.chat.threads, [id]: updated }
  }
  await refreshChatList()
  return updated
}

/** Every tag in the workspace, for suggestions and the rail filter. */
export const liveTags = () => {
  const seen = new Map()
  for (const thread of liveSummaries()) {
    for (const tag of thread.tags || []) {
      const key = String(tag).toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export async function removeThread(id) {
  await call('chat.remove', { workspace: hub.workspace, id })
  const nextThreads = { ...hub.chat.threads }
  delete nextThreads[id]
  hub.chat.threads = nextThreads
  dropChatDraft(id)
  if (hub.chat.active === id) hub.chat.active = ''
  await refreshChatList()
  if (!hub.chat.active && hub.chat.summaries.length) {
    await selectThread(hub.chat.summaries[0].id)
  }
}

/**
 * Erase every thread in this workspace, from settings → Chats.
 *
 * The main process deletes the files; the window then drops what it was
 * holding: the open transcript, the rail rows and the unsent drafts (a draft for
 * a thread that is gone is text nobody can send), so nothing on screen is
 * describing a history that no longer exists. The retention card re-reads its
 * counts itself, because it is a separate store.
 */
export async function eraseChats() {
  const result = await call('chat.eraseAll', { workspace: hub.workspace })
  hub.chat.threads = {}
  hub.chat.active = ''
  hub.chat.live = {}
  clearChatDrafts()
  await refreshChatList()
  return result
}

/** Context moves only before the first question. The server enforces the same rule. */
export async function setThreadContext(kind, value) {
  const thread = activeThread()
  if (!thread) return false
  if (isSending(thread.id)) {
    toast('Wait for the current turn to finish before changing the model.')
    return false
  }
  /* The model is not part of the pinned context: the next turn can run with a
     different one while the harness session stays the same. */
  if (threadStarted(thread) && kind !== 'model') return false
  const patch = {
    workspace: hub.workspace,
    id: thread.id,
    entity: thread.entity,
    machine: thread.machine,
    harness: thread.harness,
  }
  if (kind === 'model') patch.model = String(value || '')
  else patch[kind] = value
  try {
    const updated = await call('chat.update', patch)
    remember(updated)
    await refreshChatList()
    return true
  } catch (error) {
    toast(error?.message || 'The thread context could not be changed.')
    return false
  }
}

/* Which call currently owns a thread's `sending` flag. An interrupt cancels one
   send and starts another; the cancelled call settles later, and its `finally`
   must not clear the flag the new turn just set. */
const turnTokens = new Map()

export async function chatSend(
  text,
  { retry = false, attachments = [], attachmentsEnabled = false } = {},
) {
  const thread = activeThread()
  if (!thread || isSending(thread.id)) return
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
  const token = (turnTokens.get(thread.id) || 0) + 1
  turnTokens.set(thread.id, token)
  hub.chat.threads = { ...hub.chat.threads, [thread.id]: optimistic }
  hub.chat.sending = { ...hub.chat.sending, [thread.id]: true }
  /* a new turn makes the thread live again, whatever the last list said */
  if (hub.chat.settled[thread.id]) {
    const settled = { ...hub.chat.settled }
    delete settled[thread.id]
    hub.chat.settled = settled
  }
  if (hub.chat.stopping[thread.id]) {
    const stopping = { ...hub.chat.stopping }
    delete stopping[thread.id]
    hub.chat.stopping = stopping
  }
  hub.chat.error = ''

  try {
    const updated = await call('chat.send', {
      workspace: hub.workspace,
      id: thread.id,
      text: message,
      retry,
      attachments,
      attachmentsEnabled,
    })
    /* An interrupt cancelled this call and already started the next turn. This
       snapshot predates the optimistic row that turn appended, so applying it
       would delete the new question — the event stream has already added this
       turn's own row, and the next snapshot carries both. */
    if ((turnTokens.get(thread.id) || 0) !== token) {
      return hub.chat.threads[thread.id] || updated
    }
    /* Content only: the rail row, the live fold and the notification already
       say the turn landed. Stealing `active` would move the reader. */
    store(updated)
    /* A delegation leaves a session behind, and that row is new to the rail.
       The single-row patch cannot report it, so the list is re-read. Only an
       entity mention spawns one — a `@thread:` mention also carries a threadId,
       which is the thread it POINTS AT, not a new one. */
    const spawned = (updated.messages || []).some((message) =>
      (message.execution?.mentions || message.mentions || []).some(
        (mention) =>
          mention.kind === 'entity' &&
          mention.threadId &&
          !hub.chat.summaries.some((row) => row.id === mention.threadId),
      ),
    )
    if (!patchChatSummary(updated) || spawned) await refreshChatList()
    return updated
  } catch (error) {
    hub.chat.error = error?.message || 'The message could not be sent.'
    toast(hub.chat.error)
    try {
      /* The failure row belongs to its own thread: read it in without moving
         the reader there, or a failed turn becomes a jump scare. */
      const failed = await call('chat.read', { workspace: hub.workspace, id: thread.id })
      if (failed) store(failed)
      await refreshChatList()
    } catch {
      /* the list keeps the last readable state */
    }
  } finally {
    /* Only the current owner may clear the turn state. A cancelled send settles
       after the interrupt has already started the next one. */
    if ((turnTokens.get(thread.id) || 0) === token) {
      turnTokens.delete(thread.id)
      const sending = { ...hub.chat.sending }
      delete sending[thread.id]
      hub.chat.sending = sending
      const stopping = { ...hub.chat.stopping }
      delete stopping[thread.id]
      hub.chat.stopping = stopping
      /* a dropped event must not leave a live fold spinning after the turn */
      if (hub.chat.live[thread.id]) {
        const live = { ...hub.chat.live }
        delete live[thread.id]
        hub.chat.live = live
      }
    }
  }
}

/** Stop this thread's turn. Another thread may keep answering. */
export async function cancelChat() {
  const thread = activeThread()
  if (!thread || !isSending(thread.id) || isStopping(thread.id)) return
  hub.chat.stopping = { ...hub.chat.stopping, [thread.id]: true }
  try {
    const result = await call('chat.cancel', { workspace: hub.workspace, id: thread.id })
    if (!result?.canceled) {
      const stopping = { ...hub.chat.stopping }
      delete stopping[thread.id]
      hub.chat.stopping = stopping
      toast('That turn is already finishing.')
    }
  } catch (error) {
    const stopping = { ...hub.chat.stopping }
    delete stopping[thread.id]
    hub.chat.stopping = stopping
    toast(error?.message || 'The turn could not be stopped.')
  }
}

/**
 * Answer a held plan: `run` starts the runs, `cancel` starts nothing. The block
 * goes the moment it is answered — a Run that stays on screen reads as "nothing
 * happened" while the first harness warms up, and the rows take over from there.
 *
 * `answer` is a string (`'run'`/`'cancel'`) or the form's own payload. A run
 * carries the revision — count, band instruction, per-card rows — on the one
 * call that answers the hold, so the words on screen are the words that start.
 */
/**
 * Ask the classifier again for a held plan.
 *
 * The person edited the **delegation instruction**, and the child instructions
 * on the cards are derived from it — so the same reader that planned the turn
 * plans it again. A read: the hold stays open until Run or Cancel, and the
 * thread is not touched.
 */
export async function replanDelegation(text) {
  const thread = activeThread()
  if (!thread) return null
  return await call('chat.replan', {
    workspace: hub.workspace,
    id: thread.id,
    text: String(text || ''),
  })
}

export async function decideDelegation(answer = 'run') {
  const thread = activeThread()
  if (!thread) return null
  const wanted = answer === 'cancel' || answer?.action === 'cancel' ? 'cancel' : 'run'
  const revision = {}
  if (answer && typeof answer === 'object') {
    if (answer.count !== undefined) revision.count = answer.count
    if (answer.instruction !== undefined) revision.instruction = answer.instruction
    if (answer.rows !== undefined) revision.rows = answer.rows
  }
  setHeldRuns(thread.id, 0)
  try {
    return await call('chat.delegate', {
      workspace: hub.workspace,
      id: thread.id,
      action: wanted,
      ...revision,
    })
  } catch (error) {
    hub.chat.error = error?.message || 'The plan could not be answered.'
    toast(hub.chat.error)
    return null
  }
}

/* ── failed sessions ──────────────────────────────────────────────────────
   A spawned session can fail after the turn that started it has landed: the
   harness times out, the binary is gone, the provider 500s. The card and the
   tree both said "Failed" and offered only Continue, so a ten-run fan-out with
   six timeouts meant opening six sessions and retyping the job in each. The
   turn already knows how to be retried — `chat.send` with `retry` drops the
   error row and asks the question again — so these are the missing handle. */

/**
 * Retry one spawned session's failed turn, in its own thread.
 *
 * The run happens where the answer belongs — the session — so the transcript
 * keeps the history it painted and the card stops claiming the session is dead.
 * `text` is empty on purpose: a retry re-runs the question already in that
 * thread. It is deliberately not awaited: a turn can take an hour, and the card
 * has to say "Retrying…" now. The event stream carries the rest.
 */
export function retrySession(threadId) {
  const id = String(threadId || '')
  const row = (hub.chat.summaries || []).find((entry) => entry.id === id)
  /* Only a failed row with nothing running: a retry of a live turn would open a
     second harness on top of the first. */
  if (!row?.failed || row.working || isSending(id)) return false
  hub.chat.sending = { ...(hub.chat.sending || {}), [id]: true }
  call('chat.send', { workspace: hub.workspace, id, text: '', retry: true })
    .then(async (updated) => {
      /* Content only: a retry started from the parent's transcript must not move
         the reader into the session it retried. */
      if (updated?.id) store(updated)
      await refreshChatList()
    })
    .catch((error) => toast(error?.message || 'That session could not be retried.'))
    .finally(() => {
      if (!(hub.chat.sending || {})[id]) return
      const sending = { ...hub.chat.sending }
      delete sending[id]
      hub.chat.sending = sending
    })
  return true
}

/** Retry a set of sessions; answers how many actually started. */
export function retrySessions(ids = []) {
  const started = [...new Set(ids.filter(Boolean))].filter((id) => retrySession(id)).length
  if (!started) {
    toast('Nothing to retry: those sessions are not failed any more.')
    return 0
  }
  toast(`Retrying ${started} session${started === 1 ? '' : 's'}…`)
  return started
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
