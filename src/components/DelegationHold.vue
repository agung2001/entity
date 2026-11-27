<script setup>
/**
 * One plan, waiting for the person who wrote it.
 *
 * A message that delegates is sent as always — the reads inside it resolve,
 * their answers are real work — and then the runs stop and show themselves:
 * what would run, where it would start, how long it may take. **Run all** is the
 * only thing that starts them. Send stays send; this is not a pre-send dialog,
 * a modal or a second composer (three things DESIGN.md says were built and
 * rejected).
 *
 * The plan is a form: one instruction above the cards, one editable job per
 * card, and a stepper for the count. Run sends exactly what is on screen, so
 * the revision travels on the Run call itself — there is no write in flight and
 * nothing to debounce.
 *
 * The same block, settled, is what a reload shows after a cancel or an expiry:
 * the rows that never ran, and the outcome. It is painted from the turn's own
 * row, so it cannot disagree with the transcript.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EntityMark from './EntityMark.vue'
import PromptEnhanceDialog from './PromptEnhanceDialog.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'

const props = defineProps({
  /* the plan a turn is waiting on: rows, instruction, reads, dir, timeoutMs */
  plan: { type: Object, default: null },
  /* the settled block read back from a cancelled/expired turn's row */
  settled: { type: Object, default: null },
})
const emit = defineEmits(['run', 'cancel'])

const busy = ref(false)
const armed = ref(false)
const primary = ref(null)
let armTimer = null

/* ── the form ──────────────────────────────────────────────────────
   `cards` is a local copy, so `+`/`−` can change the count without touching the
   turn's row; `text` is the band, `jobs` one instruction per card, `undo` the
   rows a trim removed (so `Back to 4` restores their words, not the band's). */
const cards = ref([])
const text = ref('')
const jobs = ref([])
const source = ref('')
const undo = ref(null)
const seeded = ref(false)
const enhanceOpen = ref(false)
const enhanceTarget = ref('instruction')

/* The engine sends a plain job; a fan-out prepends its row. The row keeps its
   own line above the field, so the field is seeded without it. */
function stripRow(row) {
  const job = String(row?.job || '')
  const label = row?.row ? String(row.row) : ''
  if (!label) return job
  /* The engine joins them with a blank line; anything else is the person's own
     first line that happens to start with the row's words, and is not a row. */
  return job.startsWith(`${label}\n\n`) ? job.slice(label.length).trim() : job
}

function seedPlan() {
  if (seeded.value || !props.plan) return
  const list = Array.isArray(props.plan.rows) ? props.plan.rows : []
  cards.value = list.map((row) => ({ ...row }))
  jobs.value = list.map(stripRow)
  text.value = String(props.plan.instruction || jobs.value[0] || '')
  source.value = text.value
  seeded.value = true
}
/* Seeded at setup, before the first paint, and only once: a re-render must not
   clobber typing. */
seedPlan()

const rows = computed(() => props.settled?.rows || props.plan?.rows || [])
const count = computed(() => (props.settled ? rows.value.length : cards.value.length))
const single = computed(() => count.value === 1)
const name = computed(() => (props.settled ? rows.value[0]?.name : cards.value[0]?.name) || '')
const invalidAt = computed(() => jobs.value.findIndex((job) => !String(job || '').trim()))
const bandEdited = computed(() => seeded.value && text.value !== source.value)
const sameCount = computed(() => jobs.value.filter((job) => job === text.value).length)

const outcome = computed(() => {
  const settled = props.settled?.settled
  if (settled === 'expired') return { kicker: 'Expired', tag: 'waited 10 min' }
  if (settled === 'interrupted') return { kicker: 'Interrupted', tag: 'the window closed' }
  if (settled) return { kicker: 'Cancelled', tag: 'cancelled by you' }
  return null
})

const title = computed(() => {
  if (outcome.value) return 'Nothing started'
  return single.value ? `@${name.value} is ready to run` : `${count.value} runs are ready`
})

/* One count, in the title. The button names the target instead, so a title and a
   button can never disagree about how many runs there are. */
const primaryLabel = computed(() => (single.value ? `Run @${name.value}` : 'Run all'))
const summary = computed(() => {
  const plan = props.plan || {}
  const n = count.value
  const folder = plan.dir ? `folder ${plan.shownDir || plan.dir}` : 'different folders'
  return `${n} ${n === 1 ? 'run' : 'runs'} · ${folder} · ${ceiling()}`
})
const ceiling = () => {
  const ms = Number(props.plan?.timeoutMs)
  const min = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0
  return min ? `up to ${min} min each` : 'a time ceiling each'
}

