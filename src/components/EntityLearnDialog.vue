<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { copyText } from '@/lib/clipboard'
import { diffRows } from '@/lib/diff'
import { hub, toast } from '@/stores/hub'

/**
 * "Learning" — the entity reads its own recent conversations and proposes
 * better standing instructions.
 *
 * The scope is chosen *before* the review is paid for: how many conversations,
 * and since when. Nothing runs on open, and nothing is written until the person
 * applies the proposal.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  entity: { type: String, default: '' },
  /* The entity's own conversation rows, straight from the page's history list:
     the dialog counts them, caps the choice and names the scope in words. */
  threads: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'applied'])

/* ponytail: the real ceiling is `TIMEOUT_MS` in `electron/learn.cjs` and this
   constant only mirrors it so the waiting copy can name the limit instead of
   leaving a silent spinner. Both are 5 minutes because the answer is a whole
   instructions file: a 27 KB body took 148s to replace on a two-conversation
   scope, so a two-minute ceiling failed the smallest review this app can ask
   for. Move both when the ceiling moves; there is no streaming for
   `entity.learn`, so a clock is what the wait has. */
const LIMIT_MINUTES = 5

const busy = ref(false)
const applying = ref(false)
const error = ref('')
const result = ref(null)
const requestId = ref(0)
const editing = ref(false)
const draft = ref('')
const editor = ref(null)
const countField = ref(null)

/* The scope, kept across runs: re-reviewing keeps what the person chose. */
const limit = ref(10)
const since = ref('')
const until = ref('')

/* One clock, the same one the wait shows and the result prints. */
const elapsed = ref(0)
const startedAt = ref(0)
let ticker = 0

const maxThreads = computed(() => Math.max(1, props.threads.length))
const chosen = computed(() =>
  Math.min(Math.max(1, Math.round(Number(limit.value) || 1)), maxThreads.value),
)
const presets = computed(() => [
  { id: '5', label: '5', value: 5 },
  { id: '10', label: '10', value: 10 },
  { id: '25', label: '25', value: 25 },
  { id: 'all', label: 'All', value: maxThreads.value },
])

/* What the run in flight was asked for, captured when it started. */
const pending = ref(null)
const scopeWords = computed(() => {
  const asked = pending.value
  if (!asked) return ''
  const total = maxThreads.value
  const many = asked.count === 1 ? 'conversation' : 'conversations'
  const parts = [`${asked.count}${total > asked.count ? ` of ${total}` : ''} ${many}`]
  if (asked.since) parts.push(`since ${asked.since}`)
  if (asked.until) parts.push(`until ${asked.until}`)
  return parts.join(', ')
})

const clock = computed(() => {
  const total = Math.max(0, Math.round(elapsed.value))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
})
const seconds = computed(() => Math.round(elapsed.value))

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const reviewLabel = computed(() => `Review ${plural(chosen.value, 'conversation', 'conversations')}`)
const readLabel = computed(() => {
  const read = result.value?.sources?.length || 0
  const asked = result.value?.asked || read
  const tail = asked > read ? ` of ${asked} asked` : ''
  return `${plural(read, 'conversation', 'conversations')}${tail}`
})

/* The proposal is a draft: it can be edited before it is applied, and the diff
   always compares the current file with whatever is in the editor. */
const rows = computed(() =>
  result.value && !editing.value ? diffRows(result.value.current, draft.value) : [],
)
const added = computed(() => rows.value.filter((row) => row.kind !== 'same').length)
const dirty = computed(() => Boolean(result.value) && draft.value !== result.value.proposed)

function stopClock() {
  if (ticker) clearInterval(ticker)
  ticker = 0
}

function startClock() {
  stopClock()
  startedAt.value = Date.now()
  elapsed.value = 0
  ticker = setInterval(() => {
    elapsed.value = (Date.now() - startedAt.value) / 1000
  }, 250)
}

function close() {
  /* Escape inside the editor leaves edit mode first; a second Escape closes. */
  if (editing.value) {
    editing.value = false
    return
  }
  emit('close')
}

useDialogDismiss({
  active: () => props.open,
  close,
  guard: () => applying.value,
})

watch(
  () => props.open,
  async (open) => {
    if (open) {
      requestId.value += 1
      /* The scope survives a close and a re-run; only its ceiling moves. */
      limit.value = Math.min(Math.max(1, Math.round(Number(limit.value) || 10)), maxThreads.value)
      reset()
      await nextTick()
      countField.value?.focus()
      return
    }
    requestId.value += 1
    busy.value = false
    reset()
  },
)

