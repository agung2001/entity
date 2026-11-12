<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ArtifactThumb from '@/components/ArtifactThumb.vue'
import { hub, toast } from '@/stores/hub'
import {
  artifacts,
  downloadArtifact,
  loadArtifacts,
  readArtifact,
  removeArtifact,
  revealArtifact,
  uploadArtifact,
} from '@/stores/artifacts'

/**
 * The workspace's artifact shelf. Files here are ordinary files on disk; this
 * page reads metadata from the main process and asks for bytes only when a
 * preview or download actually needs them.
 */
const query = ref('')
const ext = ref('all')
const sort = ref('newest')
const busy = ref('')
const confirming = ref('')
const uploading = ref(false)
const fileInput = ref(null)
const previewOpen = ref(false)
const preview = ref(null)
const previewData = ref(null)
const previewLoading = ref(false)
let previewToken = 0

onMounted(loadArtifacts)

watch(
  () => hub.workspace,
  () => {
    query.value = ''
    ext.value = 'all'
    sort.value = 'newest'
    previewOpen.value = false
    loadArtifacts()
  },
)

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

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const rows = artifacts.items.filter((item) => {
    if (ext.value !== 'all' && (item.ext || 'no extension') !== ext.value) return false
    if (!q) return true
    return `${item.name} ${item.id} ${item.ext} ${item.mime}`.toLowerCase().includes(q)
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

function when(iso) {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  const ms = Date.now() - date.getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

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

async function download(item) {
  if (busy.value) return
  busy.value = `download:${item.id}`
  try {
    const data = await downloadArtifact(item.id)
    const href = data?.dataUrl || ''
    if (!href) throw new Error('That artifact has no downloadable content.')
    const link = document.createElement('a')
    link.href = href
    link.download = item.name
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch (error) {
    toast(error?.message || 'The artifact could not be downloaded.')
  } finally {
    busy.value = ''
  }
}

async function reveal(item) {
  if (busy.value) return
  busy.value = `reveal:${item.id}`
  try {
    await revealArtifact(item.id)
  } catch (error) {
    toast(error?.message || 'The artifact could not be revealed.')
  } finally {
    busy.value = ''
  }
}

async function remove(item) {
  if (busy.value) return
  if (confirming.value !== item.id) {
    confirming.value = item.id
    setTimeout(() => {
      if (confirming.value === item.id) confirming.value = ''
    }, 2600)
    return
  }
  confirming.value = ''
  busy.value = `remove:${item.id}`
  try {
    await removeArtifact(item.id)
    if (preview.value?.id === item.id) closePreview()
    toast(`${item.name} removed`)
  } catch (error) {
    toast(error?.message || 'The artifact could not be removed.')
  } finally {
    busy.value = ''
  }
}

async function openPreview(item) {
  previewOpen.value = true
  preview.value = item
  previewData.value = null
  previewLoading.value = true
  const token = ++previewToken
  try {
    const data = await readArtifact(item.id)
    if (token === previewToken) previewData.value = data
  } catch (error) {
    if (token === previewToken) toast(error?.message || 'The artifact could not be opened.')
  } finally {
    if (token === previewToken) previewLoading.value = false
  }
}

function closePreview() {
  previewToken += 1
  previewOpen.value = false
  preview.value = null
  previewData.value = null
  previewLoading.value = false
}

function onKey(event) {
  if (event.key === 'Escape' && previewOpen.value) closePreview()
}

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Artifacts · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Artifacts</h1>
        <p class="lede">
          Documents, screenshots, and other files that belong to this workspace. The entity
          can save here; you can upload or remove anything by hand.
          <span v-if="artifacts.path" class="mono">{{ artifacts.path }}</span>
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ artifacts.items.length }} {{ artifacts.items.length === 1 ? 'file' : 'files' }}
          <template v-if="ext !== 'all'"> · {{ filtered.length }} shown</template>
        </span>
        <button class="btn" type="button" :disabled="uploading" @click="pickUpload">
          {{ uploading ? 'Uploading…' : 'Upload' }}
        </button>
        <button class="btn" type="button" :disabled="artifacts.loading" @click="loadArtifacts()">
          Refresh
        </button>
        <input
          ref="fileInput"
          class="hidden-file"
          type="file"
          multiple
          @change="onFiles"
        />
      </div>
    </div>

    <div class="artifacts-bar">
      <div class="hsearch artifact-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          v-model="query"
          type="text"
          placeholder="Search artifacts by name, path, or type"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search artifacts"
        />
        <button v-if="query" class="hclear" type="button" aria-label="Clear search" @click="query = ''">
          ×
        </button>
      </div>
      <label class="artifact-sort">
        <span>Sort</span>
        <select v-model="sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name</option>
          <option value="size">Largest first</option>
        </select>
      </label>
    </div>

    <div class="hints artifact-exts" aria-label="Filter by extension">
      <button
        class="hint"
        type="button"
        :aria-pressed="ext === 'all' ? 'true' : 'false'"
        @click="ext = 'all'"
      >
        All <span class="hint-n">{{ artifacts.items.length }}</span>
      </button>
      <button
        v-for="entry in extensions"
        :key="entry.value"
        class="hint"
        type="button"
        :aria-pressed="ext === entry.value ? 'true' : 'false'"
        @click="ext = entry.value"
      >
        {{ entry.value || 'no extension' }} <span class="hint-n">{{ entry.count }}</span>
      </button>
    </div>

    <div v-if="artifacts.loading && !artifacts.loaded" class="empty-note">
      <b>Reading the artifact shelf…</b>
    </div>

    <div v-else-if="artifacts.error" class="empty-note">
      <b>{{ artifacts.error }}</b>
      <button class="btn btn-sm" type="button" @click="loadArtifacts()">Try again</button>
    </div>

    <div v-else-if="!filtered.length" class="empty-note">
      <b>{{ artifacts.items.length ? 'No artifacts match this view.' : 'No artifacts yet.' }}</b>
      <span v-if="artifacts.items.length">Clear the search or pick a different extension.</span>
      <span v-else>
        Upload a file, or ask an entity to save one under the workspace artifact folder.
      </span>
      <div class="empty-actions">
        <button class="btn btn-sm" type="button" :disabled="uploading" @click="pickUpload">
          Upload a file
        </button>
      </div>
    </div>

    <div v-else class="grid3 artifact-grid">
      <article v-for="item in filtered" :key="item.id" class="card2 artifact-card">
        <button class="artifact-open" type="button" :aria-label="`Open ${item.name}`" @click="openPreview(item)">
          <ArtifactThumb :item="item" />
        </button>
        <div class="card-top">
          <h3 :title="item.name">{{ item.name }}</h3>
          <span class="tag">{{ item.ext || 'file' }}</span>
        </div>
        <p class="p mono" :title="item.id">{{ item.id }}</p>
        <div class="foot">
          <span>{{ sizeLabel(item.size) }}</span>
          <span>{{ when(item.modifiedAt) }}</span>
        </div>
        <div class="card-actions artifact-actions">
          <button class="btn btn-sm" type="button" @click="openPreview(item)">Open</button>
          <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="download(item)">
            {{ busy === `download:${item.id}` ? '…' : 'Download' }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="reveal(item)">
            {{ busy === `reveal:${item.id}` ? '…' : 'Reveal' }}
          </button>
          <button
            class="btn btn-sm ws-danger"
            type="button"
            :class="{ confirming: confirming === item.id }"
            :disabled="Boolean(busy)"
            @click="remove(item)"
          >
            {{ confirming === item.id ? 'Delete?' : 'Delete' }}
          </button>
        </div>
      </article>
    </div>

    <div class="scrim" :data-open="previewOpen ? '1' : '0'" @click="closePreview"></div>
    <div
      class="modal modal-artifact"
      :data-open="previewOpen ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      :aria-label="preview ? `Preview ${preview.name}` : 'Artifact preview'"
    >
      <div class="mo-head">
        <h2>{{ preview?.name || 'Artifact' }}</h2>
        <p class="mono">{{ preview?.id || '' }}</p>
        <button class="x mo-x" aria-label="Close preview" @click="closePreview">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div class="mo-body artifact-preview-body">
        <div v-if="previewLoading" class="empty-note"><b>Opening…</b></div>
        <img
          v-else-if="previewData?.kind === 'image' && previewData?.dataUrl"
          class="artifact-image"
          :src="previewData.dataUrl"
          :alt="previewData.name"
        />
        <template v-else-if="previewData?.kind === 'text'">
          <pre class="artifact-text">{{ previewData.text }}</pre>
          <p v-if="previewData.truncated" class="mnote">
            Preview is truncated. Download for the full file.
          </p>
        </template>
        <iframe
          v-else-if="previewData?.kind === 'pdf' && previewData?.dataUrl"
          class="artifact-pdf"
          :src="previewData.dataUrl"
          :title="previewData.name"
        ></iframe>
        <div v-else class="empty-note">
          <b>No inline preview for this file.</b>
          <span>Download it to open with the application this machine already uses.</span>
          <button v-if="preview" class="btn btn-sm" type="button" @click="download(preview)">
            Download
          </button>
        </div>
      </div>
      <div class="mo-foot">
        <button v-if="preview" class="btn btn-sm" type="button" @click="download(preview)">Download</button>
        <button class="btn btn-sm" type="button" @click="closePreview">Close</button>
      </div>
    </div>
  </div>
</template>
