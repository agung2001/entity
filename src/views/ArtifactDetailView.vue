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

/* A media artifact gets a stage, not a thumbnail in a box: the bytes are often
   a screenshot or a screen recording, and reading them is the whole point.
   Documents keep the plain preview below. */
const stage = ref(null)
const zoom = ref(1)
const pan = ref({ x: 0, y: 0 })
const dragging = ref(false)
let dragFrom = null

const mediaKind = computed(() => {
  const kind = previewData.value?.kind
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : ''
})

function clampZoom(value) {
  return Math.min(8, Math.max(0.25, value))
}

function resetView() {
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
  dragging.value = false
}

function zoomBy(factor, clientX = null, clientY = null) {
  if (mediaKind.value !== 'image') return
  const next = clampZoom(zoom.value * factor)
  if (next === zoom.value) return
  const rect = stage.value?.getBoundingClientRect()
  if (rect && clientX != null) {
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    pan.value = {
      x: cx - (cx - pan.value.x) * (next / zoom.value),
      y: cy - (cy - pan.value.y) * (next / zoom.value),
    }
  }
  if (next <= 1) pan.value = { x: 0, y: 0 }
  zoom.value = next
}

function onWheel(event) {
  if (mediaKind.value !== 'image') return
  event.preventDefault()
  zoomBy(event.deltaY < 0 ? 1.15 : 0.87, event.clientX, event.clientY)
}

function startDrag(event) {
  if (mediaKind.value !== 'image' || zoom.value <= 1 || event.button !== 0) return
  dragging.value = true
  dragFrom = { x: event.clientX - pan.value.x, y: event.clientY - pan.value.y }
  stage.value?.setPointerCapture?.(event.pointerId)
}

function drag(event) {
  if (!dragging.value || !dragFrom) return
  pan.value = { x: event.clientX - dragFrom.x, y: event.clientY - dragFrom.y }
}

function endDrag(event) {
  if (!dragging.value) return
  dragging.value = false
  dragFrom = null
  stage.value?.releasePointerCapture?.(event.pointerId)
}

function onMediaKey(event) {
  if (!mediaKind.value || event.metaKey || event.ctrlKey || event.altKey) return
  const tag = String(event.target?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return
  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomBy(1.2)
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    zoomBy(0.8)
  } else if (event.key === '0') {
    event.preventDefault()
    resetView()
  }
}

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
  resetView()
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
    router.push({ name: 'overview', params: { workspace: route.params.workspace } })
  } catch (error) {
    toast(error?.message || 'The artifact could not be removed.')
  } finally {
    busy.value = ''
  }
}

watch(id, boot)

onMounted(() => {
  boot()
  window.addEventListener('keydown', onMediaKey)
})
onBeforeUnmount(() => {
  token += 1
  window.removeEventListener('keydown', onMediaKey)
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
      <button class="btn" type="button" @click="router.push({ name: 'overview', params: { workspace: route.params.workspace } })">Back to overview</button>
    </div>

    <template v-else-if="item">
      <div class="artifact-detail-meta">
        <span><em>Type</em>{{ item.mime || item.ext || 'file' }}</span>
        <span><em>Size</em>{{ sizeLabel(item.size) }}</span>
        <span><em>Modified</em>{{ when(item.modifiedAt) }}</span>
      </div>

      <section
        v-if="mediaKind === 'image' && previewData?.dataUrl"
        ref="stage"
        class="media-stage"
        :data-drag="dragging ? '1' : '0'"
        :data-zoomed="zoom > 1 ? '1' : '0'"
        @wheel="onWheel"
        @pointerdown="startDrag"
        @pointermove="drag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @dblclick="zoom > 1 ? resetView() : zoomBy(2, $event.clientX, $event.clientY)"
      >
        <div class="media-tools" @pointerdown.stop @dblclick.stop>
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" @click="zoomBy(0.85)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 8h9" /></svg>
          </button>
          <button type="button" class="media-zoom" title="Fit to the window" @click="resetView">
            {{ Math.round(zoom * 100) }}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" @click="zoomBy(1.15)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 8h9M8 3.5v9" /></svg>
          </button>
          <span class="media-sep" aria-hidden="true"></span>
          <button type="button" class="media-fit" @click="resetView">Fit</button>
        </div>
        <img
          class="media-img"
          :src="previewData.dataUrl"
          :alt="previewData.name"
          draggable="false"
          :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"
        />
      </section>

      <section v-else-if="mediaKind === 'video' && previewData?.dataUrl" class="media-stage media-stage--video">
        <video :src="previewData.dataUrl" controls playsinline preload="metadata"></video>
      </section>

      <section v-else-if="mediaKind === 'audio' && previewData?.dataUrl" class="media-stage media-stage--audio">
        <div class="media-sound">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
          </svg>
          <div>
            <b>{{ previewData.name }}</b>
            <audio :src="previewData.dataUrl" controls preload="metadata"></audio>
          </div>
        </div>
      </section>

      <section v-else class="artifact-detail-preview">
        <template v-if="previewData?.kind === 'text'">
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
