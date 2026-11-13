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
})

const MAX_RAIL_TICKS = 80
const activeIndex = ref(-1)
const previewIndex = ref(-1)
const nav = ref(null)
const card = ref(null)
let closeTimer = 0
let frame = 0
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

function scheduleMeasure() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    measure()
  })
}

function measure() {
  const box = props.scrollEl
  if (!box || !items.value.length) {
    activeIndex.value = -1
    return
  }
  const top = box.getBoundingClientRect().top
  let current = items.value[0].index
  for (const item of items.value) {
    const el = box.querySelector(`[data-thread-anchor="${item.index}"]`)
    if (!el) continue
    if (el.getBoundingClientRect().top - top <= 72) current = item.index
    else break
  }
  activeIndex.value = current
}

function jump(index) {
  const box = props.scrollEl
  if (!box) return
  const el = box.querySelector(`[data-thread-anchor="${index}"]`)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const top =
    el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16
  box.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' })
  activeIndex.value = index
}

function detach() {
  const box = props.scrollEl
  if (!box) return
  box.removeEventListener('scroll', scheduleMeasure)
  observer?.disconnect()
  observer = null
  if (frame) cancelAnimationFrame(frame)
  frame = 0
}

function attach() {
  detach()
  const box = props.scrollEl
  if (!box) return
  box.addEventListener('scroll', scheduleMeasure, { passive: true })
  observer = new ResizeObserver(scheduleMeasure)
  observer.observe(box)
  if (box.firstElementChild) observer.observe(box.firstElementChild)
  nextTick(scheduleMeasure)
}

watch(() => props.scrollEl, attach, { immediate: true })
watch(() => props.messages.length, () => nextTick(scheduleMeasure))
watch(
  () => props.messages,
  () => {
    previewIndex.value = -1
    nextTick(scheduleMeasure)
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
