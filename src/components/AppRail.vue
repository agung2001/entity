<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue'
import { hub, initials, roleById, signOut } from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'
import { artifacts } from '@/stores/artifacts'

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
    to: '/artifacts',
    view: 'artifacts',
    label: 'Artifacts',
    icon: 'artifact',
    count: () => artifacts.items.length,
  },
  {
    to: '/machines',
    view: 'machines',
    label: 'Machines',
    icon: 'screen',
    count: () => workspaces.machines.length,
  },
  { to: '/activity', view: 'activity', label: 'Activity', icon: 'pulse' },
]

const isActive = (item) => route.path === item.to || route.path.startsWith(item.to + '/')
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
        <svg v-if="item.icon === 'grid'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.4" />
          <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.4" />
          <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.4" />
          <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.4" />
        </svg>
        <svg v-else-if="item.icon === 'chat'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="1.6" y="2.4" width="12.8" height="8.8" rx="1.6" />
          <path d="M5.2 11.2v2.7l3.1-2.7" />
        </svg>
        <svg v-else-if="item.icon === 'agent'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <circle cx="8" cy="5.4" r="2.9" />
          <path d="M2.6 14c.5-2.6 2.7-4.2 5.4-4.2s4.9 1.6 5.4 4.2" />
        </svg>
        <svg v-else-if="item.icon === 'star'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M8 1.8l1.9 4.1 4.3.5-3.2 3 .9 4.3L8 11.5 4.1 13.7l.9-4.3-3.2-3 4.3-.5z" />
        </svg>
        <svg v-else-if="item.icon === 'mcp'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M4.4 9.2V5.5a1.4 1.4 0 012.8 0v3.4a1.4 1.4 0 002.8 0V5.5a1.4 1.4 0 012.8 0v3.7" />
          <path d="M3.4 9.2h9.2v1.3a4.6 4.6 0 01-9.2 0z" />
          <path d="M8 14.3v.8" />
        </svg>
        <svg v-else-if="item.icon === 'artifact'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M3 2.4h6l4 4v7.2H3z" />
          <path d="M9 2.4v4h4M5.4 9.4h5.2M5.4 11.6h3.4" />
        </svg>
        <svg v-else-if="item.icon === 'screen'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="1.6" y="2.6" width="12.8" height="8.2" rx="1.6" />
          <path d="M5.4 13.6h5.2" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M2 11.4l3.2-4.5 2.6 2.4L10.6 4l3.4 4.2" />
          <path d="M2 14h12" />
        </svg>
        <span class="lbl">{{ item.label }}</span>
        <span v-if="item.count" class="count">{{ item.count() }}</span>
      </router-link>
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
          <span class="avatar">{{ avatar }}</span>
          <span class="who">
            {{ displayName }}
            <span>{{ role.label }}</span>
          </span>
        </button>
      </div>
    </div>
  </aside>
</template>
