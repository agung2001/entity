<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import { HARNESSES, MODELS } from '@/data/mock'
import { COLORS, MOODS, SHAPES, setMark } from '@/composables/entityMark'
import { scaffoldEntity } from '@/stores/entities'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'
import { hub, toast } from '@/stores/hub'

/**
 * The one entity-creation form, opened from the entity panel in the rail.
 * It writes a real markdown file before the detail page opens it.
 */
const emit = defineEmits(['close', 'created'])

const name = ref('')
const description = ref('')
const harness = ref(HARNESSES[0]?.id || 'claude')
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
const slug = computed(() =>
  String(name.value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''),
)

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

function focusName() {
  nextTick(() => nameInput.value?.focus())
}

onMounted(() => {
  loadHarnesses().catch(() => {})
  loadModels(harness.value).catch(() => {})
  focusName()
})

watch(harness, () => {
  model.value = ''
  loadModels(harness.value).catch(() => {})
})

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
    toast(`${created.name}.md created`)
    emit('created', created)
  } catch (problem) {
    error.value = problem?.message || 'The file could not be created.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal modal-narrow" data-open="1" role="dialog" aria-modal="true" aria-label="Add entity">
    <div class="mo-head">
      <h2>Add entity</h2>
      <p>Writes <code class="mono">entities/{{ slug || 'name' }}.md</code> with a harness and a working directory you can edit.</p>
      <button class="x mo-x" aria-label="Close" @click="emit('close')">
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
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-ink" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create Entity' }}</button>
      </div>
    </form>
  </div>
</template>
