<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AreaStage from '@/components/AreaStage.vue'
import BrandMark from '@/components/BrandMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MessageBody from '@/components/MessageBody.vue'
import { call } from '@/composables/localBridge'
import {
  DEFAULT_ACCOUNT_EMAIL,
  DEFAULT_ADMIN,
  accountExists,
  credentials,
  loadAccount,
  registerAccount,
  signIn,
} from '@/stores/hub'
import { loadHarnesses } from '@/stores/harnesses'
import { loadEntities } from '@/stores/entities'
import { createWorkspace, loadSamples, workspaces } from '@/stores/workspaces'

/**
 * First run: one route, three steps.
 *
 * The account is created silently (there is one per machine and the wizard is
 * only reachable when no workspace exists), so nobody types a credential on the
 * way in. Step 1 writes a real folder, step 3 runs a real turn on the CLI they
 * already have — the point of the whole card is that the last step proves
 * itself instead of describing itself.
 */
const router = useRouter()

const WORDS = ['Name', 'Agent', 'Hello']
const HEADINGS = ['Name your room 🏠', 'Pick the agent that answers 🤖', 'Say hello 🎉']

const step = ref(1)
const msg = ref('')
const busy = ref(false)

/* ── step 1: the room ─────────────────────────────────────────────── */
const label = ref('my-workspace')
const nameEl = ref(null)

/* Same derivation the workspace store uses, shown live so the folder on disk is
   never a surprise. */
const slug = computed(() =>
  String(label.value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''),
)
const folder = computed(() => `~/.entity/workspaces/${slug.value || '…'}`)

/* ── step 2: the agent ───────────────────────────────────────────── */
const rows = ref([])
const probing = ref(false)
const chosen = ref('')

const installedCount = computed(() => rows.value.filter((row) => row.installed).length)
const countLabel = computed(() =>
  installedCount.value === 0
    ? 'No CLI found yet'
    : installedCount.value === 1
      ? '1 CLI found'
      : `${installedCount.value} CLIs found`,
)
const chosenLabel = computed(() => rows.value.find((row) => row.id === chosen.value)?.label || '')

async function probe() {
  probing.value = true
  try {
    rows.value = await loadHarnesses(true)
  } finally {
    probing.value = false
  }
  /* first installed wins; a re-probe keeps the choice if that CLI is still there */
  if (!rows.value.some((row) => row.id === chosen.value && row.installed)) {
    chosen.value = rows.value.find((row) => row.installed)?.id || ''
  }
}

/* ── step 3: hello ───────────────────────────────────────────────── */
/* The file the demo leaves behind, declared in the copy before the click. */
const WELCOME_DESCRIPTION = 'The first entity in this workspace, written by the welcome wizard.'
const WELCOME_BODY = [
  '# welcome',
  '',
  'Your first entity. The welcome wizard wrote it so the first turn had somewhere to land.',
  'Delete it whenever you like — nothing depends on it.',
  '',
  '## Rules',
  '- Answer in a couple of sentences.',
  '- Say plainly which files or commands you used.',
  '',
].join('\n')

const CHIPS = [
  'What can you do in this workspace?',
  'Write a haiku about a desert at night.',
  'Plan my day in five lines.',
]

const turns = ref([])
const threadId = ref('')
const scaffolded = ref(false)
const asking = ref('')
const replied = ref(false)

const EXIT_COPY =
  'The agent exited before it replied. Try again, or leave for now — you can talk to it from inside the workspace.'

/** The last message of a returned thread is this turn's answer, error or not. */
function settle(thread) {
  const last = thread?.messages?.[thread.messages.length - 1]
  if (!last || last.error) {
    turns.value.push({ who: 'sys', text: last?.text || 'The agent exited without a reply.', error: true })
    msg.value = EXIT_COPY
    return
  }
  turns.value.push({ who: 'agent', text: last.text })
  replied.value = true
}

async function fail(problem) {
  turns.value.push({ who: 'sys', text: problem?.message || 'The turn could not be started.', error: true })
  msg.value = EXIT_COPY
}

async function ask(text) {
  if (asking.value) return
  msg.value = ''
  asking.value = text
  turns.value.push({ who: 'me', text })
  try {
    if (!scaffolded.value) {
      await call('entity.scaffold', {
        workspace: workspaces.active,
        name: 'welcome',
        harness: chosen.value,
        description: WELCOME_DESCRIPTION,
        body: WELCOME_BODY,
      })
      scaffolded.value = true
      /* the overview reads the same store, so the demo entity is there when the
         card hands over instead of after a reload */
      await loadEntities(workspaces.active).catch(() => {})
    }
    if (!threadId.value) {
      const thread = await call('chat.create', {
        workspace: workspaces.active,
        entity: 'welcome',
        harness: chosen.value,
      })
      threadId.value = thread.id
    }
    settle(
      await call('chat.send', { workspace: workspaces.active, id: threadId.value, text }),
    )
  } catch (problem) {
    await fail(problem)
  } finally {
    asking.value = ''
  }
}

