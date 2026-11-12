<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { openWizard, toast } from '@/stores/hub'
import { activeWorkspace, openWorkspace, workspaces } from '@/stores/workspaces'

/**
 * entity holds more than one workspace, and each is a directory with its own
 * entities, skills, machines and run history. The list here is read from disk;
 * switching reloads the scope instead of relabelling it.
 */
const router = useRouter()
const open = ref(false)
const root = ref(null)
const switching = ref('')
const current = computed(() => activeWorkspace.value)

const list = computed(() => workspaces.items)

function toggle() {
  open.value = !open.value
}

async function pick(id) {
  if (switching.value) return
  if (id === workspaces.active) {
    open.value = false
    return
  }
  switching.value = id
  try {
    const record = await openWorkspace(id)
    toast(`Opened ${record.label}`)
    open.value = false
    if (router.currentRoute.value.name === 'skill') router.push('/skills')
  } catch (error) {
    toast(error?.message || 'Could not open that workspace')
  } finally {
    switching.value = ''
  }
}

function newWorkspace() {
  open.value = false
  openWizard()
}

function manage() {
  open.value = false
  router.push('/workspaces')
}

function settings() {
  open.value = false
  router.push('/workspace')
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
      :aria-label="`Workspace: ${current?.label || 'none'}, ${current?.kind || 'not created'}`"
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
        <span id="ws-name" class="nm">{{ current?.label || 'no workspace' }}</span>
        <em id="ws-kind">{{ current?.kind || '—' }}</em>
      </span>
    </button>

    <div
      id="ws-menu"
      class="pickmenu ws-menu"
      role="listbox"
      aria-label="Workspaces"
      @keydown="onMenuKey"
    >
      <div class="ph">Workspaces · on this machine</div>
      <button
        v-for="w in list"
        :key="w.id"
        class="pickopt"
        type="button"
        role="option"
        :data-ws-id="w.id"
        :aria-selected="w.id === workspaces.active ? 'true' : 'false'"
        :disabled="switching === w.id"
        @click="pick(w.id)"
      >
        <span class="nm">{{ w.label }}</span>
        <span class="mt">
          {{ switching === w.id ? 'opening…' : `${w.counts.entities} entities` }}
        </span>
        <svg class="ck" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 6.4l2.7 2.6L10 3.4" />
        </svg>
      </button>
      <div class="ws-menu-foot">
        <button class="pickopt" type="button" @click="manage">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
          Manage workspaces
        </button>
        <button class="pickopt" type="button" @click="settings">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <circle cx="8" cy="8" r="2.2" />
            <path
              d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
            />
          </svg>
          Workspace settings
        </button>
        <button class="pickopt" type="button" @click="newWorkspace">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 3.2v9.6M3.2 8h9.6" />
          </svg>
          New workspace
        </button>
      </div>
      <div v-if="workspaces.error" class="note">{{ workspaces.error }}</div>
    </div>
  </div>
</template>
