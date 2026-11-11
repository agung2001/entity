/**
 * The skill library as it exists on this machine.
 *
 * Every harness keeps its own directory (`~/.claude/skills`, `~/.pi/agent/skills`,
 * …). The same skill can appear in several of them, so an item is identified by
 * harness + name. The Skills view filters on that harness axis.
 */
import { computed, reactive } from 'vue'
import { readSkillEntry, scanSkillLibraries } from '@/composables/localBridge'

export const library = reactive({
  loading: false,
  loaded: false,
  error: '',
  scannedAt: null,
  hostname: '',
  platform: '',
  harnesses: [],
  items: [],
  count: 0,
})

let pending = null

export async function loadLibrary() {
  if (pending) return pending
  library.loading = true
  pending = (async () => {
    try {
      const data = await scanSkillLibraries()
      library.hostname = data.hostname || ''
      library.platform = data.platform || ''
      library.scannedAt = data.scannedAt || null
      library.harnesses = Array.isArray(data.harnesses) ? data.harnesses : []
      library.items = Array.isArray(data.items) ? data.items : []
      library.count = library.items.length
      library.error = ''
      library.loaded = true
    } catch (error) {
      library.error = error?.message || 'Could not read the local skill libraries.'
      library.harnesses = []
      library.items = []
      library.count = 0
      library.loaded = false
    } finally {
      library.loading = false
      pending = null
    }
  })()
  return pending
}

/** Harnesses worth showing as a filter — the ones that actually hold a skill. */
export const harnessFilters = computed(() =>
  library.harnesses.filter((harness) => harness.count > 0),
)

export const skillEntry = (harness, name) => readSkillEntry(harness, name)
