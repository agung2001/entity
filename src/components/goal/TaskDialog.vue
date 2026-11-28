<script setup>
/**
 * "Add a task" is a sentence, not a form: the composer you write a prompt in is
 * the box, and the planner decides the fields. Submitting does not append a row
 * and leave the plan stale — the page re-plans around it, which is why the copy
 * says so before you press the button.
 *
 * The footer names the plan the task joins, so this reads as an edit to that
 * plan and not as a blank form floating over it.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import PickMenu from '@/components/PickMenu.vue'
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
const composer = ref(null)

const pickedName = computed(
  () => props.entityOptions.find((option) => option.id === picked.value)?.label || '',
)

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})

async function focusComposer() {
  text.value = ''
  picked.value = props.entity
  await nextTick()
  composer.value?.focus?.()
}

onMounted(focusComposer)
watch(() => props.open, (open) => open && focusComposer())

function useExample(example) {
  text.value = example
  composer.value?.focus?.()
}

function submit() {
  const value = text.value.trim()
  if (!value) return
  emit('submit', value, pickedName.value)
}
</script>

<template>
  <Teleport v-if="open" to="body">
    <div class="scrim scrim-dialog" data-open="1" @click="emit('close')" />
    <div
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
          One job, said plainly. It joins the plan and the planner fits it in — entity, effort, date —
          re-dating whatever no longer holds.
        </p>
        <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body">
        <label class="tasklbl" for="taskdlg-input">The task</label>
        <div class="taskfld">
          <SlashComposer
            ref="composer"
            :agent="agent"
            :show-send="false"
            machine="local"
            base-dir=""
            placeholder="What has to happen — / skills · @ mentions"
            label="New task — / for a skill, @ to mention"
            :draft="text"
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
          <span class="taskwho-hint">The planner still sets its priority, effort and date.</span>
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
          Add and re-plan
        </button>
      </div>
    </div>
  </Teleport>
</template>
