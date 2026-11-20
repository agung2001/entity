<script setup>
import { onMounted, ref, watch } from 'vue'
import { voxelSvg } from '@/lib/voxel'

/**
 * A page ornament in the character's own idiom: a silhouette from the specimen
 * sheet, drawn on the mark's 9 × 9 cell grid with one flat fill per light angle
 * and a single glint that steps on and off in hard pixels.
 *
 * The slot decides the size and the editorial position; the fills come from the
 * mark's own colour (`--mk`, `--mk-h`), so an ornament and the character beside
 * it stand on the same paper in both themes. It is a drawing, not a character:
 * no requestAnimationFrame, no eyes tracking — the whole animation is CSS and
 * only where a person can see it.
 */
const props = defineProps({
  shape: { type: String, default: 'station' },
  /* the sheet's marks are all square; a caption is the caller's job */
  label: { type: String, default: '' },
})

const el = ref(null)

function paint() {
  if (!el.value) return
  /* generated from `voxel.js` — no caller-supplied markup ever reaches this */
  el.value.innerHTML = voxelSvg(props.shape)
}

onMounted(paint)
watch(() => props.shape, paint)
</script>

<template>
  <span ref="el" class="vx" :data-shape="props.shape" :title="label || null" aria-hidden="true"></span>
</template>
