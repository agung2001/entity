/**
 * The chat retention rule for one workspace.
 *
 * The main process owns the arithmetic (bands, forecast, protections) so the
 * card cannot disagree with the pass it is describing: every answer to a save is
 * the whole picture again. This store is only the request lifecycle — loading,
 * saving, the last error, and a token so a slow answer cannot overwrite a newer
 * one.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

export const retention = reactive({
  workspace: '',
  state: null,
  loading: false,
  saving: false,
  error: '',
  /* the value being saved, so the card can say "Saving… 30 days" */
  pending: '',
})

let token = 0

function apply(workspace, next) {
  retention.workspace = workspace
  retention.state = next
}

export async function loadRetention({ force = false } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  if (!force && retention.state && retention.workspace === workspace && !retention.error) {
    return retention.state
  }
  const ticket = ++token
  retention.loading = !retention.state
  retention.error = ''
  try {
    const next = await call('chat.retention', { workspace })
    if (ticket === token) apply(workspace, next)
    return next
  } catch (problem) {
    if (ticket === token) retention.error = problem?.message || 'The rule could not be read.'
    return null
  } finally {
    if (ticket === token) retention.loading = false
  }
}

/**
 * Save one field. The answer is the recomputed card, so a rule change moves the
 * chart, the effects and the forecast in the same frame the store answers.
 */
export async function setRetention(patch, { label = '' } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  const ticket = ++token
  retention.saving = true
  retention.pending = label
  retention.error = ''
  try {
    const next = await call('chat.setRetention', { workspace, patch })
    if (ticket === token) apply(workspace, next)
    return next
  } catch (problem) {
    if (ticket === token) retention.error = problem?.message || 'That value could not be saved.'
    return null
  } finally {
    if (ticket === token) {
      retention.saving = false
      retention.pending = ''
    }
  }
}

/** Run one pass now: the same thresholds, without waiting for the deadline. */
export async function runRetention({ kind = '' } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  const ticket = ++token
  retention.saving = true
  retention.pending = 'pass'
  retention.error = ''
  try {
    const result = await call('chat.runRetention', { workspace, kind })
    if (ticket === token && result?.state) apply(workspace, result.state)
    return result
  } catch (problem) {
    if (ticket === token) retention.error = problem?.message || 'The pass did not run.'
    return null
  } finally {
    if (ticket === token) {
      retention.saving = false
      retention.pending = ''
    }
  }
}
