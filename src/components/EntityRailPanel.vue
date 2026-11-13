<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityActions from '@/components/EntityActions.vue'
import EntityCreateDialog from '@/components/EntityCreateDialog.vue'
import EntityMark from '@/components/EntityMark.vue'
import { matchesQuery } from '@/composables/search'
import { ensureChats, hub } from '@/stores/hub'

/** The entity directory lives in the second tier; a row opens the detail page. */
const route = useRoute()
const router = useRouter()
const search = ref('')
const adding = ref(false)
const filtersOpen = ref(false)
const FILTERS = ['all', 'running', 'idle', 'sleep', 'error']

onMounted(ensureChats)

const filterCounts = computed(() => {
  const counts = { all: hub.agents.length }
  for (const state of ['running', 'idle', 'sleep', 'error']) {
    counts[state] = hub.agents.filter((agent) => agent.status === state).length
  }
  return counts
})

const list = computed(() =>
  hub.agents.filter((agent) => {
    if (hub.entityFilter !== 'all' && agent.status !== hub.entityFilter) return false
    return matchesQuery(`${agent.name} ${agent.desc} ${agent.harnessLabel}`, search.value)
  }),
)

const threadsFor = (name) => hub.chat.summaries.filter((thread) => thread.entity === name).length

function open(entity) {
  hub.rail.entities = false
  router.push({ name: 'entity', params: { workspace: hub.workspace, name: entity.id } })
}

const healthOf = (status) => {
  if (status === 'running') return 'working'
  if (status === 'error') return 'failed'
  return 'done'
}

function created(entity) {
  adding.value = false
  router.push({ name: 'entity', params: { workspace: hub.workspace, name: entity.name } })
}

defineExpose({
  openCreate() {
    adding.value = true
  },
})
</script>

<template>
  <div class="rail-panel rail-entity-panel">
    <div class="rail-panel-tools rail-search-row">
      <label class="rail-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="search" type="search" placeholder="Search entities" aria-label="Search entities" autocomplete="off" />
      </label>
      <button
        class="rail-filter-btn"
        type="button"
        :data-active="hub.entityFilter !== 'all' ? '1' : '0'"
        :aria-expanded="filtersOpen ? 'true' : 'false'"
        aria-controls="rail-entity-filters"
        title="Advanced filters"
        aria-label="Advanced filters"
        @click="filtersOpen = !filtersOpen"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
        <i v-if="hub.entityFilter !== 'all'" aria-hidden="true"></i>
      </button>
    </div>

    <div v-if="filtersOpen" id="rail-entity-filters" class="rail-advanced">
      <div class="rail-filter">
        <span class="rail-filter-label">State</span>
        <div class="rail-filter-chips rail-filter-chips--grid" role="group" aria-label="Filter entities by state">
          <button
            v-for="state in FILTERS"
            :key="state"
            type="button"
            :aria-pressed="hub.entityFilter === state ? 'true' : 'false'"
            @click="hub.entityFilter = state"
          >
            {{ state === 'all' ? 'All' : state }} <b>{{ filterCounts[state] }}</b>
          </button>
        </div>
      </div>
    </div>

    <p v-if="!list.length" class="rail-t2-empty">
      {{ hub.agents.length ? 'No entity matches this view.' : 'No entities yet.' }}
    </p>
    <div
      v-for="entity in list"
      :key="entity.id"
      class="rail-entity-row"
      :data-on="route.name === 'entity' && route.params.name === entity.id ? '1' : '0'"
    >
      <button class="rail-entity-open" type="button" @click="open(entity)">
        <EntityMark mini animate :badge="false" :entity="entity.name" />
        <span class="rail-entity-copy">
          <b>{{ entity.name }}</b>
          <span class="rail-entity-meta">
            <span class="rchat-health" :data-s="healthOf(entity.status)"><i></i>{{ entity.status }}</span>
            <span>{{ threadsFor(entity.name) }} {{ threadsFor(entity.name) === 1 ? 'thread' : 'threads' }}</span>
            <span class="rail-entity-sep" aria-hidden="true">·</span>
            <span>{{ entity.harnessLabel }}</span>
          </span>
        </span>
      </button>
      <EntityActions :entity="entity" />
    </div>

    <EntityCreateDialog v-if="adding" @close="adding = false" @created="created" />
  </div>
</template>
