<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { hub, toast } from '@/stores/hub'
import { attachMachine, detachMachine, workspaces } from '@/stores/workspaces'

/**
 * One machine, one page. The fleet list says which hosts exist; this page is the
 * record for one of them — how it is reached, what the workspace copied, and
 * whether the test ssh succeeds.
 */
const route = useRoute()
const router = useRouter()
const busy = ref('')

onMounted(loadFleet)

const alias = computed(() => String(route.params.id || ''))
const attached = computed(
  () => workspaces.machines.find((machine) => machine.id === alias.value) || null,
)
const host = computed(
  () =>
    fleet.hosts.find(
      (entry) =>
        entry.alias === alias.value ||
        entry.id === alias.value ||
        entry.aliases?.includes(alias.value),
    ) || null,
)
const isLocal = computed(() => Boolean(attached.value?.thisMachine))
const missing = computed(() => Boolean(attached.value?.missing))
const label = computed(() => attached.value?.label || host.value?.label || alias.value)
const spec = computed(() => attached.value?.spec || host.value?.spec || '')
const identity = computed(() => host.value?.identityFile || attached.value?.identityFile || '')
const state = computed(() => probeState(alias.value))

const stateName = computed(() => {
  if (isLocal.value) return 'ok'
  if (missing.value) return 'sleep'
  return state.value.state === 'ok' || state.value.state === 'fail' || state.value.state === 'testing'
    ? state.value.state
    : 'idle'
})
const stateLabel = computed(() => {
  if (isLocal.value) return 'this machine'
  if (missing.value) return 'missing'
  if (state.value.state === 'ok') return 'reachable'
  if (state.value.state === 'fail') return 'unreachable'
  if (state.value.state === 'testing') return 'testing'
  return 'not tested'
})

async function test() {
  if (busy.value || !host.value || missing.value) return
  busy.value = 'probe'
  try {
    await probeHost(host.value)
  } finally {
    busy.value = ''
  }
}

async function toggleAttachment() {
  if (busy.value || isLocal.value) return
  busy.value = 'attach'
  try {
    if (attached.value) await detachMachine(alias.value)
    else await attachMachine(alias.value)
  } catch (error) {
    toast(error?.message || 'The attachment could not be changed.')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="view">
    <template v-if="attached || host">
      <div class="page-head">
        <div>
          <p class="eyebrow">Machine · {{ workspaces.active }}</p>
          <h1 class="machine-title"><MachineIcon :size="20" />{{ label }}</h1>
          <p class="lede">
            {{ isLocal ? 'The machine this hub runs on.' : `An ssh host from ${host?.source || attached?.source || '~/.ssh/config'}.` }}
          </p>
        </div>
        <div class="head-actions">
          <button class="btn" type="button" @click="router.push('/machines')">All machines</button>
          <button
            v-if="!isLocal && host && !missing"
            class="btn"
            type="button"
            :disabled="busy === 'probe'"
            @click="test"
          >
            {{ busy === 'probe' ? 'Testing…' : 'Test ssh' }}
          </button>
          <button
            v-if="!isLocal"
            class="btn btn-ink"
            type="button"
            :disabled="busy === 'attach'"
            @click="toggleAttachment"
          >
            {{ attached ? 'Detach from workspace' : 'Attach to workspace' }}
          </button>
        </div>
      </div>

      <div class="grid2">
        <section class="acct-card">
          <div class="acct-card-head">
            <h2>Connection</h2>
            <span class="state" :data-s="stateName"><i></i>{{ stateLabel }}</span>
          </div>
          <dl class="dl">
            <dt>Host</dt>
            <dd class="mono">{{ alias }}</dd>
            <dt>Address</dt>
            <dd class="mono">{{ spec || host?.hostName || 'localhost' }}</dd>
            <dt>Source</dt>
            <dd class="mono">{{ attached?.source || host?.source || '~/.ssh/config' }}</dd>
            <dt>Identity</dt>
            <dd class="mono">{{ identity || 'default key / ssh agent' }}</dd>
            <dt v-if="host?.proxyJump">Jump</dt>
            <dd v-if="host?.proxyJump" class="mono">{{ host.proxyJump }}</dd>
            <dt v-if="host?.aliases?.length">Aliases</dt>
            <dd v-if="host?.aliases?.length" class="mono">{{ host.aliases.join(', ') }}</dd>
            <dt v-if="state.ms">Probe</dt>
            <dd v-if="state.ms">{{ state.ms }} ms · {{ state.message }}</dd>
          </dl>
          <p v-if="state.state === 'fail'" class="probe-msg" style="margin-top: 12px">
            {{ state.message || 'The ssh probe failed.' }}
          </p>
        </section>

        <section class="acct-card">
          <div class="acct-card-head">
            <h2>Workspace copy</h2>
            <span class="role-badge">{{ attached ? 'attached' : 'not attached' }}</span>
          </div>
          <dl class="dl">
            <dt>Config</dt>
            <dd class="mono">{{ attached?.config || `${hub.workspacePath}/machines/CONFIG` }}</dd>
            <dt>Key copy</dt>
            <dd>
              <template v-if="isLocal">not needed — this machine</template>
              <template v-else-if="attached?.keyPresent">
                <span class="mono">{{ attached.key }}</span>
              </template>
              <template v-else-if="attached">no key copy — {{ attached.keyNote || 'ssh uses the agent' }}</template>
              <template v-else>not copied until the host is attached</template>
            </dd>
            <dt>Entities here</dt>
            <dd>
              {{ isLocal ? 'Chats and runs happen here in step 1.' : 'Remote placement is not wired yet.' }}
            </dd>
          </dl>
          <p v-if="missing" class="acct-error" role="alert">
            {{ label }} disappeared from the ssh config. The workspace keeps the intent; re-add
            the Host block or detach it.
          </p>
          <p class="dr-note">
            Attaching changes what this workspace may use, not what has been deployed.
          </p>
        </section>
      </div>
    </template>

    <div v-else-if="!fleet.loaded && !fleet.error" class="empty-note">
      <b>Reading the fleet…</b>
    </div>

    <div v-else class="empty-note">
      <b>{{ fleet.error || 'That machine is not in this workspace or the ssh config.' }}</b>
      <span v-if="!fleet.error">It may have been detached or removed from ~/.ssh/config.</span>
      <router-link to="/machines">Back to machines</router-link>
    </div>
  </div>
</template>
