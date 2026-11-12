<script setup>
import { computed, nextTick, ref } from 'vue'
import EntityActions from '@/components/EntityActions.vue'
import EntityMark from '@/components/EntityMark.vue'
import { HARNESSES } from '@/data/mock'
import { scaffoldEntity } from '@/stores/entities'
import { hub, machineById, openDrawer, toast } from '@/stores/hub'

/**
 * The entity table is a directory listing. Every row is a file in
 * `<workspace>/entities/`; "Add entity" scaffolds one and opens it, so the hub
 * never holds an entity that is not on disk.
 */
const FILTERS = ['all', 'running', 'idle', 'sleep', 'error']

const adding = ref(false)
const name = ref('')
const harness = ref('claude')
const error = ref('')
const busy = ref(false)
const nameInput = ref(null)

const list = computed(() =>
  hub.entityFilter === 'all'
    ? hub.agents
    : hub.agents.filter((a) => a.status === hub.entityFilter),
)

const dotState = (status) =>
  ({ running: 'live', idle: 'idle', sleep: 'sleep', error: 'fail' })[status] || 'idle'

const machineLabel = (id) => machineById(id)?.label || id

function openFromKeyboard(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openDrawer(id)
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
  harness.value = HARNESSES[0].id
  await nextTick()
  nameInput.value?.focus()
}

function cancelAdd() {
  adding.value = false
  error.value = ''
  name.value = ''
}

async function create() {
  if (busy.value) return
  error.value = ''
  if (!slug.value) {
    error.value = 'Use lowercase letters, digits and dashes.'
    return
  }
  busy.value = true
  try {
    const created = await scaffoldEntity({ name: slug.value, harness: harness.value })
    adding.value = false
    toast(`${created.name}.md created`)
    openDrawer(created.name, 'run')
  } catch (problem) {
    error.value = problem?.message || 'The file could not be created.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Entities</h1>
        <p class="lede">
          Every entity this workspace has, one file each in
          <code class="mono">entities/</code>. Open one to read its instructions or run it
          on this machine.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="startAdd">Add entity</button>
      </div>
    </div>

    <div class="hints" style="margin-bottom: 14px">
      <button
        v-for="f in FILTERS"
        :key="f"
        class="hint"
        :aria-pressed="hub.entityFilter === f ? 'true' : 'false'"
        @click="hub.entityFilter = f"
      >
        {{ f === 'all' ? `All ${hub.agents.length}` : f }}
      </button>
    </div>

    <div class="tbl">
      <div class="tr th">
        <span>Entity</span><span>State</span><span class="col-machines">Machines</span>
        <span class="col-skills">Skills</span><span class="col-last">Last run</span>
        <span class="col-actions">Actions</span>
      </div>
      <div
        v-for="a in list"
        :key="a.id"
        class="tr"
        tabindex="0"
        role="button"
        @click="openDrawer(a.id)"
        @keydown="openFromKeyboard($event, a.id)"
      >
        <span class="cell-agent">
          <EntityMark :entity="a.name" />
          <span>
            <span class="nm2">
              {{ a.name }}
              <em v-if="a.problems.length" class="row-warn" :title="a.problems.join('\n')">
                {{ a.problems.length }}
              </em>
            </span>
            <span class="sub2" style="max-width: 38ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ a.desc }}
            </span>
          </span>
        </span>
        <span class="col-state">
          <span class="state" :data-s="dotState(a.status)"><i></i>{{ a.status }}</span>
        </span>
        <span class="col-machines">
          <template v-if="a.machines.length">
            <span v-for="m in a.machines" :key="m" class="chipm">{{ machineLabel(m) }}</span>
          </template>
          <span v-else class="unplaced">nowhere</span>
        </span>
        <span class="num col-skills">{{ a.skills.length }}</span>
        <span class="last col-last">{{ a.last }}</span>
        <EntityActions :entity="a" />
      </div>
      <div
        v-if="!list.length"
        class="tr"
        style="grid-column: 1 / -1; cursor: default; color: var(--muted); font-size: 12.5px"
      >
        {{
          hub.agents.length
            ? 'No entity in this state.'
            : 'No entities yet. Add one — it creates a real markdown file.'
        }}
      </div>
    </div>

    <div class="modal modal-narrow" :data-open="adding ? '1' : '0'" role="dialog" aria-modal="true" aria-label="Add entity">
      <div class="mo-head">
        <h2>Add entity</h2>
        <p>
          Writes <code class="mono">entities/{{ slug || 'name' }}.md</code> with a harness
          and a working directory you can edit.
        </p>
        <button class="x mo-x" aria-label="Close" @click="cancelAdd">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <form class="mo-body" @submit.prevent="create">
        <div class="fld">
          <label class="lbl" for="ent-name">Name</label>
          <input
            id="ent-name"
            ref="nameInput"
            v-model="name"
            type="text"
            placeholder="py-agent"
            spellcheck="false"
            :disabled="busy"
            @input="error = ''"
          />
          <p class="mnote">File: <code class="mono">entities/{{ slug || 'name' }}.md</code></p>
        </div>
        <div class="fld">
          <label class="lbl" for="ent-harness">Harness</label>
          <select id="ent-harness" v-model="harness" :disabled="busy">
            <option v-for="h in HARNESSES" :key="h.id" :value="h.id">{{ h.label }}</option>
          </select>
        </div>
        <p v-if="error" class="run-warn">{{ error }}</p>
        <div class="mo-foot" style="padding: 8px 0 0; border: 0">
          <button class="btn" type="button" :disabled="busy" @click="cancelAdd">Cancel</button>
          <button class="btn btn-ink" type="submit" :disabled="busy">
            {{ busy ? 'Creating…' : 'Create file' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
