<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  annotationPrompt,
  describeTarget,
  elementAt,
  previewDocument,
  sanitizeInline,
  targetOf,
} from '@/lib/annotate'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { toast } from '@/stores/hub'

/**
 * The rendered view of an HTML artifact, with the annotator.
 *
 * A same-origin `srcdoc` frame: the artifact is a real document, so its `body`
 * rules and media queries apply, while the picker is our own code reading
 * `contentDocument` — no injected script, nothing for the app's policy to
 * block. Scripts and inline handlers are stripped by `previewDocument`, so the
 * preview renders markup and CSS and nothing else; **Open in browser** is one
 * click away for the interactive version.
 */
const props = defineProps({
  html: { type: String, default: '' },
  id: { type: String, default: '' },
  name: { type: String, default: '' },
})

const emit = defineEmits(['send'])

const annotateKey = shortcutLabel('annotate')
const addNoteKey = shortcutLabel('send')

const frame = ref(null)
const annotating = ref(false)
const picked = shallowRef(null)
const noteText = ref('')
const notes = ref([])
const copying = ref(false)
const textarea = ref(null)
const document_ = computed(() => previewDocument(props.html))

/* The outline lives inside the preview document, so it scrolls with the page
   instead of chasing it from the outside. */
let doc = null
let overlay = null

/* The artifact that points at sibling files cannot reach them: a preview is one
   document. Say so once instead of showing a page with broken images. */
