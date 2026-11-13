<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { hub, toast } from '@/stores/hub'
import { forgetMachineFacts, machineFactsFor, workspaces } from '@/stores/workspaces'

/**
 * One host and the snapshot this workspace keeps about it. The connection lives
 * in ~/.ssh/config; the workspace only stores the non-secret capability report
 * from an explicit test.
 */
const route = useRoute()
const router = useRouter()
const busy = ref('')

onMounted(loadFleet)

const alias = computed(() => String(route.params.id || ''))
const isLocal = computed(() => alias.value === 'local')
const host = computed(
  () =>
    fleet.hosts.find(
      (entry) =>
        entry.alias === alias.value ||
        entry.id === alias.value ||
        entry.aliases?.includes(alias.value),
    ) || null,
)
const facts = computed(() => machineFactsFor(alias.value))
const label = computed(
  () =>
    (isLocal.value
      ? String(fleet.hostname || 'local').replace(/\.local$/i, '')
      : host.value?.label) || alias.value,
)
const spec = computed(() => (isLocal.value ? fleet.hostname || 'localhost' : host.value?.spec || ''))
const identity = computed(() => host.value?.identityFile || '')
const missing = computed(() => !isLocal.value && !host.value)
const probe = computed(() => probeState(alias.value))

const stateName = computed(() => {
  if (isLocal.value) return facts.value ? 'ok' : 'idle'
  if (missing.value) return 'sleep'
  if (probe.value.state === 'ok' || probe.value.state === 'fail' || probe.value.state === 'testing') {
    return probe.value.state
  }
  return facts.value ? 'ok' : 'idle'
})
const stateLabel = computed(() => {
  if (isLocal.value) return facts.value ? 'scanned' : 'online'
  if (missing.value) return 'missing'
  if (probe.value.state === 'ok') return 'scanned'
  if (probe.value.state === 'fail') return 'unreachable'
  if (probe.value.state === 'testing') return 'testing'
  return facts.value ? 'scanned earlier' : 'not tested'
})
const scannedAt = computed(() => {
  const at = facts.value?.checkedAt
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
})
const modelCount = computed(
  () => (facts.value?.harnesses || []).reduce((sum, entry) => sum + entry.models.length, 0),
)

async function scan() {
  if (busy.value || missing.value) return
  busy.value = 'scan'
  try {
    await probeHost(isLocal.value ? { alias: 'local' } : host.value)
    const next = probeState(alias.value)
    if (next.state === 'ok') toast(`${alias.value} scanned`)
    else toast(next.message || `${alias.value} could not be scanned`)
  } finally {
    busy.value = ''
  }
}

async function forget() {
  if (busy.value) return
  busy.value = 'forget'
  try {
    await forgetMachineFacts(alias.value)
  } catch (error) {
    toast(error?.message || 'Could not remove those facts')
  } finally {
    busy.value = ''
  }
}

const sourceLabel = (entry) => {
  if (entry.source === 'cli') return 'listed by the CLI'
  if (entry.source === 'config') return 'configured default only'
  return 'no models reported'
}
</script>