/* The band's name follows its count: `the run`, `both runs`, `all 4 runs`. */
const bandLabel = computed(() => {
  const n = cards.value.length
  if (n === 1) return 'Instruction · sent to the run'
  if (n === 2) return 'Instruction · sent to both runs'
  return `Instruction · sent to all ${n} runs`
})

const enhanceScope = computed(() =>
  enhanceTarget.value === 'instruction'
    ? 'instruction'
    : `run ${enhanceTarget.value + 1} of ${cards.value.length}`,
)
const enhanceSeed = computed(() =>
  enhanceTarget.value === 'instruction' ? text.value : jobs.value[enhanceTarget.value] || '',
)

function cardEdited(index) {
  return (jobs.value[index] || '') !== text.value
}

/* Band input: a card that still read the old band follows the new one; a card
   with its own words keeps them. */
function onBandInput(event) {
  const next = event.target.value
  const previous = text.value
  text.value = next
  jobs.value = jobs.value.map((job) => (job === previous ? next : job))
}

function onJobInput(index, event) {
  const next = event.target.value
  jobs.value = jobs.value.map((job, at) => (at === index ? next : job))
}

function useInstruction(index) {
  jobs.value = jobs.value.map((job, at) => (at === index ? text.value : job))
}

function fewer() {
  if (cards.value.length <= 1) return
  /* The first trim in a run remembers the whole plan, so two `−` still offer
     `Back to 4` rather than `Back to 3`. */
  if (!undo.value) {
    undo.value = {
      n: cards.value.length,
      rows: cards.value.map((card) => ({ ...card })),
      jobs: [...jobs.value],
    }
  }
  cards.value = cards.value.slice(0, -1)
  jobs.value = jobs.value.slice(0, -1)
}

function more() {
  if (cards.value.length >= 5 || !cards.value.length) return
  const last = cards.value[cards.value.length - 1]
  cards.value = [...cards.value, { ...last }]
  jobs.value = [...jobs.value, jobs.value[jobs.value.length - 1] ?? text.value]
  undo.value = null
}

function back() {
  const kept = undo.value
  if (!kept) return
  cards.value = kept.rows.map((card) => ({ ...card }))
  jobs.value = [...kept.jobs]
  undo.value = null
}

function openEnhance(target) {
  enhanceTarget.value = target
  enhanceOpen.value = true
}

/* Apply writes to the field it came from and nowhere else. The band propagates
   the way typing in it does. */
function applyEnhance(payload) {
  const next = String(payload?.text || '')
  if (enhanceTarget.value === 'instruction') {
    const previous = text.value
    text.value = next
    jobs.value = jobs.value.map((job) => (job === previous ? next : job))
  } else {
    const at = Number(enhanceTarget.value)
    jobs.value = jobs.value.map((job, index) => (index === at ? next : job))
  }
  enhanceOpen.value = false
}

/* What already happened, so the gate is credibly about work that has not. */
const reads = computed(() => {
  const list = props.plan?.reads || []
  if (!list.length) return ''
  return list
    .map((read) => {
      if (read.count) return `${read.token} → ${read.count} ${read.count === 1 ? 'row' : 'rows'}`
      if (read.detail) return `${read.token} → ${read.detail}`
      /* a read that found nothing is still a read that happened — and the block
         already says so in the same words */
      return `${read.token} → nothing found`
    })
    .filter(Boolean)
    .join(' · ')
})

/* `~` is the home folder, and nine entities in this workspace have nothing else:
   say it on the row, in the accent, instead of hiding it in a summary. */
function where(row) {
  if (row.note) return `starts in no folder — @${row.name} has no folder set`
  const dir = row.shownDir || row.dir || ''
  if (dir === '~') return `starts in your home folder (~) — @${row.name} has no folder set`
  if (!props.plan?.dir) return `runs in ${dir} · may write files there`
  return ''
}

function whereWarn(row) {
  const dir = row.shownDir || row.dir || ''
  return Boolean(row.note) || dir === '~'
}

function metaOf(row) {
  return [row.harness, row.model].filter(Boolean).join(' · ')
}

/* The row names an issue on the tracker the read found it in, so the line is the
   way there. Only http(s) becomes a link: the shell opens the browser and
   nothing else, so any other scheme would be a link that does nothing. */
function rowLink(row) {
  const url = String(row?.rowUrl || '')
  return /^https?:\/\//i.test(url) ? url : ''
}
function rowHost(row) {
  try {
    return new URL(rowLink(row)).host || ''
  } catch {
    return ''
  }
}

