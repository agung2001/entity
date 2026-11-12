<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppRail from '@/components/AppRail.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import ToastHost from '@/components/ToastHost.vue'
import WorkspaceWizard from '@/components/WorkspaceWizard.vue'
import { closeWizard, hub, toast } from '@/stores/hub'
import { themeMode, toggleTheme } from '@/lib/theme'
import { hasDesktopBridge } from '@/composables/localBridge'

const route = useRoute()
const router = useRouter()

const isChat = computed(() => route.name === 'chat')
const isSkill = computed(() => route.name === 'skill')
const isEntity = computed(() => route.name === 'entity')
const isMachine = computed(() => route.name === 'machine')

const crumbs = computed(() => {
  if (isSkill.value) {
    return [
      { label: 'library', to: '/' },
      { label: 'skills', to: '/skills' },
      { label: route.params.name },
    ]
  }
  if (isEntity.value) {
    return [{ label: 'entities', to: '/entities' }, { label: route.params.name }]
  }
  if (isMachine.value) {
    return [{ label: 'machines', to: '/machines' }, { label: route.params.id }]
  }
  return null
})

const overlayOpen = computed(() => hub.wizard.open || hub.palette.open)

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const isDesktop = hasDesktopBridge()
/* Browsers own several Cmd/Ctrl+Shift combinations; the dev server uses the
   same Option/Alt+Shift escape hatch as the other browser-safe shortcuts. */
const themeShortcut = isDesktop
  ? isMac
    ? '⌘⇧L'
    : 'Ctrl+Shift+L'
  : isMac
    ? '⌥⇧L'
    : 'Alt+Shift+L'
const newChatShortcut = isDesktop
  ? isMac
    ? '⌘N'
    : 'Ctrl+N'
  : isMac
    ? '⌥⇧N'
    : 'Alt+Shift+N'

function openPalette() {
  hub.palette.open = true
  hub.palette.query = ''
  hub.palette.active = 0
}

/* New thread is a topbar action everywhere. The dialog belongs to ChatView, so
   the URL carries the intent and ChatView consumes it on arrival. */
function openNewThread() {
  if (!hub.agents.length) return
  const query = route.name === 'chat' ? { ...route.query, new: '1' } : { new: '1' }
  router.push({ name: 'chat', query })
}

/* the scrim belongs to whichever surface opened last */
function onScrim() {
  if (hub.palette.open) hub.palette.open = false
  else if (hub.wizard.open) closeWizard()
}

function onKey(e) {
  const key = e.key.toLowerCase()
  const primary = (e.metaKey || e.ctrlKey) && !e.altKey
  const primaryShift = (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey
  const alternateShift = e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey

  if ((primaryShift || alternateShift) && (key === 'l' || e.code === 'KeyL')) {
    e.preventDefault()
    toggleTheme()
    return
  }
  if (primary && key === 'k') {
    e.preventDefault()
    openPalette()
    return
  }
  const barePrimary = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
  if (
    ((isDesktop && barePrimary) || primaryShift || alternateShift) &&
    (key === 'n' || e.code === 'KeyN')
  ) {
    e.preventDefault()
    openNewThread()
    return
  }
  if (e.key !== 'Escape') return
  if (hub.palette.open) hub.palette.open = false
  else if (hub.wizard.open) closeWizard()
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
        <button
          class="btn btn-yellow topbar-new"
          type="button"
          :disabled="!hub.agents.length"
          @click="openNewThread"
        >
          New thread
          <kbd class="btn-kbd">{{ newChatShortcut }}</kbd>
        </button>
        <router-link v-if="isSkill" class="linkbtn" to="/skills">
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
          Search <kbd>⌘K</kbd>
        </button>
        <button
          class="theme-toggle topbar-theme"
          type="button"
          :aria-pressed="themeMode === 'dark' ? 'true' : 'false'"
          :aria-label="`${themeMode === 'dark' ? 'Switch to light' : 'Switch to dark'} mode (${themeShortcut})`"
          :title="`${themeMode === 'dark' ? 'Switch to light' : 'Switch to dark'} mode (${themeShortcut})`"
          @click="toggleTheme"
        >
          <svg
            v-if="themeMode === 'dark'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2.4v2.1M12 19.5v2.1M2.4 12h2.1M19.5 12h2.1M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20.3 14.6A8.6 8.6 0 019.4 3.7 8.7 8.7 0 1020.3 14.6z" />
          </svg>
        </button>
      </AppTopbar>

      <div class="main-scroll" :class="{ 'main-scroll--flush': isChat }">
        <router-view />
      </div>
    </main>

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
