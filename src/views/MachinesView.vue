<script setup>
import { computed, onMounted, ref } from 'vue'
import MachineIcon from '@/components/MachineIcon.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { hub, toast } from '@/stores/hub'
import {
  artifactRetention,
  loadArtifactRetention,
  setArtifactRetention,
} from '@/stores/artifactRetention'
import { forgetMachineFacts, machineFactsFor, workspaces } from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Machines; the parent owns the page head. */
  embedded: { type: Boolean, default: false },
})

/**
 * The fleet is every Host block in ~/.ssh/config, plus the machine running this
 * process. Nothing is attached to the workspace: a test reads the host's
 * harness/model inventory and saves that snapshot here. No key or ssh config is
 * copied into the workspace.
 */
onMounted(() => {
  loadFleet()
  loadArtifactRetention()
})

const busy = ref('')
const sweep = computed(() => artifactRetention.state)
const sweepExecutor = computed(() => sweep.value?.executor || null)
const sweepSaving = computed(() => artifactRetention.saving)
/* The rule is workspace configuration: an owner or admin changes it, and the
   change reaches every clone on the next sync. A member reads it. */
const canPickSweep = computed(() => ['owner', 'admin'].includes(String(hub.session?.role || 'owner')))
const sweepOptions = computed(() => {
  const options = [
    {
      id: 'owner',
      label: "The owner's machine",
      desc: 'The first machine the workspace owner opens Entity on takes the sweep; the rest stand down.',
      tag: sweepExecutor.value?.kind === 'owner' ? sweepExecutor.value.where || 'waiting' : '',
    },
    {
      id: 'machine',
      label: 'This machine',
      desc: `Runs the pass whenever Entity is open on ${fleet.hostname || 'this machine'}.`,
      tag: sweepExecutor.value?.kind === 'machine' ? sweepExecutor.value.where || '' : '',
    },
  ]
  /* The sync host is the only executor that never waits for a person, which is
     what a shared workspace without an always-on desktop needs. It is offered
     wherever this picker renders: a clone has one, and the server *is* one. */
  options.push({
    id: 'host',
    label: 'The sync host',
    desc: 'The shared copy runs the pass itself, on its own clock — no desktop has to be open.',
    tag: sweepExecutor.value?.kind === 'host' ? 'always on' : '',
  })
  return options
})

async function setSweep(kind) {
  if (!canPickSweep.value || sweepSaving.value) return
  const next = await setArtifactRetention({ executor: { kind } }, { label: kind })
  if (next) toast(kind === 'host' ? 'The sync host runs the sweep' : kind === 'machine' ? 'This machine runs the sweep' : "The owner's machine runs the sweep")
}

const localHost = computed(() => ({
  alias: 'local',
  id: 'local',
  label: String(fleet.hostname || 'local').replace(/\.local$/i, ''),
  spec: fleet.hostname || 'localhost',
  source: 'local',
  thisMachine: true,
}))