/* The settled row is one line for the whole plan: after the fact the count is
   the story, and every share that never ran. */
const settledShares = computed(() => {
  const shares = rows.value.map((row) => row.share).filter(Boolean)
  return shares.length ? shares.join(' · ') : ''
})
const settledJob = computed(() => {
  const row = rows.value[0] || {}
  /* the row text, then the person's words — the card's existing job shape */
  return String(row.job || '').replace(/^[^\n]*\n\n/, '')
})
const settledTitle = computed(() => {
  const n = count.value
  return `${n} ${n === 1 ? 'run' : 'runs'}${settledShares.value ? ` · ${settledShares.value}` : ''}`
})

function run() {
  /* The Enter that sent the message must not be the click that runs it. */
  if (!armed.value || busy.value) return
  if (invalidAt.value >= 0) return
  busy.value = true
  emit('run', { count: cards.value.length, instruction: text.value, rows: [...jobs.value] })
}

function cancel() {
  if (busy.value) return
  busy.value = true
  emit('cancel')
}

/* `Run all` from anywhere in the thread. This is the only owner: it is the only
   place that knows whether a card is empty. */
function onRunKey(event) {
  if (props.settled || !matchesShortcut('run-delegation', event)) return
  if (enhanceOpen.value) return
  event.preventDefault()
  event.stopPropagation()
  if (invalidAt.value >= 0) return
  run()
}

/* Esc cancels while the plan is unanswered, through the one Escape stack — and
   not while Run is in flight. */
useDialogDismiss({
  active: () => !props.settled,
  close: cancel,
  guard: () => busy.value,
})

onMounted(() => {
  if (props.settled) return
  /* Focus lands on Run so the keyboard path is one key, but only after the
     send's own key event has finished travelling. */
  requestAnimationFrame(() => primary.value?.focus?.())
  armTimer = setTimeout(() => {
    armed.value = true
  }, 250)
  window.addEventListener('keydown', onRunKey)
})
onBeforeUnmount(() => {
  if (armTimer) clearTimeout(armTimer)
  armTimer = null
  window.removeEventListener('keydown', onRunKey)
})
</script>

