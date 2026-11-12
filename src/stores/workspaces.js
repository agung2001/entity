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
import { applyLibrary, applyScope, hub, toast } from '@/stores/hub'
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
  mcp: { schema: 1, servers: {}, names: [], strict: true, path: '' },
  /** the machine-wide skill libraries, for the "attach" lists */
  library: null,
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
  const [machines, skills, mcp] = await Promise.all([
    call('workspace.machines', { id }).catch(() => []),
    call('workspace.skills', { id }).catch(() => []),
    call('workspace.mcp', { id }).catch(() => ({ schema: 1, servers: {}, names: [], strict: true })),
  ])

  workspaces.machines = machines
  workspaces.skills = skills
  workspaces.mcp = mcp

  await loadEntities(id)
  await loadRuns(id)
  await loadArtifacts(id)

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
  const record = await call('workspace.open', { id })
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
    const record = await call('workspace.create', { label, machines, skills, seed, seedEntities })
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

export async function writeMcp(servers) {
  workspaces.busy = 'mcp'
  try {
    workspaces.mcp = await call('workspace.writeMcp', { id: workspaces.active, servers })
    await afterScopeWrite()
    return workspaces.mcp
  } finally {
    workspaces.busy = ''
  }
}

export async function readWorkspaceSkill(name) {
  return call('workspace.skillRead', { id: workspaces.active, name })
}
