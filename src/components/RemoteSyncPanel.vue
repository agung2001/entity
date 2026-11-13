<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import ModelInput from '@/components/ModelInput.vue'
import {
  approveRemote,
  closeRemotePanel,
  disconnectRemote,
  reconnectRemote,
  remote,
  remoteFor,
  setRemoteGuard,
  syncRemote,
} from '@/stores/remote'
import { toast } from '@/stores/hub'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'

/**
 * One connected workspace's remote status: what the last pass did, what the
 * guard stopped, and the three actions a person actually needs (sync now,
 * review & approve, disconnect).
 */
const props = defineProps({
  workspace: { type: String, default: '' },
})

const confirming = ref(false)
const busy = ref(false)
const password = ref('')
const showPassword = ref(false)
const evalEnabled = ref(false)
const evalHarness = ref('')
const evalModel = ref('')
const savingGuard = ref(false)

const installedHarnesses = computed(() => harnesses.items.filter((item) => item.installed))
const evalModelState = computed(() => harnesses.models[evalHarness.value] || null)
const evalModels = computed(() => evalModelState.value?.models || [])
const state = computed(() => remoteFor(props.workspace))
const findings = computed(() => {
  const live = remote.findings[props.workspace]
  const stored = state.value?.blocked?.findings
  return Array.isArray(live) && live.length ? live : Array.isArray(stored) ? stored : []
})
const blocked = computed(() => state.value?.status === 'blocked' || findings.value.length > 0)
const summary = computed(() => state.value?.summary || null)

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url || ''
  }
}

const when = (iso) => {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'never'
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(then).toLocaleString()
}

function syncEvaluatorFromState(current) {
  const guard = current?.guard
  evalEnabled.value = Boolean(guard?.enabled)
  evalHarness.value = guard?.harness || ''
  evalModel.value = guard?.model || ''
}

onMounted(async () => {
  await loadHarnesses().catch(() => {})
  syncEvaluatorFromState(state.value)
  if (evalHarness.value) await loadModels(evalHarness.value).catch(() => {})
})

watch(
  () => props.workspace,
  async () => {
    confirming.value = false
    busy.value = false
    await loadHarnesses().catch(() => {})
    syncEvaluatorFromState(state.value)
    if (evalHarness.value) await loadModels(evalHarness.value).catch(() => {})
  },
)

watch(
  () => [
    state.value?.guard?.enabled,
    state.value?.guard?.harness,
    state.value?.guard?.model,
  ],
  () => syncEvaluatorFromState(state.value),
)

watch(evalHarness, async (id) => {
  if (!id) return
  const current = await loadModels(id).catch(() => null)
  if (!evalModel.value && current?.default) evalModel.value = current.default
})

async function saveEvaluator() {
  if (savingGuard.value) return
  savingGuard.value = true
  try {
    await setRemoteGuard(props.workspace, {
      enabled: evalEnabled.value,
      harness: evalEnabled.value ? evalHarness.value : '',
      model: evalEnabled.value ? evalModel.value.trim() : '',
    })
  } catch (error) {
    toast(error?.message || 'The sync evaluator could not be saved.')
  } finally {
    savingGuard.value = false
  }
}

async function syncNow() {
  if (busy.value) return
  busy.value = true
  try {
    await syncRemote(props.workspace)
  } catch (error) {
    toast(error?.message || 'The remote sync failed.')
  } finally {
    busy.value = false
  }
}

async function approve() {
  if (busy.value || !findings.value.length) return
  busy.value = true
  try {
    await approveRemote(props.workspace, findings.value)
  } catch (error) {
    toast(error?.message || 'The approval could not be applied.')
  } finally {
    busy.value = false
  }
}

async function reconnect() {
  if (busy.value || !password.value) return
  busy.value = true
  try {
    await reconnectRemote(props.workspace, password.value)
    password.value = ''
  } catch (error) {
    toast(error?.message || 'The session could not be refreshed.')
  } finally {
    busy.value = false
  }
}

