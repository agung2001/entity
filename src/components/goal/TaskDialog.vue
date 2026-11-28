<script setup>
/**
 * "Add a task" is a sentence, not a form: the composer you write a prompt in is
 * the box, and the entity is the one deliberate field. Adding is a local write —
 * no planning turn, no re-dating of the rest — so priority, effort and date are
 * left for the task's edit dialog.
 *
 * The footer names the plan the task joins, so this reads as an edit to that
 * plan and not as a blank form floating over it.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import PickMenu from '@/components/PickMenu.vue'
import PromptEnhanceDialog from '@/components/PromptEnhanceDialog.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { day } from '@/lib/goals'

const props = defineProps({
  open: { type: Boolean, default: false },
  agent: { type: Object, default: () => ({}) },
  harness: { type: String, default: '' },
  planSize: { type: Number, default: 0 },
  deadline: { type: String, default: '' },
  /* the same entity picker the goal's own form uses — an entity is an identity,
     so it is the app's picker, not a native select */
  entity: { type: String, default: '' },
  entityOptions: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'submit'])

const EXAMPLES = [
  'Write the release notes',
  'Add a rollback check',
  'Schedule a review session',
]

const text = ref('')
const picked = ref(props.entity)
/* the composer's own attachments are the task's context; the first one becomes
   its source, so there is no second "Source" field to fill in */
const attachments = ref([])
const enhanceOpen = ref(false)
const dialogEl = ref(null)
const composer = ref(null)

const pickedName = computed(
  () => props.entityOptions.find((option) => option.id === picked.value)?.label || '',
)

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})

/* Opening does not put a focus ring on the composer: the box should look exactly
   like step 1's until somebody clicks into it. The dialog itself takes focus, so
   Esc and the keyboard still work from the moment it opens. */
async function resetDialog() {
  text.value = ''
  attachments.value = []
  picked.value = props.entity
  await nextTick()
  /* the dialog takes focus, not the composer: a11y without drawing a ring on a
     box that should look untouched */
  dialogEl.value?.focus?.()
}

onMounted(resetDialog)
watch(() => props.open, (open) => open && resetDialog())

function useExample(example) {
  text.value = example
  composer.value?.focus?.()
}

function applyEnhance(answer) {
  text.value = String(answer?.text || text.value)
  enhanceOpen.value = false
}

function submit() {
  const value = text.value.trim()
  if (!value) return
  emit('submit', value, pickedName.value, attachments.value)
}
</script>

<template>
  <Teleport v-if="open" to="body">
    <div class="scrim scrim-dialog" data-open="1" @click="emit('close')" />
    <div
      ref="dialogEl"
      class="modal taskdlg"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="taskdlg-t"
      tabindex="-1"
    >
      <div class="mo-head">
        <h2 id="taskdlg-t">Add a task</h2>
        <p class="tasklede">
          One job, said plainly. It joins the plan as it is — nothing else is re-dated, and no planning
          turn is spent.
        </p>
        <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body goals-page">
        <div class="tasklbl-row">
          <label class="tasklbl" for="taskdlg-input">The task</label>
          <button
            class="task-enh"
            type="button"
            title="Enhance this task with the planner"
            :disabled="!text.trim()"
            @click="enhanceOpen = true"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 1.8l1.5 4.7L14.2 8l-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" />
              <path d="M12.6 2.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" opacity=".55" />
            </svg>
            Enhance
          </button>
        </div>
        <div class="cm cm-composer taskfld">
          <SlashComposer
            ref="composer"
            :agent="agent"
            :show-send="false"
            :show-enhance="false"
            machine="local"
            base-dir=""
            placeholder="What has to happen — / skills · @ mentions"
            label="New task — / for a skill, @ to mention"
            :draft="text"
            v-model:attachments="attachments"
            @update:draft="text = $event"
            @send="submit"
          />
        </div>

        <div class="taskex">
          <span class="lbl">Try</span>
          <button v-for="example in EXAMPLES" :key="example" class="taskex-btn" type="button" @click="useExample(example)">
            {{ example }}
          </button>
        </div>

        <div class="taskwho">
          <div class="taskwho-fld">
            <label class="tasklbl">Assign to</label>
            <PickMenu
              class="field-select"
              head="Entity"
              icons="entity"
              :options="entityOptions"
              :model-value="picked"
              @update:model-value="picked = $event"
            />
          </div>
          <span class="taskwho-hint">Priority, effort and date are set on the row, after it is added.</span>
        </div>
      </div>

      <div class="mo-foot">
        <span class="taskctx">
          <EntityMark v-if="pickedName" mini :entity="pickedName" />
          <span>
            for <b>{{ pickedName || 'the planner to choose' }}</b>
            <template v-if="planSize"> · joins {{ planSize }} {{ planSize === 1 ? 'task' : 'tasks' }}</template>
            <template v-if="deadline"> · due {{ day(deadline) }}</template>
          </span>
        </span>
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!text.trim()" @click="submit">
          Add task
        </button>
      </div>
    </div>

    <PromptEnhanceDialog
      :open="enhanceOpen"
      :seed="text"
      :harness="harness"
      from="plan"
      scope="the task"
      @close="enhanceOpen = false"
      @apply="applyEnhance"
    />
  </Teleport>
</template>
