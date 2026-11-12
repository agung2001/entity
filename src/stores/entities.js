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
import { applyRunState, hub } from '@/stores/hub'
import { HARNESSES } from '@/data/mock'

export const entities = reactive({
  loading: false,
  loaded: false,
  error: '',
  workspace: '',
  items: [],
})

const harnessLabel = (id) => HARNESSES.find((h) => h.id === id)?.label || id || 'no harness'

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
    status: 'sleep',
    desc: entity.summary || 'No description in the file yet.',
    skills: entity.skills,
    mcp: entity.mcp,
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

export async function scaffoldEntity({ name, harness, model = '' }) {
  const created = await call('entity.scaffold', {
    workspace: hub.workspace,
    name,
    harness,
    model,
  })
  await loadEntities(hub.workspace)
  return created
}

export async function revealEntity(name) {
  return call('entity.reveal', { workspace: hub.workspace, name })
}

/** Re-apply run state after the agent list is replaced. */
export function reapplyRuns(latest = {}) {
  applyRunState(latest)
}
