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
import PromptEnhanceDialog from '@/components/PromptEnhanceDialog.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { EFFORT_WORDS, PRIORITY_ORDER, priorityWord } from '@/lib/goals'

const props = defineProps({
  open: { type: Boolean, default: false },
  task: { type: Object, default: null },
  entityOptions: { type: Array, default: () => [] },
  harness: { type: String, default: '' },
  agent: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'save'])

const title = ref('')
const priority = ref('normal')
const entity = ref('')
const effort = ref('')
const date = ref('')
/* the composer's attachments are the task's context. The first one is its
   source, which is why this dialog has no separate Source field. */
const attachments = ref([])
const enhanceOpen = ref(false)

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
    /* a `draft` token is the planner's reasoning label ("goal"), not a source
       anybody attached — it does not become a chip */
    const token = props.task.token || {}
    const linked = Boolean(token.value) || (token.kind && token.kind !== 'draft')
    attachments.value = linked
      ? [{ kind: String(token.kind || 'file'), name: String(token.label || token.value || ''), value: String(token.value || '') }]
      : []
  },
  { immediate: true },
)

function applyEnhance(answer) {
  title.value = String(answer?.text || title.value)
  enhanceOpen.value = false
}

/** The first attachment is the source. Only its reference travels with the task:
    the bytes the composer read are this turn's, not the goal's. */
function tokenOfAttachments() {
  const first = attachments.value[0]
  if (!first) return { kind: 'draft', label: '', value: '' }
  return {
    kind: String(first.kind || 'file'),
    label: String(first.name || first.value || first.label || ''),
    value: String(first.value || ''),
  }
}

function save() {
  const next = title.value.trim()
  if (!next) return
  emit('save', {
    title: next,
    priority: priority.value,
    entity: entity.value,
    effort: effort.value,
    date: date.value,
    token: tokenOfAttachments(),
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
          Change the row you are looking at. It writes this task only — no other row is re-dated and no
          planning turn is spent.
        </p>
        <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body goals-page taskedit-body">
        <div class="fld-solo">
          <div class="tasklbl-row">
            <span class="fld-head">Task</span>
            <button
              class="task-enh"
              type="button"
              title="Enhance this task with the planner"
              :disabled="!title.trim()"
              @click="enhanceOpen = true"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 1.8l1.5 4.7L14.2 8l-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" />
                <path d="M12.6 2.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" opacity=".55" />
              </svg>
              Enhance
            </button>
          </div>
          <!-- the same box as step 1: `/` a skill, `@` a mention, so a title can
               point at the entity or project it is about -->
          <div class="cm cm-composer task-title">
            <SlashComposer
              :agent="agent"
              :show-send="false"
              :show-enhance="false"
              machine="local"
              base-dir=""
              placeholder="What has to happen — / skills · @ mentions"
              label="Task — / for a skill, @ to mention"
              :draft="title"
              v-model:attachments="attachments"
              @update:draft="title = $event"
              @send="canSave && save()"
            />
          </div>
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

        <div class="fld-solo">
          <label for="taskedit-date">Due</label>
          <input id="taskedit-date" v-model="date" type="date" />
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

    <PromptEnhanceDialog
      :open="enhanceOpen"
      :seed="title"
      :harness="harness"
      from="plan"
      scope="the task"
      @close="enhanceOpen = false"
      @apply="applyEnhance"
    />
  </Teleport>
</template>
