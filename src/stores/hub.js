/**
 * The hub's single source of truth for this session.
 *
 * Everything here is sample data mutated in place — there is no backend yet
 * (see reports/unclear/hub-mockup-questions.md). Views read `hub` and call the
 * actions below; nothing reaches into another component's state.
 */
import { reactive } from 'vue'
import {
  ACTIVITY,
  AGENTS,
  BUILTIN_CMDS,
  CHAT_SEED,
  ENTITY_MD,
  HARNESSES,
  MACHINES,
  SKILL_DETAIL,
  SKILLS,
  WORKSPACES,
} from '@/data/mock'

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

const clone = (v) => JSON.parse(JSON.stringify(v))

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

export const hub = reactive({
  /* --- session ------------------------------------------------------- */
  session: readSession(),

  /* --- workspace data ------------------------------------------------ */
  workspace: (() => {
    try {
      const id = localStorage.getItem(WORKSPACE_KEY)
      return WORKSPACES.some((w) => w.id === id) ? id : 'sundoro'
    } catch {
      return 'sundoro'
    }
  })(),
  agents: clone(AGENTS),
  machines: clone(MACHINES),
  skills: clone(SKILLS),
  activity: clone(ACTIVITY),
  /** per-machine skill versions; only web-research has a real record */
  coverage: { 'web-research': clone(SKILL_DETAIL['web-research'].coverage) },

  /* --- ui ------------------------------------------------------------ */
  entityFilter: 'all',
  drawer: { open: false, agentId: 'py-agent', tab: 'overview' },
  move: {
    open: false,
    agentId: null,
    to: null,
    skills: [],
    md: true,
    running: false,
    finished: false,
    progress: 0,
    stepNote: '',
    doneTitle: '',
  },
  palette: { open: false, query: '', active: 0 },
  account: { open: false },
  toast: { open: false, message: '' },

  /* --- consoles ------------------------------------------------------ */
  ask: { threads: {}, counts: {} },
  chat: {
    built: false,
    sessions: [],
    active: null,
    seq: 0,
    filters: { entity: 'all', machine: 'all', harness: 'all' },
    last: { entity: 'py-agent', machine: 'studio-mac', harness: 'claude' },
  },
})

/* ── lookups ──────────────────────────────────────────────────────── */
export const agentById = (id) => hub.agents.find((a) => a.id === id) || null
export const machineById = (id) => hub.machines.find((m) => m.id === id) || null
export const harnessById = (id) => HARNESSES.find((h) => h.id === id) || HARNESSES[0]
export const workspaceById = (id) => WORKSPACES.find((w) => w.id === id) || WORKSPACES[0]
export const skillByName = (name) => hub.skills.find((s) => s.name === name) || null
export const skillDetail = (name) => SKILL_DETAIL[name] || null

export const skillOwners = (name) => hub.agents.filter((a) => a.skills.includes(name))
export const skillMachineIds = (name) => [
  ...new Set(skillOwners(name).flatMap((a) => a.machines)),
]

export function skillCoverage(name) {
  if (hub.coverage[name]) {
    return hub.machines.map((m) => ({
      machine: m,
      ...(hub.coverage[name][m.id] || { version: null, state: 'none', last: '—' }),
    }))
  }
  /* no version record: coverage is just "which machines have an owner here" */
  const ids = skillMachineIds(name)
  return hub.machines.map((m) => ({
    machine: m,
    version: ids.includes(m.id) ? 'installed' : null,
    state: ids.includes(m.id) ? 'installed' : 'none',
    last: '—',
  }))
}

export function strandedSkillCount() {
  return hub.skills.filter((s) => {
    const owners = skillOwners(s.name)
    const machines = new Set(owners.flatMap((a) => a.machines))
    return owners.length > 0 && machines.size === 1
  }).length
}

