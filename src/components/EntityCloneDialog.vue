<script setup>
import { computed, onMounted, ref } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { markFor } from '@/composables/entityMark'
import { cloneEntity } from '@/stores/entities'
import { toast } from '@/stores/hub'
import { loadWorkspaceList, workspaces } from '@/stores/workspaces'

/**
 * Clone copies one entity file into another room. The source workspace keeps
 * its conversations; the target receives the markdown, the mark, and any
 * skills/MCP references the file names. A missing reference becomes an honest
 * problem on the target entity rather than a silent edit.
 */
const props = defineProps({
  entity: { type: Object, required: true },
  workspace: { type: String, required: true },
})
const emit = defineEmits(['close', 'cloned'])

const target = ref('')
const name = ref(props.entity?.name || '')
const busy = ref(false)
const loading = ref(true)
const error = ref('')

const others = computed(() => workspaces.items.filter((item) => item.id !== props.workspace))
const sourceLabel = computed(
  () => workspaces.items.find((item) => item.id === props.workspace)?.label || props.workspace,
)
const targetRecord = computed(() => others.value.find((item) => item.id === target.value) || null)
const slug = computed(() =>
  String(name.value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''),
)

function sync() {
  if (!target.value || !others.value.some((item) => item.id === target.value)) {
    target.value = others.value[0]?.id || ''
  }
  name.value = props.entity?.name || ''
}

onMounted(async () => {
  try {
    await loadWorkspaceList()
  } finally {
    loading.value = false
    sync()
  }
})

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!target.value) {
    error.value = 'Pick a workspace to clone into.'
    return
  }
  if (!slug.value) {
    error.value = 'Use lowercase letters, digits and dashes for the name.'
    return
  }
  busy.value = true
  try {
    const mark = markFor(props.workspace, props.entity.name, props.entity.mark || null)
    const copy = await cloneEntity({
      from: props.workspace,
      to: target.value,
      name: props.entity.name,
      nextName: slug.value,
      mark,
    })
    const where = targetRecord.value?.label || target.value
    const renamed = copy.name !== slug.value ? ` as ${copy.name}` : ''
    const notes = copy.problems?.length
      ? ` · ${copy.problems.length} setup note${copy.problems.length === 1 ? '' : 's'}`
      : ''
    toast(`${copy.name}.md cloned to ${where}${renamed}${notes}`)
    emit('cloned', copy)
    emit('close')
  } catch (problem) {
    error.value = problem?.message || 'The entity could not be cloned.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" data-open="1" @click="emit('close')"></div>
    <div
      class="modal modal-narrow clone-modal"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-label="Clone entity to another workspace"
      @keydown.esc="emit('close')"
    >
      <div class="mo-head">
        <h2>Clone entity</h2>
        <p>Copy this entity's file and mark into another workspace. Conversations stay in the source room.</p>
        <button class="x mo-x" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>

      <form class="mo-body" @submit.prevent="submit">
        <div class="clone-flow" aria-label="Clone direction">
          <div class="clone-side">
            <EntityMark mini :entity="entity.name" :shape="entity.mark?.shape" />
            <span class="clone-copy">
              <em>From</em>
              <b>{{ entity.name }}</b>
              <span>{{ sourceLabel }}</span>
            </span>
          </div>
          <span class="clone-arrow" aria-hidden="true">→</span>
          <div class="clone-side" :data-empty="targetRecord ? '0' : '1'">
            <EntityMark mini :entity="entity.name" :shape="entity.mark?.shape" />
            <span class="clone-copy">
              <em>To</em>
              <b>{{ targetRecord?.label || 'No target yet' }}</b>
              <span>{{ targetRecord?.id || 'pick a workspace' }}</span>
            </span>
          </div>
        </div>

        <p v-if="loading" class="mnote">Loading workspaces…</p>
        <template v-else-if="others.length">
          <div class="fld">
            <label class="lbl" for="clone-target">Target workspace</label>
            <select id="clone-target" v-model="target" :disabled="busy">
              <option v-for="item in others" :key="item.id" :value="item.id">
                {{ item.label }} — {{ item.id }}
              </option>
            </select>
            <p class="mnote">The current workspace is not listed: a clone always crosses a room boundary.</p>
          </div>

          <div class="fld">
            <label class="lbl" for="clone-name">Name in the target</label>
            <input
              id="clone-name"
              v-model="name"
              type="text"
              spellcheck="false"
              :disabled="busy"
              @input="error = ''"
            />
            <p class="mnote">
              File: <code class="mono">entities/{{ slug || 'name' }}.md</code>.
              An existing name gets a numbered suffix.
            </p>
          </div>

          <p v-if="error" class="run-warn">{{ error }}</p>

          <div class="mo-foot clone-foot">
            <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
            <button class="btn btn-ink" type="submit" :disabled="busy">
              {{ busy ? 'Cloning…' : 'Clone entity' }}
            </button>
          </div>
        </template>

        <template v-else>
          <div class="clone-empty">
            <b>No other workspace yet.</b>
            <p>Create or import a second workspace, then this entity can move between rooms.</p>
          </div>
          <div class="mo-foot clone-foot">
            <button class="btn" type="button" @click="emit('close')">Close</button>
          </div>
        </template>
      </form>
    </div>
  </Teleport>
</template>