/** Replace the failed row instead of stacking a second answer on it. */
async function tryAgain() {
  if (asking.value || !threadId.value) return
  msg.value = ''
  asking.value = 'retry'
  turns.value.pop()
  try {
    settle(await call('chat.send', { workspace: workspaces.active, id: threadId.value, retry: true }))
  } catch (problem) {
    await fail(problem)
  } finally {
    asking.value = ''
  }
}

/* ── the card ────────────────────────────────────────────────────── */
const canGo = computed(() => {
  if (busy.value) return false
  if (step.value === 1) return Boolean(slug.value)
  if (step.value === 2) {
    if (probing.value) return false
    return installedCount.value ? Boolean(chosen.value) : true
  }
  return !asking.value
})

const cta = computed(() => {
  if (step.value === 1) return busy.value ? 'Creating…' : 'Next: pick your agent →'
  if (step.value === 2) {
    if (!installedCount.value) return 'Check again'
    return chosen.value ? 'Next: say hello →' : 'Choose one to continue'
  }
  return replied.value ? 'Open my workspace →' : 'Enter my workspace →'
})

async function createRoom() {
  if (busy.value) return
  msg.value = ''
  busy.value = true
  try {
    /* The three default sample entities (chief of staff, writer, secretary)
       come with every room the wizard makes: an empty hub was the one thing
       the old setup screen's checkboxes were for. */
    const samples = await loadSamples()
    const defaults = samples.filter((sample) => sample.default).map((sample) => sample.name)
    /* One account per machine, and this screen only appears on a machine with
       no workspace, so a missing account is created here rather than asked for. */
    const account = accountExists()
      ? credentials()
      : await registerAccount({
          email: DEFAULT_ACCOUNT_EMAIL,
          name: 'owner',
          password: DEFAULT_ADMIN.password,
          role: 'owner',
        })
    signIn(account.username, account.email, account.role)
    await createWorkspace({
      label: label.value.trim(),
      seed: true,
      /* an explicit [] means "none", so a failed read must pass null: the
         defaults are the point of "always" */
      seedEntities: defaults.length ? defaults : null,
    })
    step.value = 2
    await probe()
  } catch (problem) {
    /* a folder that already exists is the one error a person actually hits: the
       message says which folder, the primary stays enabled, the field takes the
       focus back */
    msg.value = problem?.message || 'The workspace could not be created.'
  } finally {
    busy.value = false
  }
  /* after `busy`, or the disabled input cannot take the focus back */
  if (msg.value) {
    await nextTick()
    nameEl.value?.focus()
    nameEl.value?.select?.()
  }
}

function enterWorkspace() {
  router.push({ name: 'overview', params: { workspace: workspaces.active } })
}

function primary() {
  if (busy.value || asking.value) return
  if (step.value === 1) return slug.value ? createRoom() : undefined
  if (step.value === 2) {
    if (probing.value) return
    /* zero installed: the primary re-probes instead of continuing, because
       there is nothing yet to continue with */
    if (!installedCount.value) return probe()
    if (chosen.value) step.value = 3
    return
  }
  return enterWorkspace()
}

function back() {
  if (busy.value || asking.value || step.value < 2) return
  msg.value = ''
  step.value -= 1
}

onMounted(async () => {
  await loadAccount()
})
</script>

