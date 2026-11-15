<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
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
const existing = ref([])
const checking = ref(false)
let checkToken = 0

useDialogDismiss({
  active: true,
  close: () => emit('close'),
  guard: () => busy.value,
})

const candidates = computed(() => workspaces.items)
const sourceLabel = computed(
  () => workspaces.items.find((item) => item.id === props.workspace)?.label || props.workspace,
)
const targetRecord = computed(() => candidates.value.find((item) => item.id === target.value) || null)
const slug = computed(() =>
  String(name.value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''),
)
const conflict = computed(() => Boolean(slug.value) && existing.value.includes(slug.value))

async function checkTarget() {
  const id = target.value
  if (!id) {
    existing.value = []
    return
  }
  const token = ++checkToken
  checking.value = true
  try {
    const list = await call('entity.list', { workspace: id })
    if (token === checkToken) existing.value = (list || []).map((item) => item.name)
  } catch {
    if (token === checkToken) existing.value = []
  } finally {
    if (token === checkToken) checking.value = false
  }
}

function sync() {
  /* The current workspace is a valid target: cloning there is a copy under a
     new name, not a second room. Prefer another room on first open. */
  const other = candidates.value.find((item) => item.id !== props.workspace)
  if (!target.value || !candidates.value.some((item) => item.id === target.value)) {
    target.value = other?.id || candidates.value[0]?.id || ''
  }
  name.value = props.entity?.name || ''
  checkTarget()
}

watch(target, () => {
  error.value = ''
  checkTarget()
})

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
  if (conflict.value) {
    error.value = `${slug.value} already exists in ${targetRecord.value?.label || target.value}. Rename the entity or pick another name.`
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
    <div class="scrim" data-open="1" @click="busy || emit('close')"></div>
    <div
      class="modal modal-narrow clone-modal"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-label="Clone entity to another workspace"
    >
      <div class="mo-head">
        <h2>Clone entity</h2>
        <p>Copy this entity's file and mark into a workspace, including this one. Conversations stay in the source room.</p>
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
        <template v-else-if="candidates.length">
          <div class="fld">
            <label class="lbl" for="clone-target">Target workspace</label>
            <select id="clone-target" v-model="target" :disabled="busy">
              <option v-for="item in candidates" :key="item.id" :value="item.id">
                {{ item.label }} — {{ item.id }}{{ item.id === workspace ? ' (current)' : '' }}
              </option>
            </select>
            <p class="mnote">
              Choose this workspace to copy the entity here. The target must not already
              have an entity with this name.
            </p>
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
            <p v-if="checking" class="mnote">Checking the target workspace…</p>
            <p v-else-if="conflict" class="mnote clone-conflict">
              <b>{{ slug }}</b> already exists in {{ targetRecord?.label || target }}.
              Rename the entity or pick another name.
            </p>
            <p v-else class="mnote">
              File: <code class="mono">entities/{{ slug || 'name' }}.md</code>.
            </p>
          </div>

          <p v-if="error" class="run-warn">{{ error }}</p>

          <div class="mo-foot clone-foot">
            <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
            <button class="btn btn-ink" type="submit" :disabled="busy || checking || conflict">
              {{ busy ? 'Cloning…' : 'Clone entity' }}
            </button>
          </div>
        </template>

        <template v-else>
          <div class="clone-empty">
            <b>No workspace to clone into.</b>
            <p>Create a workspace, then this entity can be copied to it.</p>
          </div>
          <div class="mo-foot clone-foot">
            <button class="btn" type="button" @click="emit('close')">Close</button>
          </div>
        </template>
      </form>
    </div>
  </Teleport>
</template>
