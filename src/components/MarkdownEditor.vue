<script setup>
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { loadProse, proseReady, renderProse } from '@/lib/prose'

/**
 * The Markdown surface. `Write` is a rich-text editor over the same Markdown the
 * file holds; `Review` is the renderer this app already had. Both read one
 * string, so the two cannot disagree.
 *
 * The editor itself is the lazy chunk: a page that only reviews a document never
 * downloads Tiptap, which is why this shell is cheap and `MarkdownRichText` is
 * not.
 *
 * This surface has no find of its own. What you type is on the page as text, so
 * `PageFind` — the app's one find, the counterpart of the browser's — searches
 * it along with the rest of the screen, and highlighting never has to rewrite a
 * node the editor owns.
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  rows: { type: Number, default: 18 },
  placeholder: { type: String, default: 'Write Markdown…' },
})
const emit = defineEmits(['update:modelValue'])

const RichText = defineAsyncComponent(() => import('@/components/MarkdownRichText.vue'))

const mode = ref('write')

const preview = computed(() => {
  /* reading the flag re-runs this the moment the parser chunk lands */
  void proseReady.value
  return renderProse(props.modelValue)
})

const words = computed(() => {
  const text = String(props.modelValue || '').trim()
  return text ? text.split(/\s+/).length : 0
})

/* `rows` is a floor rather than a frame: the document flows with the page. */
const floor = computed(() => `${Math.round(props.rows * 22)}px`)

/* Review unmounts the editor, so the document is written before it is reviewed:
   a tab switch must not lose what the editor has not published yet. */
function update(value) {
  emit('update:modelValue', value)
}

onMounted(() => loadProse().catch(() => {}))
</script>

<template>
  <div class="md-editor" :data-disabled="disabled ? '1' : '0'">
    <div class="md-bar">
      <div class="md-tabs" role="tablist" aria-label="Markdown mode">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'write' ? 'true' : 'false'"
          @click="mode = 'write'"
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'preview' ? 'true' : 'false'"
          @click="mode = 'preview'"
        >
          Review
        </button>
      </div>
      <span class="md-words">{{ words }} words</span>
    </div>

    <div v-if="mode === 'write'" class="md-input">
      <RichText
        :model-value="modelValue"
        :disabled="disabled"
        :placeholder="placeholder"
        :floor="floor"
        @update:model-value="update"
      />
    </div>
    <div v-else class="md-preview" v-html="preview"></div>
  </div>
</template>
