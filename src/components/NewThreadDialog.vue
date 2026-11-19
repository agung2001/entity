<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { markFor, moodGlyph } from '@/composables/entityMark'
import { call } from '@/composables/localBridge'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { agentById, createThread, hub } from '@/stores/hub'
import { harnesses, loadHarnesses, loadModels, pickableHarnesses } from '@/stores/harnesses'
import { fleet, loadFleet, machineChoices } from '@/stores/fleet'
import { scanMachine } from '@/stores/workspaces'

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

const form = reactive({ entity: '', machine: 'local', harness: 'claude', model: '', dir: '' })
const startKey = shortcutLabel('start-thread')
/* One digit per picker: the dialog is three choices and a button, and reaching
   for the mouse to make any of them is the slow part. */
const pickKeys = {
  entity: shortcutLabel('pick-entity'),
  machine: shortcutLabel('pick-machine'),
  harness: shortcutLabel('pick-harness'),
}
const entityPick = ref(null)
const machinePick = ref(null)
const harnessPick = ref(null)
/* The dialog is now fully keyboard-driven: it opens on the first picker, each
   picker takes arrows and Enter, and the combo below files the thread without
   reaching for the mouse. */
const body = ref(null)
const error = ref('')
const busy = ref(false)
const resetting = ref(false)
/* The folder is a power feature: hidden behind a toggle so the common case is
   still four fields and a button. */
const dirOpen = ref(false)
/* A remote host's harness list comes from its last scan. Selecting an unscanned
   host starts that scan once, so the harness field cannot keep showing a local
   binary that is not installed there. */
const scans = reactive({})

/* Escape is ignored while a provider call is in flight; the footer's Cancel is
   disabled for the same reason. */
useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
  guard: () => busy.value,
})

const machines = computed(() => machineChoices.value)
const machineOptions = computed(() =>
  machines.value.map((item) => ({ id: item.id, label: item.label, meta: item.meta })),
)
const agent = computed(() => agentById(form.entity))
const machine = computed(() => machines.value.find((item) => item.id === form.machine) || null)
const remote = computed(() => Boolean(machine.value?.remote))
const remoteFacts = computed(() => (remote.value ? machine.value?.facts || null : null))
const remoteHarness = computed(
  () => remoteFacts.value?.harnesses?.find((entry) => entry.id === form.harness) || null,
)
const scan = computed(() => scans[form.machine] || null)
const scanning = computed(() => scan.value?.state === 'busy')
const modelData = computed(() =>
  remoteHarness.value
    ? { models: remoteHarness.value.models || [], default: remoteHarness.value.default || '' }
    : harnesses.models[form.harness] || null,
)
/* Only what the harness itself reports; there is no built-in list to merge. */
const modelOptions = computed(() => [...new Set(modelData.value?.models || [])])
const modelLoading = computed(() => Boolean(modelData.value?.loading))
const entityOptions = computed(() =>
  hub.agents.map((item) => ({
    id: item.id,
    label: item.name,
    meta: item.harnessLabel,
    glyph: moodGlyph(markFor(hub.workspace, item.id, item.mark).mood),
  })),
)
const harnessOptions = computed(() => {
  if (!remote.value) {
    return pickableHarnesses.value.map((item) => ({
      id: item.id,
      label: item.label,
      meta: item.installed ? 'installed' : 'not found',
    }))
  }
  return (remoteFacts.value?.harnesses || []).map((entry) => ({
    id: entry.id,
    label: entry.label || entry.id,
    meta: 'installed on host',
  }))
})

/* The list is the main process's, so it can arrive after this dialog opens.
   Until it does, the thread keeps whatever its entity asked for; a name this
   machine no longer knows settles on the first harness it does have. */
watch(
  () => pickableHarnesses.value,
  (items) => {
    if (!items.length || items.some((item) => item.id === form.harness)) return
    form.harness = items[0].id
  },
  { immediate: true, deep: true },
)
const entityDefaultHarness = computed(() => agent.value?.harness || '')
/* A model default only belongs to the entity's own harness; once the harness
   is overridden, the model is the harness's choice until the user types one. */
