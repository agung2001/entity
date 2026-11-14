/**
 * Runs belong to a workspace, and their history is a file in it.
 *
 * `<ws>/runs/<runId>.jsonl` is append-only; the status is whatever the last
 * `state`/`exit` line says. The renderer only ever *reads* that file (through
 * the call table) and keeps a live tail for the run it started.
 *
 * Stale-event rule: every event carries its workspace, and an event from a
 * workspace you have switched away from is dropped — the old panel must not
 * paint its output into the new scope.
 */
import { reactive } from 'vue'
import { call, onRunEvent } from '@/composables/localBridge'
import { applyRunState, hub } from '@/stores/hub'
import { loadEntities } from '@/stores/entities'

export const runs = reactive({
  loading: false,
  loaded: false,
  error: '',
  workspace: '',
  /** entity name → most recent run summary */
  latest: {},
  /** every run in this workspace, newest first */
  history: [],
  /** runId → { status, entity, harness, dir, chunks, exitCode, error } */
  live: {},
  starting: false,
  cancelling: '',
})

let unsubscribe = null
let streamed = false
let entityTimer = null
let skillTimer = null

/**
 * A file changed under this workspace: an agent rewrote itself through the CLI,
 * a person edited it in `$EDITOR`, or `git checkout` replaced it. The event says
 * nothing about the run — it is the entity list that is now stale.
 *
 * Debounced because one write is several filesystem events, and coalesced
 * because a reload during the burst would read a half-written file.
 */
function scheduleEntityReload() {
  if (entityTimer) clearTimeout(entityTimer)
  entityTimer = setTimeout(() => {
    entityTimer = null
    loadEntities(hub.workspace)
  }, 200)
}

/**
 * A skill created from a chat turn (or by an agent in `$EDITOR`) lands under
 * `<ws>/skills/`. The slash menu is built from `hub.skills`, so it must be
 * refreshed without reopening the workspace. The debounce coalesces the several
 * filesystem events one directory write produces.
 */
function scheduleSkillReload() {
  if (skillTimer) clearTimeout(skillTimer)
  skillTimer = setTimeout(async () => {
    skillTimer = null
    if (!hub.workspace) return
    try {
      const skills = await call('workspace.skills', { id: hub.workspace })
      hub.skills = skills
      /* The Skills page reads the workspace store. A DOM event keeps the two
         stores in step without making the stores import each other. */
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('entity:skills-changed', { detail: skills }))
      }
    } catch {
      /* a transient read failure is repaired on the next workspace open */
    }
  }, 200)
}

function blankLive(event) {
  return {
    runId: event.runId,
    workspace: event.workspace,
    entity: '',
    harness: '',
    dir: '',
    prompt: '',
    status: 'running',
    chunks: [],
    exitCode: null,
    error: '',
  }
}

function applySummary(event) {
  const entry = runs.live[event.runId]
  if (!entry) return
  const summary = {
    id: event.runId,
    workspace: entry.workspace,
    entity: entry.entity,
    harness: entry.harness,
    dir: entry.dir,
    prompt: entry.prompt,
    status: entry.status,
    startedAt: entry.startedAt || new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: entry.exitCode,
    error: entry.error,
  }
  if (entry.entity) runs.latest = { ...runs.latest, [entry.entity]: summary }
  /* the journal is the same log — keep it in sync without a reload */
  const at = runs.history.findIndex((run) => run.id === event.runId)
  if (at >= 0) runs.history.splice(at, 1, summary)
  else runs.history.unshift(summary)
  applyRunState(runs.latest)
  hub.runs = Object.values(runs.latest).sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
  )
}

function onEvent(event) {
  /* a run from another workspace is not this hub's news */
  if (!event || event.workspace !== hub.workspace) return

  if (event.kind === 'workspace-changed') {
    scheduleEntityReload()
    if ((event.paths || []).some((file) => file.startsWith('skills/'))) {
      scheduleSkillReload()
    }
    return
  }

  if (event.kind === 'state') {
    const entry = runs.live[event.runId] || blankLive(event)
    runs.live[event.runId] = entry
    entry.entity = event.data?.entity || entry.entity
    entry.harness = event.data?.harness || entry.harness
    entry.dir = event.data?.dir || entry.dir
    entry.prompt = event.data?.prompt || entry.prompt
    entry.startedAt = event.data?.startedAt || entry.startedAt
    entry.status = event.data?.status || entry.status
    if (event.data?.error) entry.error = event.data.error
    if (entry.status === 'running' && entry.entity) {
      const agent = hub.agents.find((a) => a.id === entry.entity)
      if (agent) agent.status = 'running'
    }
    return
  }

  if (event.kind === 'stdout' || event.kind === 'stderr') {
    const entry = runs.live[event.runId]
    if (!entry) return
    entry.chunks.push({ kind: event.kind, text: String(event.data ?? '') })
    /* a run can be long; the panel only needs the tail */
    if (entry.chunks.length > 600) entry.chunks.splice(0, entry.chunks.length - 600)
    return
  }

  if (event.kind === 'exit') {
    const entry = runs.live[event.runId]
    if (!entry) return
    entry.exitCode = event.data?.code ?? null
    entry.ms = event.data?.ms ?? null
    entry.status = event.data?.canceled
      ? 'canceled'
      : entry.exitCode === 0
        ? 'ok'
        : 'error'
    if (!entry.chunks.length) entry.chunks.push({ kind: 'sys', text: '(no output)' })
    applySummary(event)
  }
}

