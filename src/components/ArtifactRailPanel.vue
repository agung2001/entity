<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArtifactIcon from '@/components/ArtifactIcon.vue'
import { matchesQuery } from '@/composables/search'
import { shortcutLabel } from '@/lib/shortcuts'
import { ago, hub, toast } from '@/stores/hub'
import { artifacts, loadArtifacts, ownsArtifact, uploadArtifact } from '@/stores/artifacts'

/** The shelf lives in the second tier; a row opens the artifact detail page. */
const route = useRoute()
const router = useRouter()
const search = ref('')
const searchKey = shortcutLabel('inventory-search')
const ext = ref('all')
const sort = ref('newest')
const uploading = ref(false)
const filtersOpen = ref(false)
const fileInput = ref(null)

onMounted(() => {
  if (!artifacts.loaded || artifacts.workspace !== hub.workspace) loadArtifacts()
})

const extensions = computed(() => {
  const counts = new Map()
  for (const item of artifacts.items) {
    const key = item.ext || 'no extension'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }))
})

watch(extensions, (list) => {
  if (ext.value !== 'all' && !list.some((entry) => entry.value === ext.value)) ext.value = 'all'
})

const list = computed(() => {
  const rows = artifacts.items.filter((item) => {
    if ((item.scope === 'shared') !== (artifacts.scope === 'shared')) return false
    if (ext.value !== 'all' && (item.ext || 'no extension') !== ext.value) return false
    return matchesQuery(`${item.name} ${item.id} ${item.ext} ${item.mime}`, search.value)
  })
  const sorted = [...rows]
  if (sort.value === 'oldest') {
    sorted.sort((a, b) => String(a.modifiedAt).localeCompare(String(b.modifiedAt)))
  } else if (sort.value === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name))
  } else if (sort.value === 'size') {
    sorted.sort((a, b) => b.size - a.size)
  } else {
    sorted.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
  }
  return sorted
})

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

/* The counts are the store's, so a scope never reads a number the shelf cannot
   show; both are present even at zero, because a missing count reads as unknown. */
const counts = computed(() => artifacts.counts || { personal: 0, shared: 0 })
const workspaceLabel = computed(() => hub.workspaceLabel || hub.workspace || 'this workspace')
const groupHead = computed(() =>
  artifacts.scope === 'shared' ? `Shared · ${workspaceLabel.value}` : 'Personal · only you',
)
const failed = computed(() => Boolean(artifacts.error) && !artifacts.loading)
/* Two different empties: a query that missed is a filter to clear, an empty
   scope is a cause and a next step. They never share a sentence. */
const filtered = computed(() => Boolean(search.value) || filtersActive.value)
const emptyCopy = computed(() =>
  artifacts.scope === 'shared'
    ? `Nothing shared yet. A file lands on your own shelf first, and appears here for everyone in ${workspaceLabel.value} only when you share it.`
    : 'Nothing on your shelf yet. Anything you upload, or an agent saves for you, lands here — and stays here until you share it.',
)

/* The one sentence a person needs when the shelf is still private-first: without
   it, `Shared 0` on a workspace that has been used for weeks reads as a bug,
   when it is the rule working. */
const scopeNote = computed(() =>
  artifacts.scope === 'shared' && !counts.value.shared
    ? 'Personal first, shared on purpose: nothing leaves this machine until you share it.'
    : '',
)

/* Clear the query and the advanced filters, never the scope: which shelf you
   are on is not part of what a search narrowed. */
function clearFilters() {
  search.value = ''
  ext.value = 'all'
  sort.value = 'newest'
}

const ownerLabel = (item) => (ownsArtifact(item) ? 'you' : item.owner?.name || 'someone')

function pickUpload() {
  if (uploading.value) return
  fileInput.value?.click()
}

async function onFiles(event) {
  const files = [...(event.target?.files || [])]
  event.target.value = ''
  if (!files.length || uploading.value) return
  uploading.value = true
  let saved = 0
  try {
    for (const file of files) {
      try {
        await uploadArtifact(file)
        saved += 1
      } catch (error) {
        toast(`${file.name}: ${error?.message || 'upload failed'}`)
      }
    }
    if (saved) toast(`${saved} artifact${saved === 1 ? '' : 's'} uploaded`)
  } finally {
    uploading.value = false
  }
}

/* One route, two surfaces: a `.dashboard` file opens the dashboard page, which
   `ArtifactDetailView` branches to on the artifact's kind. The shelf only has to
   send the id. */
function open(item) {
  hub.rail.artifacts = false
  router.push({ name: 'artifact', params: { workspace: hub.workspace, id: item.id } })
}

const isDashboard = (item) => item?.kind === 'dashboard'
const kindLabel = (item) => (isDashboard(item) ? 'dashboard' : item.ext || 'file')

const filtersActive = computed(() => ext.value !== 'all' || sort.value !== 'newest')

defineExpose({ pickUpload })
</script>

