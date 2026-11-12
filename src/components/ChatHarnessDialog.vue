<script setup>
import { computed } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { HARNESSES } from '@/data/mock'
import { harnesses } from '@/stores/harnesses'

/**
 * The harness button on the composer is informational once a thread exists:
 * it names the CLI and model the thread is pinned to instead of asking the
 * user to choose again. A new thread is where those choices are made.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  harness: { type: String, default: '' },
  model: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const label = computed(
  () => HARNESSES.find((item) => item.id === props.harness)?.label || props.harness || 'No harness',
)
const installed = computed(() => {
  const found = harnesses.items.find((item) => item.id === props.harness)
  if (!found) return ''
  return found.installed ? 'installed on this machine' : 'not found on this machine'
})
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
        <p>The CLI and model this thread runs on.</p>
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
          <div>
            <dt>Model</dt>
            <dd>
              <code v-if="model" class="mono ctxdlg-model">{{ model }}</code>
              <span v-else class="ctxdlg-empty">Harness default</span>
            </dd>
          </div>
        </dl>
        <p class="mnote">
          Pinned when this thread started. Start a new thread to use another harness or model.
        </p>
      </div>
      <div class="mo-foot">
        <button class="btn" type="button" @click="emit('close')">Close</button>
      </div>
    </div>
  </Teleport>
</template>