onBeforeUnmount(stopClock)

/** Every piece of a finished or abandoned run, and nothing of the chosen scope. */
function reset() {
  stopClock()
  elapsed.value = 0
  startedAt.value = 0
  pending.value = null
  busy.value = false
  error.value = ''
  result.value = null
  editing.value = false
  draft.value = ''
}

async function run() {
  if (!props.entity || busy.value || !props.threads.length) return
  const id = ++requestId.value
  pending.value = { count: chosen.value, since: since.value, until: until.value }
  busy.value = true
  error.value = ''
  result.value = null
  startClock()
  try {
    const data = await call('entity.learn', {
      workspace: hub.workspace,
      entity: props.entity,
      limit: pending.value.count,
      since: pending.value.since || undefined,
      until: pending.value.until || undefined,
    })
    if (id !== requestId.value) return
    stopClock()
    elapsed.value = (Date.now() - startedAt.value) / 1000
    result.value = data
    draft.value = data.proposed
    editing.value = false
    await nextTick()
  } catch (failure) {
    if (id !== requestId.value) return
    stopClock()
    elapsed.value = (Date.now() - startedAt.value) / 1000
    error.value = failure?.message || 'The review could not finish.'
  } finally {
    if (id === requestId.value) busy.value = false
  }
}

async function applyProposal() {
  if (!result.value || applying.value || !draft.value.trim()) return
  applying.value = true
  try {
    const updated = await call('entity.learnApply', {
      workspace: hub.workspace,
      entity: props.entity,
      instructions: draft.value,
    })
    const changes = diffRows(result.value.current, draft.value).filter(
      (row) => row.kind !== 'same',
    ).length
    toast(`${props.entity} learned ${changes} change${changes === 1 ? '' : 's'}`)
    emit('applied', updated)
    emit('close')
  } catch (failure) {
    error.value = failure?.message || 'The instructions could not be saved.'
  } finally {
    applying.value = false
  }
}

/* Back to the scope form with the scope it was run with, so paying for a second
   review is one press and never a guess at what was chosen. */
function changeScope() {
  result.value = null
  draft.value = ''
  editing.value = false
  error.value = ''
  elapsed.value = 0
}

async function startEditing() {
  editing.value = true
  await nextTick()
  editor.value?.focus()
}

async function copyProposal() {
  if (!result.value || !draft.value.trim()) return
  const copied = await copyText(draft.value)
  toast(copied ? 'Proposed instructions copied' : 'Could not copy to the clipboard')
}
</script>

