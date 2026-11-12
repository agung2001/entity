<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NavIcon from '@/components/NavIcon.vue'
import { matchesQuery } from '@/composables/search'
import { ago, hub, toast } from '@/stores/hub'
import { artifacts, loadArtifacts, uploadArtifact } from '@/stores/artifacts'

/** The shelf lives in the second tier; a row opens the artifact detail page. */
const route = useRoute()
const router = useRouter()
const search = ref('')
const ext = ref('all')
const sort = ref('newest')
const uploading = ref(false)
const fileInput = ref(null)

onMounted(loadArtifacts)

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

function open(item) {
  hub.rail.artifacts = false
  router.push({ name: 'artifact', params: { id: item.id } })
}
</script>

<template>
  <div class="rail-panel rail-artifact-panel">
    <div class="rail-panel-tools">
      <label class="rail-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="search" type="search" placeholder="Search artifacts" aria-label="Search artifacts" autocomplete="off" />
      </label>
      <button
        class="rail-panel-add"
        type="button"
        title="Upload artifact"
        aria-label="Upload artifact"
        :disabled="uploading"
        @click="pickUpload"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M8 10.5V2.6M4.8 5.8L8 2.5l3.2 3.3" />
          <path d="M2.6 10.2v2.4a1 1 0 001 1h8.8a1 1 0 001-1v-2.4" />
        </svg>
      </button>
      <input ref="fileInput" class="hidden-file" type="file" multiple @change="onFiles" />
    </div>

    <div class="rail-select-row">
      <select v-model="ext" aria-label="Filter artifacts by extension">
        <option value="all">All types</option>
        <option v-for="entry in extensions" :key="entry.value" :value="entry.value">
          {{ entry.value }} · {{ entry.count }}
        </option>
      </select>
      <select v-model="sort" aria-label="Sort artifacts">
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="name">Name</option>
        <option value="size">Largest</option>
      </select>
    </div>

    <p v-if="!list.length" class="rail-t2-empty">
      {{ artifacts.items.length ? 'No artifact matches this view.' : 'No artifacts yet. Upload one from the + button.' }}
    </p>
    <button
      v-for="item in list"
      :key="item.id"
      class="rail-t2-row"
      type="button"
      :title="item.name"
      :aria-current="route.name === 'artifact' && route.params.id === item.id ? 'page' : undefined"
      @click="open(item)"
    >
      <span class="rail-t2-ic"><NavIcon name="artifact" /></span>
      <span class="t">
        <b>{{ item.name }}</b>
        <span class="m">{{ item.ext || 'file' }} · {{ sizeLabel(item.size) }}</span>
      </span>
      <span class="c">{{ ago(item.modifiedAt) }}</span>
    </button>
  </div>
</template>
