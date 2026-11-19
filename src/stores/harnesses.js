/**
 * Installed harnesses and the models each CLI can report.
 *
 * This store is the renderer's only harness list: ids, labels, install state and
 * models all come from `harness.list` / `harness.models` (electron/harness-store.cjs),
 * so adding a CLI never needs a second edit here. Paths are machine-wide, so they
 * live outside the active workspace.
 */
import { computed, reactive } from 'vue'
import { call } from '@/composables/localBridge'

export const harnesses = reactive({
  loading: false,
  loaded: false,
  error: '',
  items: [],
  models: {},
})

export async function loadHarnesses(force = false) {
  if (harnesses.loading) return harnesses.items
  if (harnesses.loaded && !force) return harnesses.items
  harnesses.loading = true
  harnesses.error = ''
  try {
    harnesses.items = await call('harness.list')
    harnesses.loaded = true
    return harnesses.items
  } catch (error) {
    harnesses.error = error?.message || 'Could not inspect the installed harnesses.'
    harnesses.items = []
    harnesses.loaded = false
    return []
  } finally {
    harnesses.loading = false
  }
}

export async function loadModels(id, force = false) {
  const key = String(id || '')
  if (!key) return null
  const existing = harnesses.models[key]
  if (!force && existing?.loaded) return existing
  if (existing?.loading) return existing
  harnesses.models[key] = {
    ...(existing || {}),
    loading: true,
    loaded: false,
    error: '',
    models: existing?.models || [],
    default: existing?.default || '',
    source: existing?.source || '',
  }
  try {
    const data = await call('harness.models', { id: key })
    harnesses.models[key] = {
      loading: false,
      loaded: true,
      error: '',
      models: data?.models || [],
      default: data?.default || '',
      source: data?.source || '',
      detected: Boolean(data?.detected),
    }
    return harnesses.models[key]
  } catch (error) {
    harnesses.models[key] = {
      loading: false,
      loaded: false,
      error: error?.message || `Could not detect ${key} models.`,
      models: existing?.models || [],
      default: existing?.default || '',
      source: existing?.source || '',
      detected: false,
    }
    return harnesses.models[key]
  }
}

/** Every picker offers only what this machine has turned on. Off is not
    uninstalled: the row and its path stay, the choice does not. */
export const pickableHarnesses = computed(() => harnesses.items.filter((row) => row.enabled))

export async function setHarnessEnabled(id, enabled) {
  const item = await call('harness.setEnabled', { id, enabled })
  await loadHarnesses(true)
  return item
}

export async function setHarnessPath(id, path) {
  const item = await call('harness.setPath', { id, path })
  await loadHarnesses(true)
  delete harnesses.models[id]
  return item
}

/**
 * pi resolves a name across the providers it has authenticated, so a bare
 * `provider/model` can be ambiguous. Ask the main process before saving.
 */
export async function resolvePiModel(model) {
  return call('harness.resolvePiModel', { model: String(model || '') })
}
