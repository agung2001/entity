<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * A quiet text trigger that opens a small menu — used for the chat's filter
 * axes and for the thread's context (entity / machine / harness).
 */
const props = defineProps({
  head: { type: String, required: true },
  allLabel: { type: String, default: '' },
  options: { type: Array, required: true },
  modelValue: { type: String, default: 'all' },
  includeAll: { type: Boolean, default: false },
  /** shown next to the trigger when the current option carries a count */
  count: { type: Number, default: null },
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const root = ref(null)

const items = computed(() =>
  props.includeAll ? [{ id: 'all', label: props.allLabel }, ...props.options] : props.options,
)

const current = computed(() => items.value.find((o) => o.id === props.modelValue) || null)

const display = computed(() => {
  if (!current.value) return props.head
  if (props.includeAll && current.value.id === 'all') return props.head
  return current.value.label
})

const countLabel = computed(() =>
  props.count != null && props.modelValue !== 'all' ? `(${props.count} plugins)` : '',
)

function toggle() {
  open.value = !open.value
}

function pick(id) {
  open.value = false
  emit('update:modelValue', id)
  root.value?.querySelector('.pickbtn')?.focus()
}

function onTriggerKey(e) {
  if (open.value) return
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return
  e.preventDefault()
  open.value = true
  const sel = root.value?.querySelector('.pickopt[aria-selected="true"]') || root.value?.querySelector('.pickopt')
  sel?.focus()
}

function onMenuKey(e) {
  const opts = [...(root.value?.querySelectorAll('.pickopt') || [])]
  const i = opts.indexOf(document.activeElement)
  if (i < 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ;(opts[Math.min(opts.length - 1, i + 1)] || opts[0])?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ;(opts[Math.max(0, i - 1)] || opts[0])?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
    root.value?.querySelector('.pickbtn')?.focus()
  } else if (e.key === 'Tab') {
    open.value = false
  }
}

function onDocumentClick(e) {
  if (!open.value || root.value?.contains(e.target)) return
  open.value = false
}
function onDocumentKey(e) {
  if (e.key === 'Escape' && open.value) open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKey)
})
</script>

<template>
  <div ref="root" class="pickwrap" :data-open="open ? '1' : '0'">
    <button
      class="pickbtn"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-label="`${head}: ${current ? current.label : 'all'}${
        count != null && modelValue !== 'all' ? `, ${count} plugins` : ''
      }`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="nm">{{ display }}</span>
      <span v-if="countLabel" class="ct">{{ countLabel }}</span>
      <svg class="ch" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <div class="pickmenu" role="listbox" :aria-label="head" @keydown="onMenuKey">
      <div class="ph">{{ head }}</div>
      <button
        v-for="o in items"
        :key="o.id"
        class="pickopt"
        type="button"
        role="option"
        :aria-selected="o.id === modelValue ? 'true' : 'false'"
        :data-val="o.id"
        @click="pick(o.id)"
      >
        <span class="nm">{{ o.label }}</span>
        <span v-if="o.meta" class="mt">{{ o.meta }}</span>
        <svg class="ck" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.4l2 2 4-4.8" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
    </div>
  </div>
</template>