<template>
  <div class="rail-panel rail-artifact-panel">
    <div class="rail-panel-tools rail-search-row">
      <label class="rail-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="search" type="search" placeholder="Search artifacts" aria-label="Search artifacts" autocomplete="off" />
        <kbd v-if="!search" class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
      </label>
      <button
        class="rail-filter-btn"
        type="button"
        :data-active="filtersActive ? '1' : '0'"
        :aria-expanded="filtersOpen ? 'true' : 'false'"
        aria-controls="rail-artifact-filters"
        title="Advanced filters"
        aria-label="Advanced filters"
        @click="filtersOpen = !filtersOpen"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
        <i v-if="filtersActive" aria-hidden="true"></i>
      </button>
      <input ref="fileInput" class="hidden-file" type="file" multiple @change="onFiles" />
    </div>

    <div v-if="filtersOpen" id="rail-artifact-filters" class="rail-advanced">
      <div class="rail-filter">
        <label class="rail-filter-label" for="rail-artifact-type">Type</label>
        <select id="rail-artifact-type" v-model="ext" class="rail-adv-select" aria-label="Filter artifacts by extension">
          <option value="all">All types</option>
          <option v-for="entry in extensions" :key="entry.value" :value="entry.value">
            {{ entry.value }} · {{ entry.count }}
          </option>
        </select>
      </div>
      <div class="rail-filter">
        <label class="rail-filter-label" for="rail-artifact-sort">Sort</label>
        <select id="rail-artifact-sort" v-model="sort" class="rail-adv-select" aria-label="Sort artifacts">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name</option>
          <option value="size">Largest</option>
        </select>
      </div>
    </div>

    <div class="rail-scope" role="group" aria-label="Artifact scope">
      <button
        type="button"
        :aria-pressed="artifacts.scope === 'personal'"
        @click="artifacts.scope = 'personal'"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="6" cy="5.6" r="2.6" />
          <path d="M2.2 13.4a3.8 3.8 0 017.6 0" />
        </svg>
        Personal <b>{{ counts.personal }}</b>
      </button>
      <button
        type="button"
        :aria-pressed="artifacts.scope === 'shared'"
        @click="artifacts.scope = 'shared'"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="6" cy="5.6" r="2.6" />
          <path d="M2.2 13.4a3.8 3.8 0 017.6 0" />
          <path d="M10.4 3.4a2.4 2.4 0 010 4.5M11.6 13.4a3.6 3.6 0 00-1.2-2.6 3.4 3.4 0 013.4 2.6" />
        </svg>
        Shared <b>{{ counts.shared }}</b>
      </button>
    </div>

    <!-- A failed read replaces the list, never the toolbar: the search and the
         scope still work, they just have nothing to filter. -->
    <div v-if="failed" class="rail-t2-alert">
      <p>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3.6M8 11h.01" />
        </svg>
        <span>{{ artifacts.error }}</span>
      </p>
      <button class="btn" type="button" :disabled="artifacts.loading" @click="loadArtifacts()">
        Try again
      </button>
    </div>

    <div v-else-if="artifacts.loading && !artifacts.items.length" class="rail-t2-group">
      <div class="rail-t2-group-head">{{ groupHead }}</div>
      <div v-for="n in 3" :key="n" class="rail-skel" aria-hidden="true">
        <i class="sq"></i>
        <span class="col"><i class="l1"></i><i class="l2"></i></span>
      </div>
    </div>

    <div v-else-if="list.length" class="rail-t2-group">
      <div class="rail-t2-group-head">{{ groupHead }}</div>
      <button
        v-for="item in list"
        :key="item.id"
        class="rail-t2-row"
        type="button"
        :title="item.name"
        :aria-current="route.name === 'artifact' && route.params.id === item.id ? 'page' : undefined"
        @click="open(item)"
      >
        <span class="rail-t2-ic">
          <ArtifactIcon :kind="item.kind" :ext="item.ext" />
        </span>
        <span class="t">
          <b>{{ item.name }}</b>
          <span class="m">
            <span v-if="isDashboard(item)" class="dash-kind">{{ kindLabel(item) }}</span>
            <span v-if="isDashboard(item)" aria-hidden="true">·</span>
            <template v-if="item.scope === 'shared'">
              <span class="own" :data-mine="ownsArtifact(item) ? '1' : '0'">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="6" cy="5.6" r="2.6" />
                  <path d="M2.2 13.4a3.8 3.8 0 017.6 0" />
                </svg>
                {{ ownerLabel(item) }}
              </span>
              <span aria-hidden="true">·</span>
            </template>
            {{ item.ext || 'file' }} · {{ sizeLabel(item.size) }}
          </span>
        </span>
        <span class="c">{{ ago(item.modifiedAt) }}</span>
      </button>
    </div>

    <div v-else-if="filtered" class="rail-t2-empty rail-t2-empty--filtered">
      <p>No artifact matches this view.</p>
      <button class="btn" type="button" @click="clearFilters">Clear filters</button>
    </div>

    <p v-else class="rail-t2-empty">{{ emptyCopy }}</p>

    <p v-if="scopeNote && !failed && !artifacts.loading" class="rail-t2-note">{{ scopeNote }}</p>
  </div>
</template>
