<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { downloadArtifact, openArtifact, readArtifact } from '@/stores/artifacts'
import { hub, openArtifactPreview, toast } from '@/stores/hub'

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
const busy = ref('')
let observer = null

/**
 * One action row, decided by the file. Reveal and the artifact page apply to
 * everything; an editor only makes sense for text, a browser only for a page
 * (`.html`, `.pdf`). The list comes from the server's own capability check, so
 * the card never offers a verb the RPC would refuse.
 */
const caps = (item) => (Array.isArray(item.capabilities) ? item.capabilities : ['reveal'])
const can = (item, how) => caps(item).includes(how)

/* The artifact page a card links to, by id (ids carry slashes for subfolders). */
const pageOf = (item) => ({
  name: 'artifact',
  params: { workspace: hub.workspace, id: item.id },
})

async function open(item, how) {
  if (busy.value) return
  busy.value = `${item.id}:${how}`
  try {
    await openArtifact(item.id, how)
  } catch (error) {
    toast(error?.message || 'That file could not be opened.')
  } finally {
    busy.value = ''
  }
}

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

async function download(item) {
  if (busy.value) return
  busy.value = `${item.id}:download`
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
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
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
  <!-- One grid, one cell: a 16:10 tile over a one-line caption, whether the file
       is a screenshot or a `.md`. Wrapping variable-width cards around a fixed
       column is what made twelve files arrive as a staircase. -->
  <div
    v-if="items.length"
    v-bind="$attrs"
    ref="root"
    class="msg-artifacts"
    :data-count="items.length"
    :data-alone="items.length === 1 ? items[0].kind : ''"
    aria-label="Artifacts from this turn"
  >
    <figure v-for="item in items" :key="item.id" class="msg-attach" :data-kind="item.kind">
      <div class="msg-attach-preview">
        <button
          v-if="item.kind === 'image'"
          class="msg-attach-img"
          type="button"
          :data-artifact-load="item.id"
          :aria-label="`Open ${item.name}`"
          :title="`Open ${item.name}`"
          @click="openArtifactPreview(item.id)"
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
        <!-- A file has no shot to show, so the tile states what it is rather
             than pretending to be a preview: extension, then the kind. -->
        <button
          v-else
          class="msg-attach-tile"
          type="button"
          :aria-label="`Open ${item.name}`"
          :title="`Open ${item.name}`"
          @click="openArtifactPreview(item.id)"
        >
          <span class="msg-attach-ext" :data-ext="item.ext">{{ extFor(item) }}</span>
          <span class="msg-attach-tile-kind">{{ item.kind }}</span>
        </button>
        <!-- One action row per file, decided by the file's extension: reveal and
             the artifact page always, an editor for text, a browser for a page.
             It rides over the tile on hover and focus, so a grid of twelve stays
             a grid and not a wall of icon rows. -->
        <div class="msg-attach-acts">
          <button
            class="msg-act"
            type="button"
            title="Open in Finder"
            aria-label="Open in Finder"
            :disabled="busy === `${item.id}:reveal`"
            @click="open(item, 'reveal')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" />
              <path d="M1.8 5.8v-2h4" />
            </svg>
          </button>
          <router-link class="msg-act" :to="pageOf(item)" title="Go to artifact page" aria-label="Go to artifact page">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M4 1.8h5l3.4 3.4v9H4z" />
              <path d="M9 1.8v3.6h3.4" />
            </svg>
          </router-link>
          <button
            v-if="can(item, 'editor')"
            class="msg-act"
            type="button"
            title="Open in VS Code"
            aria-label="Open in VS Code"
            :disabled="busy === `${item.id}:editor`"
            @click="open(item, 'editor')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M5.6 4.4L2.6 8l3 3.6M10.4 4.4l3 3.6-3 3.6" />
            </svg>
          </button>
          <button
            v-if="can(item, 'browser')"
            class="msg-act"
            type="button"
            title="Open in browser"
            aria-label="Open in browser"
            :disabled="busy === `${item.id}:browser`"
            @click="open(item, 'browser')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <path d="M2 8h12M8 2c1.8 1.7 2.8 3.7 2.8 6S9.8 12.3 8 14c-1.8-1.7-2.8-3.7-2.8-6S6.2 3.7 8 2z" />
            </svg>
          </button>
          <button
            class="msg-act"
            type="button"
            title="Download"
            aria-label="Download"
            :disabled="busy === `${item.id}:download`"
            @click="download(item)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M8 2.4v8M4.6 7.2L8 10.6l3.4-3.4M3 13.2h10" />
            </svg>
          </button>
        </div>
      </div>
      <figcaption>
        <button class="msg-attach-copy" type="button" :title="item.id" @click="openArtifactPreview(item.id)">
          {{ item.name }}
        </button>
        <span class="msg-attach-meta">{{ sizeLabel(item.size) || item.kind }}</span>
      </figcaption>
    </figure>
  </div>
</template>
