<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppRail from '@/components/AppRail.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import ShortcutsDialog from '@/components/ShortcutsDialog.vue'
import ToastHost from '@/components/ToastHost.vue'
import WorkspaceWizard from '@/components/WorkspaceWizard.vue'
import { closeWizard, hub, toast } from '@/stores/hub'
import { toggleTheme } from '@/lib/theme'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { useDialogDismiss } from '@/composables/useDialog'

const route = useRoute()
const router = useRouter()

const isChat = computed(() => route.name === 'chat')
const isSkill = computed(() => route.name === 'skill')
const isEntity = computed(() => route.name === 'entity')
const isMachine = computed(() => route.name === 'machine')
const isArtifact = computed(() => route.name === 'artifact')

const crumbs = computed(() => {
  if (isSkill.value) {
    return [
      { label: 'library', to: '/workspaces' },
      { label: 'skills', to: { name: 'skills', params: { workspace: route.params.workspace } } },
      { label: route.params.name },
    ]
  }
  if (isEntity.value) {
    return [{ label: 'entities' }, { label: route.params.name }]
  }
  if (isMachine.value) {
    return [
      { label: 'machines', to: { name: 'machines', params: { workspace: route.params.workspace } } },
      { label: route.params.id },
    ]
  }
  if (isArtifact.value) {
    return [{ label: 'artifacts' }, { label: route.params.id }]
  }
  return null
})

const overlayOpen = computed(() => hub.wizard.open || hub.palette.open)

const shortcutsOpen = ref(false)

/* The wizard and the guide are the two overlays this layout owns; the palette
   registers itself. One Escape stack closes whichever opened last. */
useDialogDismiss({ active: () => hub.wizard.open, close: closeWizard })
useDialogDismiss({ active: () => shortcutsOpen.value, close: () => (shortcutsOpen.value = false) })

function openGuide() {
  hub.palette.open = false
  shortcutsOpen.value = true
}

function openPalette() {
  hub.palette.open = true
  hub.palette.query = ''
  hub.palette.active = 0
}

/* New thread is a keyboard action; the visible + lives in the chat rail. The
   dialog belongs to ChatView, so the URL carries the intent and ChatView
   consumes it on arrival. */
function openNewThread() {
  if (!hub.agents.length) return
  const query = route.name === 'chat' ? { ...route.query, new: '1' } : { new: '1' }
  router.push({ name: 'chat', params: { workspace: route.params.workspace || hub.workspace }, query })
}

/* the scrim belongs to whichever surface opened last */
function onScrim() {
  if (hub.palette.open) hub.palette.open = false
  else if (hub.wizard.open) closeWizard()
}

function isEditable(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

function onKey(e) {
  if (matchesShortcut('guide', e)) {
    /* `?` is a character a person can type; only take it outside a field. */
    if (isEditable(e.target)) return
    e.preventDefault()
    openGuide()
    return
  }
  if (matchesShortcut('theme', e)) {
    e.preventDefault()
    toggleTheme()
    return
  }
  if (matchesShortcut('palette', e)) {
    e.preventDefault()
    openPalette()
    return
  }
  if (matchesShortcut('new-thread', e)) {
    e.preventDefault()
    openNewThread()
  }
}

/** `createWorkspace()` already opened and loaded it — here we only close. */
function onCreated(record) {
  closeWizard()
  toast(`${record.label} is ready`)
}

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="app">
    <AppRail />

    <main>
      <AppTopbar :crumb="route.meta.crumb" :crumbs="crumbs">
        <router-link v-if="isSkill" class="linkbtn" :to="{ name: 'skills', params: { workspace: route.params.workspace } }">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9.6 3.2L5 8l4.6 4.8" />
          </svg>
          Library
        </router-link>
        <button v-else class="kbdbtn" type="button" @click="openPalette">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          Search <kbd>{{ shortcutLabel('palette') }}</kbd>
        </button>
        <button
          class="helpbtn"
          type="button"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          :aria-expanded="shortcutsOpen ? 'true' : 'false'"
          @click="openGuide"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="1.6" y="3.6" width="12.8" height="8.8" rx="1.6" />
            <path d="M4.4 6.4h.1M6.9 6.4h.1M9.4 6.4h.1M11.9 6.4h.1M4.4 9.4h.1M6.9 9.4h2.2M11.9 9.4h.1" stroke-linecap="round" />
          </svg>
          <kbd>?</kbd>
        </button>
      </AppTopbar>

      <div class="main-scroll" :class="{ 'main-scroll--flush': isChat }">
        <router-view />
      </div>
    </main>

    <ShortcutsDialog :open="shortcutsOpen" @close="shortcutsOpen = false" />

    <div class="scrim" :data-open="overlayOpen ? '1' : '0'" @click="onScrim"></div>
    <div class="modal modal-wizard" :data-open="hub.wizard.open ? '1' : '0'" role="dialog" aria-modal="true" aria-label="New workspace">
      <button class="x mo-x" aria-label="Close" @click="closeWizard">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
      <WorkspaceWizard v-if="hub.wizard.open" mode="modal" :open="hub.wizard.open" @created="onCreated" @close="closeWizard" />
    </div>
    <CommandPalette />
    <ToastHost />
  </div>
</template>
