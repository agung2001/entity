<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * Find in the page — the app's own find, over everything it has rendered.
 *
 * The browser's find is disabled inside an Electron shell and, in a tab, it
 * cannot know that the Markdown document is rendered prose rather than a file.
 * So this walks the page: every text node, the Instructions of an entity and
 * the artifact document included, because by the time they are on screen they
 * are ordinary text in the DOM. One search surface for the whole app, and no
 * second find inside the editor.
 *
 * Matches are painted with the CSS Custom Highlight API rather than by wrapping
 * them in elements: wrapping would rewrite the nodes the editor owns, and
 * ProseMirror re-derives its document from those nodes, so a highlighted word
 * would become a `<mark>` the next `setContent` had to explain.
 */
const BAR_ID = 'page-find'

const open = ref(false)
const query = ref('')
const total = ref(0)
const active = ref(0)
const input = ref(null)

/* The ranges this search found, in document order. */
let ranges = []
let painted = false

const findKey = shortcutLabel('find')
const count = computed(() => (total.value ? `${active.value + 1} / ${total.value}` : 'no matches'))

/* ── the walk ─────────────────────────────────────────────────────────
   Text nodes only, and never the chrome that is about finding: the bar's own
   field would otherwise match its own query. */

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'SVG'])

function collect(node, needle, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    const hay = node.nodeValue || ''
    const low = hay.toLowerCase()
    for (let at = low.indexOf(needle); at !== -1; at = low.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      out.push(range)
    }
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  if (SKIP.has(node.tagName)) return
  if (node.id === BAR_ID || node.hasAttribute?.('data-find-skip')) return
  /* What is hidden from a reader is not found by them either. */
  if (node.getAttribute?.('aria-hidden') === 'true') return
  if (node.hidden) return
  for (const child of node.childNodes) collect(child, needle, out)
}

function paint() {
  const api = window.CSS?.highlights
  if (!api) return
  const all = ranges.slice()
  const current = ranges[active.value]
  /* The active hit is a highlight of its own so it can be told apart without a
     second colour ramp: the same accent at full and at a third. */
  api.set('page-find', new Highlight(...all))
  api.set('page-find-on', current ? new Highlight(current) : new Highlight())
  painted = true
}

function unpaint() {
  const api = window.CSS?.highlights
  if (!api) return
  api.delete('page-find')
  api.delete('page-find-on')
  painted = false
}

function scrollTo(range) {
  const box = range.getBoundingClientRect()
  let el = range.startContainer.parentElement
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
      el.scrollTop += box.top - el.getBoundingClientRect().top - el.clientHeight / 2 + box.height / 2
      return
    }
    el = el.parentElement
  }
  /* Nothing scrolls it: the window does. */
  window.scrollBy({ top: box.top - window.innerHeight / 2 + box.height / 2 })
}

function search(text) {
  ranges = []
  active.value = 0
  const needle = String(text || '').trim().toLowerCase()
  if (needle.length) collect(document.body, needle, ranges)
  total.value = ranges.length
  if (!ranges.length) {
    unpaint()
    return
  }
  paint()
  scrollTo(ranges[0])
}

function step(by) {
  if (!ranges.length) return
  active.value = (active.value + by + ranges.length) % ranges.length
  paint()
  scrollTo(ranges[active.value])
}

function close() {
  open.value = false
  query.value = ''
  ranges = []
  total.value = 0
  active.value = 0
  unpaint()
}
useDialogDismiss({ active: () => open.value, close })

function show() {
  open.value = true
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
    search(query.value)
  })
}

function onKey(event) {
  if (!matchesShortcut('find', event)) return
  event.preventDefault()
  if (open.value) close()
  else show()
}

/* The page can change under an open bar — a tab switch, a keystroke in the
   editor — so the count is recomputed rather than left to describe a document
   that is no longer there. */
watch(query, (text) => {
  if (open.value) search(text)
})

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  if (painted) unpaint()
})
</script>

<template>
  <div
    v-if="open"
    :id="BAR_ID"
    class="pagefind"
    role="search"
    aria-label="Find in the page"
    data-find-skip
  >
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <circle cx="5" cy="5" r="3" />
      <path d="M7.2 7.2 10.5 10.5" />
    </svg>
    <input
      ref="input"
      v-model="query"
      type="search"
      class="pagefind-input"
      placeholder="Find in the page"
      aria-label="Find in the page"
      spellcheck="false"
      @keydown.enter.prevent="step($event.shiftKey ? -1 : 1)"
    />
    <span class="pagefind-count" role="status" aria-live="polite">{{ count }}</span>
    <button type="button" aria-label="Previous match" title="Previous match" @click="step(-1)">
      <span aria-hidden="true">↑</span>
    </button>
    <button type="button" aria-label="Next match" title="Next match" @click="step(1)">
      <span aria-hidden="true">↓</span>
    </button>
    <button type="button" :aria-label="`Close find (${findKey})`" title="Close find" @click="close">
      <span aria-hidden="true">×</span>
    </button>
  </div>
</template>
