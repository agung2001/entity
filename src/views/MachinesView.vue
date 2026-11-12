<script setup>
import { computed, onMounted, ref } from 'vue'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { toast } from '@/stores/hub'
import { attachMachine, detachMachine, workspaces } from '@/stores/workspaces'

/**
 * Two tabs, like Skills: the machines this workspace has attached, and the
 * fleet it can attach from. `~/.ssh/config` says which hosts exist; the
 * workspace says which ones it may use.
 */
onMounted(loadFleet)

const tab = ref('workspace')
const busy = ref('')

const attached = computed(() => new Set(workspaces.machines.map((machine) => machine.id)))
const missingHosts = computed(() => workspaces.machines.filter((machine) => machine.missing))
const attachedMachine = (alias) =>
  workspaces.machines.find((machine) => machine.id === alias) || null
const hostFor = (alias) =>
  fleet.hosts.find((host) => host.alias === alias || host.id === alias || host.aliases?.includes(alias)) || null

const stateOf = (alias) => {
  const state = probeState(alias).state
  return state === 'ok' || state === 'fail' || state === 'testing' ? state : 'idle'
}
const stateLabel = (alias) => {
  const state = stateOf(alias)
  if (state === 'ok') return 'reachable'
  if (state === 'fail') return 'unreachable'
  if (state === 'testing') return 'testing'
  return 'not tested'
}
const probeMs = (alias) => {
  const probe = probeState(alias)
  return probe.state === 'ok' || probe.state === 'fail' ? `${probe.ms} ms` : ''
}

async function toggle(alias, isAttached) {
  if (busy.value) return
  busy.value = alias
  try {
    if (isAttached) await detachMachine(alias)
    else await attachMachine(alias)
  } catch (error) {
    toast(error?.message || 'Could not change the attachment')
  } finally {
    busy.value = ''
  }
}