/** One subscription per window; safe to call repeatedly. */
export function ensureRunStream() {
  if (streamed) return
  streamed = true
  try {
    unsubscribe = onRunEvent(onEvent)
  } catch {
    streamed = false
  }
}

export async function loadRuns(workspaceId = hub.workspace) {
  if (!workspaceId) {
    runs.latest = {}
    runs.history = []
    runs.live = {}
    runs.loaded = true
    applyRunState({})
    return []
  }
  runs.loading = true
  runs.error = ''
  try {
    const list = await call('run.list', { workspace: workspaceId })
    runs.workspace = workspaceId
    const latest = {}
    for (const run of list) {
      if (!run.entity || latest[run.entity]) continue
      latest[run.entity] = run
    }
    runs.latest = latest
    runs.history = list
    runs.loaded = true
    reconcileLive(workspaceId, list)
    applyRunState(latest)
    return list
  } catch (error) {
    runs.error = error?.message || 'Could not read the run history.'
    runs.latest = {}
    runs.history = []
    runs.loaded = false
    return []
  } finally {
    runs.loading = false
  }
}

/**
 * A run that finished while another workspace was open emitted its `exit` into
 * the void (the stale-event rule). The log is the truth, so on scope load the
 * live entry is brought in line with it instead of leaving a row stuck on
 * "running" forever.
 */
function reconcileLive(workspaceId, list) {
  const byId = new Map(list.map((run) => [run.id, run]))
  for (const [id, entry] of Object.entries(runs.live)) {
    if (entry.workspace !== workspaceId) continue
    const summary = byId.get(id)
    if (!summary) {
      delete runs.live[id]
      continue
    }
    if (entry.status !== 'running' || summary.status === 'running') continue
    entry.status = summary.status
    entry.exitCode = summary.exitCode
    entry.error = summary.error
    if (!entry.chunks.length) {
      entry.chunks.push({
        kind: 'sys',
        text: '(finished while you were in another workspace — see the run log)',
      })
    }
  }
}

export async function startRun({ name, prompt }) {
  if (!hub.workspace) throw new Error('No workspace is open.')
  if (runs.starting) throw new Error('A run is already starting.')
  runs.starting = true
  runs.error = ''
  try {
    const result = await call('run.start', { workspace: hub.workspace, name, prompt })
    const agent = hub.agents.find((a) => a.id === name)
    if (agent) agent.status = 'running'
    runs.live[result.runId] = {
      runId: result.runId,
      workspace: hub.workspace,
      entity: result.entity,
      harness: result.harness,
      dir: result.dir,
      status: 'running',
      startedAt: new Date().toISOString(),
      chunks: [],
      exitCode: null,
      error: '',
    }
    return result
  } finally {
    runs.starting = false
  }
}

export async function cancelRun(runId) {
  runs.cancelling = runId
  try {
    return await call('run.cancel', { runId })
  } finally {
    runs.cancelling = ''
  }
}

/* An entity name is only unique inside a workspace, so the live table is
   filtered by scope as well — otherwise `py-agent` in two workspaces collides. */
export const liveFor = (entityName) =>
  Object.values(runs.live)
    .filter((entry) => entry.workspace === hub.workspace && entry.entity === entityName)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null

export const isRunning = (entityName) => Boolean(liveFor(entityName)?.status === 'running')

export function resetRuns() {
  runs.latest = {}
  runs.history = []
  runs.live = {}
  runs.error = ''
  runs.workspace = ''
}

/* the stream is independent of a scope load, but starting it lazily keeps the
   browser dev server from opening a connection nobody asked for */
if (typeof window !== 'undefined') ensureRunStream()
