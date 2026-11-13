/**
 * The workspace is the scope, the machine is the source.
 *
 * Opening a workspace is the only way any other store gets data: it reads the
 * directory, then pushes entities, machines, skills, MCP and run history into
 * `hub`. Nothing crosses workspaces — the same entity name in two of them is two
 * unrelated files.
 */
import { computed, reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { applyLibrary, applyScope, credentials, hub, toast } from '@/stores/hub'
import { loadEntities } from '@/stores/entities'
import { loadRuns, resetRuns, runs } from '@/stores/runs'
import { loadArtifacts, resetArtifacts } from '@/stores/artifacts'

const WORKSPACE_KEY = 'entity.workspace'

export const workspaces = reactive({
  loading: false,
  loaded: false,
  error: '',
  items: [],
  active: '',
  machines: [],
  skills: [],
  mcp: { schema: 1, servers: {}, disabled: {}, names: [], disabledNames: [], strict: true, path: '' },
  /** the machine-wide skill libraries, for the "attach" lists */
  library: null,
  /** machine id → the names-only index for that machine's libraries */
  skillNamesByMachine: {},
  hosts: [],
  /** the optional sample entities the wizard offers */
  samples: [],
  creating: false,
  busy: '',
})

export const activeWorkspace = computed(
  () => workspaces.items.find((item) => item.id === workspaces.active) || null,
)

export const needsSetup = computed(() => workspaces.loaded && workspaces.items.length === 0)

function persist(id) {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id)
    else localStorage.removeItem(WORKSPACE_KEY)
  } catch {
    /* session-only */
  }
}

/** Everything a workspace owns, in one read pass. */
export async function loadScope(id) {
  /* Six independent reads. Every one of them is a file walk in the main
     process, so they all start together instead of in two waves. */
  const [machines, skills, mcp] = await Promise.all([
    call('workspace.machines', { id }).catch(() => []),
    call('workspace.skills', { id }).catch(() => []),
    call('workspace.mcp', { id }).catch(() => ({ schema: 1, servers: {}, disabled: {}, names: [], disabledNames: [], strict: true })),
    loadEntities(id),
    loadRuns(id),
    loadArtifacts(id),
  ])

  workspaces.machines = machines
  workspaces.skills = skills
  workspaces.mcp = mcp

  applyScope({
    agents: hub.agents,
    machines,
    skills,
    runs: Object.values(runs.latest),
    activity: [],
  })
}

/** Rename/move a workspace and save its member roster. */
export async function updateWorkspace({ label, id, members }) {
  const previous = workspaces.active
  const record = await call('workspace.update', {
    id: previous,
    label,
    nextId: id,
    members,
  })

  workspaces.items = await call('workspace.list')
  const moved = record.id !== previous
  workspaces.active = record.id
  hub.workspace = record.id
  hub.workspaceLabel = record.label
  hub.workspaceKind = record.kind
  hub.workspacePath = record.displayPath
  persist(record.id)

  /* A new directory name is a new scope key: reload so chat/runs stop claiming
     the old id. A label-only edit leaves the open data untouched. */
  if (moved) await loadScope(record.id)
  return record
}

/** A portable JSON snapshot: entities, chats, copied skills and the MCP pool. */
export async function exportWorkspace(id = workspaces.active) {
  return call('workspace.export', { id })
}

/** Import a bundle, refresh the list, and leave the active workspace alone. */
export async function importWorkspace(bundle) {
  const result = await call('workspace.import', { bundle })
  workspaces.items = await call('workspace.list')
  return result
}

/** Delete a workspace directory. The caller decides what to open next. */
export async function removeWorkspace(id) {
  const result = await call('workspace.remove', { id })
  await loadWorkspaces()
  return result
}

export async function openWorkspace(id) {
  let record = await call('workspace.open', { id })
  /* a workspace from an older build (or an import without an owner) gets the
     account that opens it recorded as the owner. A recorded owner is immutable. */
  if (!record.owner?.email && hub.session?.email) {
    try {
      record = await call('workspace.claimOwner', {
        id: record.id,
        owner: { name: hub.session.user, email: hub.session.email },
      })
    } catch {
      /* an owner backfill is useful, not required to open the workspace */
    }
  }
  workspaces.active = record.id
  workspaces.error = ''
  persist(record.id)
  hub.workspace = record.id
  hub.workspaceLabel = record.label
  hub.workspaceKind = record.kind
  hub.workspacePath = record.displayPath

  await loadScope(record.id)
  return record
}

