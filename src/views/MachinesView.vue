<script setup>
import { computed, onMounted, ref } from 'vue'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { toast } from '@/stores/hub'
import { attachMachine, detachMachine, workspaces } from '@/stores/workspaces'

/**
 * Two lists that answer two different questions: `~/.ssh/config` says which hosts
 * exist on this machine, the workspace says which of them it may use. Attaching
 * writes `machines.json`; probing is the only thing that runs ssh.
 */
onMounted(loadFleet)

const busy = ref('')

const localMachine = computed(
  () => workspaces.machines.find((machine) => machine.thisMachine) || null,
)
const attached = computed(() => new Set(workspaces.machines.map((machine) => machine.id)))
const missingHosts = computed(() => workspaces.machines.filter((machine) => machine.missing))

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
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Fleet · {{ workspaces.active }}</p>
        <h1>Machines</h1>
        <p class="lede">
          Every host in <code class="mono">{{ fleet.displayPath }}</code>, and the ones this
          workspace has attached. Discovery reads the ssh config; attaching writes
          <code class="mono">machines.json</code>. Test a host with the keys already here;
          attaching it changes what the workspace may use, not what it has deployed.
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ workspaces.machines.length }} attached ·
          {{ workspaces.machines.filter((m) => m.thisMachine).length }} local
        </span>
      </div>
    </div>

    <div v-if="fleet.loading && !fleet.loaded" class="empty-note">
      <b>Reading {{ fleet.displayPath }}…</b>
    </div>

    <div v-else-if="fleet.error" class="empty-note">
      <b>{{ fleet.error }}</b>
      <button class="btn btn-sm" type="button" @click="loadFleet()">Try again</button>
    </div>

    <template v-else>
      <div class="mgrid">
        <div v-if="localMachine" class="mcard" data-probe="ok">
          <div class="top">
            <div>
              <h3>
                <MachineIcon />
                {{ localMachine.label }}
                <span class="tag">this machine</span>
              </h3>
              <p class="spec">{{ localMachine.spec }}</p>
            </div>
            <span class="state" data-s="ok"><i></i>online</span>
          </div>
          <div class="kv">
            <span>local</span>
            <span>{{ localMachine.desc }}</span>
          </div>
          <p class="probe-msg">Chats happen here in step 1 — no ssh, no daemon.</p>
        </div>

        <div v-if="!fleet.hosts.length" class="machine-note" style="grid-column: 1 / -1">
          <b>No hosts in {{ fleet.displayPath }}.</b>
          <span v-if="!fleet.exists"> The file does not exist on this machine yet.</span>
          <span v-else> Add a <code class="mono">Host</code> block and reload.</span>
          <span> This workspace still works locally — that is not an error.</span>
        </div>

        <div
          v-for="m in fleet.hosts"
          :key="m.id"
          class="mcard"
          :data-probe="stateOf(m.alias)"
        >
          <div class="top">
            <div>
              <h3>
                <MachineIcon />
                {{ m.label }}
                <span v-if="m.aliases.length > 1" class="tag">{{ m.aliases.length }} names</span>
                <span v-if="attached.has(m.alias)" class="tag">attached</span>
              </h3>
              <p class="spec">{{ m.spec }}</p>
            </div>
            <span class="state" :data-s="stateOf(m.alias)">
              <i></i>{{ stateLabel(m.alias) }}
            </span>
          </div>
          <div class="kv">
            <span :title="m.identityFile || 'ssh uses the default identities'">
              {{ m.identityFile || 'default key' }}
            </span>
            <span>{{ m.source }}</span>
            <span v-if="m.proxyJump">jump {{ m.proxyJump }}</span>
            <span v-if="probeMs(m.alias)">{{ probeMs(m.alias) }}</span>
          </div>
          <p
            v-if="stateOf(m.alias) === 'fail'"
            class="probe-msg"
            :title="probeState(m.alias).message"
          >
            {{ probeState(m.alias).message }}
          </p>
          <div class="mcard-actions">
            <button class="btn btn-sm" type="button" @click="probeHost(m)">Test ssh</button>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="busy === m.alias"
              @click="toggle(m.alias, attached.has(m.alias))"
            >
              {{ attached.has(m.alias) ? 'Detach' : 'Attach to workspace' }}
            </button>
          </div>
        </div>
      </div>

      <template v-if="missingHosts.length">
        <div class="sec-head" style="margin-top: 26px">
          <h2>Attached but missing</h2>
          <span class="meta">kept on purpose</span>
        </div>
        <div class="tbl">
          <div v-for="machine in missingHosts" :key="machine.id" class="tr" style="cursor: default">
            <span class="cell-agent">
              <MachineIcon />
              <span>
                <span class="nm2">{{ machine.id }}</span>
                <span class="sub2">{{ machine.desc }}</span>
              </span>
            </span>
            <span class="col-state">
              <span class="state" data-s="sleep"><i></i>missing</span>
            </span>
            <span class="col-machines"></span>
            <span class="num col-skills"></span>
            <span class="last col-last">{{ machine.source }}</span>
          </div>
        </div>
        <p class="mnote" style="margin-top: 8px">
          The host disappeared from the ssh config. The workspace keeps your intent; the entity
          is asleep, not broken.
        </p>
      </template>

      <p class="mnote" style="margin-top: 18px">
        Step 1 runs on <b>local</b> only. An attached host is the frame the remote runner fills
        in later — nothing is deployed by attaching it.
      </p>
    </template>
  </div>
</template>