async function test(host) {
  if (!host || busy.value) return
  busy.value = `probe:${host.alias}`
  try {
    await probeHost(host)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Fleet · {{ workspaces.active }}</p>
        <h1>Machines</h1>
        <p class="lede">
          The machines this workspace has attached, and every host in
          <code class="mono">{{ fleet.displayPath }}</code>. Attaching rebuilds
          <code class="mono">machines/CONFIG</code> and copies the host's key into
          <code class="mono">machines/</code> (mode 0600).
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ workspaces.machines.length }} attached ·
          {{ workspaces.machines.filter((m) => m.thisMachine).length }} local
        </span>
      </div>
    </div>

    <div class="sk-tabs" role="tablist" aria-label="Machine scope">
      <button
        role="tab"
        :aria-selected="tab === 'workspace' ? 'true' : 'false'"
        @click="tab = 'workspace'"
      >
        Workspace <span class="n">{{ workspaces.machines.length }}</span>
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'fleet' ? 'true' : 'false'"
        @click="tab = 'fleet'"
      >
        Fleet <span class="n">{{ fleet.hosts.length }}</span>
      </button>
    </div>

    <template v-if="tab === 'workspace'">
      <div class="lib-bar">
        <span class="lib-meta">
          The machines this workspace may use. <b>local</b> is always here.
        </span>
        <button class="btn btn-sm" type="button" @click="tab = 'fleet'">
          Attach from the fleet
        </button>
      </div>

      <div class="mgrid">
        <article
          v-for="machine in workspaces.machines"
          :key="machine.id"
          class="mcard"
          :data-probe="machine.thisMachine ? 'ok' : machine.missing ? 'fail' : stateOf(machine.id)"
        >
          <div class="top">
            <div>
              <h3>
                <MachineIcon />
                {{ machine.label }}
                <span v-if="machine.thisMachine" class="tag">this machine</span>
                <span v-else-if="machine.missing" class="tag">missing</span>
                <span v-else class="tag">attached</span>
              </h3>
              <p class="spec">{{ machine.spec || machine.id }}</p>
            </div>
            <span
              class="state"
              :data-s="machine.thisMachine ? 'ok' : machine.missing ? 'sleep' : stateOf(machine.id)"
            >
              <i></i>{{ machine.thisMachine ? 'online' : machine.missing ? 'missing' : stateLabel(machine.id) }}
            </span>
          </div>
          <div class="kv">
            <span>{{ machine.source || 'local' }}</span>
            <span>{{ machine.desc }}</span>
            <span v-if="probeMs(machine.id)">{{ probeMs(machine.id) }}</span>
            <span
              v-if="machine.keyPresent"
              class="mono"
              :title="machine.keyNote || machine.key"
            >
              key copied
            </span>
            <span v-else-if="!machine.thisMachine && !machine.missing" class="mono">
              {{ machine.keyNote || 'no key copy' }}
            </span>
          </div>
          <div class="mcard-actions">
            <router-link
              class="btn btn-sm"
              :to="{ name: 'machine', params: { id: machine.id } }"
            >
              Open
            </router-link>
            <button
              v-if="!machine.thisMachine && !machine.missing && hostFor(machine.id)"
              class="btn btn-sm"
              type="button"
              :disabled="busy === `probe:${machine.id}`"
              @click="test(hostFor(machine.id))"
            >
              {{ busy === `probe:${machine.id}` ? 'Testing…' : 'Test ssh' }}
            </button>
            <button
              v-if="!machine.thisMachine"
              class="btn btn-sm"
              type="button"
              :disabled="busy === machine.id"
              @click="toggle(machine.id, true)"
            >
              Detach
            </button>
          </div>
        </article>
      </div>

      <template v-if="!workspaces.machines.length">
        <div class="empty-note">
          <b>No machines attached.</b>
          <span>Open the Fleet tab to attach a host from ~/.ssh/config.</span>
        </div>
      </template>

      <p v-if="missingHosts.length" class="mnote" style="margin-top: 14px">
        {{ missingHosts.length }} attached {{ missingHosts.length === 1 ? 'host is' : 'hosts are' }}
        missing from the ssh config. The workspace keeps your intent; detach it or add the
        Host block back.
      </p>
    </template>

    <template v-else>
      <div class="lib-bar">
        <span class="lib-meta">
          Every Host block in <code class="mono">{{ fleet.displayPath }}</code>.
        </span>
        <button class="btn btn-sm" type="button" @click="loadFleet()">Reload</button>
      </div>

      <div v-if="fleet.loading && !fleet.loaded" class="empty-note">
        <b>Reading {{ fleet.displayPath }}…</b>
      </div>

      <div v-else-if="fleet.error" class="empty-note">
        <b>{{ fleet.error }}</b>
        <button class="btn btn-sm" type="button" @click="loadFleet()">Try again</button>
      </div>

      <div v-else-if="!fleet.hosts.length" class="empty-note">
        <b>No hosts in {{ fleet.displayPath }}.</b>
        <span v-if="!fleet.exists"> The file does not exist on this machine yet.</span>
        <span v-else> Add a <code class="mono">Host</code> block and reload.</span>
      </div>

      <div v-else class="mgrid">
        <article
          v-for="host in fleet.hosts"
          :key="host.id"
          class="mcard"
          :data-probe="stateOf(host.alias)"
        >
          <div class="top">
            <div>
              <h3>
                <MachineIcon />
                {{ host.label }}
                <span v-if="host.aliases.length > 1" class="tag">{{ host.aliases.length }} names</span>
                <span v-if="attached.has(host.alias)" class="tag">attached</span>
              </h3>
              <p class="spec">{{ host.spec }}</p>
            </div>
            <span class="state" :data-s="stateOf(host.alias)">
              <i></i>{{ stateLabel(host.alias) }}
            </span>
          </div>
          <div class="kv">
            <span :title="host.identityFile || 'ssh uses the default identities'">
              {{ host.identityFile || 'default key' }}
            </span>
            <span>{{ host.source }}</span>
            <span v-if="host.proxyJump">jump {{ host.proxyJump }}</span>
            <span v-if="probeMs(host.alias)">{{ probeMs(host.alias) }}</span>
            <span
              v-if="attachedMachine(host.alias)"
              class="mono"
              :title="attachedMachine(host.alias).keyNote || attachedMachine(host.alias).key"
            >
              {{ attachedMachine(host.alias).keyPresent ? 'key copied' : 'no key copy' }}
            </span>
          </div>
          <p
            v-if="stateOf(host.alias) === 'fail'"
            class="probe-msg"
            :title="probeState(host.alias).message"
          >
            {{ probeState(host.alias).message }}
          </p>
          <div class="mcard-actions">
            <router-link
              class="btn btn-sm"
              :to="{ name: 'machine', params: { id: host.alias } }"
            >
              Open
            </router-link>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="busy === `probe:${host.alias}`"
              @click="test(host)"
            >
              {{ busy === `probe:${host.alias}` ? 'Testing…' : 'Test ssh' }}
            </button>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="busy === host.alias"
              @click="toggle(host.alias, attached.has(host.alias))"
            >
              {{ attached.has(host.alias) ? 'Detach' : 'Attach to workspace' }}
            </button>
          </div>
        </article>
      </div>

      <p class="mnote" style="margin-top: 18px">
        Step 1 runs on <b>local</b> only. An attached host is the frame the remote runner fills
        in later — nothing is deployed by attaching it.
      </p>
    </template>
  </div>
</template>
