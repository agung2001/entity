/**
 * Dashboards: the cache the two surfaces read.
 *
 * A dashboard is a file, so opening one is a `read`, not a run — the page paints
 * from disk and never spends money for looking. Two reads, because they cost
 * different things: `dashboard.list` is a directory walk and answers in a
 * millisecond (the band on Overview needs to know whether *any* snapshot
 * exists before it decides to render at all), and `dashboard.read` returns the
 * document itself, parsed here into the shape both surfaces draw.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { parseDashboard } from '@/lib/dashboard'
import { hub } from '@/stores/hub'

export const dashboards = reactive({
  workspace: '',
  loading: false,
  loaded: false,
  error: '',
  items: [],
})

/* The parsed document per `<workspace>:<id>`, so switching between the band and
   the page does not re-read and re-parse the same file. A write drops the entry
   it touched. */
const docs = new Map()
const docKey = (workspace, id) => `${workspace}:${id}`

export function resetDashboards() {
  dashboards.workspace = ''
  dashboards.loading = false
  dashboards.loaded = false
  dashboards.error = ''
  dashboards.items = []
  docs.clear()
}

/** The workspace's dashboards, cheapest read first. */
export async function loadDashboards(workspace = hub.workspace) {
  if (!workspace) {
    resetDashboards()
    return []
  }
  if (dashboards.workspace !== workspace) {
    dashboards.items = []
    docs.clear()
  }
  dashboards.loading = true
  dashboards.error = ''
  try {
    const answer = await call('dashboard.list', { workspace })
    dashboards.workspace = workspace
    dashboards.items = answer?.items || []
    dashboards.loaded = true
    return dashboards.items
  } catch (error) {
    /* A build without the dashboard calls yet, or a shelf that cannot be read:
       both are "no dashboards here", and neither may break the page around it. */
    dashboards.workspace = workspace
    dashboards.items = []
    dashboards.loaded = true
    dashboards.error = error?.message || ''
    return []
  } finally {
    dashboards.loading = false
  }
}

/**
 * One dashboard, parsed. `readDashboard` hands back the wrapper the call table
 * answers (`{ id, item, doc }`), and everything below the parse is the module
 * in `src/lib/dashboard.js` — the page never re-derives what a snapshot means.
 */
export async function readDashboard(id, { workspace = hub.workspace, now = new Date() } = {}) {
  const key = docKey(workspace, id)
  const hit = docs.get(key)
  if (hit) return parseDashboard(hit, { now })
  const answer = await call('dashboard.read', { workspace, id })
  const doc = answer?.doc ?? answer
  /* Keep the raw document, not the parsed object: `state` depends on the clock,
     and a cached "fresh" that is an hour old is a lie. */
  if (docs.size >= 12) docs.delete(docs.keys().next().value)
  docs.set(key, doc)
  return parseDashboard(doc, { now })
}

/** The whole item list entry for an id, so a page can name its file. */
export function dashboardItem(id, workspace = hub.workspace) {
  return dashboards.items.find((item) => item.id === id && (!workspace || item.workspace === workspace)) || null
}

/** The dashboard the band shows: the first one a producer has actually run. */
export function primaryDashboard(workspace = hub.workspace) {
  const items = dashboards.items.filter((item) => item.workspace === workspace || !item.workspace)
  return items.find((item) => item.hasSnapshot) || items[0] || null
}

export async function writeDashboard(id, doc, { workspace = hub.workspace } = {}) {
  const answer = await call('dashboard.write', { workspace, id, doc })
  docs.delete(docKey(workspace, id))
  await loadDashboards(workspace)
  return answer
}

/**
 * One pass, now. The only call on any surface that spends money, and the only
 * one that leaves the renderer: the main process refuses when this machine is
 * not the workspace's executor, and that refusal is the sentence the page shows.
 */
export async function refreshDashboard(id, { workspace = hub.workspace } = {}) {
  const answer = await call('dashboard.refresh', { workspace, id })
  docs.delete(docKey(workspace, id))
  await loadDashboards(workspace)
  return answer
}

export async function saveSchedule(id, schedule, { workspace = hub.workspace } = {}) {
  const answer = await call('dashboard.schedule', { workspace, id, schedule })
  docs.delete(docKey(workspace, id))
  return answer
}
