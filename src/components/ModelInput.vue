<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { matchesQuery } from '@/composables/search'

/**
 * A free-text model field with a searchable suggestion list. The harnesses keep
 * changing their models, so the list is a hint, never a whitelist: typing a
 * name that is not detected is still valid.
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'harness default' },
  label: { type: String, default: 'Model' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const root = ref(null)
const input = ref(null)
const open = ref(false)
const searching = ref(false)
const active = ref(-1)
const draft = ref(props.modelValue)

const matched = computed(() => {
  const needle = searching.value ? draft.value.trim() : ''
  return props.options.filter((item) => matchesQuery(item, needle))
})

const visible = computed(() => matched.value.slice(0, 200))

const remaining = computed(() => Math.max(0, matched.value.length - visible.value.length))

watch(
  () => props.modelValue,
  (value) => {
    if (value !== draft.value) draft.value = value
  },
)

function openList() {
  if (props.disabled) return
  open.value = true
  searching.value = false
  active.value = -1
}

function onInput() {
  searching.value = true
  open.value = true
  active.value = -1
  emit('update:modelValue', draft.value)
}

function pick(value) {
  draft.value = value
  searching.value = false
  open.value = false
  active.value = -1
  emit('update:modelValue', value)
  nextTick(() => input.value?.focus())
}

function clear() {
  draft.value = ''
  searching.value = false
  open.value = true
  active.value = -1
  emit('update:modelValue', '')
  nextTick(() => input.value?.focus())
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    open.value = false
    return
  }
  openList()
  nextTick(() => input.value?.focus())
}

function onKey(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!open.value) openList()
    if (visible.value.length) active.value = (active.value + 1) % visible.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) openList()
    if (visible.value.length) active.value = (active.value - 1 + visible.value.length) % visible.value.length
  } else if (event.key === 'Enter' && open.value && active.value >= 0) {
    event.preventDefault()
    pick(visible.value[active.value])
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    open.value = false
  }
}

function onDocumentClick(event) {
  if (!open.value || root.value?.contains(event.target)) return
  open.value = false
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <div ref="root" class="model-input" :data-open="open ? '1' : '0'" :aria-busy="loading ? 'true' : undefined">
    <input
      ref="input"
      v-model="draft"
      type="text"
      autocomplete="off"
      spellcheck="false"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      @focus="openList"
      @input="onInput"
      @keydown="onKey"
    />
    <span v-if="loading" class="model-spin model-spin--field" role="status" aria-label="Loading models"></span>
    <button
      v-if="draft"
      class="model-clear"
      type="button"
      aria-label="Clear model"
      :disabled="disabled"
      @click="clear"
    >
      ×
    </button>
    <button
      class="model-chev"
      type="button"
      :disabled="disabled"
      :aria-label="open ? 'Hide model suggestions' : 'Show model suggestions'"
      @click="toggle"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>

    <div v-if="open" class="model-menu" role="listbox" :aria-label="`${label} suggestions`">
      <div class="ph">{{ label }} suggestions</div>
      <button
        v-for="(item, index) in visible"
        :key="item"
        class="model-opt"
        type="button"
        role="option"
        :aria-selected="item === modelValue ? 'true' : 'false'"
        :data-on="index === active ? '1' : '0'"
        @click="pick(item)"
      >
        <span class="nm mono">{{ item }}</span>
        <svg class="ck" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.4l2 2 4-4.8" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <p v-if="loading && !visible.length" class="pempty pempty-loading"><span class="model-spin" aria-hidden="true"></span> Detecting models…</p>
      <p v-else-if="!visible.length" class="pempty">
        Keep typing a custom model name, or clear the search.
      </p>
      <p v-if="remaining" class="pnote">
        Showing the first {{ visible.length }} of {{ visible.length + remaining }}. Keep typing to narrow.
      </p>
    </div>
  </div>
</template>
