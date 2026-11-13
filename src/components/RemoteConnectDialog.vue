<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import ModelInput from '@/components/ModelInput.vue'
import { connectRemote, discoverRemote, remote } from '@/stores/remote'
import { toast } from '@/stores/hub'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'

/**
 * Connect the local hub to a shared Entity server.
 *
 * Two steps on purpose: the credentials find the workspaces first, then the
 * person chooses which one to clone. A single "connect" button would have to
 * guess when an account belongs to more than one workspace, and guessing which
 * team's data to copy is not a decision a form should make silently.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'connected'])

const step = ref('credentials')
const serverUrl = ref('')
const email = ref('')
const password = ref('')
const showPassword = ref(false)
const workspaces = ref([])
const chosen = ref('')
const label = ref('')
const account = ref(null)
const error = ref('')
const busy = ref(false)

/* The optional second-opinion evaluator. The deterministic scan always runs;
   this is the person's own CLI reviewing the same pulled bytes. */
const reviewEnabled = ref(false)
const reviewHarness = ref('')
const reviewModel = ref('')

const installedHarnesses = computed(() => harnesses.items.filter((item) => item.installed))
const reviewModelState = computed(() => harnesses.models[reviewHarness.value] || null)
const reviewModels = computed(() => reviewModelState.value?.models || [])

const target = computed(() => workspaces.value.find((entry) => entry.id === chosen.value) || null)
const canDiscover = computed(
  () => Boolean(serverUrl.value.trim() && email.value.trim() && password.value) && !busy.value,
)
const canConnect = computed(
  () =>
    Boolean(target.value) &&
    !busy.value &&
    Boolean(password.value) &&
    (!reviewEnabled.value || Boolean(reviewHarness.value && installedHarnesses.value.length)),
)

function chooseDefaultHarness() {
  if (!installedHarnesses.value.length) {
    reviewEnabled.value = false
    return
  }
  if (reviewHarness.value && installedHarnesses.value.some((item) => item.id === reviewHarness.value)) {
    return
  }
  const preferred =
    installedHarnesses.value.find((item) => item.id === 'claude') || installedHarnesses.value[0]
  reviewHarness.value = preferred?.id || ''
  reviewModel.value = ''
}

onMounted(async () => {
  await loadHarnesses().catch(() => {})
  chooseDefaultHarness()
  if (reviewHarness.value) await loadModels(reviewHarness.value).catch(() => {})
  if (!reviewModel.value && reviewModelState.value?.default) {
    reviewModel.value = reviewModelState.value.default
  }
})

watch(
  () => installedHarnesses.value.length,
  (count) => {
    if (!count) reviewEnabled.value = false
  },
)

watch(reviewHarness, async (id) => {
  if (!id) return
  reviewModel.value = ''
  const state = await loadModels(id).catch(() => null)
  if (!reviewModel.value && state?.default) reviewModel.value = state.default
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    step.value = 'credentials'
    workspaces.value = []
    chosen.value = ''
    label.value = ''
    account.value = null
    error.value = ''
    busy.value = false
    showPassword.value = false
    if (!email.value) email.value = ''
    if (!serverUrl.value) serverUrl.value = ''
    password.value = ''
    chooseDefaultHarness()
  },
)

function chooseWorkspace(entry) {
  chosen.value = entry.id
  label.value = entry.label || entry.id
}

async function discover() {
  if (!canDiscover.value) return
  error.value = ''
  busy.value = true
  try {
    const result = await discoverRemote({
      serverUrl: serverUrl.value.trim(),
      email: email.value.trim(),
      password: password.value,
    })
    workspaces.value = result.workspaces || []
    account.value = result.account || null
    if (!workspaces.value.length) {
      error.value = 'That account has no workspace on this server yet.'
      return
    }
    chooseWorkspace(workspaces.value[0])
    step.value = 'pick'
  } catch (problem) {
    error.value = problem?.message || 'The server could not be reached.'
  } finally {
    busy.value = false
  }
}

function back() {
  step.value = 'credentials'
  error.value = ''
}

