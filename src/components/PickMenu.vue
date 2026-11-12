<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'

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
  /** 'harness' | 'machine' — paints the brand mark beside every row */
  icons: { type: String, default: '' },
  /** locked once a thread has started; the context is history at that point */
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const root = ref(null)
const query = ref('')
const searchEl = ref(null)

const items = computed(() =>
  props.includeAll ? [{ id: 'all', label: props.allLabel }, ...props.options] : props.options,
)

/* the menu is a list you look things up in, not a list you scroll: typing
   narrows every axis, including entity names and skill counts */
const visibleItems = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return items.value
  return items.value.filter((entry) =>
    `${entry.label} ${entry.meta || ''}`.toLowerCase().includes(needle),
  )
})

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
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) return
  query.value = ''
  nextTick(() => searchEl.value?.focus())
}

function pick(id) {
  if (props.disabled) return
  open.value = false
  query.value = ''
  emit('update:modelValue', id)
  root.value?.querySelector('.pickbtn')?.focus()
}

function onTriggerKey(e) {
  if (props.disabled || open.value) return
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return
  e.preventDefault()
  open.value = true
  query.value = ''
  nextTick(() => searchEl.value?.focus())
}

function onMenuKey(e) {
  const opts = [...(root.value?.querySelectorAll('.pickopt') || [])]
  const i = opts.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ;(opts[i + 1] || opts[0])?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ;(opts[i - 1] || opts[opts.length - 1])?.focus()
  } else if (e.key === 'Enter' && i < 0) {
    /* focus is still in the search field — take the first match */
    e.preventDefault()
    if (opts[0]) pick(opts[0].dataset.val)
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
  <div
    ref="root"
    class="pickwrap"
    :data-open="open ? '1' : '0'"
    :data-locked="disabled ? '1' : '0'"
  >
    <button
      class="pickbtn"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="disabled"
      :title="disabled ? 'This thread has started — its context is locked' : `${head}`"
      :aria-label="`${head}: ${current ? current.label : 'all'}${
        count != null && modelValue !== 'all' ? `, ${count} plugins` : ''
      }${disabled ? ', locked' : ''}`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <HarnessIcon
        v-if="icons === 'harness'"
        :name="current ? current.id : 'all'"
        :size="12"
      />
      <MachineIcon v-else-if="icons === 'machine'" :size="12" />
      <span class="nm">{{ display }}</span>
      <span v-if="countLabel" class="ct">{{ countLabel }}</span>
      <svg class="ch" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <div class="pickmenu" role="listbox" :aria-label="head" @keydown="onMenuKey">
      <div class="ph">{{ head }}</div>
      <label class="psearch">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="7" cy="7" r="4.4" />
          <path d="M10.3 10.3L13.6 13.6" />
        </svg>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search…"
          :aria-label="`Search ${head}`"
        />
      </label>
      <button
        v-for="o in visibleItems"
        :key="o.id"
        class="pickopt"
        type="button"
        role="option"
        :aria-selected="o.id === modelValue ? 'true' : 'false'"
        :data-val="o.id"
        @click="pick(o.id)"
      >
        <HarnessIcon v-if="icons === 'harness'" :name="o.id" :size="12" />
        <MachineIcon v-else-if="icons === 'machine'" :size="12" />
        <span class="nm">{{ o.label }}</span>
        <span v-if="o.meta" class="mt">{{ o.meta }}</span>
        <svg class="ck" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.4l2 2 4-4.8" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <p v-if="!visibleItems.length" class="pempty">No matches for “{{ query }}”</p>
    </div>
  </div>
</template>