/** Record the signed-in account as owner of an unowned active workspace. */
export async function claimActiveWorkspaceOwner(owner) {
  if (!workspaces.active || !owner?.email) return null
  try {
    return await call('workspace.claimOwner', { id: workspaces.active, owner })
  } catch {
    return null
  }
}

/**
 * Read only the workspace list. The sign-in screen needs labels and owners, not
 * the entities, run logs and artifact walk of the workspace it is about to open.
 * `loaded` stays false so the hub still performs its full scope load after login.
 */
export async function loadWorkspaceList() {
  const items = await call('workspace.list')
  workspaces.items = items
  return items
}

/**
 * Read the workspace list and land on the right one: the remembered id if it
 * still exists on disk, otherwise the oldest workspace, otherwise setup.
 */
export async function loadWorkspaces() {
  workspaces.loading = true
  workspaces.error = ''
  try {
    const items = await call('workspace.list')
    workspaces.items = items
    workspaces.loaded = true

    if (!items.length) {
      workspaces.active = ''
      hub.workspace = ''
      hub.workspaceLabel = ''
      resetRuns()
      resetArtifacts()
      applyScope({})
      persist('')
      return items
    }

    let remembered = ''
    try {
      remembered = localStorage.getItem(WORKSPACE_KEY) || ''
    } catch {
      remembered = ''
    }
    const target = items.some((item) => item.id === remembered)
      ? remembered
      : items[0].id
    if (target !== workspaces.active) await openWorkspace(target)
    else await loadScope(target)
    return items
  } catch (error) {
    workspaces.error = error?.message || 'Could not read ~/.entity/workspaces.'
    workspaces.items = []
    workspaces.loaded = true
    return []
  } finally {
    workspaces.loading = false
  }
}

/** The machine-wide harness libraries — discovery, not intent. */
let libraryPending = null
/**
 * Scan every harness library on this machine.
 *
 * Deliberately lazy: the workspace's own skills are the primary view, so a
 * six-directory walk is paid for only when something asks for it — the Library
 * tab, a `/` in the composer, or a library skill page — and the answer is cached
 * for the session. `force` is the "Try again" path after a failed scan.
 */
const skillNamesPending = new Map()

/**
 * Names-only library scan for the composer, per machine.
 *
 * It answers the same references as the full library, but leaves descriptions,
 * byte counts and file trees alone, so typing `/` does not pay for the library
 * page's card data. A machine that is not this one answers with an empty list
 * and a note: its libraries cannot be read from here, and a local path would be
 * a lie about where the harness will look.
 */
export async function loadSkillNames({ machine = 'local', force = false } = {}) {
  const key = String(machine || 'local')
  if (!force && workspaces.skillNamesByMachine[key]) return workspaces.skillNamesByMachine[key]
  if (!force && skillNamesPending.has(key)) return skillNamesPending.get(key)

  const task = (async () => {
    let payload
    try {
      payload =
        (await call('skills.names', { machine: key })) || {
          machine: key,
          items: [],
          count: 0,
        }
    } catch (error) {
      payload = {
        machine: key,
        items: [],
        count: 0,
        error: error?.message || 'The skill libraries could not be read.',
      }
    }
    workspaces.skillNamesByMachine = { ...workspaces.skillNamesByMachine, [key]: payload }
    /* the hub's menu index is this machine's inventory; another machine's empty
       answer must not wipe it */
    if (key === 'local') applyLibrary(payload.items || [])
    return payload
  })()

  skillNamesPending.set(key, task)
  try {
    return await task
  } finally {
    skillNamesPending.delete(key)
  }
}

export async function loadLibrary({ force = false } = {}) {
  /* the rail and the skills page both mount at once; scan the machine once */
  if (libraryPending) return libraryPending
  if (workspaces.library && !force) return workspaces.library
  libraryPending = (async () => {
    try {
      workspaces.library = await call('workspace.library')
      applyLibrary(workspaces.library?.items)
    } catch (error) {
      workspaces.library = { items: [], harnesses: [], count: 0, error: error?.message || '' }
      applyLibrary([])
    } finally {
      libraryPending = null
    }
    return workspaces.library
  })()
  return libraryPending
}