/* ── mark rule parsing ────────────────────────────────────────────── */
export function mdRules(agent) {
  const block = (ENTITY_MD[agent.id] || '').match(/## Rules\n([\s\S]*?)(?:\n## |$)/)
  return ((block && block[1]) || '').match(/^- (.+)$/gm)?.map((s) => s.slice(2)) || []
}

export const entityMd = (agent) => ENTITY_MD[agent.id] || `# ${agent.name}\n\nNo instructions yet.`

export const initials = (name) => name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase()

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

export function setWorkspace(id) {
  if (!WORKSPACES.some((w) => w.id === id)) return
  hub.workspace = id
  try {
    localStorage.setItem(WORKSPACE_KEY, id)
  } catch {
    /* session-only */
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

/* ── account settings ─────────────────────────────────────────────── */
export function openAccount() {
  hub.account.open = true
}

export function closeAccount() {
  hub.account.open = false
}

/* ── move / relocate ──────────────────────────────────────────────── */
export function openMove(agentId, toId) {
  const agent = agentById(agentId) || hub.agents[0]
  hub.move.agentId = agent.id
  hub.move.skills = [...agent.skills]
  hub.move.to =
    toId ||
    hub.machines.find((m) => !agent.machines.includes(m.id) || m.id !== agent.machines[0]).id
  hub.move.md = true
  hub.move.running = false
  hub.move.finished = false
  hub.move.progress = 0
  hub.move.stepNote = ''
  hub.move.doneTitle = ''
  hub.move.open = true
}

export function closeMove() {
  if (hub.move.running) return
  hub.move.open = false
}

export const movePackNote = () => {
  const agent = agentById(hub.move.agentId)
  if (!agent) return ''
  const n = hub.move.skills.length
  return `Estimated ${agent.size} · ssh · ${n} skill${n === 1 ? '' : 's'}${
    hub.move.md ? ' + ENTITY.md' : ''
  } · ~6s on LAN`
}

export function toggleMoveSkill(name) {
  const at = hub.move.skills.indexOf(name)
  if (at > -1) hub.move.skills.splice(at, 1)
  else hub.move.skills.push(name)
}

let moveTimer = 0
export function startTransfer() {
  if (hub.move.running || hub.move.finished) return
  const agent = agentById(hub.move.agentId)
  const to = hub.move.to
  if (!agent || !to) return

  hub.move.running = true
  hub.move.progress = 0
  hub.move.stepNote = 'packing the runtime'

  clearInterval(moveTimer)
  moveTimer = setInterval(() => {
    hub.move.progress = Math.min(100, hub.move.progress + 6 + Math.random() * 13)
    if (hub.move.progress >= 40 && hub.move.progress < 100) {
      hub.move.stepNote = `sending to ${machineById(to)?.label || to} over ssh`
    }
    if (hub.move.progress >= 100) {
      clearInterval(moveTimer)
      hub.move.stepNote = 'verifying ENTITY.md and skills'
      setTimeout(() => {
        if (!agent.machines.includes(to)) agent.machines.push(to)
        hub.activity.unshift({
          t: 'now',
          who: agent.name,
          act: `copied to ${to}`,
          where: `${agent.size} · ssh`,
        })
        hub.move.doneTitle = `${agent.name} is live on ${to}.`
        hub.move.running = false
        hub.move.finished = true
        hub.move.stepNote = ''
        toast(`${agent.name} is live on ${to}`)
      }, 380)
    }
  }, 130)
}

/* ── skill copy (skill page) ──────────────────────────────────────── */
export function copySkillToMachine(name, machineId) {
  const detail = skillDetail(name)
  const machine = machineById(machineId)
  if (!detail || !machine) return
  if (!hub.coverage[name]) hub.coverage[name] = {}
  hub.coverage[name][machineId] = {
    version: detail.version,
    state: 'sync',
    last: 'just now',
  }
  hub.activity.unshift({
    t: 'now',
    who: 'library',
    act: `copied ${name} ${detail.version} to ${machine.label}`,
    where: 'skill',
  })
  toast(`${name} ${detail.version} copied to ${machine.label}`)
}

/* ── the console: one reply engine for both surfaces ──────────────── */
const ASK_DEF = { entity: 'py-agent', machine: 'studio-mac', harness: 'claude' }

/** The console joins the session you already initiated — it cannot retarget one. */
export function askSession() {
  const c = hub.chat.last || ASK_DEF
  return {
    entity: agentById(c.entity) ? c.entity : ASK_DEF.entity,
    machine: machineById(c.machine) ? c.machine : ASK_DEF.machine,
    harness: HARNESSES.some((h) => h.id === c.harness) ? c.harness : ASK_DEF.harness,
  }
}

export const askKey = () => {
  const s = askSession()
  return `${s.entity}|${s.machine}|${s.harness}`
}

export const askAgent = () => agentById(askSession().entity) || hub.agents[0]
export const askMachine = () => machineById(askSession().machine) || hub.machines[0]
export const askHarnessFn = () => harnessById(askSession().harness)

export function greeting(agent) {
  const rules = mdRules(agent).length
  return `${agent.desc} ${agent.skills.length} skills and ENTITY.md (${rules} ${
    rules === 1 ? 'rule' : 'rules'
  }) travel with me.`
}

export function askThread() {
  const s = askSession()
  const key = askKey()
  const agent = agentById(s.entity) || hub.agents[0]
  if (!hub.ask.threads[key]) {
    hub.ask.threads[key] = [
      { who: 'sys', text: `run → ${askMachine().label} · ${askHarnessFn().label}` },
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
  const log = askThread()
  log.push({ who: 'me', text })
  log.push({ who: 'agent', text: askReply(agent, askMachine(), askHarnessFn(), text) })
  const counts = askCounts()
  counts.sent += 1
  counts.got += 1
}

export function askReply(agent, machine, harness, question) {
  const rules = mdRules(agent)
  const guard = rules.length
    ? `ENTITY.md guard: ${rules[0]}`
    : 'ENTITY.md has no guards written yet.'
  const t = question.toLowerCase()

  if (question.startsWith('/')) {
    const name = question.split(/\s+/)[0]
    const skill = name.slice(1)
    if (BUILTIN_CMDS.some((c) => c.name === name))
      return `${name} → ${agent.name} · ${machine.label} · ${harness.label}.\nBuilt into ${harness.label}, so there is nothing to install. ${guard}`
    if (agent.skills.includes(skill))
      return `${name} → ${agent.name} · ${machine.label} · ${harness.label}.\n${skill} is attached, so it ships inside the bundle and runs from the agent home — nothing to install on ${machine.label}. ${guard}`
    return `No command or skill called ${name} on ${agent.name}.\nAttached: ${agent.skills
      .map((s) => '/' + s)
      .join(', ')}. Built in: ${BUILTIN_CMDS.map((c) => c.name).join(', ')}.`
  }
  if (/where|machine|server|local|host/.test(t))
    return (
      (agent.machines.length
        ? `I am placed on ${agent.machines.join(' and ')}.`
        : 'I am not placed on a machine yet.') +
      ` This session is ${harness.label} on ${machine.label}.`
    )
  if (/skill|carry|tool|able/.test(t))
    return agent.skills.length
      ? `I carry ${agent.skills.length} skills: ${agent.skills.join(', ')}. Type / here to run one.`
      : 'No skills attached yet — attach them before I run.'
  if (/entity|\.md|instruction|rule/.test(t))
    return `ENTITY.md travels with me everywhere — ${rules.length} rules. ${guard}`
  if (/move|transfer|migrat|copy|replicat/.test(t))
    return 'Move agent copies me, the skills you tick and ENTITY.md to another machine. Start it from my drawer or the Machines view.'
  if (/model|runtime|size|harness/.test(t))
    return `${agent.model}, ${agent.runtime} runtime, ${agent.size} on disk. Harness here: ${harness.label}.`
  if (/^(hi|hello|hey)\b/.test(t))
    return `I am ${agent.name} on ${machine.label}. Ask about my skills, my ENTITY.md, or where I run.`
  return `I only answer from my own record: ${agent.name}, ${agent.skills.length} skills, ${machine.label}, ${harness.label}. Try “where do you run”, “what do you carry”, or type / for a command.`
}

/* slash-command menu — one shape for both composers */
export function slashMenu(value, agent) {
  const parts = value.split(/\s/)
  if (!value.startsWith('/') || parts.length !== 1) return []
  const q = parts[0].slice(1).toLowerCase()
  const all = BUILTIN_CMDS.concat(
    agent.skills.map((s) => ({ name: '/' + s, desc: `Skill carried by ${agent.name}`, skill: true })),
  )
  return all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 7)
}

/* ── chat ─────────────────────────────────────────────────────────── */
const greetingFor = (entityId) => greeting(agentById(entityId) || hub.agents[0])

export function buildChat() {
  if (hub.chat.built) return
  hub.chat.sessions = CHAT_SEED.map((seed) => {
    const agent = agentById(seed.entity) || hub.agents[0]
    const machine = machineById(seed.machine) || hub.machines[0]
    const harness = harnessById(seed.harness)
    const msgs = [{ who: 'agent', text: greetingFor(seed.entity) }]
    seed.asks.forEach((q) => {
      msgs.push({ who: 'me', text: q })
      msgs.push({ who: 'agent', text: askReply(agent, machine, harness, q) })
    })
    return { ...seed, msgs }
  })
  hub.chat.active = hub.chat.sessions[0]?.id || null
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
    s.msgs.push({ who: 'sys', text: `machine → ${machineById(value).label} · ${harnessById(s.harness).label}` })
  }
  if (kind === 'harness' && s.harness !== value) {
    s.harness = value
    s.msgs.push({ who: 'sys', text: `harness → ${harnessById(value).label} · ${machineById(s.machine).label}` })
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
    msgs: [{ who: 'agent', text: greetingFor(entity) }],
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
  const agent = agentById(s.entity) || hub.agents[0]
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
