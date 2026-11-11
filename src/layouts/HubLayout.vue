<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppRail from '@/components/AppRail.vue'
import AppTopbar from '@/components/AppTopbar.vue'
import AccountModal from '@/components/AccountModal.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import EntityDrawer from '@/components/EntityDrawer.vue'
import MoveAgentModal from '@/components/MoveAgentModal.vue'
import ToastHost from '@/components/ToastHost.vue'
import { closeAccount, closeDrawer, closeMove, hub } from '@/stores/hub'

const route = useRoute()

const isChat = computed(() => route.name === 'chat')
const isSkill = computed(() => route.name === 'skill')

const crumbs = computed(() =>
  isSkill.value
    ? [
        { label: 'library', to: '/' },
        { label: 'skills', to: '/skills' },
        { label: route.params.name },
      ]
    : null,
)

const overlayOpen = computed(
  () => hub.drawer.open || hub.move.open || hub.palette.open || hub.account.open,
)

function openPalette() {
  hub.palette.open = true
  hub.palette.query = ''
  hub.palette.active = 0
}

/* the scrim belongs to whichever surface opened last */
function onScrim() {
  if (hub.palette.open) hub.palette.open = false
  else if (hub.move.open) closeMove()
  else if (hub.account.open) closeAccount()
  else closeDrawer()
}

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openPalette()
    return
  }
  if (e.key !== 'Escape') return
  if (hub.palette.open) hub.palette.open = false
  else if (hub.move.open) closeMove()
  else if (hub.account.open) closeAccount()
  else if (hub.drawer.open) closeDrawer()
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
    <EntityDrawer />
    <MoveAgentModal />
    <AccountModal />
    <CommandPalette />
    <ToastHost />
  </div>
</template>
