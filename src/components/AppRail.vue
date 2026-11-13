<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import NavIcon from '@/components/NavIcon.vue'
import RailContext from '@/components/RailContext.vue'
import { ensureChats, hub, initials, roleById, signOut } from '@/stores/hub'
import { artifacts } from '@/stores/artifacts'
import { hasDesktopBridge } from '@/composables/localBridge'
import { gravatarUrl } from '@/lib/gravatar'
import { themeMode, toggleTheme } from '@/lib/theme'

const route = useRoute()
const router = useRouter()

const accountOpen = ref(false)
const accountRoot = ref(null)
const railEl = ref(null)
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const isDesktop = hasDesktopBridge()
const themeShortcut = isDesktop
  ? isMac
    ? '⌘⇧L'
    : 'Ctrl+Shift+L'
  : isMac
    ? '⌥⇧L'
    : 'Alt+Shift+L'

/* The second tier is a working surface, not fixed chrome: some histories need
   more width than others. The width belongs to the window, like the fold. */
const WIDTH_KEY = 'entity.rail.width'
const MIN_WIDTH = 190
const MAX_WIDTH = 360
const DEFAULT_WIDTH = 236
const railWidth = ref(DEFAULT_WIDTH)
const resizing = ref(false)
let resizeStartX = 0
let resizeStartWidth = DEFAULT_WIDTH
let resizeWidth = DEFAULT_WIDTH
let resizeFrame = 0

try {
  const stored = localStorage.getItem(WIDTH_KEY)
  if (stored !== null) {
    const saved = Number(stored)
    if (Number.isFinite(saved)) railWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, saved))
  }
} catch {
  /* private mode: keep the default */
}

/* The root owns the custom property so a drag can move the second tier without
   re-rendering the rail on every pointer sample. */
const railStyle = computed(() => ({ '--rail-w': `${railWidth.value}px` }))

function storeWidth() {
  try {
    localStorage.setItem(WIDTH_KEY, String(railWidth.value))
  } catch {
    /* session-only */
  }
}

function startResize(event) {
  if (collapsed.value || event.button !== 0) return
  event.preventDefault()
  resizing.value = true
  resizeStartX = event.clientX
  resizeStartWidth = railWidth.value
  resizeWidth = railWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
}

function onResizeMove(event) {
  if (!resizing.value) return
  resizeWidth = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, resizeStartWidth + event.clientX - resizeStartX),
  )
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    railEl.value?.style.setProperty('--rail-w', `${resizeWidth}px`)
  })
}

function stopResize() {
  if (!resizing.value) return
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  resizing.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  railEl.value?.style.setProperty('--rail-w', `${resizeWidth}px`)
  railWidth.value = resizeWidth
  storeWidth()
}

function nudgeResize(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  railWidth.value = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, railWidth.value + (event.key === 'ArrowRight' ? 8 : -8)),
  )
  storeWidth()
}

function resetWidth() {
  railWidth.value = DEFAULT_WIDTH
  storeWidth()
}

/* the second tier folds away; the icon tier stays. The choice belongs to the
   window, not the workspace, so it lives beside the other UI preferences */
const COLLAPSE_KEY = 'entity.rail.collapsed'
const collapsed = ref(false)
try {
  collapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1'
} catch {
  /* private mode: start expanded */
}

function toggleRail() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
  } catch {
    /* session-only */
  }
}

function expandRail() {
  if (!collapsed.value) return
  collapsed.value = false
  try {
    localStorage.setItem(COLLAPSE_KEY, '0')
  } catch {
    /* session-only */
  }
}

function openRailPanel(panel) {
  expandRail()
  hub.rail.entities = panel === 'entities'
  hub.rail.artifacts = panel === 'artifacts'
}

function onPanelClick(item) {
  if (isActive(item)) toggleRail()
  else openRailPanel(item.panel)
}

function onNavClick(item, event) {
  if (item.view === 'overview') {
    hub.rail.entities = false
    hub.rail.artifacts = false
    if (collapsed.value) expandRail()
    return
  }
  if (isActive(item)) {
    event.preventDefault()
    toggleRail()
    return
  }
  /* A directory panel belongs to the section that opened it. Moving to Chat or
     Configurations must close it before the duplicate-navigation check, or a
     click on the same route leaves the old shelf in the rail. */
  hub.rail.entities = false
  hub.rail.artifacts = false
  expandRail()
}

/* A route move means the section's own list should win again. */
watch(
  () => route.fullPath,
  () => {
    hub.rail.entities = false
    hub.rail.artifacts = false
  },
)

onMounted(() => {
  ensureChats()
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKey)
  stopResize()
})

function toggleAccount() {
  accountOpen.value = !accountOpen.value
}

function onDocumentClick(event) {
  if (!accountOpen.value || accountRoot.value?.contains(event.target)) return
  accountOpen.value = false
}

function onDocumentKey(event) {
  if (event.key === 'Escape') accountOpen.value = false
  const target = event.target
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  if (editable) return

  const key = event.key.toLowerCase()
  const code = event.code
  const primary = (event.metaKey || event.ctrlKey) && !event.altKey

  if (!primary || event.shiftKey) return
  if (key !== 'b' && code !== 'KeyB') return
  event.preventDefault()
  toggleRail()
}

function openAccountPage() {
  accountOpen.value = false
  router.push('/account')
}

const NAV = [
  { name: 'overview', view: 'overview', label: 'Overview', icon: 'grid' },
  { panel: 'entities', view: 'entities', label: 'Entities', icon: 'agent', count: () => hub.agents.length },
  {
    panel: 'artifacts',
    view: 'artifacts',
    label: 'Artifacts',
    icon: 'artifact',
    count: () => artifacts.items.length,
  },
  { name: 'chat', view: 'chat', label: 'Chat', icon: 'chat', count: () => hub.chat.summaries.length },
  {
    name: 'workspace',
    view: 'configurations',
    label: 'Configurations',
    icon: 'sliders',
  },
]

