<script setup>
/**
 * One delegated run, whether it is still working or long finished.
 *
 * The same card is painted twice in a turn's life — inside the live bubble while
 * the fan-out runs, and inside the answer once it lands — because a person
 * watching seven jobs should not see one grammar turn into another. A live card
 * has no `threadId` yet, so Continue appears only when there is somewhere to go.
 */
import { computed, onMounted, ref } from 'vue'
import EntityMark from './EntityMark.vue'
import { call } from '@/composables/localBridge'
import { hub, isSending } from '@/stores/hub'

const props = defineProps({
  mention: { type: Object, required: true },
  /* a held row: the folder it would start in, and whether that folder is worth
     a warning (`~`, or no folder at all). Absent on a finished answer's card. */
  hold: { type: Object, default: null },
})

/* A held row's job is the instruction the run receives: the row first, then the
   person's words. The finished card shows the same string as one block; the hold
   marks the row, because the row is what a fan-out is about. */
const jobRow = computed(() =>
  props.hold && props.mention.row ? String(props.mention.row) : '',
)
const jobText = computed(() => {
  const job = String(props.mention.job || '')
  if (!jobRow.value) return job
  return job.startsWith(jobRow.value) ? job.slice(jobRow.value.length).trim() : job
})

defineEmits(['open-thread', 'retry'])

/* A failure outlives the turn that recorded it: the session it left behind may
   have been retried since. The stored mention is what happened then; the row is
   what is true now, and the card is the glance. */
const childRow = computed(() =>
  props.mention.threadId
    ? (hub.chat.summaries || []).find((row) => row.id === props.mention.threadId) || null
    : null,
)
const retrying = computed(
  () => Boolean(props.mention.threadId) && isSending(props.mention.threadId),
)
/** Failed in the record, answered since: the red border is no longer true. */
const recovered = computed(
  () =>
    props.mention.status === 'error' &&
    Boolean(childRow.value) &&
    !childRow.value.failed &&
    childRow.value.replies > 0,
)
/** Nothing to retry into means no button: a run that never got a session. */
const retryable = computed(
  () => props.mention.status === 'error' && Boolean(props.mention.threadId) && !recovered.value,
)
const failedNote = computed(() =>
  props.mention.status === 'error' && !recovered.value
    ? props.mention.note || 'This run failed.'
    : '',
)

