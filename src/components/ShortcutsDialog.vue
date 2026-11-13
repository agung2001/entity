<script setup>
import { computed } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { shortcutGroups, shortcutLabel } from '@/lib/shortcuts'

/**
 * The keyboard guide. It reads the catalog in `src/lib/shortcuts.js` — never a
 * local copy — so a new shortcut appears here the moment it is registered.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const groups = computed(() => shortcutGroups())
const closeKey = shortcutLabel('escape')

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
})
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
    <div
      class="modal shortcut-help"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-help-title"
    >
      <div class="mo-head">
        <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
        <p>Every key the app listens for, grouped by where you are.</p>
        <button class="x mo-x" type="button" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body shortcut-body">
        <section v-for="group in groups" :key="group.id" class="shortcut-group">
          <h3>{{ group.label }}</h3>
          <dl class="help-list">
            <div v-for="item in group.items" :key="item.id">
              <dt>
                <kbd v-for="key in item.keys" :key="key">{{ key }}</kbd>
              </dt>
              <dd>
                <b>{{ item.label }}</b>
                <span>{{ item.desc }}</span>
              </dd>
            </div>
          </dl>
        </section>

        <p class="help-note">
          These are the keys this window accepts; a browser tab keeps Option/Alt+Shift where its
          own chrome owns the combo.
        </p>
      </div>

      <div class="mo-foot shortcut-foot">
        <span class="shortcut-hint"><kbd>{{ closeKey }}</kbd> closes this guide</span>
        <button class="btn btn-ink" type="button" @click="emit('close')">Done</button>
      </div>
    </div>
  </Teleport>
</template>
