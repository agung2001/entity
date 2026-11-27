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

/* The row names an issue on the tracker the read found it in, and that read
   recorded the URL: the card is the other way to the issue, so it links. Only
   http(s) — the shell opens the browser and nothing else. */
const rowHref = computed(() => {
  const url = String(props.mention.rowUrl || '')
  return /^https?:\/\//i.test(url) ? url : ''
})
const rowHost = computed(() => {
  try {
    return new URL(rowHref.value).host || ''
  } catch {
    return ''
  }
})

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
  return [execution.harness, execution.model, duration(props.mention.ms || execution.ms)]
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
be the lie this one exists to prevent. The row's own record can tell, and does:
`worktreeState` reads the paths it names before it falls back to the ticket key,
so `gone` arrives only when the record named a workspace Orca no longer lists. */
onMounted(async () => {
  /* A held row has no cwd yet — nothing ran — so there is no worktree to look
     up; the card that lands after Run carries the chip instead. With no key and
     no path in the record, `worktreeState` answers `none` and the chip stays
     off, which is the honest answer rather than a guess. */
  if (props.hold) return
  try {
    const state = await call('mention.worktree', {
      cwd: props.mention.execution?.cwd || '',
      ticket: ticket(),
      record: { steps: props.mention.steps || [], answer: props.mention.answer || '' },
    })
    if (!state?.state || ['none', 'unknown'].includes(state.state)) return
    worktree.value = state
  } catch {
    /* an offline Orca must not mark the card */
  }
})

/* The chip as one word: the workspace's own name, or `gone` when the record
   named one that is no longer there. A state with no name to show is quiet. */
const chip = computed(() => {
  const state = worktree.value
  if (!state) return ''
  if (state.name) return String(state.name)
  return state.state === 'gone' ? 'gone' : ''
})

/* A live card says where it is instead of claiming an answer it does not have. */
function statusText() {
  const mention = props.mention
  if (retrying.value) return 'Retrying…'
  if (mention.answer) return mention.answer
  /* The failure line above already prints the note: printing it here as well put
     a whole multi-line salvage report on the card twice. */
  if (mention.note && !failedNote.value) return mention.note
  if (mention.status === 'running') return 'Working…'
  if (mention.status === 'queued') return 'Queued'
  return stepTail() || 'No answer recorded.'
}

/** One line of step content, clipped to something a card row can hold. */
function stepText(value, limit = 120) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** A tool call reads as what it was doing, not as a JSON blob. */
function stepLine(step) {
  if (!step) return ''
  if (step.type === 'tool_use') {
    let input = step.input
    if (input && typeof input === 'object') {
      try {
        input = JSON.stringify(input)
      } catch {
        input = ''
      }
    }
    const brief = stepText(input)
    return `${step.tool || 'tool'}${brief ? ` … ${brief}` : ''}`
  }
  return stepText(step.content || step.output || '')
}

/* A run that was killed leaves steps and no answer, and "No answer recorded."
   is the one thing that is certainly false about it: it recorded plenty. The
   last two steps are where the harness had got to — the account a person reads
   before deciding whether to retry. */
function stepTail() {
  const steps = Array.isArray(props.mention.steps) ? props.mention.steps : []
  return steps
    .slice(-2)
    .map(stepLine)
    .filter(Boolean)
    .join(' · ')
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
      <!-- Identity only, one line: a long workspace name shrinks instead of
           pushing `run 1/3` or a state word onto the entity's name. -->
      <div class="msg-delegation-head">
        <span class="msg-delegation-kicker">Delegated to</span>
        <span class="msg-delegation-name">{{ label() }}</span>
        <span
          v-if="chip"
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
          {{ chip }}
        </span>
        <span
          v-if="recovered"
          class="msg-delegation-retried"
          title="This session has answered since the failure this card recorded"
          >retried</span
        >
        <!-- A run of one instruction N times: a per-run label, not a fragment of
             the meta string, so `run 1/3` is never read as part of the name. -->
        <span
          v-if="mention.share"
          class="msg-delegation-share"
          title="This is one of several runs of the same instruction"
          >run {{ mention.share }}</span
        >
      </div>
      <!-- What ran and the way out of it: the meta may wrap on its own band, and
           the action keeps the right edge by being the only auto margin here. -->
      <div class="msg-delegation-row">
        <span v-if="meta()" class="msg-delegation-meta">{{ meta() }}</span>
        <span v-if="mention.threadId || retryable" class="msg-delegation-actions">
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
          <!-- A failed run is retried where it happened: the session re-asks its
               own question, so the card keeps the history it painted and the
               answer lands in the session the button beside this one opens. -->
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
        </span>
      </div>
      <p v-if="mention.job" class="msg-delegation-job">
        <a
          v-if="jobRow && rowHref"
          class="row"
          :href="rowHref"
          target="_blank"
          rel="noreferrer noopener"
          :title="`Open this issue on ${rowHost || 'its source'}`"
          >{{ jobRow }}<span class="row-go" aria-hidden="true"> ↗</span></a
        ><span v-else-if="jobRow" class="row">{{ jobRow }}</span><span
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