const label = () => props.mention.token || `@${props.mention.name || 'entity'}`

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function meta() {
  const execution = props.mention.execution || {}
  return [
    execution.harness,
    execution.model,
    duration(props.mention.ms || execution.ms),
    /* a run of one instruction N times: the card has to say which one it is */
    props.mention.share ? `run ${props.mention.share}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/* The worktree the row works in, as it is *now* — not as it was when the run
   ended. A stored field would freeze at "clean, exists" and lie about the one
   case this is for: the row was merged and its worktree removed. */
const worktree = ref(null)

/* No key, no chip: a `spawn 3` share or a job with no issue id says nothing
   about a worktree, so it does not ask. */
function ticket() {
  return (String(props.mention.row || '').match(/^([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || ''
}

/* Orca forgets a worktree once it is removed, so "no row in its list" cannot
tell `merged and removed` from `never created` — and a chip that guesses would
be the lie this one exists to prevent. The row's own record can tell: a child
that worked in a checkout ran in that directory, so its steps or answer name
the path. Derived from the transcript, and used only to decide whether to paint
a word — no path from here is ever read. */
function hadWorktree() {
  const key = ticket().toLowerCase()
  if (!key) return false
  const text = JSON.stringify([props.mention.steps || [], props.mention.answer || '']).toLowerCase()
  return text.includes('/orca/workspaces/') && text.includes(`/${key}`)
}

onMounted(async () => {
  /* A held row has no cwd yet — nothing ran — so there is no worktree to look
     up; the card that lands after Run carries the chip instead. */
  if (props.hold || !ticket()) return
  try {
    const state = await call('mention.worktree', {
      cwd: props.mention.execution?.cwd || '',
      ticket: ticket(),
    })
    if (!state?.state || ['none', 'unknown'].includes(state.state)) return
    if (state.state === 'gone' && !hadWorktree()) return
    worktree.value = state
  } catch {
    /* an offline Orca must not mark the card */
  }
})

/* A live card says where it is instead of claiming an answer it does not have. */
function statusText() {
  const mention = props.mention
  if (retrying.value) return 'Retrying…'
  if (mention.answer) return mention.answer
  if (mention.note) return mention.note
  if (mention.status === 'running') return 'Working…'
  if (mention.status === 'queued') return 'Queued'
  return 'No answer recorded.'
}
</script>

<template>
  <div
    class="msg-delegation"
    :data-error="mention.status === 'error' && !recovered ? '1' : '0'"
    :data-live="mention.live ? mention.status || 'queued' : null"
    :data-hold="hold ? '1' : null"
    :title="mention.job || mention.raw || ''"
  >
    <EntityMark :entity="mention.name" animate class="msg-delegation-mark" />
    <div class="msg-delegation-body">
      <div class="msg-delegation-head">
        <span class="msg-delegation-kicker">Delegated to</span>
        <span class="msg-delegation-name">{{ label() }}</span>
        <!-- Between the name and the meta on purpose: `.msg-delegation-meta`
             and `.msg-delegation-open` share `margin-left: auto`, and
             `.msg-delegation-meta + .msg-delegation-open` disambiguates them. -->
        <span
          v-if="worktree"
          class="msg-delegation-worktree"
          :data-state="worktree.state"
          :title="
            worktree.state === 'gone'
              ? `the worktree for ${ticket()} is gone — merged and removed, or deleted`
              : `${worktree.path} · ${worktree.branch} — ${
                  worktree.files ? `${worktree.files} paths uncommitted` : 'no uncommitted changes'
                }`
          "
        >
          {{ worktree.state === 'dirty' ? `${worktree.files} changed` : worktree.state }}
        </span>
        <span
          v-if="recovered"
          class="msg-delegation-retried"
          title="This session has answered since the failure this card recorded"
          >retried</span
        >
        <span v-if="meta()" class="msg-delegation-meta">{{ meta() }}</span>
        <!-- The run is a session, not a dead end: continue it as a real
             conversation with that entity. -->
        <button
          v-if="mention.threadId"
          class="msg-delegation-open"
          type="button"
          :title="`Continue this session with ${mention.name || 'the entity'}`"
          @click="$emit('open-thread', mention.threadId)"
        >
          Continue
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M5.5 3h7.5v7.5M13 3L6.5 9.5" />
          </svg>
        </button>
        <!-- A failed run is retried where it happened: the session re-asks its own
             question, so the card keeps the history it painted and the answer
             lands in the session the button beside this one opens. -->
        <button
          v-if="retryable"
          class="msg-delegation-retry"
          type="button"
          :disabled="retrying"
          :title="retrying ? 'This session is answering again' : 'Run this session’s question again'"
          @click="$emit('retry', mention.threadId)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M12.8 6.4A5 5 0 1 0 13 9" />
            <path d="M12.8 2.6v3.8H9" />
          </svg>
          {{ retrying ? 'Retrying…' : 'Retry' }}
        </button>
      </div>
      <p v-if="mention.job" class="msg-delegation-job">
        <span v-if="jobRow" class="row">{{ jobRow }}</span><span
          v-if="jobText"
          class="text"
          >{{ jobText }}</span
        >
      </p>
      <!-- what will run, where: hedged, because a harness may only read -->
      <p v-if="hold && hold.where" class="hold-where" :data-warn="hold.warn ? '1' : '0'">
        {{ hold.where }}
      </p>
      <p v-if="!hold && failedNote" class="msg-delegation-fail">{{ failedNote }}</p>
      <p v-if="!hold" class="msg-delegation-answer">{{ statusText() }}</p>
    </div>
  </div>
</template>
