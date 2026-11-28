<script setup>
/**
 * Edit one task — the same dialog grammar as "Add a task", with the fields the
 * planner would set: title, priority, entity, effort, date and the source it
 * was reasoned from. Adding is a planning turn; editing a row you are looking
 * at is a local write, so this dialog never calls a harness.
 *
 * The entity is `PickMenu` (an entity is an identity), the date is the same
 * `<input type="date">` the goal's own form uses, and priority/effort are the
 * app's words, not codes.
 */
import { computed, ref, watch } from 'vue'
import PickMenu from '@/components/PickMenu.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { EFFORT_WORDS, PRIORITY_ORDER, priorityWord } from '@/lib/goals'

const props = defineProps({
  open: { type: Boolean, default: false },
  task: { type: Object, default: null },
  entityOptions: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'save'])

const title = ref('')
const priority = ref('normal')
const entity = ref('')
const effort = ref('')
const date = ref('')
const source = ref('')

const priorities = PRIORITY_ORDER
const efforts = Object.entries(EFFORT_WORDS)

const canSave = computed(() => Boolean(title.value.trim()))

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})

watch(
  () => props.open,
  (open) => {
    if (!open || !props.task) return
    title.value = String(props.task.title || '')
    priority.value = String(props.task.priority || 'normal')
    entity.value = String(props.task.entity || '')
    effort.value = String(props.task.effort || '')
    date.value = String(props.task.date || '')
    source.value = String(props.task.token?.label || '')
  },
  { immediate: true },
)

function save() {
  const next = title.value.trim()
  if (!next) return
  emit('save', {
    title: next,
    priority: priority.value,
    entity: entity.value,
    effort: effort.value,
    date: date.value,
    token: { ...(props.task?.token || { kind: 'draft' }), label: source.value.trim() },
  })
}
</script>

<template>
  <Teleport v-if="open && task" to="body">
    <div class="scrim scrim-dialog" data-open="1" @click="emit('close')" />
    <div
      class="modal taskdlg taskedit"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="taskedit-t"
      tabindex="-1"
    >
      <div class="mo-head">
        <h2 id="taskedit-t">Edit task</h2>
        <p class="tasklede">
          Change the row you are looking at. Nothing here re-plans the rest — adding and removing tasks
          are what ask the planner for a new version.
        </p>
        <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body goals-page taskedit-body">
        <div class="fld-solo">
          <label for="taskedit-title">Task</label>
          <input id="taskedit-title" v-model="title" type="text" placeholder="What has to happen" />
        </div>

        <!-- priority's four words need the whole width; effort, entity and the
             rest pair up two by two -->
        <div class="fld-solo">
          <label class="fld-head">Priority</label>
          <div class="seg seg-pri" role="group" aria-label="Priority">
            <button
              v-for="word in priorities"
              :key="word"
              type="button"
              :data-p="word"
              :aria-pressed="priority === word ? 'true' : 'false'"
              @click="priority = word"
            ><i class="dot"></i>{{ priorityWord(word) }}</button>
          </div>
        </div>

        <div class="fld-row">
          <div class="fld-solo">
            <label class="fld-head">Effort</label>
            <div class="seg" role="group" aria-label="Effort">
              <button
                v-for="[value, label] in efforts"
                :key="value"
                type="button"
                :aria-pressed="effort === value ? 'true' : 'false'"
                @click="effort = effort === value ? '' : value"
              >{{ label }}</button>
            </div>
          </div>
          <div class="fld-solo">
            <label class="fld-head">Entity</label>
            <PickMenu
              class="field-select"
              head="Entity"
              icons="entity"
              :options="entityOptions"
              :model-value="entity"
              @update:model-value="entity = $event"
            />
          </div>
        </div>

        <div class="fld-row">
          <div class="fld-solo">
            <label for="taskedit-date">Due</label>
            <input id="taskedit-date" v-model="date" type="date" />
          </div>
          <div class="fld-solo">
            <label for="taskedit-source">Source <span class="opt">optional</span></label>
            <input id="taskedit-source" v-model="source" type="text" placeholder="The project or file it came from" />
          </div>
        </div>
      </div>

      <div class="mo-foot">
        <span class="galfoot-why">{{ canSave ? 'Changes stay in this draft until you create the goal.' : 'A task needs a title.' }}</span>
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canSave" @click="save">
          Save task
        </button>
      </div>
    </div>
  </Teleport>
</template>
