<script setup>
import { computed, onMounted, ref } from 'vue'
import MachineIcon from '@/components/MachineIcon.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { hub, toast } from '@/stores/hub'
import { forgetMachineFacts, machineFactsFor, workspaces } from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Fleet; the parent owns the page head. */
  embedded: { type: Boolean, default: false },
})

/**
 * The fleet is every Host block in ~/.ssh/config, plus the machine running this
 * process. Nothing is attached to the workspace: a test reads the host's
 * harness/model inventory and saves that snapshot here. No key or ssh config is
 * copied into the workspace.
 */
onMounted(loadFleet)

const busy = ref('')

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
        <p class="eyebrow">Fleet · {{ workspaces.active }}</p>
        <h1>Fleet</h1>
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
