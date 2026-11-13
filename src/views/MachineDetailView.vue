<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MachineIcon from '@/components/MachineIcon.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
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
const query = ref('')

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

/* One search box for both axes: a person may remember a harness, a binary path
   or a model id, and should not have to scan hundreds of ids to find it. */
const matchingModels = (entry) => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return entry.models || []
  const harnessText = [entry.id, entry.label, entry.path, entry.default]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (harnessText.includes(needle)) return entry.models || []
  return (entry.models || []).filter((model) => model.toLowerCase().includes(needle))
}

const matchesHarness = (entry) => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return true
  const harnessText = [entry.id, entry.label, entry.path, entry.default]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return harnessText.includes(needle) || (entry.models || []).some((model) => model.toLowerCase().includes(needle))
}

const filteredHarnesses = computed(() => (facts.value?.harnesses || []).filter(matchesHarness))
const visibleModelCount = computed(() =>
  filteredHarnesses.value.reduce((sum, entry) => sum + matchingModels(entry).length, 0),
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

            <div v-if="facts.harnesses.length" class="cap-search">
              <input
                v-model="query"
                class="acct-input"
                type="search"
                autocomplete="off"
                spellcheck="false"
                placeholder="Search harness, path or model…"
                aria-label="Search harnesses and models"
              />
              <span v-if="query" class="mnote">
                {{ filteredHarnesses.length }} harnesses · {{ visibleModelCount }} models
              </span>
            </div>

            <div v-if="filteredHarnesses.length" class="cap-list">
              <details
                v-for="entry in filteredHarnesses"
                :key="entry.id"
                class="cap-entry"
                :open="query ? true : undefined"
              >
                <summary>
                  <HarnessIcon :name="entry.id" :size="12" />
                  <b>{{ entry.label }}</b>
                  <span :title="sourceLabel(entry)">{{ matchingModels(entry).length }} models</span>
                </summary>
                <p v-if="entry.path" class="mono cap-path">{{ entry.path }}</p>
                <p v-if="entry.default" class="mnote">
                  Default: <code class="mono">{{ entry.default }}</code>
                </p>
                <div v-if="matchingModels(entry).length" class="cap-models">
                  <code v-for="model in matchingModels(entry)" :key="model" class="mono">{{ model }}</code>
                </div>
                <p v-else class="mnote">No model list reported by this CLI.</p>
              </details>
            </div>
            <p v-else-if="facts.harnesses.length" class="mnote">
              No harness or model matches “{{ query }}”.
            </p>
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
.cap-search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
}
.cap-search .acct-input {
  width: 100%;
}
.cap-list {
  margin-top: 8px;
}
.cap-entry {
  border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
}
.cap-entry:first-child {
  border-top: 0;
}
.cap-entry summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 0;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
}
.cap-entry summary::-webkit-details-marker {
  display: none;
}
.cap-entry summary b {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.cap-entry summary :deep(.harness-icon) {
  flex: 0 0 auto;
}
.cap-entry summary span {
  font-size: 10px;
  opacity: 0.62;
  font-style: normal;
  white-space: nowrap;
}
.cap-path {
  font-size: 10px;
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
  font-size: 9.5px;
  padding: 2px 5px;
  border: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 3px;
  opacity: 0.8;
}
</style>
