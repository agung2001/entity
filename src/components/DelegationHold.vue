<script setup>
/**
 * One plan, waiting for the person who wrote it.
 *
 * A message that delegates is sent as always — the reads inside it resolve,
 * their answers are real work — and then the runs stop and show themselves:
 * what would run, where it would start, how long it may take. **Run** is the
 * only thing that starts them. Send stays send; this is not a pre-send dialog,
 * a modal or a second composer (three things DESIGN.md says were built and
 * rejected).
 *
 * The same block, settled, is what a reload shows after a cancel or an expiry:
 * the rows that never ran, and the outcome. It is painted from the turn's own
 * row, so it cannot disagree with the transcript.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EntityMark from './EntityMark.vue'
import DelegationCard from './DelegationCard.vue'
import { useDialogDismiss } from '@/composables/useDialog'

const props = defineProps({
  /* the plan a turn is waiting on: rows, reads, dir, timeoutMs */
  plan: { type: Object, default: null },
  /* the settled block read back from a cancelled/expired turn's row */
  settled: { type: Object, default: null },
})
const emit = defineEmits(['run', 'cancel'])

const busy = ref(false)
const armed = ref(false)
const primary = ref(null)
let armTimer = null

const rows = computed(() => props.settled?.rows || props.plan?.rows || [])
const count = computed(() => rows.value.length)
const single = computed(() => count.value === 1)
const name = computed(() => rows.value[0]?.name || '')

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
  busy.value = true
  emit('run')
}

function cancel() {
  if (busy.value) return
  busy.value = true
  emit('cancel')
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
})
onBeforeUnmount(() => {
  if (armTimer) clearTimeout(armTimer)
  armTimer = null
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

    <!-- Held: the production row, with the folder it would start in. -->
    <div
      v-else
      class="msg-delegations"
      :class="{ 'msg-delegations--scroll': rows.length > 4 }"
      aria-label="Runs that have not started"
    >
      <DelegationCard
        v-for="(row, index) in rows"
        :key="`${row.row || row.name || 'run'}-${index}`"
        :mention="{
          kind: 'entity',
          name: row.name,
          row: row.row,
          job: row.job,
          share: row.share,
          status: 'queued',
          execution: { harness: row.harness, model: row.model },
        }"
        :hold="{ where: where(row), warn: whereWarn(row) }"
      />
    </div>

    <div v-if="!settled" class="hold-foot">
      <span class="hold-summary">{{ summary }}</span>
      <span class="hold-actions">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="cancel">
          Cancel
        </button>
        <button ref="primary" class="btn btn-ink" type="button" :disabled="busy" @click="run">
          {{ busy ? 'Starting…' : primaryLabel }}
          <span class="btn-kbd" aria-hidden="true">↵</span>
        </button>
      </span>
    </div>
  </div>
</template>
