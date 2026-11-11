<script setup>
import { hub } from '@/stores/hub'
</script>

<template>
  <div class="toast" role="status" aria-live="polite" :data-open="hub.toast.open ? '1' : '0'">
    {{ hub.toast.message }}
  </div>
</template>