const CONFIG_ROUTES = new Set(['workspace', 'skills', 'skill', 'mcp', 'machines', 'machine', 'activity'])
const onWorkspaces = computed(() => route.name === 'workspaces')
const onOverview = computed(() => route.name === 'overview')
const showContext = computed(
  () => !onWorkspaces.value && (!onOverview.value || hub.rail.entities || hub.rail.artifacts),
)

function isActive(item) {
  const panelOpen = hub.rail.entities || hub.rail.artifacts
  if (panelOpen) return item.panel ? hub.rail[item.panel] : false
  if (item.panel === 'entities') return route.name === 'entity'
  if (item.panel === 'artifacts') return route.name === 'artifact'
  if (item.view === 'configurations') return CONFIG_ROUTES.has(String(route.name || ''))
  return route.name === item.name
}
const user = computed(() => hub.session?.user || 'no session')

/* "you@example.dev" → "You" in the account menu, the full handle underneath */
const displayName = computed(() => {
  const local = user.value.split('@')[0]
  return (
    local
      .split(/[._-]/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(' ') || user.value
  )
})
/* The rail says what this person may do, not where their mail is delivered. */
const role = computed(() => roleById(hub.session?.role || 'owner'))
const avatar = computed(() => initials(displayName.value) || 'as')
const avatarUrl = computed(() => gravatarUrl(hub.session?.email || '', 72))
const accountTip = computed(() => `Account · ${displayName.value} (${role.value.label})`)

function leave() {
  accountOpen.value = false
  signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <aside
    ref="railEl"
    class="rail"
    :data-collapsed="collapsed ? '1' : '0'"
    :data-resizing="resizing ? '1' : '0'"
    :data-panel="hub.rail.entities || hub.rail.artifacts ? '1' : '0'"
    :style="railStyle"
  >
    <div class="rail-t1">
      <header class="rail-t1-head">
        <router-link
          class="rail-brand"
          to="/workspaces"
          aria-label="All workspaces"
          data-tip="All workspaces"
          data-sfx="workspace"
          :aria-current="onWorkspaces ? 'page' : undefined"
        >
          <BrandMark />
        </router-link>
      </header>

      <nav v-if="!onWorkspaces" class="rail-nav" aria-label="Workspace">
        <template v-for="item in NAV" :key="item.view">
          <router-link
            v-if="item.name"
            class="rail-ico"
            :to="{ name: item.name, params: { workspace: hub.workspace } }"
            :aria-current="isActive(item) ? 'page' : undefined"
            :aria-label="item.label"
            :data-tip="item.label"
            data-sfx="nav"
            @click="onNavClick(item, $event)"
          >
            <NavIcon :name="item.icon" />
            <span v-if="item.count && item.count()" class="rail-badge">{{ item.count() }}</span>
          </router-link>
          <button
            v-else
            class="rail-ico"
            type="button"
            :aria-current="isActive(item) ? 'page' : undefined"
            :aria-label="item.label"
            :data-tip="item.label"
            data-sfx="nav"
            @click="onPanelClick(item)"
          >
            <NavIcon :name="item.icon" />
            <span v-if="item.count && item.count()" class="rail-badge">{{ item.count() }}</span>
          </button>
        </template>
      </nav>

      <div class="rail-t1-spacer"></div>

      <button
        class="rail-ico rail-theme"
        type="button"
        :aria-pressed="themeMode === 'dark' ? 'true' : 'false'"
        :aria-label="`${themeMode === 'dark' ? 'Switch to light' : 'Switch to dark'} mode (${themeShortcut})`"
        :data-tip="`${themeMode === 'dark' ? 'Switch to light' : 'Switch to dark'} (${themeShortcut})`"
        data-sfx="off"
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

      <div ref="accountRoot" class="account rail-account" :data-open="accountOpen ? '1' : '0'">
        <div class="acct-menu" role="menu" aria-label="Account">
          <div class="acct-head">
            <span class="acct-nm">{{ displayName }}</span>
            <span class="acct-em">{{ role.label }}</span>
          </div>
          <button class="pickopt" type="button" role="menuitem" data-sfx="nav" @click="openAccountPage">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
              <circle cx="8" cy="8" r="2.2" />
              <path
                d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
              />
            </svg>
            Account settings
          </button>
          <button class="pickopt acct-signout" type="button" role="menuitem" data-sfx="close" @click="leave">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6" />
              <path d="M10.5 5l3 3-3 3M6.8 8h6.7" />
            </svg>
            Sign out
          </button>
        </div>

        <button
          class="user rail-user"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="accountOpen ? 'true' : 'false'"
          :aria-label="accountTip"
          :data-tip="accountTip"
          data-sfx="nav"
          @click="toggleAccount"
        >
          <img v-if="avatarUrl" class="avatar avatar-img" :src="avatarUrl" alt="" />
          <span v-else class="avatar">{{ avatar }}</span>
          <span class="who">
            {{ displayName }}
            <span>{{ role.label }}</span>
          </span>
        </button>
      </div>
    </div>

    <RailContext v-if="showContext" />

    <button
      v-if="showContext"
      class="rail-resize"
      type="button"
      role="separator"
      aria-orientation="vertical"
      :aria-label="`Resize context panel, ${railWidth} pixels`"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="MAX_WIDTH"
      :aria-valuenow="railWidth"
      title="Drag to resize context panel · double-click to reset"
      @pointerdown="startResize"
      @keydown="nudgeResize"
      @dblclick="resetWidth"
    ></button>
  </aside>
</template>
