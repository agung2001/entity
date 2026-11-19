/**
 * Entities are files, and the workspace owns them.
 *
 * `electron/entity-store.cjs` reads `<ws>/entities/*.md`; this store maps that
 * contract onto the shape the views already render (`hub.agents`), including the
 * `problems[]` the file itself cannot fix: a missing `dir`, a skill the workspace
 * does not have, an unknown harness.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { applyRunState, harnessById, hub } from '@/stores/hub'

export const entities = reactive({
  loading: false,
  loaded: false,
  error: '',
  workspace: '',
  items: [],
})

const harnessLabel = (id) => harnessById(id).label

/** entity file → the row shape the hub renders */
export function toAgent(entity) {
  const dir = entity.dir || ''
  return {
    id: entity.name,
    name: entity.name,
    /* `runtime` used to be python/node/bash when the record was invented; the
       harness is the runtime now, and it is a real one */
    runtime: entity.harness || '—',
    harness: entity.harness,
    harnessLabel: harnessLabel(entity.harness),
    model: entity.model || '',
    dir,
    /* the entity's own bookmark order for the `/` menu; never a grant */
    prefer: Array.isArray(entity.prefer) ? entity.prefer : [],
    status: 'sleep',
    desc: entity.summary || 'No description in the file yet.',
    /* the seed's first shape/colour/mood, before the picker writes its own */
    mark: entity.mark || null,
    /* step 1 runs on this machine only; a remote placement is a later step */
    machines: dir && !entity.problems?.some((p) => p.startsWith('dir ')) ? ['local'] : [],
    last: 'never',
    size: '',
    start: '',
    instructions: entity.instructions,
    rules: entity.rules,
    problems: entity.problems || [],
    runError: '',
    ok: entity.ok,
    displayPath: entity.displayPath,
    sourcePath: entity.sourcePath,
    fileName: entity.fileName,
  }
}

export async function loadEntities(workspaceId = hub.workspace) {
  if (!workspaceId) {
    entities.items = []
    entities.loaded = true
    return []
  }
  entities.loading = true
  entities.error = ''
  try {
    const list = await call('entity.list', { workspace: workspaceId })
    entities.workspace = workspaceId
    entities.items = list
    const agents = list.map(toAgent)
    hub.agents = agents
    entities.loaded = true
    return agents
  } catch (error) {
    entities.error = error?.message || 'Could not read the entity files.'
    entities.items = []
    hub.agents = []
    entities.loaded = false
    return []
  } finally {
    entities.loading = false
  }
}

export function findEntity(name) {
  return entities.items.find((item) => item.name === name) || null
}

/** Rewrite the file from the parsed record — the only writer is the store. */
export async function saveEntity(entity) {
  const saved = await call('entity.write', { entity })
  await loadEntities(entity.workspace)
  return saved
}

/**
 * Add or remove one skill in an entity's `prefer:` line.
 *
 * The bookmark lives in the entity file and nowhere else, so both pickers — the
 * entity page naming skills and the skill page naming entities — write through
 * this one function. Order is the file's: a new name appends, so the order the
 * person picked in is the order the `/` menu shows.
 */
export async function togglePreferredSkill(entityName, skillName) {
  const raw = findEntity(entityName)
  if (!raw) throw new Error(`"${entityName}" is no longer in the workspace.`)
  const current = Array.isArray(raw.prefer) ? raw.prefer : []
  const next = current.includes(skillName)
    ? current.filter((name) => name !== skillName)
    : [...current, skillName]
  return saveEntity({ ...raw, prefer: next })
}

export async function scaffoldEntity({ name, harness, model = '', description = '', mark = null }) {
  const created = await call('entity.scaffold', {
    workspace: hub.workspace,
    name,
    harness,
    model,
    description,
    shape: mark?.shape || '',
    color: mark?.color || '',
    mood: mark?.mood || '',
  })
  await loadEntities(hub.workspace)
  return created
}

export async function revealEntity(name) {
  return call('entity.reveal', { workspace: hub.workspace, name })
}

export async function duplicateEntity(name, mark = null) {
  const copy = await call('entity.duplicate', {
    workspace: hub.workspace,
    name,
    shape: mark?.shape || '',
    color: mark?.color || '',
    mood: mark?.mood || '',
  })
  await loadEntities(hub.workspace)
  return copy
}

/** A copy proposed by a pinned run, waiting for this workspace's person. */
export async function pendingCloneRequest(workspace = hub.workspace) {
  return call('clone.pending', { workspace })
}

export async function approveCloneRequest(id) {
  const copy = await call('clone.approve', { workspace: hub.workspace, id })
  if (copy?.workspace === hub.workspace) await loadEntities(hub.workspace)
  return copy
}

export async function dismissCloneRequest(id) {
  return call('clone.dismiss', { workspace: hub.workspace, id })
}

export async function cloneEntity({ from, to, name, nextName = '', mark = null }) {
  const copy = await call('entity.clone', {
    from,
    to,
    name,
    nextName,
    shape: mark?.shape || '',
    color: mark?.color || '',
    mood: mark?.mood || '',
  })
  if (to === hub.workspace) await loadEntities(hub.workspace)
  return copy
}

export async function removeEntity(name) {
  const result = await call('entity.remove', { workspace: hub.workspace, name })
  await loadEntities(hub.workspace)
  return result
}

/** Re-apply run state after the agent list is replaced. */
export function reapplyRuns(latest = {}) {
  applyRunState(latest)
}
