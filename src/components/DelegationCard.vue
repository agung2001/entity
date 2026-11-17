<script setup>
/**
 * One delegated run, whether it is still working or long finished.
 *
 * The same card is painted twice in a turn's life — inside the live bubble while
 * the fan-out runs, and inside the answer once it lands — because a person
 * watching seven jobs should not see one grammar turn into another. A live card
 * has no `threadId` yet, so Continue appears only when there is somewhere to go.
 */
import EntityMark from './EntityMark.vue'

const props = defineProps({
  mention: { type: Object, required: true },
})

defineEmits(['open-thread'])

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

/* A live card says where it is instead of claiming an answer it does not have. */
function statusText() {
  const mention = props.mention
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
    :data-error="mention.status === 'error' ? '1' : '0'"
    :data-live="mention.live ? mention.status || 'queued' : null"
    :title="mention.job || mention.raw || ''"
  >
    <EntityMark :entity="mention.name" animate class="msg-delegation-mark" />
    <div class="msg-delegation-body">
      <div class="msg-delegation-head">
        <span class="msg-delegation-kicker">Delegated to</span>
        <span class="msg-delegation-name">{{ label() }}</span>
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
      </div>
      <p v-if="mention.job" class="msg-delegation-job">{{ mention.job }}</p>
      <p class="msg-delegation-answer">{{ statusText() }}</p>
    </div>
  </div>
</template>
