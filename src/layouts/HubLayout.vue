<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppRail from '@/components/AppRail.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import ToastHost from '@/components/ToastHost.vue'
import WorkspaceWizard from '@/components/WorkspaceWizard.vue'
import { closeWizard, hub, toast } from '@/stores/hub'
import { toggleTheme } from '@/lib/theme'
import { hasDesktopBridge } from '@/composables/localBridge'

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
      { label: 'library', to: '/' },
      { label: 'skills', to: '/skills' },
      { label: route.params.name },
    ]
  }
  if (isEntity.value) {
    return [{ label: 'entities' }, { label: route.params.name }]
  }
  if (isMachine.value) {
    return [{ label: 'machines', to: '/machines' }, { label: route.params.id }]
  }
  if (isArtifact.value) {
    return [{ label: 'artifacts' }, { label: route.params.id }]
  }
  return null
})

const overlayOpen = computed(() => hub.wizard.open || hub.palette.open)

const isDesktop = hasDesktopBridge()

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