async function disconnect() {
  if (busy.value) return
  if (!confirming.value) {
    confirming.value = true
    setTimeout(() => {
      confirming.value = false
    }, 3000)
    return
  }
  busy.value = true
  try {
    await disconnectRemote(props.workspace, { forget: true })
    closeRemotePanel()
  } catch (error) {
    toast(error?.message || 'The remote connection could not be removed.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    v-if="workspace && remote.panel === workspace"
    class="modal modal-narrow rmt-panel"
    data-open="1"
    role="dialog"
    aria-modal="true"
    aria-label="Remote workspace status"
    @click.self="closeRemotePanel()"
  >
    <header class="mo-head">
      <p class="kicker">remote workspace</p>
      <h2>{{ state?.label || 'Connected workspace' }}</h2>
      <p v-if="state">
        <span class="mono">{{ hostOf(state.serverUrl) }}</span> ·
        <span class="mono">{{ state.remoteWorkspace }}</span> · signed in as
        {{ state.accountEmail }}
      </p>
      <p v-else>This workspace is no longer connected to a server.</p>
    </header>

    <div class="mo-body">
      <template v-if="state">
        <div class="rmt-status" :data-tone="blocked ? 'danger' : state.status === 'error' || state.status === 'unauthorized' ? 'danger' : 'ok'">
          <span class="rmt-dot"></span>
          <div>
            <b>{{ blocked ? 'Sync stopped for review' : state.status === 'syncing' ? 'Syncing…' : state.status === 'error' ? 'Last sync failed' : state.status === 'unauthorized' ? 'Session rejected' : 'Connected' }}</b>
            <span>
              Last sync {{ when(state.lastSyncAt) }} · {{ state.counts.tracked }} tracked files · auto every
              {{ Math.round((state.intervalMs || 0) / 3_600_000) }}h
            </span>
          </div>
        </div>

        <p v-if="state.lastError" class="rmt-error" role="alert">{{ state.lastError }}</p>

        <form
          v-if="state.status === 'unauthorized' || /rejected|sign in/i.test(state.lastError || '')"
          class="rmt-reconnect"
          @submit.prevent="reconnect"
        >
          <label class="fld">
            <span class="lbl">Server password</span>
            <span class="rmt-secret">
              <input
                v-model="password"
                class="acct-input"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="••••••••"
                :disabled="busy"
              />
              <button class="btn btn-sm" type="button" @click="showPassword = !showPassword">
                {{ showPassword ? 'Hide' : 'Show' }}
              </button>
            </span>
          </label>
          <button class="btn btn-ink" type="submit" :disabled="busy || !password">
            {{ busy ? 'Refreshing…' : 'Refresh session' }}
          </button>
        </form>

        <div v-if="summary" class="rmt-summary">
          <span><b>{{ summary.pulled || 0 }}</b> pulled</span>
          <span><b>{{ summary.pushed || 0 }}</b> pushed</span>
          <span><b>{{ summary.conflicts?.length || 0 }}</b> conflicts</span>
          <span><b>{{ summary.deletedRemote || 0 }}</b> removed remotely</span>
        </div>

        <div v-if="summary?.conflicts?.length" class="rmt-note">
          <b>Both sides changed.</b> The local copy of each conflicting file was kept
          under <code class="mono">artifacts/conflicts/</code>; the remote version took
          the original path.
          <ul class="rmt-mini-list">
            <li v-for="path in summary.conflicts.slice(0, 8)" :key="path" class="mono">{{ path }}</li>
          </ul>
        </div>

        <div v-if="summary?.quarantined?.length" class="rmt-note">
          <b>MCP servers parked.</b> These arrived from the server and are disabled
          locally until you review them in MCP:
          <span class="mono">{{ summary.quarantined.join(', ') }}</span>.
        </div>

        <div v-if="summary?.mcpDiverged?.length" class="rmt-note">
          <b>MCP definitions kept local.</b> The server changed
          <span class="mono">{{ summary.mcpDiverged.join(', ') }}</span>, but an enabled
          server's command, args or URL is code this machine spawns — update it by hand
          in MCP after reviewing the change.
        </div>

        <div v-if="summary?.missingSkills?.length" class="rmt-note">
          <b>Skills not attached.</b> This machine's harness libraries do not have
          <span class="mono">{{ summary.missingSkills.join(', ') }}</span>; install the
          skill and attach it, then sync again.
        </div>

        <section class="rmt-eval" aria-label="Sync evaluator">
          <div class="rmt-eval-head">
            <b>Sync evaluator</b>
            <span v-if="state.guard?.enabled" class="mono">
              {{ state.guard.harness }}{{ state.guard.model ? ` · ${state.guard.model}` : '' }}
            </span>
            <span v-else>off</span>
          </div>
          <label class="rmt-check">
            <input
              v-model="evalEnabled"
              type="checkbox"
              :disabled="savingGuard || (!installedHarnesses.length && !evalEnabled)"
            />
            <span>
              <b>Review pulled files with a local agent</b>
              <span class="mnote">
                Runs your own CLI over the pulled bytes before they are written. The
                deterministic scan always runs first.
              </span>
            </span>
          </label>
          <div v-if="evalEnabled && installedHarnesses.length" class="rmt-eval-grid">
            <label class="fld">
              <span class="lbl">Harness</span>
              <select v-model="evalHarness" class="acct-input" :disabled="savingGuard">
                <option v-for="item in installedHarnesses" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <div class="fld rmt-model">
              <span class="lbl">Model</span>
              <ModelInput
                v-model="evalModel"
                label="Evaluator model"
                :options="evalModels"
                :loading="Boolean(evalModelState?.loading)"
                :disabled="savingGuard"
                placeholder="harness default"
              />
            </div>
          </div>
          <p v-if="!installedHarnesses.length" class="mnote">
            No local harness found. The deterministic scan still runs; install a CLI to
            enable the agent reviewer.
          </p>
          <div class="rmt-eval-foot">
            <button
              class="btn btn-sm"
              type="button"
              :disabled="savingGuard || (evalEnabled && !evalHarness)"
              @click="saveEvaluator"
            >
              {{ savingGuard ? 'Saving…' : 'Save evaluator' }}
            </button>
          </div>
        </section>

        <section v-if="findings.length" class="rmt-findings" aria-label="Security findings">
          <div class="rmt-findings-head">
            <b>Blocked before writing</b>
            <span>{{ findings.length }} finding{{ findings.length === 1 ? '' : 's' }}</span>
          </div>
          <p class="mnote">
            Nothing from this sync was applied. Read each excerpt; approve only content
            you wrote or trust.
          </p>
          <ul>
            <li v-for="(finding, index) in findings" :key="`${finding.path}-${finding.rule}-${index}`">
              <span class="rmt-sev" :data-sev="finding.severity">{{ finding.severity }}</span>
              <div>
                <b class="mono">{{ finding.path }}</b>
                <span>{{ finding.title || finding.rule }} — {{ finding.message }}</span>
                <code v-if="finding.excerpt" class="rmt-excerpt">{{ finding.excerpt }}</code>
              </div>
            </li>
          </ul>
          <p v-if="state.blocked?.ai?.error" class="rmt-note">
            AI reviewer unavailable: {{ state.blocked.ai.error }}
          </p>
        </section>
      </template>
    </div>

    <footer class="mo-foot">
      <button class="btn" type="button" :disabled="busy" @click="closeRemotePanel()">Close</button>
      <button
        v-if="state"
        class="btn rmt-danger"
        type="button"
        :disabled="busy"
        @click="disconnect"
      >
        {{ confirming ? 'Click again to disconnect' : 'Disconnect' }}
      </button>
      <button
        v-if="findings.length"
        class="btn"
        type="button"
        :disabled="busy"
        @click="approve"
      >
        {{ busy ? 'Working…' : 'I reviewed it — approve & sync' }}
      </button>
      <button v-if="state" class="btn btn-ink" type="button" :disabled="busy" @click="syncNow">
        {{ busy || state.status === 'syncing' ? 'Syncing…' : 'Sync now' }}
      </button>
    </footer>
  </div>
</template>