<template>
  <div class="view">
    <template v-if="!missing">
      <div class="page-head">
        <div>
          <p class="eyebrow">Fleet · {{ workspaces.active }}</p>
          <h1 class="machine-title"><MachineIcon :size="20" />{{ label }}</h1>
          <p class="lede">
            {{
              isLocal
                ? 'The machine this hub runs on.'
                : `An ssh host from ${host?.source || '~/.ssh/config'}.`
            }}
          </p>
        </div>
        <div class="head-actions">
          <button
            class="btn"
            type="button"
            @click="router.push({ name: 'machines', params: { workspace: hub.workspace } })"
          >
            All hosts
          </button>
          <button class="btn btn-ink" type="button" :disabled="Boolean(busy)" @click="scan">
            {{ busy === 'scan' ? 'Scanning…' : 'Test & scan' }}
          </button>
          <button
            v-if="facts"
            class="btn"
            type="button"
            :disabled="Boolean(busy)"
            @click="forget"
          >
            {{ busy === 'forget' ? 'Removing…' : 'Forget facts' }}
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
            <dd class="mono">{{ spec || 'localhost' }}</dd>
            <dt>Source</dt>
            <dd class="mono">{{ isLocal ? 'this process' : host?.source || '~/.ssh/config' }}</dd>
            <dt>Identity</dt>
            <dd class="mono">{{ identity || 'ssh agent / default identities' }}</dd>
            <dt v-if="host?.proxyJump">Jump</dt>
            <dd v-if="host?.proxyJump" class="mono">{{ host.proxyJump }}</dd>
            <dt v-if="host?.aliases?.length">Aliases</dt>
            <dd v-if="host?.aliases?.length" class="mono">{{ host.aliases.join(', ') }}</dd>
            <dt v-if="probe.ms">Last test</dt>
            <dd v-if="probe.ms">{{ probe.ms }} ms · {{ probe.message }}</dd>
          </dl>
          <p v-if="probe.state === 'fail'" class="probe-msg" style="margin-top: 12px">
            {{ probe.message || 'The scan failed.' }}
          </p>
          <p class="dr-note">
            ssh reads your own <code class="mono">~/.ssh/config</code> and agent. The
            workspace stores no key and no ssh config. The inventory is local to this
            copy of the workspace and is not part of remote sync.
          </p>
        </section>

        <section class="acct-card">
          <div class="acct-card-head">
            <h2>Capabilities</h2>
            <span class="role-badge">{{ facts ? `${modelCount} models` : 'not scanned' }}</span>
          </div>

          <template v-if="facts">
            <dl class="dl">
              <dt>Host name</dt>
              <dd class="mono">{{ facts.hostname || '—' }}</dd>
              <dt>Platform</dt>
              <dd class="mono">{{ facts.platform }} {{ facts.arch }}</dd>
              <dt>Scanned</dt>
              <dd>{{ scannedAt || '—' }}</dd>
              <dt>Harnesses</dt>
              <dd>{{ facts.harnesses.length }}</dd>
            </dl>

            <div v-if="facts.harnesses.length" class="cap-list">
              <details v-for="entry in facts.harnesses" :key="entry.id" class="cap-entry">
                <summary>
                  <b>{{ entry.label }}</b>
                  <span>{{ entry.models.length }} models</span>
                  <em>{{ sourceLabel(entry) }}</em>
                </summary>
                <p v-if="entry.path" class="mono cap-path">{{ entry.path }}</p>
                <p v-if="entry.default" class="mnote">
                  Default: <code class="mono">{{ entry.default }}</code>
                </p>
                <div v-if="entry.models.length" class="cap-models">
                  <code v-for="model in entry.models" :key="model" class="mono">{{ model }}</code>
                </div>
                <p v-else class="mnote">This CLI did not report a model list.</p>
              </details>
            </div>
            <p v-else class="mnote">
              Connected, but none of the known harnesses are installed on this host.
            </p>
          </template>

          <p v-else class="mnote">
            No inventory yet. Test the connection to read the installed harnesses and
            their models; the result is stored in this workspace.
          </p>
        </section>
      </div>
    </template>

    <div v-else-if="!fleet.loaded && !fleet.error" class="empty-note">
      <b>Reading the fleet…</b>
    </div>

    <div v-else class="empty-note">
      <b>{{ fleet.error || 'That host is not in ~/.ssh/config.' }}</b>
      <span v-if="!fleet.error">Add a Host block and reload, or pick another host.</span>
      <router-link :to="{ name: 'machines', params: { workspace: hub.workspace } }">
        Back to the fleet
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.cap-list {
  margin-top: 14px;
  border-top: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 14%, transparent);
}
.cap-entry {
  border-bottom: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 14%, transparent);
}
.cap-entry summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 0;
  cursor: pointer;
  list-style: none;
}
.cap-entry summary::-webkit-details-marker {
  display: none;
}
.cap-entry summary b {
  flex: 1;
}
.cap-entry summary span,
.cap-entry summary em {
  font-size: 11px;
  opacity: 0.7;
  font-style: normal;
}
.cap-entry summary em {
  display: none;
}
.cap-path {
  font-size: 11px;
  opacity: 0.7;
  word-break: break-all;
  margin: 0 0 8px;
}
.cap-models {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 240px;
  overflow: auto;
  padding: 0 0 12px;
}
.cap-models code {
  font-size: 10px;
  padding: 2px 5px;
  border: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 3px;
  opacity: 0.8;
}
</style>
