<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { HARNESSES, MODELS } from '@/data/mock'
import { agentById, createThread, hub } from '@/stores/hub'

/**
 * A thread is pinned to four choices, so they are asked once, up front: which
 * entity, which machine, which harness, and which model. The old "New thread"
 * button silently reused the last thread's context, which made a mistake hard
 * to see until the first answer arrived.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  defaults: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'created'])

const form = reactive({ entity: '', machine: 'local', harness: 'claude', model: '' })
const error = ref('')
const busy = ref(false)
const resetting = ref(false)

const machines = computed(() =>
  hub.machines.length
    ? hub.machines
    : [{ id: 'local', label: 'This machine', thisMachine: true }],
)
const agent = computed(() => agentById(form.entity))
const modelOptions = computed(() => MODELS[form.harness] || [])
const machine = computed(() => machines.value.find((item) => item.id === form.machine) || null)
const remote = computed(() => Boolean(machine.value && !machine.value.thisMachine))

function reset() {
  const defaults = props.defaults || {}
  const last = hub.chat.last || {}
  resetting.value = true
  form.entity = defaults.entity || last.entity || hub.agents[0]?.id || ''
  const wantedMachine = defaults.machine || last.machine || machines.value[0]?.id || 'local'
  form.machine = machines.value.some((entry) => entry.id === wantedMachine)
    ? wantedMachine
    : machines.value[0]?.id || 'local'
  form.harness =
    defaults.harness || last.harness || agentById(form.entity)?.harness || 'claude'
  form.model =
    defaults.model ||
    (agent.value?.harness === form.harness ? agent.value.model || '' : '') ||
    ''
  error.value = ''
  nextTick(() => {
    resetting.value = false
  })
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

/* changing the entity suggests its own harness, but the user can still override */
watch(
  () => form.entity,
  () => {
    if (resetting.value) return
    const chosen = agent.value
    if (!chosen) return
    form.harness = chosen.harness || form.harness
    form.model = chosen.model || ''
  },
)

watch(
  () => form.harness,
  () => {
    if (resetting.value) return
    const chosen = agent.value
    form.model = chosen && chosen.harness === form.harness ? chosen.model || '' : ''
  },
)

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!form.entity) {
    error.value = 'Pick an entity first.'
    return
  }
  if (!machine.value) {
    error.value = 'Pick a machine for this thread.'
    return
  }
  if (remote.value) {
    error.value = 'Remote chat is not wired yet. Pick this machine to send a message.'
    return
  }
  busy.value = true
  try {
    const thread = await createThread({
      entity: form.entity,
      machine: form.machine,
      harness: form.harness,
      model: form.model.trim(),
    })
    emit('created', thread)
    emit('close')
  } catch (problem) {
    error.value = problem?.message || 'The thread could not be started.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
  <div
    class="modal modal-narrow"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="New thread"
  >
    <div class="mo-head">
      <h2>New thread</h2>
      <p>Pin the entity, machine, harness and model this conversation belongs to.</p>
      <button class="x mo-x" aria-label="Close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>

    <form class="mo-body" @submit.prevent="submit">
      <div class="fld">
        <label class="lbl" for="thread-entity">Entity</label>
        <select id="thread-entity" v-model="form.entity" :disabled="busy">
          <option v-for="item in hub.agents" :key="item.id" :value="item.id">
            {{ item.name }} — {{ item.harnessLabel }}
          </option>
        </select>
      </div>

      <div class="fld">
        <label class="lbl" for="thread-machine">Machine</label>
        <select id="thread-machine" v-model="form.machine" :disabled="busy">
          <option v-for="item in machines" :key="item.id" :value="item.id">
            {{ item.label }}<template v-if="item.thisMachine"> — this machine</template>
          </option>
        </select>
        <p v-if="remote" class="mnote">
          Remote chat is not wired yet. Pick this machine to start the thread.
        </p>
      </div>

      <div class="fld">
        <label class="lbl" for="thread-harness">Harness</label>
        <select id="thread-harness" v-model="form.harness" :disabled="busy">
          <option v-for="harness in HARNESSES" :key="harness.id" :value="harness.id">
            {{ harness.label }}
          </option>
        </select>
      </div>

      <div class="fld">
        <label class="lbl" for="thread-model">Model</label>
        <input
          id="thread-model"
          v-model="form.model"
          class="acct-input"
          type="text"
          :list="`thread-models-${form.harness}`"
          placeholder="harness default"
          spellcheck="false"
          :disabled="busy"
        />
        <datalist :id="`thread-models-${form.harness}`">
          <option v-for="option in modelOptions" :key="option" :value="option" />
        </datalist>
        <p class="mnote">
          Free text. Leave blank to use the harness default or the entity's own
          <code class="mono">model:</code>.
        </p>
      </div>

      <p v-if="error" class="acct-error" role="alert">{{ error }}</p>

      <div class="mo-foot" style="padding: 8px 0 0; border: 0">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-ink" type="submit" :disabled="busy || !hub.agents.length">
          {{ busy ? 'Starting…' : 'Start thread' }}
        </button>
      </div>
    </form>
  </div>
</template>
