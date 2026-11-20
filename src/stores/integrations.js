/**
 * Which third-party services the composer may mention, and what each one can
 * report about itself.
 *
 * The read is deliberately two calls, because the two halves cost different
 * things: `integrations.list` is a small preference file and one `stat` per
 * binary, and `integrations.probe` spawns `orca`, spawns `gh` and searches
 * YouTrack through the MCP pool. A page that waited for both painted nothing
 * for four seconds.
 *
 * The probe is also cached here, in the renderer, on top of the main process's
 * own TTL: coming back to Account → Integrations paints the rows and their
 * status line from memory, and only `Refresh` asks the CLIs again. A settings
 * page whose content is "is gh signed in" does not need to re-sign-in on every
 * visit.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

export const integrations = reactive({
  workspace: '',
  loading: false,
  loaded: false,
  /* a probe is in flight — the rows are already drawn, their status is not */
  probing: false,
  probed: false,
  probedAt: 0,
  /* the probe came from cache, so the page can say whose clock it is showing */
  cached: false,
  error: '',
  probeError: '',
  rows: [],
  total: 3,
})

export const enabledIntegrations = () =>
  Object.fromEntries(integrations.rows.map((row) => [row.id, Boolean(row.enabled)]))

function adopt(answer, { probed = false, cached = false } = {}) {
  if (Array.isArray(answer?.rows)) integrations.rows = answer.rows
  if (Number.isFinite(answer?.total)) integrations.total = answer.total
  if (probed) {
    integrations.probed = true
    integrations.probedAt = answer?.at || Date.now()
    integrations.cached = Boolean(cached)
  }
}

/** The switches only. Cheap; always worth one trip. */
export async function loadIntegrations({ workspace } = {}) {
  const id = workspace || integrations.workspace
  if (!id) return []
  integrations.loading = true
  integrations.error = ''
  try {
    const answer = await call('integrations.list', { workspace: id })
    integrations.workspace = id
    adopt(answer)
    integrations.loaded = true
    return integrations.rows
  } catch (problem) {
    integrations.error = problem?.message || 'Could not read the integration switches.'
    integrations.rows = []
    integrations.loaded = false
    return []
  } finally {
    integrations.loading = false
  }
}

/** The status line. Slow by nature; cached in main for minutes. */
export async function probeIntegrations({ workspace, force = false } = {}) {
  const id = workspace || integrations.workspace
  if (!id) return []
  integrations.probing = true
  integrations.probeError = ''
  try {
    const answer = await call('integrations.probe', { workspace: id, force })
    adopt(answer, { probed: true, cached: answer?.cached })
    integrations.loaded = true
    return integrations.rows
  } catch (problem) {
    /* the rows stay: `not probed` is a state, not an empty page */
    integrations.probeError = problem?.message || 'The CLIs could not be asked.'
    return integrations.rows
  } finally {
    integrations.probing = false
  }
}

/**
 * A write replaces the row it touched instead of refetching three probes, and
 * drops the probe cache in main only because the switch changed — the status
 * line it comes back with is the fresh one.
 */
export async function setIntegrationEnabled(id, enabled) {
  const answer = await call('integrations.setEnabled', {
    workspace: integrations.workspace,
    id,
    enabled,
  })
  if (!answer) return null
  integrations.rows = integrations.rows.map((row) => (row.id === answer.id ? answer : row))
  return answer
}

export async function saveIntegrationCredential({ id, token, host }) {
  const answer = await call('integrations.saveCredential', {
    workspace: integrations.workspace,
    id,
    token,
    host,
  })
  if (answer?.row) {
    integrations.rows = integrations.rows.map((row) => (row.id === answer.row.id ? answer.row : row))
  }
  return answer
}

export async function testIntegration(id) {
  return call('integrations.test', { workspace: integrations.workspace, id })
}
