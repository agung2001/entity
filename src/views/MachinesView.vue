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
const query = ref('')
const sweep = computed(() => artifactRetention.state)
const sweepExecutor = computed(() => sweep.value?.executor || null)
const sweepSaving = computed(() => artifactRetention.saving)
/* The rule is workspace configuration: an owner or admin changes it, and the
   change reaches every clone on the next sync. A member reads it. */
const canPickSweep = computed(() => ['owner', 'admin'].includes(String(hub.session?.role || 'owner')))
const sweepHere = computed(() => Boolean(sweepExecutor.value?.isThis))
const sweepPlace = computed(
  () => sweepExecutor.value?.where || sweepExecutor.value?.label || 'no machine yet',
)

async function setSweep(kind) {
  if (!canPickSweep.value || sweepSaving.value) return
  const next = await setArtifactRetention({ executor: { kind } }, { label: kind })
  if (!next) return
  toast(
    kind === 'host'
      ? 'The sync host runs the sweep'
      : kind === 'machine'
        ? 'This machine runs the sweep'
        : "The owner's machine runs the sweep",
  )
}

const localHost = computed(() => ({
  alias: 'local',
  id: 'local',
  label: String(fleet.hostname || 'local').replace(/\.local$/i, ''),
  spec: fleet.hostname || 'localhost',
  source: 'local',
  thisMachine: true,
}))

/* The shared copy of this workspace is a machine too: it is the only one that can
   sweep without a desktop open, so it gets a card like any other. It has no ssh
   host and nothing to scan — the actions that belong to a host are hidden. */
const sweepHost = computed(() => ({
  alias: 'host',
  id: 'host',
  label: 'the sync host',
  spec: 'the shared copy of this workspace',
  source: 'sync',
  syncHost: true,
}))

