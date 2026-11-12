<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { readArtifact } from '@/stores/artifacts'

/**
 * A screenshot is worth showing in the list. Load it only when it is near the
 * viewport, so an artifacts folder with many images does not decode all of them
 * at once.
 */
const props = defineProps({ item: { type: Object, required: true } })
const src = ref('')
const failed = ref(false)
const root = ref(null)
let observer = null

async function load() {
  if (!props.item || props.item.kind !== 'image' || src.value) return
  try {
    const data = await readArtifact(props.item.id)
    src.value = data?.dataUrl || ''
  } catch {
    failed.value = true
  }
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') {
    load()
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect()
        observer = null
        load()
      }
    },
    { rootMargin: '240px' },
  )
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(() => props.item.id, () => {
  src.value = ''
  failed.value = false
  load()
})
</script>

<template>
  <span ref="root" class="artifact-thumb">
    <img v-if="src" :src="src" :alt="item.name" loading="lazy" @error="src = ''; failed = true" />
    <span v-else class="artifact-thumb-fallback" :data-ext="item.ext">
      {{ failed ? '!' : (item.ext || 'file').replace('.', '').slice(0, 4) }}
    </span>
  </span>
</template>
