<script setup>
import { computed, nextTick, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * A small Markdown editor and reviewer: toolbar in write mode, rendered
 * document in preview mode. The preview is sanitized before it reaches the DOM.
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  rows: { type: Number, default: 18 },
  placeholder: { type: String, default: 'Write Markdown…' },
})
const emit = defineEmits(['update:modelValue'])

const mode = ref('write')
const area = ref(null)

const preview = computed(() => {
  const html = marked.parse(String(props.modelValue || ''), { gfm: true, breaks: true })
  return DOMPurify.sanitize(String(html), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  })
})

const words = computed(() => {
  const text = String(props.modelValue || '').trim()
  return text ? text.split(/\s+/).length : 0
})

function update(value) {
  emit('update:modelValue', value)
}

function replaceSelection(before, after = '', fallback = 'text') {
  if (props.disabled) return
  const el = area.value
  if (!el) return
  const start = el.selectionStart ?? 0
  const end = el.selectionEnd ?? 0
  const selected = props.modelValue.slice(start, end) || fallback
  const next = `${props.modelValue.slice(0, start)}${before}${selected}${after}${props.modelValue.slice(end)}`
  update(next)
  nextTick(() => {
    el.focus()
    el.setSelectionRange(start + before.length, start + before.length + selected.length)
  })
}

function prefixLine(prefix) {
  if (props.disabled) return
  const el = area.value
  if (!el) return
  const start = el.selectionStart ?? 0
  const lineStart = props.modelValue.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const next = `${props.modelValue.slice(0, lineStart)}${prefix}${props.modelValue.slice(lineStart)}`
  update(next)
  nextTick(() => {
    el.focus()
    el.setSelectionRange(start + prefix.length, start + prefix.length)
  })
}

function link() {
  replaceSelection('[', '](https://)', 'link text')
}
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
      <div v-if="mode === 'write'" class="md-tools" role="toolbar" aria-label="Markdown formatting">
        <button type="button" title="Heading" aria-label="Heading" :disabled="disabled" @click="prefixLine('## ')">H</button>
        <button type="button" title="Bold" aria-label="Bold" :disabled="disabled" @click="replaceSelection('**', '**', 'bold')"><b>B</b></button>
        <button type="button" title="Italic" aria-label="Italic" :disabled="disabled" @click="replaceSelection('_', '_', 'italic')"><i>I</i></button>
        <button type="button" title="Inline code" aria-label="Inline code" :disabled="disabled" @click="replaceSelection('`', '`', 'code')"><span class="mono">`</span></button>
        <button type="button" title="Link" aria-label="Link" :disabled="disabled" @click="link">↗</button>
        <button type="button" title="List" aria-label="List" :disabled="disabled" @click="prefixLine('- ')">•</button>
      </div>
      <span class="md-count">{{ words }} words</span>
    </div>

    <textarea
      v-if="mode === 'write'"
      ref="area"
      class="md-input mono"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      spellcheck="false"
      @input="update($event.target.value)"
    ></textarea>
    <div v-else class="md-preview" v-html="preview"></div>
  </div>
</template>
