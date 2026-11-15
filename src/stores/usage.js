/**
 * Spend and activity for the open workspace, folded by the main process.
 *
 * One read serves the overview, an entity page and the chat timeline. The
 * result is per calendar year, so switching year would be a different request;
 * the hub only ever shows the current one today.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

export const usage = reactive({
  workspace: '',
  year: new Date().getFullYear(),
  loading: false,
  loaded: false,
  error: '',
  at: 0,
  data: null,
})

/* A turn finishes and the overview comes back into view; half a minute of
   staleness is fine, a stale number after new work is not. */
const TTL_MS = 30_000

export async function loadUsage({
  workspace = hub.workspace,
  year = new Date().getFullYear(),
  force = false,
} = {}) {
  if (!workspace) return null
  if (
    !force &&
    usage.loaded &&
    usage.workspace === workspace &&
    usage.year === year &&
    Date.now() - usage.at < TTL_MS
  ) {
    return usage.data
  }
  usage.loading = true
  usage.error = ''
  try {
    const data = await call('usage.summary', { workspace, year })
    usage.data = data
    usage.workspace = workspace
    usage.year = year
    usage.loaded = true
    usage.at = Date.now()
    return data
  } catch (error) {
    usage.error = error?.message || 'Could not read usage for this workspace.'
    usage.loaded = false
    return null
  } finally {
    usage.loading = false
  }
}

/** Days for one entity, or every entity when no name is given. */
export function daysFor(entity = '') {
  const data = usage.data
  if (!data) return {}
  if (!entity) return data.days || {}
  return data.entities?.[entity]?.days || {}
}
