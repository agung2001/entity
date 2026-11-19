<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppRail from '@/components/AppRail.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import ShortcutsDialog from '@/components/ShortcutsDialog.vue'
import ToastHost from '@/components/ToastHost.vue'
import WorkspaceWizard from '@/components/WorkspaceWizard.vue'
import { closeWizard, hub, toast } from '@/stores/hub'
import { loadHarnesses } from '@/stores/harnesses'
import { toggleTheme } from '@/lib/theme'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hasDesktopBridge } from '@/composables/localBridge'
import { RELEASES_URL } from '@/lib/releases'
import { useDialogDismiss } from '@/composables/useDialog'

/* The palette is twenty kilobytes of search that nobody needs to paint the
   hub. Kept mounted so its open/close transition still runs, but parsed and
   evaluated only after the rail is on screen. */
const CommandPalette = defineAsyncComponent(() => import('@/components/CommandPalette.vue'))

const route = useRoute()
const router = useRouter()

/* The app button belongs to the browser: inside Electron it would open the
   window you are already in. */
const showAppLink = !hasDesktopBridge()

/* A browser cannot ask whether an app is installed. Try the protocol, and if
   the page keeps focus (no handler launched anything), fall back to the
   download page. */
function openDesktopApp() {
  let left = false
  const onBlur = () => {
    left = true
  }
  window.addEventListener('blur', onBlur, { once: true })
  window.setTimeout(() => {
    window.removeEventListener('blur', onBlur)
    if (!left) window.location.href = RELEASES_URL
  }, 1600)
  window.location.href = 'entity://open'
}

const isChat = computed(() => route.name === 'chat')
/* The artifact detail page owns its own scroll: its glass bar floats over the
   file the same way the chat header floats over the thread. */
const isFlush = computed(() => isChat.value || route.name === 'artifact')
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

function onKey(e) {
  /* The platform's own Settings accelerator; the shift form is accepted
     because some layouts only produce a comma with a modifier held. */
  const settingsWithShift =
    e.code === 'Comma' && e.shiftKey && (e.metaKey || e.ctrlKey || e.altKey)
  if (matchesShortcut('account-settings', e) || settingsWithShift) {
    e.preventDefault()
    router.push({ name: 'account' })
    return
  }
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
  /* On an entity page the entity-chat key is "chat with this entity" (its own
     handler, capture phase), so the generic new-thread does not also open a
     dialog over it. */
  if (matchesShortcut('new-thread', e) && !isEntity.value) {
    e.preventDefault()
    openNewThread()
    return
  }
  /* The list-search key — the same combo the conversations rail, the skills
     roster and the tool list use. One key, one meaning: the search field of the
     list on this page. It carries a modifier, so nothing here has to guard
     against a `/` someone is typing. */
  if (matchesShortcut('inventory-search', e)) {
    if (hub.palette.open) return
    e.preventDefault()
    const input = document.querySelector('.rail-t2 input[type="search"]')
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }
}

/** `createWorkspace()` already opened and loaded it — here we only close. */
function onCreated(record) {
  closeWizard()
  toast(`${record.label} is ready`)
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  /* Harness labels are needed by the rail and every picker, not by sign-in. */
  loadHarnesses().catch(() => {})
})
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
        <button
          v-if="showAppLink"
          class="helpbtn appbtn"
          type="button"
          title="Open the desktop app — or download it"
          aria-label="Open the desktop app"
          @click="openDesktopApp"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="2" y="3.4" width="12" height="9.2" rx="1.4" />
            <path d="M2 6.2h12M4.2 4.8h.1M6 4.8h.1" stroke-linecap="round" />
            <path d="M6.6 8.4h2.8M8 8.4v3M6.9 10.5L8 11.6l1.1-1.1" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </AppTopbar>

      <div class="main-scroll" :class="{ 'main-scroll--flush': isFlush }">
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
