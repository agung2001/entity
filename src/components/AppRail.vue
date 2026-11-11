<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue'
import { hub, initials, signOut } from '@/stores/hub'

const route = useRoute()
const router = useRouter()

const NAV = [
  { to: '/', view: 'overview', label: 'Overview', icon: 'grid' },
  { to: '/chat', view: 'chat', label: 'Chat', icon: 'chat' },
  { to: '/entities', view: 'entities', label: 'Entities', icon: 'agent', count: () => hub.agents.length },
  { to: '/skills', view: 'skills', label: 'Skills', icon: 'star', count: () => hub.skills.length },
  { to: '/machines', view: 'machines', label: 'Machines', icon: 'screen', count: () => hub.machines.length },
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
const handle = computed(() => {
  const local = user.value.split('@')[0]
  return `${local}@studio-mac`
})
const avatar = computed(() => initials(displayName.value) || 'as')

function leave() {
  signOut()
  router.push({ name: 'login' })
}
</script>

<template>
  <aside class="rail">
    <router-link class="brand" to="/">
      <EntityMark />
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
        <svg v-else-if="item.icon === 'screen'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="1.6" y="2.6" width="12.8" height="8.2" rx="1.6" />
          <path d="M5.4 13.6h5.2" />
        </svg>
        <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <path d="M2 11.4l3.2-4.5 2.6 2.4L10.6 4l3.4 4.2" />
          <path d="M2 14h12" />
        </svg>
        {{ item.label }}
        <span v-if="item.count" class="count">{{ item.count() }}</span>
      </router-link>
    </nav>

    <div class="rail-foot">
      <div class="sync"><i></i> ssh reachable · {{ hub.machines.length }} machines</div>
      <button class="user" type="button" title="Sign out" @click="leave">
        <span class="avatar">{{ avatar }}</span>
        <span class="who">
          {{ displayName }}
          <span>{{ handle }}</span>
        </span>
      </button>
    </div>
  </aside>
</template>