export async function loadSamples() {
  try {
    workspaces.samples = await call('workspace.samples')
    return workspaces.samples
  } catch {
    workspaces.samples = []
    return []
  }
}

export async function loadHosts() {
  try {
    const data = await call('ssh.hosts')
    workspaces.hosts = Array.isArray(data.hosts) ? data.hosts : []
    return workspaces.hosts
  } catch {
    workspaces.hosts = []
    return []
  }
}

/** One atomic call in main: staging directory → rename (§3.6). */
export async function createWorkspace({
  label,
  machines = ['local'],
  skills = [],
  seed = false,
  seedEntities = null,
}) {
  workspaces.creating = true
  workspaces.error = ''
  try {
    const owner = hub.session
      ? {
          name: hub.session.user,
          email: hub.session.email || credentials().email || '',
        }
      : null
    const record = await call('workspace.create', {
      label,
      machines,
      skills,
      seed,
      seedEntities,
      owner,
    })
    workspaces.items = await call('workspace.list')
    await openWorkspace(record.id)
    return record
  } catch (error) {
    workspaces.error = error?.message || 'The workspace could not be created.'
    throw error
  } finally {
    workspaces.creating = false
  }
}

/**
 * Refresh after an attach/detach. Deliberately lighter than `applyScope`: the
 * console threads are not thrown away because a machine or a skill changed.
 */
async function afterScopeWrite() {
  await loadEntities(workspaces.active)
  await loadRuns(workspaces.active)
  hub.machines = workspaces.machines
  hub.skills = workspaces.skills
  hub.runs = Object.values(runs.latest)
}

export async function attachMachine(alias) {
  workspaces.busy = `machine:${alias}`
  try {
    workspaces.machines = await call('workspace.attachMachine', {
      id: workspaces.active,
      alias,
    })
    await afterScopeWrite()
    toast(`${alias} attached`)
  } finally {
    workspaces.busy = ''
  }
}

export async function detachMachine(alias) {
  workspaces.busy = `machine:${alias}`
  try {
    workspaces.machines = await call('workspace.detachMachine', {
      id: workspaces.active,
      alias,
    })
    await afterScopeWrite()
    toast(`${alias} detached`)
  } finally {
    workspaces.busy = ''
  }
}

export async function attachSkill({ name, harness }) {
  workspaces.busy = `skill:${name}`
  try {
    const result = await call('workspace.attachSkill', {
      id: workspaces.active,
      name,
      harness,
    })
    workspaces.skills = await call('workspace.skills', { id: workspaces.active })
    await afterScopeWrite()
    toast(result.copied ? `${name} copied into the workspace` : `${name} attached`)
    return result
  } finally {
    workspaces.busy = ''
  }
}

export async function detachSkill(name) {
  workspaces.busy = `skill:${name}`
  try {
    await call('workspace.detachSkill', { id: workspaces.active, name })
    workspaces.skills = await call('workspace.skills', { id: workspaces.active })
    await afterScopeWrite()
    toast(`${name} detached`)
  } finally {
    workspaces.busy = ''
  }
}

export async function setMcpEnabled(name, enabled, definition = null) {
  workspaces.busy = `mcp:${name}`
  try {
    workspaces.mcp = await call('workspace.setMcpEnabled', {
      id: workspaces.active,
      name,
      enabled,
      definition,
    })
    return workspaces.mcp
  } finally {
    workspaces.busy = ''
  }
}

export async function writeMcp(servers, { disabled } = {}) {
  workspaces.busy = 'mcp'
  try {
    workspaces.mcp = await call('workspace.writeMcp', {
      id: workspaces.active,
      servers,
      ...(disabled ? { disabled } : {}),
    })
    await afterScopeWrite()
    return workspaces.mcp
  } finally {
    workspaces.busy = ''
  }
}

export async function readWorkspaceSkill(name) {
  return call('workspace.skillRead', { id: workspaces.active, name })
}
