<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { hydrateMark, releaseMark } from '@/composables/entityMark'

/**
 * The voxel character. Sizing is done by the CSS of whatever slot the mark
 * sits in (`.mark`), so this component only says which variant it is:
 * `mini` (list rows) and `hop` (where the mark is the whole statement).
 */
const props = defineProps({
  mini: { type: Boolean, default: false },
  hop: { type: Boolean, default: false },
})

const el = ref(null)

onMounted(() => hydrateMark(el.value, { mini: props.mini, hop: props.hop }))
onBeforeUnmount(() => releaseMark(el.value))
</script>

<template>
  <span
    ref="el"
    class="mark"
    :class="{ 'mark--xs': mini, 'mark--hop': hop }"
    data-avatar
    aria-hidden="true"
  ></span>
</template>