const hosts = computed(() => {
  const seen = new Set()
  return [localHost.value, ...fleet.hosts].filter((host) => {
    const key = host.alias || host.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const scannedCount = computed(
  () => hosts.value.filter((host) => Boolean(machineFactsFor(host.alias))).length,
)

const stateOf = (alias) => {
  if (alias === 'local') return machineFactsFor('local') ? 'ok' : 'idle'
  const state = probeState(alias).state
  if (state === 'ok' || state === 'fail' || state === 'testing') return state
  return machineFactsFor(alias) ? 'ok' : 'idle'
}
const stateLabel = (machine) => {
  const state = stateOf(machine.alias)
  if (machine.thisMachine) return state === 'ok' ? 'scanned' : 'online'
  if (state === 'ok') return machineFactsFor(machine.alias) ? 'scanned' : 'reachable'
  if (state === 'fail') return 'unreachable'
  if (state === 'testing') return 'testing'
  return 'not tested'
}
const probeMs = (alias) => {
  const probe = probeState(alias)
  return probe.state === 'ok' || probe.state === 'fail' ? `${probe.ms} ms` : ''
}
const factFor = (alias) => machineFactsFor(alias)
const harnessCount = (alias) => factFor(alias)?.harnesses?.length || 0
const modelCount = (alias) =>
  (factFor(alias)?.harnesses || []).reduce((sum, entry) => sum + entry.models.length, 0)
const harnessPreview = (alias) => (factFor(alias)?.harnesses || []).slice(0, 3)
const when = (alias) => {
  const at = factFor(alias)?.checkedAt
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

async function scan(machine) {
  if (busy.value) return
  busy.value = `scan:${machine.alias}`
  try {
    await probeHost(machine)
    const probe = probeState(machine.alias)
    if (probe.state === 'ok') toast(`${machine.alias} scanned`)
    else toast(probe.message || `${machine.alias} could not be scanned`)
  } finally {
    busy.value = ''
  }
}

async function forget(alias) {
  if (busy.value) return
  busy.value = `forget:${alias}`
  try {
    await forgetMachineFacts(alias)
  } catch (error) {
    toast(error?.message || 'Could not remove those facts')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div :class="props.embedded ? 'ws-embed' : 'view'">
    <div v-if="!props.embedded" class="page-head">
      <div>
        <p class="eyebrow">Machines · {{ workspaces.active }}</p>
        <h1>Machines</h1>
        <p class="lede">
          Every host in <code class="mono">{{ fleet.displayPath }}</code>, plus this
          machine. Testing a host stores its harness and model inventory in this
          workspace. No private key or ssh config is copied.
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ hosts.length }} hosts · {{ scannedCount }} scanned
        </span>
        <button class="btn btn-sm" type="button" @click="loadFleet()">Reload</button>
      </div>
    </div>

    <div class="lib-bar">
      <span class="lib-meta">
        <b>local</b> is always available. A scan is read-only on the host.
      </span>
      <span class="mnote">Snapshots stay on this machine; they are not synced.</span>
    </div>

    <p v-if="sweepExecutor?.kind === 'local'" class="mnote" style="margin: 0 0 14px">
      <b>Artifact sweep</b> — this workspace lives only on this machine, so this machine
      runs the sweep, on its own clock. A shared workspace is the only case where the
      machine can be chosen.
    </p>

    <fieldset
      v-else-if="sweepExecutor"
      class="bkp-fieldset"
      :disabled="!canPickSweep || sweepSaving"
    >
      <legend>Artifact sweep</legend>
      <div class="bkp-modes" role="radiogroup" aria-label="Which machine runs the artifact sweep">
        <label
          v-for="option in sweepOptions"
          :key="option.id"
          class="bkp-mode"
          :data-on="sweepExecutor.kind === option.id ? '1' : '0'"
        >
          <input
            class="bkp-radio"
            type="radio"
            name="sweep-executor"
            :value="option.id"
            :checked="sweepExecutor.kind === option.id"
            @change="setSweep(option.id)"
          />
          <span class="bkp-dot" aria-hidden="true"></span>
          <span class="bkp-mode-copy">
            <b>{{ option.label }}</b>
            <span>{{ option.desc }}</span>
          </span>
          <span class="bkp-mode-tag">{{ option.tag }}</span>
        </label>
      </div>
    </fieldset>

    <p v-if="sweepExecutor && sweepExecutor.kind !== 'local'" class="mnote" style="margin: 8px 0 14px">
      One machine runs the archive and delete passes; every other clone shows the same
      thresholds and stands down. The rule is shared with the team — the archive dates are
      not.
      <template v-if="!canPickSweep">Only a workspace owner or admin can change this.</template>
      <template v-else-if="sweepExecutor.kind === 'owner' && !sweepExecutor.claimed">
        No owner machine has claimed the sweep yet.
      </template>
      <template v-else>Runs on {{ sweepExecutor.where || sweepExecutor.label }}.</template>
    </p>

    <div v-if="fleet.loading && !fleet.loaded" class="empty-note">
      <b>Reading {{ fleet.displayPath }}…</b>
    </div>

    <div v-else-if="fleet.error" class="empty-note">
      <b>{{ fleet.error }}</b>
      <button class="btn btn-sm" type="button" @click="loadFleet()">Try again</button>
    </div>

    <div class="mgrid">
      <article
        v-for="machine in hosts"
        :key="machine.alias"
        class="mcard"
        :data-probe="stateOf(machine.alias)"
      >
        <div class="top">
          <div>
            <h3>
              <MachineIcon />
              {{ machine.label }}
              <span v-if="machine.thisMachine" class="tag">this machine</span>
              <span v-else class="tag">ssh</span>
            </h3>
            <p class="spec">{{ machine.spec || machine.alias }}</p>
          </div>
          <span class="state" :data-s="stateOf(machine.alias)">
            <i></i>{{ stateLabel(machine) }}
          </span>
        </div>

        <div class="kv">
          <span>{{ machine.source || '~/.ssh/config' }}</span>
          <span v-if="probeMs(machine.alias)">{{ probeMs(machine.alias) }}</span>
          <span v-if="factFor(machine.alias)">
            {{ harnessCount(machine.alias) }} harnesses · {{ modelCount(machine.alias) }} models
          </span>
          <span v-else class="mono">not scanned</span>
        </div>

        <p v-if="factFor(machine.alias)" class="mnote cap-preview">
          <span
            v-for="entry in harnessPreview(machine.alias)"
            :key="entry.id"
            class="cap-preview-item"
          >
            <HarnessIcon :name="entry.id" :size="10" />{{ entry.label }}
          </span>
          <span v-if="harnessCount(machine.alias) > 3">…</span>
          <span class="mono">{{ when(machine.alias) }}</span>
        </p>

        <div class="mcard-actions">
          <router-link
            class="btn btn-sm"
            :to="{ name: 'machine', params: { workspace: hub.workspace, id: machine.alias } }"
          >
            Open
          </router-link>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="scan(machine)"
          >
            {{ busy === `scan:${machine.alias}` ? 'Scanning…' : 'Test & scan' }}
          </button>
          <button
            v-if="factFor(machine.alias)"
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="forget(machine.alias)"
          >
            {{ busy === `forget:${machine.alias}` ? 'Removing…' : 'Forget facts' }}
          </button>
        </div>
      </article>
    </div>

    <p v-if="!fleet.hosts.length" class="mnote" style="margin-top: 14px">
      No Host blocks in {{ fleet.displayPath }} yet. Local still works; add a host
      there and reload to test a remote machine.
    </p>
  </div>
</template>

<style scoped>
.cap-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.cap-preview-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.cap-preview > .mono {
  margin-left: auto;
  opacity: 0.7;
}
</style>
