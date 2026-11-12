<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityActions from '@/components/EntityActions.vue'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import { HARNESSES, MODELS } from '@/data/mock'
import { COLORS, MOODS, SHAPES, setMark } from '@/composables/entityMark'
import { matchesQuery } from '@/composables/search'
import { scaffoldEntity } from '@/stores/entities'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'
import { ago, ensureChats, harnessById, hub, machineById, toast } from '@/stores/hub'

/**
 * The entity table is a directory listing. Every row is a file in
 * `<workspace>/entities/`; "Add entity" scaffolds one and opens it, so the hub
 * never holds an entity that is not on disk.
 */
const FILTERS = ['all', 'running', 'idle', 'sleep', 'error']
const router = useRouter()

const adding = ref(false)
const search = ref('')
const openId = ref('')
const name = ref('')
const description = ref('')
const harness = ref('claude')
const model = ref('')
const error = ref('')
const busy = ref(false)
const nameInput = ref(null)

const harnessOptions = computed(() =>
  HARNESSES.map((item) => {
    const found = harnesses.items.find((entry) => entry.id === item.id)
    return {
      id: item.id,
      label: item.label,
      meta: found ? (found.installed ? 'installed' : 'not found') : '',
    }
  }),
)
const modelData = computed(() => harnesses.models[harness.value] || null)
const modelOptions = computed(() => [
  ...new Set([...(modelData.value?.models || []), ...(MODELS[harness.value] || [])]),
])
const modelLoading = computed(() => Boolean(modelData.value?.loading))

/** A new entity gets a mark up front, deterministically from its name. */
function markForName(value) {
  let hash = 5381
  for (const char of String(value || '')) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0
  const shapes = SHAPES.length > 1 ? SHAPES.slice(1) : SHAPES
  const moods = MOODS.length > 1 ? MOODS.slice(1) : MOODS
  return {
    shape: shapes[hash % shapes.length].id,
    color: COLORS[(hash >>> 7) % COLORS.length].id,
    mood: moods[(hash >>> 13) % moods.length].id,
  }
}

const lastChat = (name) => {
  const thread = hub.chat.summaries.find((item) => item.entity === name)
  return thread ? ago(thread.updatedAt) : 'never'
}

onMounted(ensureChats)

watch(harness, () => {
  model.value = ''
  loadModels(harness.value).catch(() => {})
})

const filterCounts = computed(() => {
  const counts = { all: hub.agents.length }
  for (const state of ['running', 'idle', 'sleep', 'error']) {
    counts[state] = hub.agents.filter((agent) => agent.status === state).length
  }
  return counts
})

const list = computed(() => {
  const q = search.value
  return hub.agents.filter((agent) => {
    if (hub.entityFilter !== 'all' && agent.status !== hub.entityFilter) return false
    return matchesQuery(`${agent.name} ${agent.desc} ${agent.harnessLabel}`, q)
  })
})

const threadsFor = (name) => hub.chat.summaries.filter((thread) => thread.entity === name)
const threadTurns = (thread) => (thread.queries || 0) + (thread.replies || 0)
const threadLink = (thread) => ({ name: 'chat', query: { thread: thread.id } })

function toggleThreads(id) {
  openId.value = openId.value === id ? '' : id
}

watch([search, () => hub.entityFilter], () => {
  openId.value = ''
})

const dotState = (status) =>
  ({ running: 'live', idle: 'idle', sleep: 'sleep', error: 'fail' })[status] || 'idle'

const machineLabel = (id) => machineById(id)?.label || id

function openFromKeyboard(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    router.push({ name: 'entity', params: { name: id } })
  }
}

const slug = computed(() =>
  String(name.value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''),
)

async function startAdd() {
  adding.value = true
  error.value = ''
  name.value = ''
  description.value = ''
  harness.value = HARNESSES[0].id
  model.value = ''
  loadHarnesses().catch(() => {})
  loadModels(harness.value).catch(() => {})
  await nextTick()
  nameInput.value?.focus()
}

function cancelAdd() {
  adding.value = false
  error.value = ''
  name.value = ''
  description.value = ''
  model.value = ''
}

