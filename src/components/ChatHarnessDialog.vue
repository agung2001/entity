<script setup>
import { computed, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import ModelInput from '@/components/ModelInput.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { harnesses, loadModels } from '@/stores/harnesses'

/**
 * The harness is pinned to the thread, but the model is not: every turn starts
 * a fresh process on the same harness, so a different model can be selected
 * without moving the conversation.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  harness: { type: String, default: '' },
  model: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save'])

useDialogDismiss({ active: () => props.open, close: () => emit('close') })

const draft = ref('')

watch(
  () => [props.open, props.harness, props.model],
  ([open]) => {
    if (!open) return
    draft.value = props.model || ''
    loadModels(props.harness).catch(() => {})
  },
  { immediate: true },
)

const label = computed(
  () => harnesses.items.find((item) => item.id === props.harness)?.label || props.harness || 'No harness',
)
const installed = computed(() => {
  const found = harnesses.items.find((item) => item.id === props.harness)
  if (!found) return ''
  return found.installed ? 'installed on this machine' : 'not found on this machine'
})
const modelData = computed(() => harnesses.models[props.harness] || null)
const modelOptions = computed(() => [...new Set(modelData.value?.models || [])])
const dirty = computed(() => draft.value.trim() !== (props.model || ''))

function save() {
  if (!dirty.value) return
  emit('save', draft.value.trim())
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
    <div
      class="modal modal-narrow ctxdlg"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      aria-label="Harness and model"
    >
      <div class="mo-head">
        <h2>Harness &amp; model</h2>
        <p>The CLI this thread runs on, and the model its next turn uses.</p>
        <button class="x mo-x" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div class="mo-body ctxdlg-body">
        <dl class="ctxdlg-facts">
          <div>
            <dt>Harness</dt>
            <dd class="ctxdlg-harness">
              <HarnessIcon :name="harness" :size="15" />
              <b>{{ label }}</b>
              <span v-if="installed" class="ctxdlg-note">{{ installed }}</span>
            </dd>
          </div>
        </dl>
        <div class="fld">
          <span class="lbl">Model</span>
          <ModelInput
            :model-value="draft"
            :options="modelOptions"
            :loading="Boolean(modelData?.loading)"
            label="Model"
            :placeholder="modelData?.default || 'harness default'"
            @update:model-value="draft = $event"
          />
        </div>
        <p class="mnote">
          The harness stays with this thread. A different model applies from the next turn;
          blank uses the harness default.
        </p>
      </div>
      <div class="mo-foot">
        <button class="btn" type="button" @click="emit('close')">Cancel</button>
        <button class="btn btn-ink" type="button" :disabled="!dirty" @click="save">
          Save model
        </button>
      </div>
    </div>
  </Teleport>
</template>
