<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import NavIcon from '@/components/NavIcon.vue'
import RailContext from '@/components/RailContext.vue'
import UpdateBadge from '@/components/UpdateBadge.vue'
import { ensureChats, hub, initials, roleById, signOut } from '@/stores/hub'
import { isEditable } from '@/lib/dom'
import { NAV, isActive as isActiveNav, linkFor } from '@/lib/nav'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { gravatarUrl } from '@/lib/gravatar'
import { themeMode, toggleTheme } from '@/lib/theme'

const route = useRoute()
const router = useRouter()

/* The phone appbar, the drawer and the account sheet only exist at ≤ 820 px.
   One media query, matched in script as well as in CSS, so the same markup can
   carry a menu on a desktop window and a dialog on a phone. */
const compact = ref(false)
let compactQuery = null
function syncCompact(event) {
  compact.value = event.matches
}
onMounted(() => {
  compactQuery = window.matchMedia('(max-width: 820px)')
  compact.value = compactQuery.matches
  compactQuery.addEventListener('change', syncCompact)
})

const accountOpen = ref(false)
const accountRoot = ref(null)
const railEl = ref(null)
const themeShortcut = shortcutLabel('theme')

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
  /* Entities is a page now, not a shelf: the row is a link, so a click always
     navigates — to the index from anywhere, or nowhere when it is already open.
     Folding the rail out from under the page it just opened is not a gesture
     anybody asked for. */
  if (item.name === 'entities') {
    hub.rail.entities = false
    hub.rail.artifacts = false
    expandRail()
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
    hub.rail.drawer = false
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
  compactQuery?.removeEventListener('change', syncCompact)
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
  if (isEditable(event.target)) return

  if (event.key === 'Escape') {
    if (hub.rail.drawer) hub.rail.drawer = false
    accountOpen.value = false
    return
  }
  if (!matchesShortcut('rail', event)) return
  event.preventDefault()
  toggleRail()
}

/* What section this is, for the appbar's first line. The drawer names the
   section too, so the two never disagree. */
const SECTION_TITLES = {
  workspaces: 'All workspaces',
  overview: 'Overview',
  chat: 'Chat',
  entities: 'Entities',
  entity: 'Entities',
  artifact: 'Artifacts',
  artifacts: 'Artifacts',
  news: 'News',
  /* all five goals routes carry `crumb: 'goals'`, so the detail and create
     steps land here too */
  goals: 'Goals',
  account: 'Account',
}
const sectionTitle = computed(() => {
  if (hub.rail.entities) return 'Entities'
  if (hub.rail.artifacts) return 'Artifacts'
  const name = String(route.name || '')
  return SECTION_TITLES[name] || SECTION_TITLES[route.meta.crumb] || 'Configurations'
})

function closeOverlays() {
  hub.rail.drawer = false
  accountOpen.value = false
}

function openAccountPage() {
  accountOpen.value = false
  router.push('/account')
}

const onWorkspaces = computed(() => route.name === 'workspaces')
const onOverview = computed(() => route.name === 'overview')
/* Two ways to have no second tier: the destinations that never had one, and a
   route that says so itself in `meta.rail`. The second one exists because the
   first is a blocklist — `news` arrived and inherited a machine list beside it,
   and the phone drew a drawer button that opened nothing. */
const showContext = computed(
  () =>
    !onWorkspaces.value &&
    route.meta.rail !== false &&
    (!onOverview.value || hub.rail.entities || hub.rail.artifacts || hub.rail.drawer),
)

/* The tab index is the destination the current address belongs to. Two panels
   take part: an entity page is "Entities", an artifact page is "Artifacts". */
function isActive(item) {
  return isActiveNav(item, route)
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
    :data-drawer="hub.rail.drawer ? '1' : '0'"
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

      <!-- the phone appbar shows what section this is, over the workspace name -->
      <span class="ab-title">
        <span class="ab-sec">{{ sectionTitle }}</span>
        <span class="ab-ws">{{ hub.workspaceLabel || hub.workspace }}</span>
      </span>

      <nav v-if="!onWorkspaces" class="rail-nav" aria-label="Workspace">
        <template v-for="item in NAV" :key="item.view">
          <router-link
            v-if="item.name"
            class="rail-ico"
            :to="linkFor(item)"
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

      <UpdateBadge />

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

      <button
        v-if="showContext"
        class="ab-drawer"
        type="button"
        :aria-label="`Open the ${sectionTitle} panel`"
        :aria-expanded="hub.rail.drawer ? 'true' : 'false'"
        @click="hub.rail.drawer = !hub.rail.drawer"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2.2 4.4h11.6M2.2 8h11.6M2.2 11.6h7.2" />
        </svg>
      </button>

      <button class="ab-search" type="button" aria-label="Search" @click="hub.palette.open = true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.5 10.5L14 14" />
        </svg>
      </button>

      <div ref="accountRoot" class="account rail-account" :data-open="accountOpen ? '1' : '0'">
        <div
          class="acct-menu"
          :role="compact ? 'dialog' : 'menu'"
          :aria-modal="compact ? 'true' : undefined"
          aria-label="Account"
        >
          <span class="as-grabber" aria-hidden="true"></span>
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
          <button class="pickopt acct-theme" type="button" role="menuitem" data-sfx="off" @click="toggleTheme">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M13.4 10.2A6 6 0 016.2 2.7 6.2 6.2 0 1013.4 10.2z" />
            </svg>
            {{ themeMode === 'dark' ? 'Light theme' : 'Dark theme' }}
          </button>
          <div class="as-upd"><UpdateBadge /></div>
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

    <div
      class="rail-scrim"
      :data-open="hub.rail.drawer || accountOpen ? '1' : '0'"
      @click="closeOverlays"
    ></div>

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
