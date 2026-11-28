<script setup>
/**
 * "Add a task" is a sentence, not a form: the composer you write a prompt in is
 * the box, and the planner decides the fields. Submitting does not append a row
 * and leave the plan stale — the page re-plans around it, which is why the copy
 * says so before you press the button.
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { shortcutLabel } from '@/lib/shortcuts'

const props = defineProps({
  open: { type: Boolean, default: false },
  agent: { type: Object, default: () => ({}) },
  harness: { type: String, default: '' },
})
const emit = defineEmits(['close', 'submit'])

const text = ref('')
const composer = ref(null)

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})

async function focusComposer() {
  text.value = ''
  await nextTick()
  composer.value?.focus?.()
}

onMounted(focusComposer)
watch(() => props.open, (open) => open && focusComposer())

function submit() {
  const value = text.value.trim()
  if (!value) return
  emit('submit', value)
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
          Say what has to happen. The planner fits it into the plan, gives it an entity, an effort and a
          date, and re-dates whatever no longer fits.
        </p>
        <button class="mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body">
        <div class="cm cm-composer">
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
        <p class="ctx-note tasknote">
          No title, priority or date to fill in: those are the planner's answer, and this dialog does not
          pretend to know them first. <kbd>{{ shortcutLabel('goal-draft') }}</kbd> adds it.
        </p>
      </div>

      <div class="mo-foot">
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!text.trim()" @click="submit">
          Add and re-plan
        </button>
      </div>
    </div>
  </Teleport>
</template>
