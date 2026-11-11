<script setup>
import { onMounted } from 'vue'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'

/* The fleet is this machine's ~/.ssh/config, not a cloud record. A click is
   the only thing that runs ssh; the card stays neutral until a probe answers. */
onMounted(loadFleet)

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
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Fleet</p>
        <h1>Machines</h1>
        <p class="lede">
          Every host in <code class="mono">{{ fleet.displayPath }}</code> — the ssh
          configurations on this machine. Click a host to test it with the keys already here.
          Nothing is stored in the cloud: the hub runs on
          {{ fleet.hostname || 'this machine' }}.
        </p>
      </div>
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
      <span v-if="!fleet.exists">The file does not exist on this machine yet.</span>
      <span v-else>Add a <code class="mono">Host</code> block and reload.</span>
    </div>

    <div v-else class="mgrid">
      <button
        v-for="m in fleet.hosts"
        :key="m.id"
        type="button"
        class="mcard mcard-btn"
        :data-probe="stateOf(m.alias)"
        :aria-label="`Test ssh connection to ${m.label}`"
        @click="probeHost(m)"
      >
        <div class="top">
          <div>
            <h3>
              <MachineIcon />
              {{ m.label }}
              <span v-if="m.aliases.length > 1" class="tag">{{ m.aliases.length }} names</span>
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
        <p v-if="stateOf(m.alias) === 'fail'" class="probe-msg" :title="probeState(m.alias).message">
          {{ probeState(m.alias).message }}
        </p>
      </button>
    </div>
  </div>
</template>