const hosts = computed(() => {
  const seen = new Set()
  const list = [localHost.value, ...fleet.hosts].filter((host) => {
    const key = host.alias || host.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (sweepExecutor.value && sweepExecutor.value.kind !== 'local') list.push(sweepHost.value)
  return list
})

const filteredHosts = computed(() => {
  const q = String(query.value || '').trim().toLowerCase()
  if (!q) return hosts.value
  return hosts.value.filter((host) =>
    [host.alias, host.id, host.label, host.spec, host.source].some((value) =>
      String(value || '').toLowerCase().includes(q),
    ),
  )
})

/** The card that is allowed to run the pass: this machine, or the sync host. */
const sweepPickable = (machine) => Boolean(machine.thisMachine || machine.syncHost)
const isSweeper = (machine) =>
  machine.syncHost ? sweepExecutor.value?.kind === 'host' : sweepHere.value

const scannedCount = computed(
  () => hosts.value.filter((host) => Boolean(machineFactsFor(host.alias))).length,
)

const stateOf = (alias) => {
  if (alias === 'local') return machineFactsFor('local') ? 'ok' : 'idle'
  const state = probeState(alias).state
  if (state === 'ok' || state === 'fail' || state === 'testing') return state
  return machineFactsFor(alias) ? 'ok' : 'idle'
}
const cardState = (machine) =>
  machine.syncHost ? (isSweeper(machine) ? 'ok' : 'idle') : stateOf(machine.alias)
const stateLabel = (machine) => {
  const state = cardState(machine)
  if (machine.syncHost) return isSweeper(machine) ? 'sweeping' : 'available'
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
          machine — and the workspace's sync host while it is shared. Testing a host
          stores its harness and model inventory in this workspace. No private key or ssh
          config is copied.
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
      <label class="wsl-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input
          v-model="query"
          type="search"
          placeholder="Search machines"
          aria-label="Search machines"
          autocomplete="off"
        />
        <span v-if="query" class="cnt">{{ filteredHosts.length }} of {{ hosts.length }}</span>
      </label>
    </div>

    <div
      v-if="sweepExecutor && sweepExecutor.kind !== 'local' && !sweepExecutor.claimed"
      class="role-line"
      role="status"
      style="margin-bottom: 12px"
    >
      <span class="role-badge">sweep</span>
      <span>
        No machine runs the artifact sweep yet. The first machine the workspace owner opens
        Entity on takes it — or pick a machine below.
      </span>
    </div>

    <div v-if="fleet.loading && !fleet.loaded" class="empty-note">
      <b>Reading {{ fleet.displayPath }}…</b>
    </div>

    <div v-else-if="fleet.error" class="empty-note">
      <b>{{ fleet.error }}</b>
      <button class="btn btn-sm" type="button" @click="loadFleet()">Try again</button>
    </div>

    <p v-if="query && !filteredHosts.length" class="empty-note">
      <b>No machine matches “{{ query }}”.</b>
      <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
    </p>

    <div class="mgrid">
      <article
        v-for="machine in filteredHosts"
        :key="machine.alias"
        class="mcard"
        :data-probe="cardState(machine)"
      >
        <div class="top">
          <div>
            <h3>
              <MachineIcon />
              {{ machine.label }}
              <span v-if="machine.thisMachine" class="tag">this machine</span>
              <span v-else-if="machine.syncHost" class="tag">sync host</span>
              <span v-else class="tag">ssh</span>
              <span v-if="isSweeper(machine)" class="tag">sweep</span>
            </h3>
            <p class="spec">{{ machine.spec || machine.alias }}</p>
          </div>
          <span class="state" :data-s="cardState(machine)">
            <i></i>{{ stateLabel(machine) }}
          </span>
        </div>

        <div class="kv">
          <span>{{ machine.source || '~/.ssh/config' }}</span>
          <span v-if="probeMs(machine.alias)">{{ probeMs(machine.alias) }}</span>
          <span v-if="factFor(machine.alias)">
            {{ harnessCount(machine.alias) }} harnesses · {{ modelCount(machine.alias) }} models
          </span>
          <span v-else-if="machine.syncHost" class="mono">always on</span>
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
          <button
            v-if="sweepPickable(machine)"
            class="btn btn-sm"
            type="button"
            :aria-pressed="isSweeper(machine) ? 'true' : 'false'"
            :disabled="!canPickSweep || sweepSaving || isSweeper(machine)"
            :title="
              !canPickSweep
                ? 'Only a workspace owner or admin changes which machine sweeps'
                : isSweeper(machine)
                  ? 'This machine runs the artifact sweep'
                  : 'Run the artifact archive and delete passes on this machine'
            "
            @click="setSweep(machine.syncHost ? 'host' : 'machine')"
          >
            {{
              sweepSaving
                ? 'Saving…'
                : isSweeper(machine)
                  ? 'Sweeping here'
                  : 'Run the sweep here'
            }}
          </button>
          <router-link
            v-if="!machine.syncHost"
            class="btn btn-sm"
            :to="{ name: 'machine', params: { workspace: hub.workspace, id: machine.alias } }"
          >
            Open
          </router-link>
          <button
            v-if="!machine.syncHost"
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="scan(machine)"
          >
            {{ busy === `scan:${machine.alias}` ? 'Scanning…' : 'Test & scan' }}
          </button>
          <button
            v-if="!machine.syncHost && factFor(machine.alias)"
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

    <p v-if="sweepExecutor && sweepExecutor.kind !== 'local'" class="mnote" style="margin-top: 14px">
      <template v-if="sweepExecutor.claimed">
        The artifact sweep runs on <b>{{ sweepPlace }}</b>.
      </template>
      The thresholds and the schedule are shared with the team; the archive dates are not.
      An ssh host is a run target, not a daemon — a sweep only runs where the workspace is.
      <button
        v-if="canPickSweep && sweepExecutor.kind !== 'owner'"
        class="btn btn-sm"
        type="button"
        :disabled="sweepSaving"
        @click="setSweep('owner')"
      >
        Use the owner's machine
      </button>
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
