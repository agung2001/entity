<script setup>
import { computed } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * A retry is a real harness turn: minutes of work and real tokens, and it
 * either replaces the failure under the question or lands a second copy of the
 * same words at the foot of the thread. Both are worth one sentence before the
 * click, so every retry — the failed row's own button and the prompt's footer
 * action — comes through here.
 *
 * `mode` is read from the transcript, never guessed by the dialog:
 *  - `replace` — the only rows after the question are the failed turn, so the
 *    retry re-runs it in place and the question is not duplicated;
 *  - `new` — the prompt already has an answer (or never landed one), so the
 *    retry is another turn and the earlier answer stays where it is.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  text: { type: String, default: '' },
  entity: { type: String, default: 'the entity' },
  harness: { type: String, default: '' },
  mode: { type: String, default: 'new' },
})
const emit = defineEmits(['close', 'confirm'])

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})

const replaces = computed(() => props.mode === 'replace')

/* The question as the person wrote it, shortened for the dialog. Same words,
   collapsed whitespace — this is evidence, not the transcript. */
const excerpt = computed(() => {
  const text = String(props.text || '').replace(/\s+/g, ' ').trim()
  return text.length > 240 ? `${text.slice(0, 240).trimEnd()}…` : text
})

const runsOn = computed(() =>
  props.harness ? `${props.harness} as ${props.entity}` : props.entity,
)
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
  <div
    class="modal modal-narrow confirm-modal prompt-retry"
    :data-open="open ? '1' : '0'"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="prompt-retry-title"
    aria-describedby="prompt-retry-body"
  >
    <header class="mo-head">
      <div>
        <p class="eyebrow">Retry prompt</p>
        <h2 id="prompt-retry-title">Ask this prompt again?</h2>
      </div>
      <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>

    <div class="mo-body">
      <p id="prompt-retry-body" class="confirm-lead">
        <template v-if="replaces">
          The turn that ran this prompt failed. Retrying runs it again and replaces the error with
          the new answer — the question stays exactly where it is.
        </template>
        <template v-else>
          This prompt is already in the conversation. Retrying asks it again as a new turn at the
          end; the earlier answer and everything it saved stay where they are.
        </template>
      </p>
      <blockquote class="prompt-retry-quote">{{ excerpt }}</blockquote>
      <p class="confirm-note">
        It runs as a real turn on {{ runsOn }} — the same process, time and tokens as the first
        attempt.
      </p>
    </div>

    <footer class="mo-foot">
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn btn-ink prompt-retry-go" type="button" @click="emit('confirm')">
        Retry prompt
      </button>
    </footer>
  </div>
</template>