<template>
  <div
    class="hold"
    :data-settled="settled ? '1' : '0'"
    role="group"
    :aria-label="settled ? `Delegated runs: ${title}` : `Delegated runs, waiting for you: ${title}`"
  >
    <div class="hold-head">
      <span class="hold-kicker">{{ outcome ? outcome.kicker : 'Waiting for you' }}</span>
      <span class="hold-title">{{ title }}</span>
      <span class="hold-tag">{{ outcome ? outcome.tag : 'nothing has started' }}</span>
    </div>

    <p v-if="reads" class="hold-reads">
      <b>Read:</b>
      <span>{{ reads }}</span>
    </p>

    <!-- Settled: one row for the whole plan, because nothing ran. -->
    <div v-if="settled" class="msg-delegations">
      <div class="msg-delegation" data-hold="1" data-settled="1">
        <EntityMark :entity="rows[0]?.name || 'entity'" class="msg-delegation-mark" />
        <div class="msg-delegation-body">
          <div class="msg-delegation-head">
            <span class="msg-delegation-kicker">Not run</span>
            <span class="msg-delegation-name">@{{ rows[0]?.name || 'entity' }}</span>
          </div>
          <div class="msg-delegation-row">
            <span class="msg-delegation-meta">{{ settledTitle }}</span>
          </div>
          <p v-if="settledJob" class="msg-delegation-job">{{ settledJob }}</p>
        </div>
      </div>
    </div>

    <!-- Held: the plan as a form. The band is the shared instruction, every
         card is one run's own words, and the stepper moves the count. -->
    <template v-else>
      <div class="plan-band">
        <div class="plan-band-head">
          <label class="lbl" for="plan-inst">{{ bandLabel }}</label>
          <span v-if="bandEdited" class="plan-note">edited</span>
          <button
            class="plan-enh"
            type="button"
            aria-label="Enhance the instruction"
            @click="openEnhance('instruction')"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />
            </svg>
            Enhance
          </button>
        </div>
        <textarea
          id="plan-inst"
          class="plan-field"
          rows="3"
          :value="text"
          @input="onBandInput"
        ></textarea>
        <p class="plan-hint">
          Every run gets this. A card with its own words keeps them —
          <b>{{ sameCount }} {{ sameCount === 1 ? 'run still reads' : 'runs still read' }} this text</b>.
        </p>
      </div>

      <div class="plan-count">
        <span class="lbl">Runs</span>
        <span class="step" role="group" aria-label="How many runs">
          <button
            class="step-btn"
            type="button"
            aria-label="One fewer run"
            :disabled="cards.length <= 1"
            @click="fewer"
          >
            −
          </button>
          <span class="step-n" aria-live="polite">{{ cards.length }}</span>
          <button
            class="step-btn"
            type="button"
            aria-label="One more run"
            :disabled="cards.length >= 5"
            @click="more"
          >
            +
          </button>
        </span>
        <span class="plan-count-note">
          <template v-if="undo">
            {{ undo.n - cards.length }} removed ·
            <button class="plan-link" type="button" @click="back">Back to {{ undo.n }}</button>
          </template>
          <template v-else>
            <span data-long>one instruction · <b>{{ cards.length }}</b> sessions · the most is 5</span>
            <span data-short>max 5</span>
          </template>
        </span>
      </div>

      <div
        class="msg-delegations"
        :class="{ 'msg-delegations--scroll': cards.length > 4 }"
        aria-label="Runs that have not started"
      >
        <div
          v-for="(card, index) in cards"
          :key="`${card.row || card.name || 'run'}-${index}`"
          class="msg-delegation"
          data-hold="1"
        >
          <EntityMark :entity="card.name" animate class="msg-delegation-mark" />
          <div class="msg-delegation-body">
            <div class="plan-card-head">
              <span class="msg-delegation-kicker">Delegated to</span>
              <span class="msg-delegation-name">@{{ card.name }}</span>
              <span
                v-if="cards.length > 1 || card.share"
                class="msg-delegation-share"
                title="This is one of several runs of the plan"
                >run {{ index + 1 }}/{{ cards.length }}</span
              >
              <span v-if="cardEdited(index)" class="plan-chip">edited</span>
              <button
                class="plan-enh"
                type="button"
                :aria-label="`Enhance run ${index + 1} of ${cards.length}`"
                @click="openEnhance(index)"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" />
                </svg>
                Enhance
              </button>
            </div>
            <div v-if="metaOf(card)" class="msg-delegation-row">
              <span class="msg-delegation-meta">{{ metaOf(card) }}</span>
            </div>
            <!-- A fan-out card still says which row it is, on its own line —
                 and opens it when the read that resolved it found a URL. -->
            <p v-if="card.row" class="msg-delegation-job">
              <a
                v-if="rowLink(card)"
                class="row"
                :href="rowLink(card)"
                target="_blank"
                rel="noreferrer noopener"
                :title="`Open this issue on ${rowHost(card) || 'its source'}`"
                >{{ card.row }}<span class="row-go" aria-hidden="true"> ↗</span></a
              >
              <span v-else class="row">{{ card.row }}</span>
            </p>
            <textarea
              class="plan-job"
              rows="2"
              :value="jobs[index]"
              placeholder="No instruction"
              :aria-label="`Instruction for run ${index + 1} of ${cards.length}`"
              :aria-invalid="invalidAt === index ? 'true' : 'false'"
              @input="onJobInput(index, $event)"
            ></textarea>
            <p v-if="cardEdited(index)" class="plan-hint">
              <button class="plan-link" type="button" @click="useInstruction(index)">
                Use the instruction
              </button>
            </p>
            <p v-if="where(card)" class="hold-where" :data-warn="whereWarn(card) ? '1' : '0'">
              {{ where(card) }}
            </p>
            <p v-if="invalidAt === index" class="plan-err" role="alert">
              Give this run words, or remove it.
            </p>
          </div>
        </div>
      </div>
    </template>

    <div v-if="!settled" class="hold-foot">
      <span class="hold-summary" :data-error="invalidAt >= 0 ? '1' : '0'">
        {{ invalidAt >= 0 ? `run ${invalidAt + 1} has no instruction` : summary }}
      </span>
      <span class="hold-actions">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="cancel">
          Cancel
        </button>
        <button
          ref="primary"
          class="btn btn-ink"
          type="button"
          :disabled="busy || invalidAt >= 0"
          @click="run"
        >
          {{ busy ? 'Starting…' : primaryLabel }}
          <span class="btn-kbd" aria-hidden="true">{{ shortcutLabel('run-delegation') }}</span>
        </button>
      </span>
    </div>

    <PromptEnhanceDialog
      :open="enhanceOpen"
      :seed="enhanceSeed"
      from="plan"
      :scope="enhanceScope"
      @apply="applyEnhance"
      @close="enhanceOpen = false"
    />
  </div>
</template>
