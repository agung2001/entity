/**
 * The artifact retention rule for one workspace.
 *
 * The main process owns the arithmetic (bands, forecast, protections) so the
 * card cannot disagree with the pass it is describing: every answer to a save is
 * the whole picture again. This store is only the request lifecycle — loading,
 * saving, the last error, and a token so a slow answer cannot overwrite a newer
 * one. Same shape as `src/stores/retention.js`, on files instead of threads.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

export const artifactRetention = reactive({
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
  artifactRetention.workspace = workspace
  artifactRetention.state = next
}

export async function loadArtifactRetention({ force = false } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  if (
    !force &&
    artifactRetention.state &&
    artifactRetention.workspace === workspace &&
    !artifactRetention.error
  ) {
    return artifactRetention.state
  }
  const ticket = ++token
  artifactRetention.loading = !artifactRetention.state
  artifactRetention.error = ''
  try {
    const next = await call('artifact.retention', { workspace })
    if (ticket === token) apply(workspace, next)
    return next
  } catch (problem) {
    if (ticket === token) {
      artifactRetention.error = problem?.message || 'The rule could not be read.'
    }
    return null
  } finally {
    if (ticket === token) artifactRetention.loading = false
  }
}

/**
 * Save one field. The answer is the recomputed card, so a rule change moves the
 * chart, the effects and the forecast in the same frame the store answers.
 */
export async function setArtifactRetention(patch, { label = '' } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  const ticket = ++token
  artifactRetention.saving = true
  artifactRetention.pending = label
  artifactRetention.error = ''
  try {
    const next = await call('artifact.setRetention', { workspace, patch })
    if (ticket === token) apply(workspace, next)
    return next
  } catch (problem) {
    if (ticket === token) {
      artifactRetention.error = problem?.message || 'That value could not be saved.'
    }
    return null
  } finally {
    if (ticket === token) {
      artifactRetention.saving = false
      artifactRetention.pending = ''
    }
  }
}

/** Run one pass now: the same thresholds, without waiting for the deadline. */
export async function runArtifactRetention({ kind = '' } = {}) {
  const workspace = hub.workspace
  if (!workspace) return null
  const ticket = ++token
  artifactRetention.saving = true
  artifactRetention.pending = 'pass'
  artifactRetention.error = ''
  try {
    const result = await call('artifact.runRetention', { workspace, kind })
    if (ticket === token && result?.state) apply(workspace, result.state)
    return result
  } catch (problem) {
    if (ticket === token) {
      artifactRetention.error = problem?.message || 'The pass did not run.'
    }
    return null
  } finally {
    if (ticket === token) {
      artifactRetention.saving = false
      artifactRetention.pending = ''
    }
  }
}