<template>
  <main class="auth welcome">
    <AreaStage />

    <div class="welc">
      <div class="stack">
        <div class="bouncer">
          <BrandMark class="brand-mark--lg" hop />
        </div>

        <section class="auth-card">
          <p class="kicker">entity</p>

          <ol class="steps" :aria-label="`Step ${step} of 3`">
            <template v-for="(word, index) in WORDS" :key="word">
              <li
                :data-on="step === index + 1 ? '1' : '0'"
                :data-done="step > index + 1 ? '1' : '0'"
                :aria-current="step === index + 1 ? 'step' : undefined"
              >
                {{ index + 1 }}<span class="word"> · {{ word }}</span>
              </li>
              <li v-if="index < WORDS.length - 1" class="rule" aria-hidden="true"></li>
            </template>
          </ol>

          <h1>{{ HEADINGS[step - 1] }}</h1>

          <form novalidate @submit.prevent="primary">
            <template v-if="step === 1">
              <p class="sub">
                Everything you make lives in one folder on this machine. It starts with three
                example entities, and nothing is uploaded.
              </p>
              <div class="field">
                <label for="room">Workspace name</label>
                <input
                  id="room"
                  ref="nameEl"
                  v-model="label"
                  name="room"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="busy"
                  @input="msg = ''"
                />
                <p class="mnote">Folder: <code :title="folder">{{ folder }}</code></p>
              </div>
            </template>

            <template v-else-if="step === 2">
              <p class="sub">
                entity has no model of its own. It runs a CLI you already have, with the keys you
                already set up.
              </p>

              <div v-if="probing" class="hlist">
                <div v-for="n in 5" :key="`sk-${n}`" class="hrow" data-missing="1">
                  <span class="ico" aria-hidden="true"></span>
                  <span class="who"><b class="sk"></b><span class="sk sk--short"></span></span>
                  <span class="hstate"><span class="spinner"></span></span>
                </div>
              </div>

              <div
                v-else-if="!installedCount"
                class="none"
                role="group"
                aria-labelledby="install-head"
              >
                <h3 id="install-head">No agent CLI yet</h3>
                <p>
                  The workspace is made — it is just waiting for one of these on your
                  <code class="mono">PATH</code>. Install one, then press Check again.
                </p>
                <ul v-if="rows.length" class="cmds">
                  <li v-for="row in rows" :key="row.id">npm i -g {{ row.command }}</li>
                </ul>
                <p class="mnote">
                  A version manager or an app bundle puts it somewhere else — point at it in
                  Account → Harnesses after this.
                </p>
              </div>

              <div v-else role="radiogroup" aria-label="Agent CLI" class="hlist">
                <label
                  v-for="row in rows"
                  :key="row.id"
                  class="hrow"
                  :data-on="chosen === row.id ? '1' : '0'"
                  :data-missing="row.installed ? '0' : '1'"
                >
                  <input
                    v-model="chosen"
                    type="radio"
                    name="harness"
                    :value="row.id"
                    :disabled="!row.installed"
                    @change="msg = ''"
                  />
                  <HarnessIcon :name="row.id" :size="16" />
                  <span class="who">
                    <b>{{ row.label }}</b>
                    <span :title="row.path || row.command"
                  >{{ row.command }}<template v-if="row.path"> · {{ row.path }}</template></span
                >
                  </span>
                  <span class="hstate" :data-s="row.installed ? 'found' : 'missing'">
                    <i aria-hidden="true"></i>{{ row.installed ? 'installed' : 'not installed' }}
                  </span>
                </label>
              </div>

              <p v-if="!probing" class="mnote">
                {{ countLabel
                }}<template v-if="chosenLabel"> · the first turn runs on <b>{{ chosenLabel }}</b></template
                >.
              </p>
            </template>

            <template v-else>
              <p class="sub">
                This asks <b>{{ chosenLabel }}</b> one question and leaves <code>welcome.md</code>
                in the workspace so you can see how it answers. Delete the file whenever you like.
              </p>

              <ul class="chips">
                <li v-for="chip in CHIPS" :key="chip">
                  <button type="button" :disabled="Boolean(asking)" @click="ask(chip)">
                    {{ chip }}
                  </button>
                </li>
              </ul>

              <div class="log">
                <p v-if="!turns.length" class="hint">Pick one of these, or type your own.</p>
                <div
                  v-for="(turn, index) in turns"
                  :key="index"
                  class="turn"
                  :class="{
                    'turn--user': turn.who === 'me',
                    'turn--err': turn.error,
                  }"
                >
                  <BrandMark v-if="turn.who !== 'me'" class="av" />
                  <div class="body">
                    <span class="who">{{
                      turn.who === 'me' ? 'You' : turn.error ? `${chosenLabel} · error` : `welcome · ${chosenLabel}`
                    }}</span>
                    <MessageBody v-if="turn.who === 'agent'" :text="turn.text" />
                    <template v-else>{{ turn.text }}</template>
                  </div>
                </div>
                <div v-if="asking" class="turn">
                  <BrandMark class="av" />
                  <div class="body">
                    <span class="who">welcome · {{ chosenLabel }}</span>
                    <span class="hint">Thinking…</span>
                    <span class="caret" aria-hidden="true"></span>
                  </div>
                </div>
              </div>
            </template>

            <div class="slot" :data-on="msg ? '1' : '0'" role="status" aria-live="polite">
              <p class="msg">{{ msg }}</p>
            </div>

            <div class="wiz-foot">
              <button
                v-if="step > 1 && !(step === 3 && turns.length)"
                class="btn btn-ghost"
                type="button"
                :disabled="busy || Boolean(asking)"
                @click="back"
              >
                ← Back
              </button>
              <button
                v-if="step === 3 && msg && !asking"
                class="btn"
                type="button"
                @click="tryAgain"
              >
                Try again
              </button>
              <button
                class="btn btn-primary"
                type="submit"
                :data-busy="busy ? '1' : '0'"
                :disabled="!canGo"
              >
                <span class="spinner" aria-hidden="true"></span>{{ cta }}
              </button>
            </div>
          </form>
        </section>

        <p v-if="step === 2 && !probing && !installedCount" class="alt">
          <button type="button" @click="enterWorkspace">Open my workspace →</button>
        </p>
        <p v-else-if="step === 3 && msg && !asking" class="alt">
          <button type="button" @click="enterWorkspace">Leave for now</button>
        </p>
      </div>
    </div>
  </main>
</template>