const modelDefault = computed(() =>
  remote.value
    ? remoteHarness.value?.default || ''
    : form.harness === agent.value?.harness
      ? agent.value?.model || ''
      : '',
)
const harnessOverridden = computed(
  () => Boolean(agent.value) && form.harness !== entityDefaultHarness.value,
)
const modelOverridden = computed(
  () => Boolean(agent.value) && form.model !== modelDefault.value,
)

function useEntityHarness() {
  if (!agent.value) return
  form.harness = agent.value.harness || form.harness
  form.model = agent.value.model || ''
  loadModels(form.harness).catch(() => {})
}

function useEntityModel() {
  if (remote.value) {
    form.model = remoteHarness.value?.default || ''
    return
  }
  if (!agent.value) return
  form.model = form.harness === agent.value.harness ? agent.value.model || '' : ''
}

function reset() {
  const defaults = props.defaults || {}
  const last = hub.chat.last || {}
  resetting.value = true
  form.entity = defaults.entity || last.entity || hub.agents[0]?.id || ''
  const wantedMachine = defaults.machine || last.machine || machines.value[0]?.id || 'local'
  form.machine = machines.value.some((entry) => entry.id === wantedMachine)
    ? wantedMachine
    : machines.value[0]?.id || 'local'
  /* The entity owns the run defaults. A new thread starts from those, not from
     whichever harness the previous conversation happened to use; the picker and
     model field below are the explicit per-thread override. */
  const chosen = agentById(form.entity)
  form.harness = chosen?.harness || pickableHarnesses.value[0]?.id || ''
  form.model = chosen?.model || ''
  form.dir = ''
  dirOpen.value = false
  error.value = ''
  loadHarnesses().catch(() => {})
  settleMachine()
  if (!remote.value) loadModels(form.harness).catch(() => {})
  nextTick(() => {
    resetting.value = false
    if (props.open) body.value?.querySelector('.pickbtn:not([disabled])')?.focus()
  })
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      for (const id of Object.keys(scans)) delete scans[id]
      if (!fleet.loaded) loadFleet()
      reset()
    }
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
    if (!remote.value) loadModels(form.harness).catch(() => {})
  },
)

/* The base directory belongs to this machine: a far host cannot read it. */
watch(remote, (isRemote) => {
  if (isRemote) {
    form.dir = ''
    dirOpen.value = false
  }
})

async function scanHost(id) {
  if (!id || id === 'local') return
  if (scans[id]?.state === 'busy') return
  scans[id] = { state: 'busy', error: '' }
  try {
    await scanMachine(id)
    scans[id] = { state: 'ok', error: '' }
  } catch (problem) {
    scans[id] = {
      state: 'error',
      error: problem?.message || `Could not read the harnesses on ${id}.`,
    }
  }
}

async function pickDirectory() {
  if (busy.value || remote.value) return
  try {
    const picked = await call('dialog.chooseDirectory', {
      title: 'Choose a base directory for this thread',
    })
    if (!picked?.canceled && picked?.directory) form.dir = picked.directory
  } catch (problem) {
    error.value = problem?.message || 'The folder picker is not available here.'
  }
}

function settleMachine() {
  if (remote.value) {
    const available = remoteFacts.value?.harnesses || []
    if (!available.length) {
      /* No snapshot yet: clear the local harness rather than claiming it runs
         there, then read the host once. */
      form.harness = ''
      form.model = ''
      if (!scans[form.machine]) scanHost(form.machine)
      return
    }
    const preferred = form.harness || entityDefaultHarness.value
    const chosen =
      available.find((entry) => entry.id === preferred) ||
      available.find((entry) => entry.id === entityDefaultHarness.value) ||
      available[0]
    form.harness = chosen.id
    form.model = chosen.default || ''
    return
  }
  /* a harness that is off is not offerable, so it cannot be the settled pick */
  const installed = pickableHarnesses.value.filter((entry) => entry.installed)
  if (!installed.length) return
  if (!installed.some((entry) => entry.id === form.harness)) {
    form.harness = installed.some((entry) => entry.id === entityDefaultHarness.value)
      ? entityDefaultHarness.value
      : installed[0].id
  }
  form.model = form.harness === entityDefaultHarness.value ? agent.value?.model || '' : ''
}

