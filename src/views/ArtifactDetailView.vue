<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArtifactHtmlPreview from '@/components/ArtifactHtmlPreview.vue'
import CodeEditor from '@/components/CodeEditor.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { shortcutLabel, matchesShortcut } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import {
  artifacts,
  downloadArtifact,
  loadArtifacts,
  readArtifact,
  openArtifact,
  removeArtifact,
  revealArtifact,
  writeArtifactText,
} from '@/stores/artifacts'

/**
 * One artifact, with its bytes loaded only for this page. The shelf itself is
 * the rail's second tier, so there is no list page between the two.
 *
 * The page borrows the chat's glass bar: it floats over the file and scrolls
 * beneath it, instead of being a floating card on a page. A Markdown artifact
 * is opened in the editor, not dumped as raw text in a box.
 */
const route = useRoute()
const router = useRouter()

/**
 * The same page, twice: routed (`/ws/artifacts/…`) and as a dialog over the
 * chat. `id` is the dialog's argument; `modal` only changes where "back" points
 * and where the notes are sent.
 */
const props = defineProps({
  id: { type: String, default: '' },
  modal: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])
const preview = ref(null)
const previewData = ref(null)
const loading = ref(false)
const missing = ref(false)
const busy = ref('')
const confirming = ref('')
const saving = ref(false)
const draftText = ref('')
const savedText = ref('')
const barRef = ref(null)
const barHeight = ref(56)
let barObserver = null
let token = 0

/* A media artifact gets a stage, not a thumbnail in a box: the bytes are often
   a screenshot or a screen recording, and reading them is the whole point. */
const stage = ref(null)
const zoom = ref(1)
const pan = ref({ x: 0, y: 0 })
const dragging = ref(false)
let dragFrom = null

const mediaKind = computed(() => {
  const kind = previewData.value?.kind
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : ''
})

const id = computed(() => String(props.id || route.params.id || ''))
const item = computed(() => artifacts.items.find((entry) => entry.id === id.value) || null)
const isMarkdown = computed(() => {
  const name = item.value?.name || previewData.value?.name || ''
  const mime = item.value?.mime || previewData.value?.mime || ''
  return /\.md$/i.test(name) || /markdown/i.test(mime)
})
/* An HTML artifact opens as the page it is, with a Source switch. Everything
   else that is text goes straight to its editor. */
const isHtml = computed(() => {
  const name = item.value?.name || previewData.value?.name || ''
  return /\.[xX]?[hH][tT][mM][lL]$/.test(name)
})
/* One mode per artifact: reopening a page should show the page. */
const mode = ref('preview')
/* Whether the rendered surface is the one on screen right now. */
const htmlPreview = computed(
  () => isHtml.value && mode.value === 'preview' && previewData.value?.kind === 'text',
)
watch(
  () => item.value?.id,
  () => {
    mode.value = 'preview'
  },
)

/* Every text artifact is editable: Markdown gets the prose editor, anything
   else gets CodeMirror. A truncated read stays read-only, because saving it
   would delete the half that was never loaded. */
const canEditText = computed(
  () => previewData.value?.kind === 'text' && !previewData.value?.truncated,
)

/**
 * A note written on the preview belongs in the chat, where the agent is. The
 * message is a draft, not a send: the person reads it and presses send.
 */
function sendAnnotations(prompt) {
  if (!prompt) return
  hub.chat.draft = prompt
  toast('Notes added to the chat draft')
  /* Over the conversation already: the notes land in this thread's composer. */
  if (props.modal) emit('close')
  else router.push({ name: 'chat', params: { workspace: hub.workspace } })
}
const codeLanguage = computed(() => (/\.[Pp][Yy]$/.test(item.value?.name || '') ? 'python' : 'plain'))
const dirty = computed(() => canEditText.value && draftText.value !== savedText.value)
const saveShortcut = shortcutLabel('save')

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
  if (mediaKind.value !== 'image' || event.button !== 0) return
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

