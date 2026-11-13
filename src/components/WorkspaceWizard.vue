<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { harnesses, loadHarnesses } from '@/stores/harnesses'
import { createWorkspace, loadSamples, workspaces } from '@/stores/workspaces'

/**
 * The first-run form, reused as a modal from the workspace picker.
 *
 * It is one screen on purpose: a name, and — optionally — which sample entities
 * to start with. A workspace is data, not a machine: any entity can be sent to a
 * host from the Fleet view later, without copying credentials into the folder.
 */
const props = defineProps({
  open: { type: Boolean, default: true },
  mode: { type: String, default: 'page' },
})
const emit = defineEmits(['created', 'close'])

const label = ref('my-workspace')
const seed = ref(false)
const selectedSamples = ref([])
const error = ref('')
const busy = ref(false)

const samples = computed(() => workspaces.samples)

const harnessLabel = (id) =>
  harnesses.items.find((h) => h.id === id)?.label || id

/** Same derivation the store uses, shown so the folder name is never a surprise. */
const slug = computed(() =>
  String(label.value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''),
)

const isSampleOn = (name) => selectedSamples.value.includes(name)

function toggleSample(name) {
  const at = selectedSamples.value.indexOf(name)
  if (at > -1) selectedSamples.value.splice(at, 1)
  else selectedSamples.value.push(name)
}

const selectAllSamples = () => {
  selectedSamples.value = samples.value.map((sample) => sample.name)
}
const clearSamples = () => {
  selectedSamples.value = []
}

/** Three preselected, the other three one click away. */
function applySampleDefaults() {
  if (selectedSamples.value.length) return
  const preferred = samples.value.filter((sample) => sample.default).map((sample) => sample.name)
  selectedSamples.value = preferred.length
    ? preferred
    : samples.value.slice(0, 3).map((sample) => sample.name)
}

async function sync() {
  if (!workspaces.samples.length) await loadSamples()
  if (!harnesses.items.length) await loadHarnesses()
  applySampleDefaults()
}

function reset() {
  label.value = 'my-workspace'
  selectedSamples.value = []
  seed.value = false
  error.value = ''
  applySampleDefaults()
}

onMounted(sync)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    reset()
    sync()
  },
)

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!slug.value) {
    error.value = 'Give the workspace a name with letters or digits.'
    return
  }
  busy.value = true
  try {
    const record = await createWorkspace({
      label: label.value,
      seed: seed.value,
      seedEntities: selectedSamples.value,
    })
    emit('created', record)
  } catch (problem) {
    error.value = problem?.message || 'The workspace could not be created.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="wiz">
    <header class="wiz-head">
      <p class="kicker">entity</p>
      <h1>Create a workspace</h1>
      <p class="sub">
        A workspace is a folder: its entities, skills, artifacts and run history live
        in <code class="mono">~/.entity/workspaces/{{ slug || '…' }}</code>. The signed-in
        account becomes its owner.
      </p>
    </header>

    <form novalidate @submit.prevent="submit">
      <div class="fld">
        <label class="lbl" for="wiz-name">Name</label>
        <input
          id="wiz-name"
          v-model="label"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="my-workspace"
          :disabled="busy"
          @input="error = ''"
        />
        <p class="mnote">
          Folder: <code class="mono">~/.entity/workspaces/{{ slug || '…' }}</code>
        </p>
      </div>

      <label class="check">
        <input v-model="seed" type="checkbox" :disabled="busy" />
        <span>
          Start with sample entities
          <em>
            {{ samples.length || 6 }} markdown files you can read, edit or delete —
            pick which ones below. Off by default.
          </em>
        </span>
      </label>

      <div v-if="seed" class="seed">
        <div class="seed-head">
          <span class="lbl">
            Entities to create
            <span class="mnote-inline">{{ selectedSamples.length }} of {{ samples.length }}</span>
          </span>
          <div class="seed-actions">
            <button type="button" :disabled="busy" @click="selectAllSamples">
              Select all {{ samples.length }}
            </button>
            <button type="button" :disabled="busy || !selectedSamples.length" @click="clearSamples">
              Clear
            </button>
          </div>
        </div>

        <label
          v-for="sample in samples"
          :key="sample.name"
          class="seed-row"
          :data-on="isSampleOn(sample.name) ? '1' : '0'"
        >
          <input
            type="checkbox"
            :checked="isSampleOn(sample.name)"
            :disabled="busy"
            @change="toggleSample(sample.name)"
          />
          <span class="seed-id">
            <span class="seed-nm">
              {{ sample.name }}
              <em>{{ harnessLabel(sample.harness) }}</em>
            </span>
            <span class="seed-desc">{{ sample.description }}</span>
          </span>
          <span class="seed-file mono">{{ sample.name }}.md</span>
        </label>

        <p v-if="!selectedSamples.length" class="mnote">
          Nothing will be created — the workspace starts empty.
        </p>
      </div>

      <div class="slot" :data-on="error ? '1' : '0'" aria-live="polite">
        <p class="msg">{{ error }}</p>
      </div>

      <div class="wiz-foot">
        <button
          v-if="mode === 'modal'"
          class="btn"
          type="button"
          :disabled="busy"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button class="btn btn-ink" type="submit" :disabled="busy || workspaces.creating">
          {{ busy || workspaces.creating ? 'Creating…' : 'Create workspace' }}
        </button>
      </div>
    </form>
  </div>
</template>
