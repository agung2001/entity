<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hub, toast } from '@/stores/hub'
import {
  artifacts,
  downloadArtifact,
  loadArtifacts,
  readArtifact,
  removeArtifact,
  revealArtifact,
} from '@/stores/artifacts'

/**
 * One artifact, with its bytes loaded only for this page. The shelf itself is
 * the rail's second tier, so there is no list page between the two.
 */
const route = useRoute()
const router = useRouter()
const preview = ref(null)
const previewData = ref(null)
const loading = ref(false)
const missing = ref(false)
const busy = ref('')
const confirming = ref('')
let token = 0

const id = computed(() => String(route.params.id || ''))
const item = computed(() => artifacts.items.find((entry) => entry.id === id.value) || null)

function when(iso) {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

async function loadPreview() {
  const current = item.value
  if (!current) {
    missing.value = true
    previewData.value = null
    return
  }
  missing.value = false
  loading.value = true
  preview.value = current
  previewData.value = null
  const ask = ++token
  try {
    const data = await readArtifact(current.id)
    if (ask === token) previewData.value = data
  } catch (error) {
    if (ask === token) toast(error?.message || 'The artifact could not be opened.')
  } finally {
    if (ask === token) loading.value = false
  }
}

async function boot() {
  if (!artifacts.loaded || !artifacts.items.some((entry) => entry.id === id.value)) {
    await loadArtifacts()
  }
  if (!item.value) {
    missing.value = true
    return
  }
  await loadPreview()
}

async function download() {
  const current = item.value
  if (!current || busy.value) return
  busy.value = 'download'
  try {
    const data = await downloadArtifact(current.id)
    const href = data?.dataUrl || ''
    if (!href) throw new Error('That artifact has no downloadable content.')
    const link = document.createElement('a')
    link.href = href
    link.download = current.name
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch (error) {
    toast(error?.message || 'The artifact could not be downloaded.')
  } finally {
    busy.value = ''
  }
}

async function reveal() {
  const current = item.value
  if (!current || busy.value) return
  busy.value = 'reveal'
  try {
    await revealArtifact(current.id)
  } catch (error) {
    toast(error?.message || 'The artifact could not be revealed.')
  } finally {
    busy.value = ''
  }
}

async function remove() {
  const current = item.value
  if (!current || busy.value) return
  if (confirming.value !== current.id) {
    confirming.value = current.id
    setTimeout(() => {
      if (confirming.value === current.id) confirming.value = ''
    }, 2600)
    return
  }
  confirming.value = ''
  busy.value = 'remove'
  try {
    await removeArtifact(current.id)
    toast(`${current.name} removed`)
    router.push('/')
  } catch (error) {
    toast(error?.message || 'The artifact could not be removed.')
  } finally {
    busy.value = ''
  }
}

watch(id, boot)

onMounted(boot)
onBeforeUnmount(() => {
  token += 1
})
</script>

<template>
  <div class="view artifact-detail">
    <header v-if="item" class="page-head artifact-detail-head">
      <div>
        <p class="eyebrow">Artifact · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>{{ item.name }}</h1>
        <p class="lede mono">{{ item.id }}</p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" :disabled="Boolean(busy)" @click="download">
          {{ busy === 'download' ? 'Preparing…' : 'Download' }}
        </button>
        <button class="btn" type="button" :disabled="Boolean(busy)" @click="reveal">
          {{ busy === 'reveal' ? 'Revealing…' : 'Reveal' }}
        </button>
        <button
          class="btn ws-danger"
          type="button"
          :class="{ confirming: confirming === item.id }"
          :disabled="Boolean(busy)"
          @click="remove"
        >
          {{ confirming === item.id ? 'Click again to delete' : 'Delete' }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="empty-note"><b>Opening {{ item?.name || 'artifact' }}…</b></div>

    <div v-else-if="missing" class="empty-note">
      <b>That artifact is not in this workspace.</b>
      <span>It may have been removed on disk.</span>
      <button class="btn" type="button" @click="router.push('/')">Back to overview</button>
    </div>

    <template v-else-if="item">
      <div class="artifact-detail-meta">
        <span><em>Type</em>{{ item.mime || item.ext || 'file' }}</span>
        <span><em>Size</em>{{ sizeLabel(item.size) }}</span>
        <span><em>Modified</em>{{ when(item.modifiedAt) }}</span>
      </div>

      <section class="artifact-detail-preview">
        <img
          v-if="previewData?.kind === 'image' && previewData?.dataUrl"
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
          <button class="btn btn-sm" type="button" @click="download">Download</button>
        </div>
      </section>
    </template>
  </div>
</template>