async function create() {
  if (busy.value) return
  error.value = ''
  if (!slug.value) {
    error.value = 'Use lowercase letters, digits and dashes.'
    return
  }
  if (!description.value.trim()) {
    error.value = 'Add a short description so the entity knows what it is for.'
    return
  }
  busy.value = true
  try {
    const mark = markForName(slug.value)
    const created = await scaffoldEntity({
      name: slug.value,
      harness: harness.value,
      model: model.value,
      description: description.value,
      mark,
    })
    setMark({ workspace: hub.workspace, entity: created.name, ...mark, persist: true })
    adding.value = false
    toast(`${created.name}.md created`)
    router.push({ name: 'entity', params: { name: created.name } })
  } catch (problem) {
    error.value = problem?.message || 'The file could not be created.'
  } finally {
    busy.value = false
  }
}
</script>


<template>
  <div class="view edir-view">
    <header class="page-head edir-head">
      <div>
        <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Entities</h1>
        <p class="lede">
          Every entity this workspace has, one file each in <code class="mono">entities/</code>.
          Open a row to read what it is and every conversation it has had on this machine.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn btn-ink" @click="startAdd">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add entity
        </button>
      </div>
    </header>

    <div class="edir-tool">
      <label class="edir-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="search" type="search" placeholder="Search name or description" aria-label="Search entities" autocomplete="off" />
      </label>
      <div class="edir-filters" role="group" aria-label="Filter by state">
        <button
          v-for="f in FILTERS"
          :key="f"
          type="button"
          :aria-pressed="hub.entityFilter === f ? 'true' : 'false'"
          @click="hub.entityFilter = f"
        >
          {{ f === 'all' ? 'All' : f }}<b>{{ filterCounts[f] }}</b>
        </button>
      </div>
      <span class="edir-count">{{ list.length }} of {{ hub.agents.length }} entities</span>
    </div>

    <div v-if="list.length" class="edir-table">
      <div class="edir-head-row">
        <span>Entity</span><span>State</span><span>Machines</span><span>Conversations</span><span class="edir-actions-head">Actions</span>
      </div>
      <template v-for="a in list" :key="a.id">
        <div
          class="edir-row"
          :data-open="openId === a.id ? '1' : '0'"
          tabindex="0"
          role="button"
          @click="router.push({ name: 'entity', params: { name: a.id } })"
          @keydown="openFromKeyboard($event, a.id)"
        >
          <span class="cell-agent">
            <EntityMark :entity="a.name" />
            <span class="edir-ident">
              <span class="nm2">
                {{ a.name }}
                <em v-if="a.problems.length" class="row-warn" :title="a.problems.join('\n')">{{ a.problems.length }}</em>
              </span>
              <span class="sub2 edir-desc">{{ a.desc }}</span>
            </span>
          </span>
          <span class="state" :data-s="dotState(a.status)"><i></i>{{ a.status }}</span>
          <span class="edir-machines">
            <span class="chipm chipm--harness"><HarnessIcon :name="a.harness" :size="10" />{{ a.harnessLabel }}</span>
            <span v-for="m in a.machines" :key="m" class="chipm"><MachineIcon :size="10" />{{ machineLabel(m) }}</span>
            <span v-if="!a.machines.length" class="unplaced">nowhere</span>
          </span>
          <button
            class="edir-thrcell"
            type="button"
            :aria-expanded="openId === a.id ? 'true' : 'false'"
            @click.stop="toggleThreads(a.id)"
          >
            <span class="edir-thrtop">
              <span class="n">{{ threadsFor(a.name).length }} {{ threadsFor(a.name).length === 1 ? 'thread' : 'threads' }}</span>
              <span v-if="threadsFor(a.name).length" class="when">{{ ago(threadsFor(a.name)[0].updatedAt) }}</span>
            </span>
            <span class="edir-thrq">
              {{ threadsFor(a.name).length ? (threadsFor(a.name)[0].preview || 'No question asked yet') : 'No conversations yet' }}
            </span>
          </button>
          <EntityActions :entity="a" />
        </div>
        <div v-if="openId === a.id" class="edir-drawer">
          <div class="edir-drawer-head">
            <span>{{ threadsFor(a.name).length }} {{ threadsFor(a.name).length === 1 ? 'conversation' : 'conversations' }}</span>
            <router-link :to="{ name: 'entity', params: { name: a.name } }">Open entity →</router-link>
          </div>
          <router-link v-for="t in threadsFor(a.name)" :key="t.id" class="edir-thr" :to="threadLink(t)">
            <span class="edir-tm">{{ ago(t.updatedAt) }}</span>
            <span class="edir-thrbody">
              <b>{{ t.title || t.preview || 'No question asked yet' }}</b>
              <span>
                <MachineIcon :size="9" /> {{ machineLabel(t.machine) }}
                <span aria-hidden="true">·</span>
                <HarnessIcon :name="t.harness" :size="9" /> {{ harnessById(t.harness).label }}
                <span aria-hidden="true">·</span>
                {{ threadTurns(t) }} {{ threadTurns(t) === 1 ? 'turn' : 'turns' }}
              </span>
            </span>
            <svg class="edir-go" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 2l4 4-4 4" /></svg>
          </router-link>
          <p v-if="!threadsFor(a.name).length" class="edir-empty-thr">Nothing has been asked of {{ a.name }} yet.</p>
        </div>
      </template>
    </div>

    <div v-else class="empty-note edir-empty">
      <b>{{ hub.agents.length ? 'Nothing matches.' : 'No entities yet.' }}</b>
      <span>
        {{ hub.agents.length ? 'Search covers the name and description. Clear the filter to see the rest.' : 'An entity is a markdown file with its own instructions, skills and conversations.' }}
      </span>
      <button v-if="hub.agents.length" class="btn" type="button" @click="search = ''; hub.entityFilter = 'all'">Clear filters</button>
      <button v-else class="btn btn-ink" type="button" @click="startAdd">Add entity</button>
    </div>

    <p class="edir-foot">
      <span><b>{{ hub.agents.length }}</b> entities · <b>{{ hub.chat.summaries.length }}</b> conversations</span>
      <span class="r">A thread is a file in <b>chats/</b>; opening one takes you straight to it in Chat.</span>
    </p>

    <div class="modal modal-narrow" :data-open="adding ? '1' : '0'" role="dialog" aria-modal="true" aria-label="Add entity">
      <div class="mo-head">
        <h2>Add entity</h2>
        <p>Writes <code class="mono">entities/{{ slug || 'name' }}.md</code> with a harness and a working directory you can edit.</p>
        <button class="x mo-x" aria-label="Close" @click="cancelAdd">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>
      <form class="mo-body" @submit.prevent="create">
        <div class="fld">
          <label class="lbl" for="ent-name">Name</label>
          <input id="ent-name" ref="nameInput" v-model="name" type="text" placeholder="py-agent" spellcheck="false" :disabled="busy" @input="error = ''" />
          <p class="mnote">File: <code class="mono">entities/{{ slug || 'name' }}.md</code></p>
        </div>
        <div class="fld">
          <label class="lbl" for="ent-desc">Description</label>
          <textarea
            id="ent-desc"
            v-model="description"
            rows="3"
            placeholder="What this entity owns, who it helps, and what a finished job looks like."
            :disabled="busy"
            @input="error = ''"
          ></textarea>
          <p class="mnote">Saved as the entity's starting brief. Its harness expands this into the full instructions.</p>
        </div>
        <div class="fld">
          <span class="lbl">Harness</span>
          <PickMenu
            class="field-select"
            head="Harness"
            icons="harness"
            :options="harnessOptions"
            :model-value="harness"
            :disabled="busy"
            @update:model-value="harness = $event"
          />
        </div>
        <div class="fld">
          <span class="lbl">Model</span>
          <ModelInput
            :model-value="model"
            :options="modelOptions"
            :loading="modelLoading"
            :disabled="busy"
            label="Model"
            :placeholder="modelData?.default || 'harness default'"
            @update:model-value="model = $event"
          />
          <p class="mnote">Written as <code class="mono">model:</code> in the entity file. Leave blank to let {{ HARNESSES.find((h) => h.id === harness)?.label || harness }} choose.</p>
        </div>
        <p v-if="error" class="run-warn">{{ error }}</p>
        <div class="mo-foot" style="padding: 8px 0 0; border: 0">
          <button class="btn" type="button" :disabled="busy" @click="cancelAdd">Cancel</button>
          <button class="btn btn-ink" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create Entity' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
