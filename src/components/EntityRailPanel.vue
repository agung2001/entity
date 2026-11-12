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
  router.push({ name: 'entity', params: { name: entity.id } })
}

function created(entity) {
  adding.value = false
  router.push({ name: 'entity', params: { name: entity.name } })
}
</script>

<template>
  <div class="rail-panel rail-entity-panel">
    <div class="rail-panel-tools">
      <label class="rail-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="search" type="search" placeholder="Search entities" aria-label="Search entities" autocomplete="off" />
      </label>
      <button class="rail-panel-add" type="button" title="Add entity" aria-label="Add entity" @click="adding = true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      </button>
    </div>

    <div class="rail-filter-chips" role="group" aria-label="Filter entities by state">
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

    <p v-if="!list.length" class="rail-t2-empty">
      {{ hub.agents.length ? 'No entity matches this view.' : 'No entities yet.' }}
    </p>
    <div
      v-for="entity in list"
      :key="entity.id"
      class="rail-t2-row rail-entity-row"
      :data-on="route.name === 'entity' && route.params.name === entity.id ? '1' : '0'"
    >
      <button class="rail-t2-open" type="button" @click="open(entity)">
        <EntityMark mini :entity="entity.name" />
        <span class="t">
          <b>{{ entity.name }}</b>
          <span class="m">{{ entity.status }} · {{ threadsFor(entity.name) }} threads</span>
        </span>
      </button>
      <EntityActions :entity="entity" />
    </div>

    <EntityCreateDialog v-if="adding" @close="adding = false" @created="created" />
  </div>
</template>
