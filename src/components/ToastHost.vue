<script setup>
import { hub, runToastAction } from '@/stores/hub'
</script>

<template>
  <div class="toast" role="status" aria-live="polite" :data-open="hub.toast.open ? '1' : '0'">
    <span>{{ hub.toast.message }}</span>
    <!-- One action, and only when the message has one: a reversible write offers
         Undo where the person is already looking, not in a second surface. -->
    <button
      v-if="hub.toast.actionLabel"
      class="toast-action"
      type="button"
      @click="runToastAction"
    >
      {{ hub.toast.actionLabel }}
    </button>
  </div>
</template>
