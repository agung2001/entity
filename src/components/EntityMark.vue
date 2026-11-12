<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { hydrateMark, markFor, releaseMark } from '@/composables/entityMark'
import { hub } from '@/stores/hub'

/**
 * The voxel character. Sizing is done by the CSS of whatever slot the mark
 * sits in (`.mark`), so this component only says which variant it is:
 * `mini` (list rows) and `hop` (where the mark is the whole statement).
 *
 * Pass `entity` to make the mark wear that entity's own mood and colour. The
 * brand mark (rail, sign-in) has no entity and keeps the hub-wide settings.
 */
const props = defineProps({
  mini: { type: Boolean, default: false },
  animate: { type: Boolean, default: false },
  hop: { type: Boolean, default: false },
  entity: { type: String, default: '' },
  workspace: { type: String, default: '' },
  shape: { type: String, default: '' },
  badge: { type: Boolean, default: true },
})

const el = ref(null)
const mark = computed(() => markFor(props.workspace || hub.workspace, props.entity))

function mount() {
  if (!el.value) return
  hydrateMark(el.value, {
    mini: props.mini,
    hop: props.hop,
    animate: props.animate,
    mark: mark.value,
    shape: props.shape,
    /* the brand mark is a logo; entity marks keep their mood badge */
    badge: props.badge && Boolean(props.entity),
  })
}

function remount() {
  if (!el.value) return
  releaseMark(el.value)
  el.value.innerHTML = ''
  delete el.value.dataset.ready
  mount()
}

onMounted(mount)
watch(
  [() => props.entity, () => props.workspace, () => props.shape, () => mark.value.shape, () => hub.workspace],
  remount,
)
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
