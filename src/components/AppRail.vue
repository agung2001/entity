<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import NavIcon from '@/components/NavIcon.vue'
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue'
import { hub, initials, roleById, signOut } from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'
import { artifacts } from '@/stores/artifacts'
import { gravatarUrl } from '@/lib/gravatar'

const route = useRoute()
const router = useRouter()

const accountOpen = ref(false)
const accountRoot = ref(null)
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const railShortcut = isMac ? '⌘B' : 'Ctrl+B'

/* the rail folds down to its icons; the choice belongs to the window, not the
   workspace, so it lives beside the other UI preferences */
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

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKey)
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
  if (event.shiftKey || event.altKey) return
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') return
  const target = event.target
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  if (editable) return
  event.preventDefault()
  toggleRail()
}

function openAccountPage() {
  accountOpen.value = false
  router.push('/account')
}

const NAV = [
  { to: '/', view: 'overview', label: 'Overview', icon: 'grid' },
  { to: '/chat', view: 'chat', label: 'Chat', icon: 'chat' },
  { to: '/entities', view: 'entities', label: 'Entities', icon: 'agent', count: () => hub.agents.length },
  {
    to: '/artifacts',
    view: 'artifacts',
    label: 'Artifacts',
    icon: 'artifact',
    count: () => artifacts.items.length,
  },
  { to: '/activity', view: 'activity', label: 'Activity', icon: 'pulse' },
]

/* Plumbing stays behind a disclosure: a person who only chats and writes
   entities should not have to learn what an MCP server is on day one. */
const ADVANCED = [
  {
    to: '/skills',
    view: 'skills',
    label: 'Skills',
    icon: 'star',
    /* the workspace's own skills — the page opens on that tab, and counting the
       machine-wide libraries here would mean scanning them on every launch */
    count: () => workspaces.skills.length,
  },
  {
    to: '/mcp',
    view: 'mcp',
    label: 'MCP',
    icon: 'mcp',
    count: () => Object.keys(workspaces.mcp?.servers || {}).length,
  },
  {
    to: '/machines',
    view: 'machines',
    label: 'Machines',
    icon: 'screen',
    count: () => workspaces.machines.length,
  },
]

const ADVANCED_KEY = 'entity.rail.advanced'
const advancedOpen = ref(false)
try {
  advancedOpen.value = localStorage.getItem(ADVANCED_KEY) === '1'
} catch {
  /* private mode: start closed */
}

const isActive = (item) => route.path === item.to || route.path.startsWith(item.to + '/')
const advancedActive = computed(() => ADVANCED.some(isActive))
const showAdvanced = computed(() => collapsed.value || advancedOpen.value)

function toggleAdvanced() {
  advancedOpen.value = !advancedOpen.value
  try {
    localStorage.setItem(ADVANCED_KEY, advancedOpen.value ? '1' : '0')
  } catch {
    /* session-only */
  }
}

/* A deep link (or the palette) should reveal the section it lands in. */
watch(
  () => route.path,
  () => {
    if (advancedActive.value) advancedOpen.value = true
  },
  { immediate: true },
)
const user = computed(() => hub.session?.user || 'no session')

/* "agung@studio.dev" → "Agung" in the rail, the full handle underneath */
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

function leave() {
  accountOpen.value = false
  signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <aside class="rail" :data-collapsed="collapsed ? '1' : '0'">
    <router-link class="brand" to="/" aria-label="entity">
      <BrandMark />
      <span class="wordmark">entity</span>
    </router-link>

    <WorkspaceSwitcher />

    <nav class="nav" aria-label="Workspace">
      <div class="nav-label">Hub</div>
      <router-link
        v-for="item in NAV"
        :key="item.view"
        :to="item.to"
        :aria-current="isActive(item) ? 'page' : undefined"
        :aria-label="item.label"
        :title="collapsed ? item.label : undefined"
      >
        <NavIcon :name="item.icon" />
        <span class="lbl">{{ item.label }}</span>
        <span v-if="item.count" class="count">{{ item.count() }}</span>
      </router-link>

      <button
        class="nav-group"
        type="button"
        :aria-expanded="showAdvanced ? 'true' : 'false'"
        aria-controls="nav-advanced"
        :title="collapsed ? 'Advanced' : undefined"
        @click="toggleAdvanced"
      >
        <span class="lbl">Advanced</span>
        <svg class="nav-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
      </button>

      <div v-if="showAdvanced" id="nav-advanced" class="nav-adv">
        <router-link
          v-for="item in ADVANCED"
          :key="item.view"
          :to="item.to"
          :aria-current="isActive(item) ? 'page' : undefined"
          :aria-label="item.label"
          :title="collapsed ? item.label : undefined"
        >
          <NavIcon :name="item.icon" />
          <span class="lbl">{{ item.label }}</span>
          <span v-if="item.count" class="count">{{ item.count() }}</span>
        </router-link>
      </div>
    </nav>

    <div class="rail-foot">
      <button
        class="rail-toggle"
        type="button"
        :aria-expanded="collapsed ? 'false' : 'true'"
        :title="`${collapsed ? 'Expand' : 'Collapse'} sidebar (${railShortcut})`"
        :aria-label="`${collapsed ? 'Expand' : 'Collapse'} sidebar (${railShortcut})`"
        @click="toggleRail"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M9.6 3.2L5 8l4.6 4.8" />
        </svg>
        <span class="lbl">{{ collapsed ? 'Expand' : 'Collapse' }}</span>
        <kbd class="rail-kbd">{{ railShortcut }}</kbd>
      </button>
      <div ref="accountRoot" class="account" :data-open="accountOpen ? '1' : '0'">
        <div class="acct-menu" role="menu" aria-label="Account">
          <div class="acct-head">
            <span class="acct-nm">{{ displayName }}</span>
            <span class="acct-em">{{ role.label }}</span>
          </div>
          <button class="pickopt" type="button" role="menuitem" @click="openAccountPage">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
              <circle cx="8" cy="8" r="2.2" />
              <path
                d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
              />
            </svg>
            Account settings
          </button>
          <button class="pickopt acct-signout" type="button" role="menuitem" @click="leave">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6" />
              <path d="M10.5 5l3 3-3 3M6.8 8h6.7" />
            </svg>
            Sign out
          </button>
        </div>

        <button
          class="user"
          type="button"
          title="Account"
          aria-haspopup="menu"
          :aria-expanded="accountOpen ? 'true' : 'false'"
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
  </aside>
</template>