async function connect() {
  if (!canConnect.value || !target.value) return
  error.value = ''
  busy.value = true
  try {
    const result = await connectRemote({
      serverUrl: serverUrl.value.trim(),
      email: email.value.trim(),
      password: password.value,
      remoteWorkspace: target.value.id,
      label: label.value.trim() || target.value.label,
      guard: {
        enabled: reviewEnabled.value,
        harness: reviewEnabled.value ? reviewHarness.value : '',
        model: reviewEnabled.value ? reviewModel.value.trim() : '',
      },
    })
    const found = result?.result?.blocked
    toast(
      found
        ? `${result.record.label} connected · sync stopped for review`
        : `${result.record.label} connected`,
    )
    emit('connected', result)
    emit('close')
  } catch (problem) {
    error.value = problem?.message || 'The workspace could not be connected.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="modal modal-narrow rmt-modal"
    data-open="1"
    role="dialog"
    aria-modal="true"
    aria-label="Connect to a remote server"
    @click.self="emit('close')"
  >
    <header class="mo-head">
      <p class="kicker">remote workspace</p>
      <h2>{{ step === 'credentials' ? 'Connect to a server' : 'Choose a workspace' }}</h2>
      <p v-if="step === 'credentials'">
        Sign in with your account on the Entity server. Your password is used once to
        obtain a session token and is never stored.
      </p>
      <p v-else>
        <template v-if="account">{{ account.name || account.email }} · </template>
        Choose the workspace to copy to this machine. It stays connected in both
        directions afterwards.
      </p>
    </header>

    <div class="mo-body">
      <form v-if="step === 'credentials'" class="rmt-form" novalidate @submit.prevent="discover">
        <label class="fld">
          <span class="lbl">Server URL</span>
          <input
            v-model="serverUrl"
            class="acct-input"
            type="url"
            autocomplete="url"
            spellcheck="false"
            placeholder="https://entity.server.dev"
            :disabled="busy"
            @input="error = ''"
          />
          <span class="mnote">The address you open in a browser — https:// in front of a real host.</span>
        </label>
        <label class="fld">
          <span class="lbl">Email or handle</span>
          <input
            v-model="email"
            class="acct-input"
            type="text"
            autocomplete="username"
            spellcheck="false"
            placeholder="you@example.com"
            :disabled="busy"
            @input="error = ''"
          />
        </label>
        <label class="fld">
          <span class="lbl">Password</span>
          <span class="rmt-secret">
            <input
              v-model="password"
              class="acct-input"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="••••••••"
              :disabled="busy"
              @input="error = ''"
            />
            <button
              class="btn btn-sm rmt-eye"
              type="button"
              :aria-pressed="showPassword ? 'true' : 'false'"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? 'Hide' : 'Show' }}
            </button>
          </span>
        </label>

        <p class="rmt-note">
          Pulled files are scanned before they are written. Prompt injection,
          credential-export requests and shell payloads stop the sync before a single
          file lands.
        </p>
      </form>

      <div v-else class="rmt-list" role="radiogroup" aria-label="Remote workspaces">
        <button
          v-for="entry in workspaces"
          :key="entry.id"
          class="rmt-item"
          type="button"
          role="radio"
          :aria-checked="chosen === entry.id ? 'true' : 'false'"
          :data-on="chosen === entry.id ? '1' : '0'"
          :disabled="busy"
          @click="chooseWorkspace(entry)"
        >
          <span class="rmt-item-main">
            <b>{{ entry.label }}</b>
            <span class="mono">{{ entry.id }}</span>
          </span>
          <span class="rmt-item-meta">
            <span v-if="entry.counts">{{ entry.counts.entities }} entities · {{ entry.counts.skills }} skills</span>
            <span v-if="entry.role">{{ entry.role }}</span>
          </span>
        </button>

        <label class="fld rmt-label">
          <span class="lbl">Local name</span>
          <input
            v-model="label"
            class="acct-input"
            type="text"
            spellcheck="false"
            :disabled="busy"
            placeholder="team"
          />
          <span class="mnote">The folder name on this machine. The server workspace keeps its own id.</span>
        </label>
      </div>

      <section class="rmt-eval" aria-label="Sync evaluator">
        <label class="rmt-check">
          <input
            v-model="reviewEnabled"
            type="checkbox"
            :disabled="busy || !installedHarnesses.length"
          />
          <span>
            <b>Review pulled files with a local agent</b>
            <span class="mnote">
              The deterministic scan always runs. This adds a second opinion from your
              own CLI before anything is written.
            </span>
          </span>
        </label>

        <div v-if="reviewEnabled && installedHarnesses.length" class="rmt-eval-grid">
          <label class="fld">
            <span class="lbl">Harness</span>
            <select v-model="reviewHarness" class="acct-input" :disabled="busy">
              <option v-for="item in installedHarnesses" :key="item.id" :value="item.id">
                {{ item.label }}
              </option>
            </select>
          </label>
          <div class="fld rmt-model">
            <span class="lbl">Model</span>
            <ModelInput
              v-model="reviewModel"
              label="Evaluator model"
              :options="reviewModels"
              :loading="Boolean(reviewModelState?.loading)"
              :disabled="busy"
              placeholder="harness default"
            />
          </div>
        </div>

        <p v-if="!installedHarnesses.length" class="mnote">
          No local harness was found. Install one (or set its path in
          Account → Harnesses) to use the agent reviewer; the deterministic scan
          still protects the sync.
        </p>
      </section>

      <p v-if="error" class="rmt-error" role="alert">{{ error }}</p>
    </div>

    <footer class="mo-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button v-if="step === 'pick'" class="btn" type="button" :disabled="busy" @click="back">
        Back
      </button>
      <button
        v-if="step === 'credentials'"
        class="btn btn-ink"
        type="button"
        :disabled="!canDiscover"
        @click="discover"
      >
        {{ remote.busy === 'discover' ? 'Looking…' : 'Find workspaces' }}
      </button>
      <button
        v-else
        class="btn btn-ink"
        type="button"
        :disabled="!canConnect"
        @click="connect"
      >
        {{ remote.busy === 'connect' ? 'Pulling…' : 'Connect & sync' }}
      </button>
    </footer>
  </div>
</template>
