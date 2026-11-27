<script setup>
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'

/**
 * One child's instruction, whole.
 *
 * A held card shows the first four lines of what its run will receive — enough
 * to recognise the instruction, not enough to read the conversation it was
 * built from. **Read more** opens this: the delegation instruction and the
 * context block as two fields, each on its own lines, so neither has to be read
 * as one long paragraph.
 *
 * It is an editor, not a second composer. Nothing here starts a run; Save
 * writes that card's own instruction back, and Run is still the only thing that
 * starts anything.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /* the two halves of this run's prompt, as the card holds them */
  task: { type: String, default: '' },
  context: { type: String, default: '' },
  /* `run 1 of 2`, so two dialogs cannot be mistaken for one another */
  scope: { type: String, default: '' },
})
const emit = defineEmits(['close', 'apply'])

/* Mounted once per held plan; the ids have to be this instance's, because a
   second dialog may be in the document at the same time. */
const uid = useId()
const titleId = `prompt-title-${uid}`
const taskId = `prompt-task-${uid}`
const contextId = `prompt-context-${uid}`

const task = ref('')
const context = ref('')
const taskEl = ref(null)
const saveKey = shortcutLabel('send')

const empty = computed(() => !task.value.trim())
const words = (value) => (value.trim() ? value.trim().split(/\s+/).length : 0)
const contextWords = computed(() => words(context.value))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    task.value = String(props.task || '')
    context.value = String(props.context || '')
    nextTick(() => {
      taskEl.value?.focus()
      taskEl.value?.setSelectionRange(0, 0)
      taskEl.value?.scrollTo?.({ top: 0 })
    })
  },
  { immediate: true },
)

/* The same close function the scrim, the X and `Esc` use, so all three leave
   the same state behind. */
function dismiss() {
  emit('close')
}

function apply() {
  if (empty.value) return
  emit('apply', { task: task.value, context: context.value })
}

useDialogDismiss({ active: () => props.open, close: dismiss })

function onKey(event) {
  /* The composer's send key saves here, the way it generates in Enhance. It
     never sends a turn: the card's Run is still the one way out. */
  if (!matchesShortcut('send', event)) return
  event.preventDefault()
  event.stopPropagation()
  apply()
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim scrim-dialog" :data-open="open ? '1' : '0'" @click="dismiss" />
    <div
      class="modal promptdlg"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      @keydown="onKey"
    >
      <div class="mo-head">
        <span class="prompt-kicker">{{ scope }}</span>
        <h2 :id="titleId">Child instruction</h2>
        <p class="prompt-lede">
          What this run starts with. The context is where the delegation instruction came from —
          trim it if the run does not need it.
        </p>
        <button class="mo-x" type="button" aria-label="Close" @click="dismiss">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body">
        <div class="prompt-field">
          <label class="prompt-label" :for="taskId">
            <span>Delegation instruction</span>
            <span class="prompt-note">{{ words(task) }} {{ words(task) === 1 ? 'word' : 'words' }}</span>
          </label>
          <textarea
            :id="taskId"
            ref="taskEl"
            v-model="task"
            class="plan-field prompt-task"
            rows="4"
            :aria-invalid="empty ? 'true' : 'false'"
          ></textarea>
        </div>

        <div class="prompt-field">
          <label class="prompt-label" :for="contextId">
            <span>Context from this conversation</span>
            <span class="prompt-note">
              added by the engine · {{ contextWords }}
              {{ contextWords === 1 ? 'word' : 'words' }}
            </span>
          </label>
          <textarea
            :id="contextId"
            v-model="context"
            class="plan-field prompt-context"
            rows="12"
            spellcheck="false"
          ></textarea>
        </div>

        <p v-if="empty" class="plan-err" role="alert">Give this run words, or cancel.</p>
      </div>

      <div class="mo-foot">
        <span class="prompt-key">Esc closes · <span class="btn-kbd">{{ saveKey }}</span> saves</span>
        <button class="btn" type="button" @click="dismiss">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="empty" @click="apply">
          Save instruction
        </button>
      </div>
    </div>
  </Teleport>
</template>