watch(() => form.machine, settleMachine)
watch(remoteFacts, settleMachine)

watch(
  () => form.harness,
  () => {
    if (resetting.value) return
    /* An entity model belongs to a harness on this machine; a remote harness
       uses its own default. */
    if (remote.value) {
      form.model = remoteHarness.value?.default || ''
      return
    }
    const chosen = agent.value
    form.model = chosen && chosen.harness === form.harness ? chosen.model || '' : ''
    loadModels(form.harness).catch(() => {})
  },
)

/**
 * The `start-thread` combo files the thread with the picks made — the same key
 * that confirms a message, used for the one dialog whose whole point is "start".
 *
 * The listener is window-level because focus moves between the pickers, the
 * model field and the folder input; the composer's own send handler lives on
 * its textarea, so nothing behind this dialog can fire.
 */
function onKey(event) {
  if (!props.open || busy.value) return
  if (matchesShortcut('start-thread', event)) {
    event.preventDefault()
    submit()
    return
  }
  const pickers = [
    ['pick-entity', entityPick],
    ['pick-machine', machinePick],
    ['pick-harness', harnessPick],
  ]
  for (const [id, target] of pickers) {
    if (!matchesShortcut(id, event)) continue
    /* a disabled picker is the machine refusing the choice, not a key to eat */
    event.preventDefault()
    target.value?.toggle()
    return
  }
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

async function submit() {
  if (busy.value) return
  error.value = ''
  if (!form.entity) {
    error.value = 'Pick an entity first.'
    return
  }
  if (!machine.value) {
    error.value = 'Pick a machine for this chat.'
    return
  }
  busy.value = true
  try {
    const thread = await createThread({
      entity: form.entity,
      machine: form.machine,
      harness: form.harness,
      model: form.model.trim(),
      dir: form.dir.trim(),
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
  <div class="scrim" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal modal-narrow newthread-modal"
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

    <form ref="body" class="mo-body thread-body newthread-body" @submit.prevent="submit">
      <div class="fld">
        <span class="lbl">Entity <kbd v-if="!busy" class="fld-key">{{ pickKeys.entity }}</kbd></span>
        <PickMenu
          ref="entityPick"
          class="field-select"
          head="Entity"
          icons="entity"
          :options="entityOptions"
          :model-value="form.entity"
          :disabled="busy"
          @update:model-value="form.entity = $event"
        />
      </div>

      <div class="fld">
        <span class="lbl">Machine <kbd v-if="!busy" class="fld-key">{{ pickKeys.machine }}</kbd></span>
        <PickMenu
          ref="machinePick"
          class="field-select"
          head="Machine"
          icons="machine"
          :options="machineOptions"
          :model-value="form.machine"
          :disabled="busy"
          @update:model-value="form.machine = $event"
        />
        <p v-if="remote" class="mnote">
          Runs over ssh on {{ form.machine }}. The workspace is staged there for the turn.
        </p>
      </div>

      <div class="fld">
        <span class="lbl">Harness <kbd v-if="!busy" class="fld-key">{{ pickKeys.harness }}</kbd></span>
        <PickMenu
          ref="harnessPick"
          class="field-select"
          head="Harness"
          icons="harness"
          :options="harnessOptions"
          :model-value="form.harness"
          :disabled="busy || (remote && !harnessOptions.length)"
          @update:model-value="form.harness = $event"
        />
        <p v-if="remote && scanning" class="mnote">Reading this machine's harnesses… first scan can take a few seconds.</p>
        <p v-else-if="remote && scan?.state === 'error'" class="mnote">
          {{ scan.error }}
          <button type="button" :disabled="busy" @click="scanHost(form.machine)">Try again</button>
        </p>
        <p v-else-if="remote && !harnessOptions.length" class="mnote">
          No harness answered on this machine.
        </p>
        <p
          v-if="form.harness"
          class="mnote thread-inherit"
          :data-override="harnessOverridden ? '1' : '0'"
        >
          <template v-if="remote">
            Available on {{ form.machine }}. Change it only for this thread.
          </template>
          <template v-else-if="harnessOverridden">
            Thread override. {{ agent?.name }} uses <b>{{ agent?.harnessLabel }}</b>.
            <button type="button" :disabled="busy" @click="useEntityHarness">Use default</button>
          </template>
          <template v-else-if="agent">
            From {{ agent.name }}. Change it only for this thread.
          </template>
        </p>
      </div>

      <div class="fld">
        <span class="lbl">Model</span>
        <ModelInput
          :model-value="form.model"
          :options="modelOptions"
          :loading="modelLoading"
          :disabled="busy"
          label="Model"
          :placeholder="modelData?.default || 'harness default'"
          @update:model-value="form.model = $event"
        />
        <p class="mnote thread-inherit" :data-override="modelOverridden ? '1' : '0'">
          <template v-if="modelOverridden">
            Thread override.
            <template v-if="remote">
              This machine defaults to <b>{{ modelDefault || 'the harness default' }}</b>.
            </template>
            <template v-else>
              {{ agent?.name }} uses <b>{{ modelDefault || 'the harness default' }}</b>.
            </template>
            <button type="button" :disabled="busy" @click="useEntityModel">Use default</button>
          </template>
          <template v-else-if="modelDefault">
            <template v-if="remote">From this machine: <code class="mono">{{ modelDefault }}</code>.</template>
            <template v-else>From {{ agent?.name }}: <code class="mono">{{ modelDefault }}</code>.</template>
          </template>
          <template v-else-if="modelData?.detected">
            <template v-if="remote">No model reported by this host;</template>
            <template v-else>No entity model;</template>
            {{ form.harness }} will choose<template v-if="modelData.default">&nbsp;·&nbsp;<code class="mono">{{ modelData.default }}</code></template>.
          </template>
          <template v-else>
            <template v-if="remote">No model reported by this host; blank uses the harness default.</template>
            <template v-else>No entity model; blank uses the harness default.</template>
          </template>
        </p>
      </div>

      <button
        v-if="!remote && !dirOpen"
        type="button"
        class="dir-toggle"
        :disabled="busy"
        @click="dirOpen = true"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" />
          <path d="M1.8 5.8v-2h4" />
          <path d="M8 8.4v3.2M6.4 10h3.2" />
        </svg>
        Start from a folder
        <em class="opt">optional</em>
      </button>

      <div v-if="dirOpen && !remote" class="fld">
        <div class="dir-head">
          <span class="lbl">Base directory</span>
          <button type="button" class="dir-hide" :disabled="busy" @click="dirOpen = false; form.dir = ''">
            Hide
          </button>
        </div>
        <div class="dirpick">
          <input
            v-model="form.dir"
            type="text"
            class="acct-input"
            spellcheck="false"
            autocomplete="off"
            placeholder="/Users/you/project"
            aria-label="Base directory"
            :disabled="busy || remote"
            @keydown.enter.prevent
          />
          <button
            class="btn dirpick-browse"
            type="button"
            :disabled="busy || remote"
            @click="pickDirectory"
          >
            Browse…
          </button>
          <button
            v-if="form.dir"
            class="dirpick-clear"
            type="button"
            :disabled="busy"
            aria-label="Clear base directory"
            @click="form.dir = ''"
          >
            ×
          </button>
        </div>
        <p class="mnote">
          <template v-if="remote">
            Only this machine can read a base directory; this thread runs on {{ form.machine }}.
          </template>
          <template v-else>
            Start in a project folder: skills under <code class="mono">.claude/</code>,
            <code class="mono">.agents/</code> appear in <code class="mono">/</code>, and
            <code class="mono">@file:</code> paths resolve from here.
          </template>
        </p>
      </div>

      <p v-if="error" class="acct-error" role="alert">{{ error }}</p>

      <div class="mo-foot newthread-foot">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-ink" type="submit" :disabled="busy || !hub.agents.length || !form.harness">
          {{ busy ? 'Starting…' : 'Start thread' }}
          <kbd v-if="!busy" class="btn-kbd">{{ startKey }}</kbd>
        </button>
      </div>
    </form>
  </div>
</template>