function onKey(event) {
  /* Saving a draft works even while the editor has focus; the browser's own
     Save Page dialog must not open over the app. */
  if (matchesShortcut('save', event) && canEditText.value) {
    event.preventDefault()
    save()
    return
  }
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

function when(iso) {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function back() {
  if (props.modal) {
    emit('close')
    return
  }
  router.push({ name: 'overview', params: { workspace: hub.workspace } })
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

function syncDraft(data) {
  if (data?.kind === 'text') {
    draftText.value = data.text || ''
    savedText.value = draftText.value
  } else {
    draftText.value = ''
    savedText.value = ''
  }
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
    if (ask === token) {
      previewData.value = data
      syncDraft(data)
    }
  } catch (error) {
    if (ask === token) toast(error?.message || 'The artifact could not be opened.')
  } finally {
    if (ask === token) {
      loading.value = false
      /* The header only exists once the loading state is gone, so the bar is
         measured after the DOM swap — not from the item watcher, which fires
         while the spinner is still the visible branch. */
      await nextTick()
      watchBar()
    }
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

async function save() {
  const current = item.value
  if (!current || !canEditText.value || saving.value || !dirty.value) return
  saving.value = true
  try {
    const meta = await writeArtifactText(current.id, draftText.value)
    savedText.value = draftText.value
    previewData.value = {
      ...(previewData.value || {}),
      ...meta,
      text: draftText.value,
      truncated: false,
    }
    toast(`${current.name} saved`)
  } catch (error) {
    toast(error?.message || 'The document could not be saved.')
  } finally {
    saving.value = false
  }
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

/** What this file allows beyond Download and Reveal, decided by the server. */
const capabilities = computed(() =>
  Array.isArray(item.value?.capabilities) ? item.value.capabilities : ['reveal'],
)
const can = (how) => capabilities.value.includes(how)

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

async function openWith(how) {
  const current = item.value
  if (!current || busy.value) return
  busy.value = how
  try {
    await openArtifact(current.id, how)
  } catch (error) {
    toast(error?.message || 'That file could not be opened.')
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
    router.push({ name: 'overview', params: { workspace: hub.workspace } })
  } catch (error) {
    toast(error?.message || 'The artifact could not be removed.')
  } finally {
    busy.value = ''
  }
}

watch(id, boot)

/**
 * The glass bar is out of the flow, so the scroll owes it its real height. The
 * bar holds three text lines and can be taller than the top bar; measuring the
 * border box (not `contentRect`) keeps the editor flush under it.
 */
function watchBar() {
  if (!barRef.value || typeof ResizeObserver !== 'function') return
  barObserver?.disconnect()
  barObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    const box = entry?.borderBoxSize?.[0]?.blockSize
    const height = Number.isFinite(box) ? box : entry?.target?.getBoundingClientRect().height
    barHeight.value = Math.round(height || 56)
  })
  barObserver.observe(barRef.value)
}


onMounted(() => {
  boot()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  token += 1
  barObserver?.disconnect()
  barObserver = null
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div
    class="view artifact-detail"
    :class="{ 'artifact-detail--media': Boolean(mediaKind) }"
    :style="{ '--abar-h': `${barHeight}px` }"
  >
    <div v-if="loading" class="empty-note artifact-state">
      <b>Opening {{ item?.name || 'artifact' }}…</b>
    </div>

    <div v-else-if="missing" class="empty-note artifact-state">
      <b>That artifact is not in this workspace.</b>
      <span>It may have been removed on disk.</span>
      <button class="btn" type="button" @click="back">Back to overview</button>
    </div>

    <template v-else-if="item">
      <header ref="barRef" class="artifact-bar">
        <button class="media-back" type="button" aria-label="Back to overview" title="Back" @click="back">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M13 8H3.4M7.4 3.4L3 8l4.4 4.6" />
          </svg>
        </button>
        <div class="artifact-titles">
          <p class="eyebrow">Artifact · {{ hub.workspaceLabel || hub.workspace }}</p>
          <h1 :title="item.id">{{ item.name }}</h1>
          <p class="artifact-meta">
            <span>{{ item.mime || item.ext || 'file' }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ sizeLabel(item.size) }}</span>
            <span aria-hidden="true">·</span>
            <span>Modified {{ when(item.modifiedAt) }}</span>
            <span v-if="canEditText && dirty" class="artifact-unsaved">Unsaved changes</span>
          </p>
        </div>
        <div class="artifact-actions">
          <div v-if="isHtml" class="artifact-mode" role="group" aria-label="How to show this file">
            <button
              type="button"
              :aria-pressed="mode === 'preview'"
              :class="{ on: mode === 'preview' }"
              @click="mode = 'preview'"
            >
              Preview
            </button>
            <button
              type="button"
              :aria-pressed="mode === 'source'"
              :class="{ on: mode === 'source' }"
              @click="mode = 'source'"
            >
              Source
            </button>
          </div>
          <button
            v-if="canEditText"
            class="btn btn-sm"
            :class="dirty || saving ? 'btn-ink' : 'btn-ghost'"
            type="button"
            :disabled="!dirty || saving"
            :title="dirty ? `Save the document (${saveShortcut})` : 'No unsaved changes'"
            @click="save"
          >
            {{ saving ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
            <kbd v-if="dirty && !saving" class="btn-kbd">{{ saveShortcut }}</kbd>
          </button>
          <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="download">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M8 2.4v8M4.6 7.2L8 10.6l3.4-3.4M3 13.2h10" />
            </svg>
            {{ busy === 'download' ? 'Preparing…' : 'Download' }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="reveal">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" />
              <path d="M1.8 5.8v-2h4" />
            </svg>
            {{ busy === 'reveal' ? 'Revealing…' : 'Reveal' }}
          </button>
          <button
            v-if="can('editor')"
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            :title="`Open ${item.name} in VS Code`"
            @click="openWith('editor')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M5.6 4.4L2.6 8l3 3.6M10.4 4.4l3 3.6-3 3.6" />
            </svg>
            {{ busy === 'editor' ? 'Opening…' : 'VS Code' }}
          </button>
          <button
            v-if="can('browser')"
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            :title="`Open ${item.name} in your browser`"
            @click="openWith('browser')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <path d="M2 8h12M8 2c1.8 1.7 2.8 3.7 2.8 6S9.8 12.3 8 14c-1.8-1.7-2.8-3.7-2.8-6S6.2 3.7 8 2z" />
            </svg>
            {{ busy === 'browser' ? 'Opening…' : 'Browser' }}
          </button>
          <button
            class="btn btn-sm ws-danger"
            type="button"
            :class="{ confirming: confirming === item.id }"
            :disabled="Boolean(busy)"
            @click="remove"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M3 4.6h10M6.4 4.6V3h3.2v1.6M4.4 4.6l.6 8.4h6l.6-8.4M6.8 7v4M9.2 7v4" />
            </svg>
            {{ confirming === item.id ? 'Confirm delete' : 'Delete' }}
          </button>
          <!-- In a dialog the page needs its own way out, and it belongs in the
               row like every other control: same 28 px seat, same hover, no
               floating chip with a shadow over the page. -->
          <button
            v-if="modal"
            class="x artifact-close"
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            @click="emit('close')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
            </svg>
          </button>
        </div>
      </header>

      <div
        class="artifact-scroll"
        :class="{ 'artifact-scroll--document': previewData?.kind === 'text' }"
      >
        <div v-if="mediaKind" class="media-view">
          <section
            ref="stage"
            class="media-canvas"
            :data-kind="mediaKind"
            :data-drag="dragging ? '1' : '0'"
            @wheel="onWheel"
            @pointerdown="startDrag"
            @pointermove="drag"
            @pointerup="endDrag"
            @pointercancel="endDrag"
            @dblclick="mediaKind === 'image' && (zoom > 1 ? resetView() : zoomBy(2, $event.clientX, $event.clientY))"
          >
            <aside v-if="mediaKind === 'image'" class="media-rail" @pointerdown.stop @dblclick.stop>
              <button type="button" aria-label="Zoom in" title="Zoom in (+)" @click="zoomBy(1.15)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path d="M3.5 8h9M8 3.5v9" />
                </svg>
              </button>
              <button type="button" class="media-zoom" title="Fit to the window" @click="resetView">
                {{ Math.round(zoom * 100) }}%
              </button>
              <button type="button" aria-label="Zoom out" title="Zoom out (−)" @click="zoomBy(0.85)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path d="M3.5 8h9" />
                </svg>
              </button>
              <span class="media-sep" aria-hidden="true"></span>
              <button type="button" aria-label="Fit to the window" title="Fit" @click="resetView">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path d="M6 2.8H2.8V6M10 2.8h3.2V6M6 13.2H2.8V10M10 13.2h3.2V10" />
                </svg>
              </button>
            </aside>

            <img
              v-if="mediaKind === 'image' && previewData?.dataUrl"
              class="media-img"
              :src="previewData.dataUrl"
              :alt="previewData.name"
              draggable="false"
              :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }"
            />

            <video
              v-else-if="mediaKind === 'video' && previewData?.dataUrl"
              :src="previewData.dataUrl"
              controls
              playsinline
              preload="metadata"
            ></video>

            <div v-else-if="mediaKind === 'audio' && previewData?.dataUrl" class="media-sound">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
              </svg>
              <div>
                <b>{{ previewData.name }}</b>
                <audio :src="previewData.dataUrl" controls preload="metadata"></audio>
              </div>
            </div>
          </section>
        </div>

        <section v-else class="artifact-doc">
          <ArtifactHtmlPreview
            v-if="htmlPreview"
            :key="`preview:${item.id}:${previewData.text?.length || 0}`"
            :html="previewData.text || ''"
            :id="item.id"
            :name="item.name"
            @send="sendAnnotations"
            @escape="modal && emit('close')"
          />
          <MarkdownEditor
            v-else-if="canEditText && isMarkdown"
            :key="item.id"
            v-model="draftText"
            :rows="26"
            placeholder="Write Markdown…"
          />
          <CodeEditor
            v-else-if="canEditText"
            :key="item.id"
            v-model="draftText"
            :language="codeLanguage"
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
      </div>
    </template>
  </div>
</template>
