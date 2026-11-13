<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import { COLORS, MOODS, SHAPES, setMark } from '@/composables/entityMark'
import { useDialogDismiss } from '@/composables/useDialog'
import { scaffoldEntity } from '@/stores/entities'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'
import { hub, toast } from '@/stores/hub'
import { loadSamples, workspaces } from '@/stores/workspaces'

/**
 * Entity creation is a two-step guide: pick a real sample role (or blank),
 * then adjust the short brief before the markdown file is written. Samples
 * come from the same directory the workspace wizard uses; nothing is invented
 * here, and an existing name is suffixed rather than overwritten.
 */
const emit = defineEmits(['close', 'created'])

const step = ref(1)
const sample = ref(null)
const name = ref('')
const description = ref('')
const harness = ref('')
const model = ref('')
const adjusted = ref('')
const error = ref('')
const busy = ref(false)
const samplesLoading = ref(true)
const nameInput = ref(null)

useDialogDismiss({
  active: true,
  close: () => emit('close'),
  guard: () => busy.value,
})

const samples = computed(() => workspaces.samples)
const harnessOptions = computed(() =>
  harnesses.items.map((item) => ({
    id: item.id,
    label: item.label,
    meta: item.installed ? 'installed' : 'not found',
  })),
)

/* The harness list comes from the machine, not from here; seed the picker once
   it lands, unless the user already chose. */
watch(
  () => harnesses.items,
  (items) => {
    if (!harness.value && items[0]) harness.value = items[0].id
  },
  { immediate: true, deep: true },
)
const modelData = computed(() => harnesses.models[harness.value] || null)
/* Only what the harness itself reports; there is no built-in list to merge. */
const modelOptions = computed(() => [...new Set(modelData.value?.models || [])])
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

onMounted(async () => {
  loadHarnesses().catch(() => {})
  loadModels(harness.value).catch(() => {})
  try {
    await loadSamples()
  } finally {
    samplesLoading.value = false
  }
})

watch(harness, () => {
  model.value = ''
  loadModels(harness.value).catch(() => {})
})

function harnessLabel(id) {
  return harnesses.items.find((item) => item.id === id)?.label || id || 'harness'
}

function isTaken(value) {
  return hub.agents.some((agent) => agent.name === value)
}

/** Never replace an existing file: writer becomes writer-2, writer-3, … */
function nextNameFor(base) {
  if (!isTaken(base)) return base
  let n = 2
  while (isTaken(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

async function useSample(entry) {
  sample.value = entry
  step.value = 2
  error.value = ''
  const next = nextNameFor(entry.name)
  adjusted.value = next === entry.name ? '' : next
  name.value = next
  description.value = entry.description
  harness.value = entry.harness
  await nextTick()
  model.value = entry.model || ''
  focusName()
}

async function useBlank() {
  sample.value = null
  step.value = 2
  error.value = ''
  adjusted.value = ''
  name.value = ''
  description.value = ''
  model.value = ''
  await nextTick()
  focusName()
}

function back() {
  error.value = ''
  step.value = 1
}

async function create() {
  if (busy.value) return
  error.value = ''
  if (!slug.value) {
    error.value = 'Use lowercase letters, digits and dashes.'
    return
  }
  if (isTaken(slug.value)) {
    error.value = `${slug.value}.md already exists. Pick another name.`
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
  <Teleport to="body">
    <div class="scrim" data-open="1" @click="busy || emit('close')"></div>
    <div
      class="modal ent-wizard"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-label="Add entity"
    >
      <div class="mo-head ent-wiz-head">
        <span class="ent-wiz-kicker">New entity</span>
        <h2>{{ step === 1 ? 'Choose a starting point' : 'Shape your entity' }}</h2>
        <p v-if="step === 1">
          Start from a proven role or a blank file. Every field stays editable before the markdown is written.
        </p>
        <p v-else>
          Writes <code class="mono">entities/{{ slug || 'name' }}.md</code> with a harness and its own brief.
        </p>
        <button class="x mo-x" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
        <div class="ent-wiz-progress" aria-label="Progress">
          <span :data-on="step >= 1 ? '1' : '0'">1 · Pick</span>
          <i></i>
          <span :data-on="step >= 2 ? '1' : '0'">2 · Shape</span>
        </div>
      </div>

      <form id="ent-wiz-form" class="mo-body ent-wiz-body" @submit.prevent="step === 1 ? null : create()">
        <template v-if="step === 1">
          <p v-if="samplesLoading" class="ent-wiz-loading">Loading sample entities…</p>
          <div v-else class="ent-wiz-samples">
            <button
              v-for="entry in samples"
              :key="entry.name"
              class="ent-wiz-sample"
              type="button"
              :data-taken="isTaken(entry.name) ? '1' : '0'"
              @click="useSample(entry)"
            >
              <span class="ent-wiz-sample-top">
                <EntityMark mini :entity="entry.name" :shape="entry.shape" />
                <span class="ent-wiz-sample-name">
                  <b>{{ entry.name }}</b>
                  <em>{{ harnessLabel(entry.harness) }}</em>
                </span>
                <span v-if="isTaken(entry.name)" class="ent-wiz-taken">in workspace</span>
              </span>
              <span class="ent-wiz-sample-desc">{{ entry.description }}</span>
              <span class="ent-wiz-sample-foot">
                <span>{{ isTaken(entry.name) ? `Creates ${nextNameFor(entry.name)}` : 'Use this template' }}</span>
                <span aria-hidden="true">→</span>
              </span>
            </button>

            <button class="ent-wiz-sample ent-wiz-blank" type="button" @click="useBlank">
              <span class="ent-wiz-plus" aria-hidden="true">+</span>
              <span class="ent-wiz-blank-copy">
                <b>Blank entity</b>
                <span class="ent-wiz-sample-desc">Start from an empty brief and write the role yourself.</span>
              </span>
              <span class="ent-wiz-sample-foot">
                <span>Start from scratch</span>
                <span aria-hidden="true">→</span>
              </span>
            </button>
          </div>
          <p v-if="!samplesLoading && !samples.length" class="ent-wiz-loading">
            No sample directory is available. Start with a blank entity instead.
          </p>
        </template>

        <template v-else>
          <div class="ent-wiz-selected">
            <EntityMark mini :entity="sample?.name || slug || 'entity'" :shape="sample?.shape" />
            <span class="ent-wiz-selected-copy">
              <span>Based on</span>
              <b>{{ sample?.name || 'Blank entity' }}</b>
            </span>
            <button class="ent-wiz-change" type="button" @click="back">Change</button>
          </div>

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
            <p v-if="adjusted && name === adjusted" class="mnote ent-wiz-adjust">
              <b>{{ sample?.name }}</b> is already here, so this starts as <code class="mono">{{ adjusted }}</code>.
            </p>
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
            <p class="mnote">Written as <code class="mono">model:</code> in the entity file. Leave blank to let {{ harnessLabel(harness) }} choose.</p>
          </div>

          <p v-if="error" class="run-warn">{{ error }}</p>
        </template>
      </form>

      <div class="mo-foot ent-wiz-foot">
        <template v-if="step === 1">
          <button class="btn" type="button" @click="emit('close')">Cancel</button>
          <button class="btn btn-ink" type="button" @click="useBlank">Start blank</button>
        </template>
        <template v-else>
          <button class="btn" type="button" :disabled="busy" @click="back">Back</button>
          <button class="btn btn-ink" type="submit" form="ent-wiz-form" :disabled="busy">
            {{ busy ? 'Creating…' : 'Create Entity' }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