<template>
  <div
    class="scrim scrim-dialog"
    :data-open="open ? '1' : '0'"
    @click="!applying && emit('close')"
  ></div>
  <div
    class="modal learn-modal"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Learn from recent conversations"
  >
    <header class="mo-head">
      <div>
        <p class="eyebrow">Learning · {{ entity }}</p>
        <h2>What the conversations taught it</h2>
      </div>
      <button class="x mo-x" type="button" aria-label="Close" :disabled="applying" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>

    <div class="mo-body">
      <div v-if="busy" class="learn-state">
        <span class="spinner" aria-hidden="true"></span>
        <div>
          <b>Reading {{ scopeWords }}</b>
          <p class="learn-meta" role="status">
            <span aria-hidden="true">{{ clock }} · gives up after {{ LIMIT_MINUTES }} minutes</span>
            <span class="sr-only">The review gives up after {{ LIMIT_MINUTES }} minutes.</span>
          </p>
          <p>The entity's own harness compares its instructions with how it was actually used.</p>
        </div>
      </div>

      <template v-else-if="result">
        <div class="learn-summary">
          <p>{{ result.summary }}</p>
          <p class="learn-meta">
            {{ readLabel }} · {{ result.harness }}
            <template v-if="result.model"> · {{ result.model }}</template>
            · {{ seconds }}s
          </p>
        </div>

        <div class="learn-toolbar">
          <div class="learn-tabs" role="tablist" aria-label="Review mode">
            <button
              type="button"
              role="tab"
              :aria-selected="!editing ? 'true' : 'false'"
              @click="editing = false"
            >
              Side by side
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="editing ? 'true' : 'false'"
              @click="startEditing"
            >
              Edit proposed
            </button>
          </div>
          <span v-if="dirty" class="learn-dirty">Edited · {{ draft.split('\n').length }} lines</span>
          <span v-else class="learn-hint">Edit the proposal before applying it.</span>
          <button class="learn-again" type="button" @click="changeScope">Change scope</button>
        </div>

        <div
          v-if="editing"
          class="learn-editor-wrap"
          :data-editor-open="'1'"
        >
          <textarea
            ref="editor"
            v-model="draft"
            class="learn-editor"
            spellcheck="false"
            aria-label="Proposed instructions"
          ></textarea>
        </div>

        <div v-else class="learn-diff" role="table" aria-label="Proposed instruction changes">
          <div class="learn-diff-head" role="row">
            <span>Current instructions</span>
            <span>Proposed</span>
          </div>
          <div
            v-for="(row, index) in rows"
            :key="index"
            class="learn-row"
            :data-kind="row.kind"
            role="row"
          >
            <div
              class="learn-cell"
              role="cell"
              data-side="Current"
              :data-kind="row.kind === 'add' ? 'blank' : row.kind === 'change' ? 'remove' : row.kind"
            >
              <span class="learn-no">{{ row.leftNo }}</span>
              <code>{{ row.left }}</code>
            </div>
            <div
              class="learn-cell"
              role="cell"
              data-side="Proposed"
              :data-kind="row.kind === 'remove' ? 'blank' : row.kind === 'change' ? 'add' : row.kind"
            >
              <span class="learn-no">{{ row.rightNo }}</span>
              <code>{{ row.right }}</code>
            </div>
          </div>
        </div>

        <p v-if="error" class="learn-error" role="alert">{{ error }}</p>
      </template>

      <div v-else class="learn-scope">
        <div class="learn-scope-row">
          <label class="learn-field learn-field--count" for="learn-count">
            <span>Conversations</span>
            <input
              id="learn-count"
              ref="countField"
              v-model.number="limit"
              type="number"
              min="1"
              :max="maxThreads"
              :disabled="busy || !threads.length"
              :aria-describedby="'learn-scope-note'"
            />
          </label>
          <div class="learn-presets" role="group" aria-label="How many conversations to read">
            <button
              v-for="preset in presets"
              :key="preset.id"
              class="btn btn-sm"
              type="button"
              :data-on="chosen === Math.min(preset.value, maxThreads) ? '1' : '0'"
              :disabled="busy || !threads.length"
              @click="limit = Math.min(preset.value, maxThreads)"
            >
              {{ preset.label }}
            </button>
          </div>
        </div>

        <div class="learn-scope-row">
          <label class="learn-field learn-field--date" for="learn-since">
            <span>Since</span>
            <input
              id="learn-since"
              v-model="since"
              type="date"
              :max="until || undefined"
              :disabled="busy || !threads.length"
            />
          </label>
          <label class="learn-field learn-field--date" for="learn-until">
            <span>Until</span>
            <input
              id="learn-until"
              v-model="until"
              type="date"
              :min="since || undefined"
              :disabled="busy || !threads.length"
            />
          </label>
          <button
            class="btn btn-ink learn-review"
            type="button"
            :disabled="busy || !threads.length"
            @click="run"
          >
            {{ reviewLabel }}
          </button>
        </div>

        <p id="learn-scope-note" class="learn-scope-note">
          <template v-if="threads.length">
            {{ plural(threads.length, 'conversation', 'conversations') }} with {{ entity }} ·
            empty dates mean no bound · nothing is written until you apply.
          </template>
          <template v-else>
            No conversations with {{ entity }} yet. Chat with it first, then learn from them.
          </template>
        </p>

        <p v-if="error" class="learn-error" role="alert">{{ error }}</p>
      </div>
    </div>

    <footer class="mo-foot">
      <span class="learn-count">
        <template v-if="result && !editing">{{ added }} changed {{ added === 1 ? 'line' : 'lines' }}</template>
        <template v-else-if="result">Editing the proposal</template>
        <template v-else-if="busy">Nothing is written until you apply.</template>
      </span>
      <button class="btn" type="button" :disabled="busy || applying" @click="emit('close')">Cancel</button>
      <button class="btn" type="button" :disabled="!result || busy || applying || !draft.trim()" @click="copyProposal">
        Copy proposed
      </button>
      <button
        class="btn btn-ink"
        type="button"
        :disabled="!result || applying || !draft.trim()"
        @click="applyProposal"
      >
        {{ applying ? 'Applying…' : 'Apply to instructions' }}
      </button>
    </footer>
  </div>
</template>
