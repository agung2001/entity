<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * A right-edge outline of the conversation. Long replies are hard to navigate
 * with only a scrollbar, so every message gets a tick; questions are longer
 * than answers, and hovering or focusing a tick opens one stationary list of
 * destinations that can be clicked. The rail follows the reading position.
 */
const props = defineProps({
  messages: { type: Array, default: () => [] },
  scrollEl: { type: Object, default: null },
  entityName: { type: String, default: 'entity' },
  /* Long transcripts mount on demand; a jump to an unmounted message asks the
     list to mount down to it first. */
  reveal: { type: Function, default: null },
  /* How many rows are mounted right now. New anchors are observed as the list
     fills in, so the rail keeps tracking the reading position. */
  rendered: { type: Number, default: 0 },
})

const MAX_RAIL_TICKS = 80
const activeIndex = ref(-1)
const previewIndex = ref(-1)
const nav = ref(null)
const card = ref(null)
let closeTimer = 0
let observer = null

const textOf = (message) => {
  const value = String(message?.text || '').replace(/\s+/g, ' ').trim()
  if (!value) return message?.who === 'sys' ? 'Run failed' : '(empty)'
  return value.length > 120 ? `${value.slice(0, 119)}…` : value
}

const items = computed(() =>
  props.messages
    .map((message, index) => ({
      index,
      id: message.id || `${message.who}-${index}`,
      who: message.who,
      error: Boolean(message.error),
      title: textOf(message),
      role:
        message.who === 'me'
          ? 'You'
          : message.who === 'sys'
            ? 'Error'
            : props.entityName,
    }))
    .filter((item) => item.who === 'me' || item.who === 'agent' || item.error),
)

/* Past a useful number of ticks, keep the questions and errors and let the
   outline card carry every reply. */
const railItems = computed(() =>
  items.value.length <= MAX_RAIL_TICKS
    ? items.value
    : items.value.filter((item) => item.who !== 'agent' || item.error),
)

const tickLabel = (item) => `${item.role}: ${item.title}`

/* The jump card is a surface: Escape closes it before anything behind it. */
useDialogDismiss({ active: () => previewIndex.value >= 0, close: () => (previewIndex.value = -1) })

/* With reply ticks dropped, the reply currently being read still lights the
   question it belongs to. */
const activeRailIndex = computed(() => {
  if (railItems.value.some((item) => item.index === activeIndex.value)) {
    return activeIndex.value
  }
  return (
    [...railItems.value].reverse().find((item) => item.index <= activeIndex.value)?.index ?? -1
  )
})

/* The reading position is whichever message crosses a thin strip at the top
   of the transcript. An IntersectionObserver answers that without measuring
   every row: a long thread used to cost one layout read per message on every
   scroll frame and on every switch. */
const visible = new Set()
const observed = new WeakSet()

function observeAnchors() {
  const box = props.scrollEl
  if (!box || !observer) return
  for (const el of box.querySelectorAll('[data-thread-anchor]')) {
    if (observed.has(el)) continue
    observed.add(el)
    observer.observe(el)
  }
}

function observe() {
  const box = props.scrollEl
  if (!box) {
    activeIndex.value = -1
    return
  }
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.dataset.threadAnchor)
          if (!Number.isFinite(index)) continue
          if (entry.isIntersecting) visible.add(index)
          else visible.delete(index)
        }
        if (visible.size) activeIndex.value = Math.min(...visible)
      },
      { root: box, rootMargin: '0px 0px -95% 0px', threshold: 0 },
    )
  }
  observeAnchors()
}

function jump(index, retry = true) {
  const box = props.scrollEl
  if (!box) return
  const el = box.querySelector(`[data-thread-anchor="${index}"]`)
  if (!el) {
    if (retry && props.reveal) {
      props.reveal(index)
      nextTick(() => jump(index, false))
    }
    return
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const top =
    el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16
  const far = Math.abs(top - box.scrollTop) > box.clientHeight * 2
  box.scrollTo({ top: Math.max(0, top), behavior: reduce || far ? 'auto' : 'smooth' })
  activeIndex.value = index
}

function detach() {
  observer?.disconnect()
  observer = null
  visible.clear()
}

function attach() {
  detach()
  nextTick(observe)
}

watch(() => props.scrollEl, attach, { immediate: true })
watch(() => props.rendered, () => nextTick(observeAnchors))
watch(
  () => props.messages,
  () => {
    previewIndex.value = -1
    nextTick(observeAnchors)
  },
  { deep: false },
)
onBeforeUnmount(() => {
  detach()
  clearTimeout(closeTimer)
})

function openPreview(index) {
  clearTimeout(closeTimer)
  previewIndex.value = index
  nextTick(() => {
    const row = card.value?.querySelector(`li[data-index="${previewIndex.value}"]`)
    if (!row) return
    if (row.offsetTop < card.value.scrollTop) card.value.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > card.value.scrollTop + card.value.clientHeight) {
      card.value.scrollTop = row.offsetTop + row.offsetHeight - card.value.clientHeight
    }
  })
}

function closeSoon() {
  clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    if (!nav.value?.contains(document.activeElement) && !card.value?.contains(document.activeElement)) {
      previewIndex.value = -1
    }
  }, 140)
}

function cancelClose() {
  clearTimeout(closeTimer)
}

function onTickClick(item) {
  jump(item.index)
  previewIndex.value = -1
}
</script>

<template>
  <div v-if="items.length > 1" class="thread-minimap">
    <nav
      ref="nav"
      class="tm-rail"
      aria-label="Jump between messages"
      @pointerleave="closeSoon"
      @focusout="closeSoon"
    >
      <button
        v-for="item in railItems"
        :key="item.id"
        type="button"
        class="tm-tick"
        :data-kind="item.who"
        :data-on="activeRailIndex === item.index ? '1' : '0'"
        :data-preview="previewIndex === item.index ? '1' : '0'"
        :aria-label="tickLabel(item)"
        :aria-current="activeRailIndex === item.index ? 'true' : undefined"
        @pointerenter="openPreview(item.index)"
        @focus="openPreview(item.index)"
        @click="onTickClick(item)"
      >
        <span></span>
      </button>
    </nav>

    <div
      v-if="previewIndex >= 0"
      ref="card"
      class="tm-card"
      @pointerenter="cancelClose"
      @pointerleave="closeSoon"
      @focusin="cancelClose"
      @focusout="closeSoon"
    >
      <ul>
        <li v-for="item in items" :key="item.id" :data-kind="item.who" :data-index="item.index">
          <button
            type="button"
            :data-active="previewIndex === item.index ? '1' : '0'"
            @pointerenter="openPreview(item.index)"
            @focus="openPreview(item.index)"
            @click="onTickClick(item)"
          >
            <span class="tm-role">{{ item.role }}</span>
            <span class="tm-title">{{ item.title }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
