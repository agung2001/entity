<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { downloadArtifact, readArtifact } from '@/stores/artifacts'
import { toast } from '@/stores/hub'

/**
 * Files a harness produced during one chat turn. The chat is a reading surface,
 * so a screenshot should arrive here — not as a bare path the person has to
 * translate into an /artifacts visit. Bytes are read through the same artifact
 * RPC the shelf uses; the renderer never sees a local path.
 */
const props = defineProps({
  items: { type: Array, default: () => [] },
})

const state = reactive({})
const root = ref(null)
const zoom = ref(null)
const busy = ref('')
let observer = null

const extFor = (item) =>
  String(item.ext || item.name?.split('.').pop() || 'file')
    .replace('.', '')
    .slice(0, 4)
    .toUpperCase()

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function itemById(id) {
  return props.items.find((item) => item.id === id) || null
}

async function load(item) {
  if (!item || item.kind !== 'image' || state[item.id]) return
  state[item.id] = { loading: true, dataUrl: '', error: '' }
  try {
    const data = await readArtifact(item.id)
    state[item.id] = {
      loading: false,
      dataUrl: data?.dataUrl || '',
      error: data?.dataUrl ? '' : 'That file has no preview.',
    }
  } catch (error) {
    state[item.id] = {
      loading: false,
      dataUrl: '',
      error: error?.message || 'The artifact could not be opened.',
    }
  }
}

function observe() {
  observer?.disconnect()
  observer = null
  if (!root.value) return
  const targets = [...root.value.querySelectorAll('[data-artifact-load]')]
  if (typeof IntersectionObserver === 'undefined') {
    for (const target of targets) load(itemById(target.dataset.artifactLoad))
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer?.unobserve(entry.target)
        load(itemById(entry.target.dataset.artifactLoad))
      }
    },
    { rootMargin: '280px' },
  )
  for (const target of targets) observer.observe(target)
}

function openZoom(item) {
  zoom.value = item
  load(item)
}

function closeZoom() {
  zoom.value = null
}

function onKey(event) {
  if (event.key === 'Escape' && zoom.value) closeZoom()
}

async function download(item) {
  if (busy.value) return
  busy.value = item.id
  try {
    const data = await downloadArtifact(item.id)
    if (!data?.dataUrl) throw new Error('That artifact has nothing to download.')
    const link = document.createElement('a')
    link.href = data.dataUrl
    link.download = data.name || item.name || 'artifact'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch (error) {
    toast(error?.message || 'The artifact could not be downloaded.')
  } finally {
    busy.value = ''
  }
}

onMounted(async () => {
  await nextTick()
  observe()
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  document.removeEventListener('keydown', onKey)
})

watch(
  () => props.items.map((item) => item.id).join('|'),
  async () => {
    await nextTick()
    observe()
  },
)
</script>

<template>
  <div v-if="items.length" ref="root" class="msg-artifacts" aria-label="Artifacts from this turn">
    <figure v-for="item in items" :key="item.id" class="msg-attach" :data-kind="item.kind">
      <template v-if="item.kind === 'image'">
        <button
          class="msg-attach-img"
          type="button"
          :data-artifact-load="item.id"
          :aria-label="`Open ${item.name}`"
          @click="openZoom(item)"
        >
          <img
            v-if="state[item.id]?.dataUrl"
            :src="state[item.id].dataUrl"
            :alt="item.name"
            loading="lazy"
          />
          <span v-else class="msg-attach-ph" :data-error="state[item.id]?.error ? '1' : '0'">
            {{ state[item.id]?.error || 'Opening screenshot…' }}
          </span>
        </button>
        <figcaption>
          <span class="msg-attach-name" :title="item.id">{{ item.name }}</span>
          <span class="msg-attach-meta">{{ sizeLabel(item.size) || 'image' }}</span>
          <button
            class="msg-attach-dl"
            type="button"
            :disabled="busy === item.id"
            @click="download(item)"
          >
            Download
          </button>
        </figcaption>
      </template>
      <div v-else class="msg-attach-file">
        <span class="msg-attach-ext" :data-ext="item.ext">{{ extFor(item) }}</span>
        <span class="msg-attach-copy">
          <b :title="item.id">{{ item.name }}</b>
          <span>{{ item.kind }}<template v-if="sizeLabel(item.size)"> · {{ sizeLabel(item.size) }}</template></span>
        </span>
        <button
          class="msg-attach-dl"
          type="button"
          :disabled="busy === item.id"
          @click="download(item)"
        >
          Download
        </button>
      </div>
    </figure>
  </div>

  <Teleport to="body">
    <div
      v-if="zoom"
      class="msg-artifact-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="zoom.name"
      @click.self="closeZoom"
    >
      <button class="msg-artifact-modal-x" type="button" aria-label="Close preview" @click="closeZoom">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      </button>
      <img v-if="state[zoom.id]?.dataUrl" :src="state[zoom.id].dataUrl" :alt="zoom.name" />
      <p v-else class="msg-artifact-modal-note">{{ state[zoom.id]?.error || 'Opening screenshot…' }}</p>
      <div class="msg-artifact-modal-foot">
        <span>{{ zoom.name }}</span>
        <button class="msg-attach-dl" type="button" @click="download(zoom)">Download</button>
      </div>
    </div>
  </Teleport>
</template>
