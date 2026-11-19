<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesQuery } from '@/composables/search'

/**
 * The bookmark picker: one trigger, a searchable list, a check per row.
 *
 * It is used twice — the entity page picks skills for its `prefer:` line, the
 * skill page picks the entities that name it — and both write the *same* line
 * in an entity file. So the sheet is deliberately not a filter: it never hides
 * what the workspace already offers, it only marks what this file names first.
 *
 * Picking does not close the sheet: a `prefer:` line is several names, and
 * closing after each one would mean reopening the trigger per pick.
 */
const props = defineProps({
  /** menu title, e.g. "Starts from" */
  head: { type: String, required: true },
  /** trigger text, e.g. "Add skill" */
  label: { type: String, default: 'Select' },
  /** [{ id, label, meta, on }] — `on` is the state in the file */
  options: { type: Array, required: true },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle'])

const open = ref(false)
const root = ref(null)
const menu = ref(null)
const query = ref('')
const searchEl = ref(null)
/* Teleported to <body> and measured from the trigger, the same way PickMenu
   does it: a picker inside a page section must not be clipped by its overflow. */
const menuStyle = ref({})

/* The checked rows come first — the current list is the thing you are editing —
   then everything else in the order the page sent it. The order is frozen when
   the sheet opens: a row that jumps to the top the moment you tick it makes the
   second pick land on the wrong line. */
const order = ref([])

function freezeOrder() {
  order.value = [
    ...props.options.filter((o) => o.on).map((o) => o.id),
    ...props.options.filter((o) => !o.on).map((o) => o.id),
  ]
}

const ordered = computed(() => {
  const byId = new Map(props.options.map((o) => [o.id, o]))
  const known = order.value.map((id) => byId.get(id)).filter(Boolean)
  /* the store can grow under an open sheet (a skill attached in another tab) */
  const fresh = props.options.filter((o) => !order.value.includes(o.id))
  return [...known, ...fresh]
})

const visible = computed(() =>
  ordered.value.filter((o) => matchesQuery(`${o.label} ${o.meta || ''}`, query.value)),
)

const checked = computed(() => props.options.filter((o) => o.on).length)

function placeMenu() {
  const trigger = root.value?.querySelector('.pickbtn')
  const el = menu.value
  if (!trigger || !el) return
  const rect = trigger.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(Math.max(220, rect.width), vw - 16)
  const left = Math.min(Math.max(8, rect.right - width), vw - width - 8)

  menuStyle.value = {
    left: `${left}px`,
    top: '0px',
    width: `${width}px`,
    maxWidth: `${width}px`,
    maxHeight: '320px',
  }
  const height = el.offsetHeight
  const below = vh - rect.bottom - 10
  const above = rect.top - 10
  const down = below >= Math.min(height, 260) || below >= above
  const maxHeight = Math.max(160, Math.min(320, down ? below : above))
  const shown = Math.min(height, maxHeight)
  menuStyle.value = {
    left: `${left}px`,
    top: `${down ? Math.min(rect.bottom + 6, vh - shown - 8) : Math.max(8, rect.top - shown - 6)}px`,
    width: `${width}px`,
    maxWidth: `${width}px`,
    maxHeight: `${maxHeight}px`,
  }
}

function afterOpen() {
  nextTick(() => {
    placeMenu()
    searchEl.value?.focus()
  })
}

function onViewportChange() {
  if (open.value) placeMenu()
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) return
  query.value = ''
  freezeOrder()
  afterOpen()
}

function pick(id) {
  emit('toggle', id)
}

function onTriggerKey(e) {
  if (props.disabled || open.value) return
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return
  e.preventDefault()
  open.value = true
  query.value = ''
  freezeOrder()
  afterOpen()
}

function onMenuKey(e) {
  const opts = [...(menu.value?.querySelectorAll('.pickopt') || [])]
  const i = opts.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ;(opts[i + 1] || opts[0])?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ;(opts[i - 1] || opts[opts.length - 1])?.focus()
  } else if (e.key === 'Enter' && i < 0) {
    e.preventDefault()
    if (opts[0]) pick(opts[0].dataset.val)
  } else if (e.key === 'Tab') {
    open.value = false
  }
}

function onDocumentClick(e) {
  if (!open.value || root.value?.contains(e.target) || menu.value?.contains(e.target)) return
  open.value = false
}

useDialogDismiss({
  active: () => open.value,
  close: () => {
    open.value = false
    root.value?.querySelector('.pickbtn')?.focus()
  },
})

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <div ref="root" class="pickwrap" :data-open="open ? '1' : '0'">
    <button
      class="pickbtn"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="disabled"
      :title="`${head} — pick what this file names first`"
      :aria-label="`${head}: pick, ${checked} selected`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span aria-hidden="true">+</span>
      <span class="nm">{{ label }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="pickmenu"
        :style="menuStyle"
        role="listbox"
        aria-multiselectable="true"
        :aria-label="head"
        @keydown="onMenuKey"
      >
        <div class="ph">{{ head }} · {{ checked }} selected</div>
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
          v-for="o in visible"
          :key="o.id"
          class="pickopt"
          type="button"
          role="option"
          :aria-selected="o.on ? 'true' : 'false'"
          :data-val="o.id"
          @click="pick(o.id)"
        >
          <span class="nm">{{ o.label }}</span>
          <span v-if="o.meta" class="mt">{{ o.meta }}</span>
          <svg class="ck" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5.4l2 2 4-4.8" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <p v-if="!visible.length" class="pempty">No matches for “{{ query }}”</p>
      </div>
    </Teleport>
  </div>
</template>
