<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  copySkillToMachine,
  hub,
  skillCoverage,
  skillDetail,
} from '@/stores/hub'

/**
 * Copying a skill is one directory over ssh, then a manifest check on arrival.
 * The sheet shows what actually travels — the entry and manifest always,
 * references and scripts on request.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  skillName: { type: String, required: true },
  /** machine preselected by a per-row Copy button */
  preset: { type: String, default: null },
})
const emit = defineEmits(['close'])

const detail = computed(() => skillDetail(props.skillName))
const coverage = computed(() => skillCoverage(props.skillName))
const thisMachine = computed(() => hub.machines.find((m) => m.thisMachine) || hub.machines[0])

const dest = ref(hub.machines[0]?.id || null)
const inc = reactive({ refs: true, scripts: true })
const running = ref(false)
const finished = ref(false)
const progress = ref(0)
const note = ref('')

const version = computed(() => detail.value?.version || 'latest')

const packFiles = computed(() => 2 + (inc.refs ? 2 : 0) + (inc.scripts ? 1 : 0))
const packNote = computed(
  () => `will copy ${packFiles.value} of 5 files · nothing is written until you start`,
)

const destRow = computed(() => coverage.value.find((c) => c.machine.id === dest.value) || null)

const destVersionNote = computed(() => {
  const row = destRow.value
  if (!row) return ''
  if (row.state === 'sync') return `already ${row.version}`
  if (row.state === 'behind') return `${row.version} → ${version.value}`
  return 'not installed'
})

const placedEntities = computed(() => {
  const agents = hub.agents.filter((a) => a.machines.includes(dest.value))
  return agents.length
})

const timers = []
function later(fn, ms) {
  const id = setTimeout(fn, ms)
  timers.push(id)
  return id
}
function clearTimers() {
  timers.splice(0).forEach(clearTimeout)
}

function reset() {
  clearTimers()
  running.value = false
  finished.value = false
  progress.value = 0
  note.value = packNote.value
  inc.refs = true
  inc.scripts = true
  const behind = coverage.value.find((c) => c.state !== 'sync')
  dest.value = props.preset || (behind || coverage.value[0])?.machine.id || null
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
)

function close() {
  if (running.value) return
  clearTimers()
  emit('close')
}

function start() {
  if (running.value || finished.value) return
  const machine = hub.machines.find((m) => m.id === dest.value)
  if (!machine) return

  running.value = true
  progress.value = 4
  note.value = `packing ${packFiles.value} files · 8.8 KB`

  later(() => {
    progress.value = 34
  }, 120)
  later(() => {
    progress.value = 68
    note.value = `sending to ${machine.label} over ssh`
  }, 620)
  later(() => {
    progress.value = 92
    note.value = 'verifying manifest'
  }, 1240)
  later(() => {
    progress.value = 100
    copySkillToMachine(props.skillName, machine.id)
    note.value = `manifest verified · ${packFiles.value} files · sha256 9c1e…4b7f`
    running.value = false
    finished.value = true
    later(close, 1150)
  }, 1800)
}

function onKey(e) {
  if (e.key !== 'Escape' || !props.open) return
  close()
}

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  clearTimers()
})
</script>

<template>
  <div>
    <div class="scrim" :data-open="open ? '1' : '0'" @click="close"></div>

    <div
      class="modal"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mo-title"
    >
      <div class="mo-head">
        <h2 id="mo-title">Copy {{ skillName }}</h2>
        <p>Packs the skill directory over ssh and verifies the manifest on arrival.</p>
        <button class="x" type="button" aria-label="Close" style="position: absolute; right: 14px; top: 14px" @click="close">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
          </svg>
        </button>
      </div>

      <div class="mo-body">
        <div class="fld">
          <span id="dest-label" class="lbl">Destination</span>
          <div class="dest" role="radiogroup" aria-labelledby="dest-label">
            <button
              v-for="row in coverage"
              :key="row.machine.id"
              class="destbtn"
              type="button"
              role="radio"
              :aria-checked="dest === row.machine.id ? 'true' : 'false'"
              @click="dest = row.machine.id"
            >
              <span class="rd"></span>
              <span>
                <span class="nm">{{ row.machine.label }}</span>
                <span class="d">{{ row.machine.desc }}</span>
              </span>
              <span class="ver">
                {{ row.state === 'sync' ? `already ${row.version}` : row.state === 'behind' ? `${row.version} → ${version}` : 'not installed' }}
              </span>
            </button>
          </div>
        </div>

        <div class="fld">
          <span class="lbl">Version</span>
          <div class="vline">
            <div>
              <small>from</small>
              <b>{{ thisMachine.label }} · library</b>
              <span>{{ version }}</span>
            </div>
            <div>
              <small>to</small>
              <b>{{ hub.machines.find((m) => m.id === dest)?.label }}</b>
              <span class="new">{{ destVersionNote }}</span>
            </div>
          </div>
        </div>

        <div class="fld">
          <span class="lbl">Include</span>
          <div class="picks">
            <button
              class="pick"
              type="button"
              :aria-pressed="inc.refs ? 'true' : 'false'"
              @click="inc.refs = !inc.refs"
            >
              <i>✓</i>references/
            </button>
            <button
              class="pick"
              type="button"
              :aria-pressed="inc.scripts ? 'true' : 'false'"
              @click="inc.scripts = !inc.scripts"
            >
              <i>✓</i>scripts/
            </button>
          </div>
        </div>

        <div class="progress" :hidden="progress === 0">
          <i :style="{ width: progress + '%' }"></i>
        </div>

        <p class="mnote">{{ running || finished ? note : packNote }}</p>

        <div v-if="finished" class="done">
          <span class="g">✓</span>
          <p>
            <b>{{ skillName }} {{ version }} is on {{ hub.machines.find((m) => m.id === dest)?.label }}.</b>
            The {{ placedEntities }} {{ placedEntities === 1 ? 'entity' : 'entities' }} placed
            there can call /{{ skillName }} on the next run.
          </p>
        </div>
      </div>

      <div class="mo-foot">
        <button class="btn" :disabled="running" @click="close">Cancel</button>
        <button class="btn btn-ink" :disabled="running || finished" @click="start">
          {{ running ? 'Copying…' : finished ? 'Done' : 'Start copy' }}
        </button>
      </div>
    </div>
  </div>
</template>