const missingAssets = computed(() => {
  const source = String(props.html || '')
  const match = source.match(
    /(?:src|href)=["'](?!https?:|data:|#|\/\/)([^"']+\.(?:png|jpe?g|gif|webp|avif|svg|css|js|woff2?))/i,
  )
  return match ? match[1] : ''
})

function ensureOverlay() {
  if (!doc?.body) return null
  if (overlay?.box?.isConnected) return overlay
  /* Copied from Orca's grab overlay: a white border ringed in dark so it reads
     on any page background, a faint wash (an accent tint muddies the design
     underneath), and a dark pill naming the element. */
  const box = doc.createElement('div')
  box.setAttribute('data-entity-annotate', 'box')
  box.style.cssText = [
    'position:fixed',
    'display:none',
    'pointer-events:none',
    'z-index:2147483646',
    'border:2px solid rgba(255,255,255,0.9)',
    'border-radius:3px',
    'background:rgba(255,255,255,0.08)',
    'box-shadow:0 0 0 1px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.15)',
    'transition:all .05s ease-out',
  ].join(';')

  const label = doc.createElement('div')
  label.setAttribute('data-entity-annotate', 'label')
  label.style.cssText = [
    'position:fixed',
    'display:none',
    'pointer-events:none',
    'z-index:2147483646',
    'padding:3px 8px',
    'background:rgba(30,30,30,0.92)',
    'color:#e5e5e5',
    'font:11px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    'border-radius:4px',
    'white-space:nowrap',
    'max-width:300px',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
  ].join(';')

  doc.body.append(box, label)
  overlay = { box, label, el: null }
  return overlay
}

function labelFor(element, rect) {
  const tag = String(element.tagName || '').toLowerCase()
  const role = element.getAttribute?.('role')
  const text = (element.innerText || element.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  const parts = [tag]
  if (role) parts.push(`role=${role}`)
  if (text) parts.push(`"${text}"`)
  parts.push(`${Math.round(rect.width)}x${Math.round(rect.height)}`)
  return parts.join('  ')
}

function paint(element) {
  const nodes = ensureOverlay()
  if (!nodes) return
  const { box, label } = nodes
  if (!element || element === doc.documentElement || element === doc.body) {
    box.style.display = 'none'
    label.style.display = 'none'
    nodes.el = null
    return
  }
  const rect = element.getBoundingClientRect()
  const view = doc.defaultView || window
  box.style.left = `${rect.x}px`
  box.style.top = `${rect.y}px`
  box.style.width = `${rect.width}px`
  box.style.height = `${rect.height}px`
  box.style.display = 'block'

  label.textContent = labelFor(element, rect)
  /* Below the element, or above it when there is no room at the bottom. */
  const below = rect.bottom + 6
  const top = below + 28 > view.innerHeight ? Math.max(4, rect.top - 28) : below
  label.style.left = `${Math.max(4, rect.left)}px`
  label.style.top = `${top}px`
  label.style.display = 'block'
  nodes.el = element
}

function hideOverlay() {
  if (!overlay) return
  overlay.box.style.display = 'none'
  overlay.label.style.display = 'none'
  overlay.el = null
}

function clearOutline() {
  hideOverlay()
}

/* A fixed box does not follow a scrolling page on its own. */
let followFrame = 0
function follow() {
  if (followFrame || !overlay?.el) return
  followFrame = doc.defaultView.requestAnimationFrame(() => {
    followFrame = 0
    if (overlay?.el) paint(overlay.el)
  })
}

function onPointerMove(event) {
  if (!annotating.value || picked.value) return
  paint(elementAt(doc, event))
}

/* The send shortcut adds the note, exactly like sending a message; the combo
   comes from the catalog so it can never drift from the guide. */
function onNoteKey(event) {
  if (matchesShortcut('send', event)) {
    event.preventDefault()
    addNote()
  }
}

function onClick(event) {
  if (!annotating.value) return
  event.preventDefault()
  event.stopPropagation()
  const element = elementAt(doc, event)
  const target = targetOf(element)
  if (!target) return
  picked.value = target
  noteText.value = ''
  /* Freeze the outline on the element being described, like Orca does: you
     should still see what the note is about while you type it. */
  paint(element)
  nextTick(() => textarea.value?.focus())
}

function toggleAnnotate() {
  annotating.value = !annotating.value
  if (!annotating.value) {
    clearOutline()
    closePicker()
  }
}

function closePicker() {
  picked.value = null
  noteText.value = ''
  clearOutline()
}

function addNote() {
  const target = picked.value
  const text = sanitizeInline(noteText.value, 2000)
  if (!target || !text) {
    textarea.value?.focus()
    return
  }
  notes.value = [...notes.value, { target, text }]
  closePicker()
}

function removeNote(index) {
  notes.value = notes.value.filter((_, at) => at !== index)
}

async function copyPrompt() {
  const prompt = annotationPrompt({ id: props.id, name: props.name, notes: notes.value })
  if (!prompt) return
  copying.value = true
  try {
    await navigator.clipboard.writeText(prompt)
    toast(`Copied ${notes.value.length} note${notes.value.length === 1 ? '' : 's'}`)
  } catch {
    toast('The clipboard is not available here.')
  } finally {
    copying.value = false
  }
}

function sendPrompt() {
  const prompt = annotationPrompt({ id: props.id, name: props.name, notes: notes.value })
  if (prompt) emit('send', prompt)
}

function detach() {
  doc?.removeEventListener('mousemove', onPointerMove, true)
  doc?.removeEventListener('click', onClick, true)
  doc?.removeEventListener('keydown', onKey, true)
  doc?.removeEventListener('scroll', follow, true)
  doc?.removeEventListener('resize', follow, true)
  doc = null
  overlay = null
}

/** The frame re-loads whenever the src document changes; rebind on load. */
function onFrameLoad() {
  detach()
  doc = frame.value?.contentDocument || null
  if (!doc) return
  doc.addEventListener('mousemove', onPointerMove, true)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKey, true)
  doc.addEventListener('scroll', follow, true)
  doc.addEventListener('resize', follow, true)
  ensureOverlay()
}

onMounted(() => {
  if (frame.value?.contentDocument?.readyState === 'complete') onFrameLoad()
})

watch(
  () => props.html,
  () => {
    clearOutline()
    closePicker()
  },
)

/* The picker is inline, not a dialog, but it is dismissible — so Escape goes
   through the one stack that owns it, like every other surface. */
useDialogDismiss({ active: () => Boolean(picked.value), close: closePicker })

/* The annotate shortcut from the catalog: one key to start reviewing, the
   same key to stop. The combo itself is never written here. */
function onKey(event) {
  /* Escape reaches us only when the focus is inside the preview document; the
     one dismiss stack owns the case where it is in the app. */
  if (event.key === 'Escape' && picked.value) {
    event.preventDefault()
    closePicker()
    return
  }
  if (!matchesShortcut('annotate', event)) return
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) {
    return
  }
  event.preventDefault()
  toggleAnnotate()
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

onBeforeUnmount(detach)
</script>

<template>
  <div class="artifact-html">
    <p v-if="missingAssets" class="annotate-warn">
      This page points at <code class="mono">{{ missingAssets }}</code>, and a preview is one
      document — links to sibling files do not load here. Use
      <strong>Open in browser</strong> for the full page.
    </p>

    <!-- Floating review dock: the picker, the notes and the actions stay within
         reach of the pointer instead of owning a toolbar row. -->
    <div class="annotate-dock" :data-on="annotating ? '1' : '0'">
      <div v-if="picked" class="annotate-card annotate-card--pick">
        <div class="annotate-card-head">
          <b>{{ describeTarget(picked) }}</b>
          <button class="annotate-x" type="button" aria-label="Cancel this note" @click="closePicker">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <p class="annotate-styles">
          {{ picked.selector }} · {{ picked.rect.w }}×{{ picked.rect.h }}px
          <template v-if="picked.styles.font"> · {{ picked.styles.font }}</template>
        </p>
        <textarea
          ref="textarea"
          v-model="noteText"
          class="annotate-input"
          rows="3"
          placeholder="What should change here?"
          @keydown="onNoteKey"
        ></textarea>
        <div class="annotate-card-actions">
          <button class="btn btn-sm" type="button" @click="closePicker">Cancel</button>
          <button class="btn btn-sm btn-ink" type="button" :disabled="!noteText.trim()" @click="addNote">
            Add note
            <kbd class="btn-kbd">{{ addNoteKey }}</kbd>
          </button>
        </div>
      </div>

      <ol v-if="notes.length" class="annotate-card annotate-card--list">
        <li v-for="(note, index) in notes" :key="`${note.target.selector}-${index}`">
          <div>
            <b>{{ describeTarget(note.target) }}</b>
            <span>{{ note.text }}</span>
          </div>
          <button class="annotate-x" type="button" aria-label="Remove note" @click="removeNote(index)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </li>
      </ol>

      <div class="annotate-pill">
        <button
          class="annotate-toggle"
          type="button"
          :data-on="annotating ? '1' : '0'"
          :aria-pressed="annotating"
          :title="`Annotate the preview (${annotateKey})`"
          @click="toggleAnnotate"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M3 2.4l9.2 4.6-4.1 1.2-1.2 4.1z" />
          </svg>
          {{ annotating ? 'Pick an element' : 'Annotate' }}
          <kbd>{{ annotateKey }}</kbd>
        </button>
        <template v-if="notes.length">
          <span class="annotate-dot" aria-hidden="true"></span>
          <button class="annotate-link" type="button" :disabled="copying" @click="copyPrompt">
            {{ copying ? 'Copying…' : `Copy ${notes.length}` }}
          </button>
          <button class="annotate-send" type="button" @click="sendPrompt">Send to chat</button>
        </template>
      </div>
    </div>

    <iframe
      ref="frame"
      class="artifact-preview"
      :data-annotating="annotating ? '1' : '0'"
      :srcdoc="document_"
      :title="`Preview of ${name || 'the artifact'}`"
      referrerpolicy="no-referrer"
      @load="onFrameLoad"
    ></iframe>
  </div>
</template>
