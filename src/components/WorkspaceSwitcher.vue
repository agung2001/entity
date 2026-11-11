<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { WORKSPACES } from '@/data/mock'
import { hub, setWorkspace, workspaceById } from '@/stores/hub'

/**
 * entity holds more than one workspace, so the rail card is a switcher rather
 * than a label. The list is sample data: this hub's entities, skills and
 * machines all belong to `sundoro`, and the menu says so instead of pretending
 * a second dataset was loaded.
 */
const open = ref(false)
const root = ref(null)
const current = computed(() => workspaceById(hub.workspace))

function toggle() {
  open.value = !open.value
}

function pick(id) {
  setWorkspace(id)
  open.value = false
}

function onTriggerKey(e) {
  if (open.value) return
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return
  e.preventDefault()
  open.value = true
  const sel = root.value?.querySelector('[aria-selected="true"]') || root.value?.querySelector('[data-ws-id]')
  sel?.focus()
}

function onMenuKey(e) {
  const options = [...(root.value?.querySelectorAll('[data-ws-id]') || [])]
  const i = options.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    ;(options[i + 1] || options[0])?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ;(options[i - 1] || options[options.length - 1])?.focus()
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (i >= 0) pick(options[i].dataset.wsId)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
    root.value?.querySelector('#ws-btn')?.focus()
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
  <div ref="root" class="ws" :data-open="open ? '1' : '0'">
    <button
      id="ws-btn"
      class="ws-btn"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      aria-controls="ws-menu"
      :aria-label="`Workspace: ${current.label}, ${current.kind}`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="k">
        Workspace
        <svg class="ch" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1.9 3.7L5 6.8l3.1-3.1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="v">
        <span id="ws-name" class="nm">{{ current.label }}</span>
        <em id="ws-kind">{{ current.kind }}</em>
      </span>
    </button>

    <div
      id="ws-menu"
      class="pickmenu ws-menu"
      role="listbox"
      aria-label="Workspaces"
      @keydown="onMenuKey"
    >
      <div class="ph">Workspaces</div>
      <button
        v-for="w in WORKSPACES"
        :key="w.id"
        class="pickopt"
        type="button"
        role="option"
        :data-ws-id="w.id"
        :aria-selected="w.id === hub.workspace ? 'true' : 'false'"
        @click="pick(w.id)"
      >
        <span class="nm">{{ w.label }}</span>
        <span class="mt">{{ w.entities }} entities</span>
        <svg class="ck" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 6.4l2.7 2.6L10 3.4" />
        </svg>
      </button>
      <div class="note">Sample workspaces — this hub’s records live in sundoro.</div>
    </div>
  </div>
</template>
