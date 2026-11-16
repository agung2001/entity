<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * A CodeMirror surface for a text artifact that is not Markdown. The library is
 * imported only when such a file is opened, so a workspace that never edits code
 * never downloads the editor.
 *
 * The component owns one EditorView. Keeping the value in sync is a two-way
 * edge: a document change emits `update:modelValue`, and a parent change (a
 * reload, a saved file) replaces the doc without echoing back.
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  language: { type: String, default: 'plain' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const host = ref(null)
const ready = ref(false)
const failed = ref('')
let view = null
let destroyed = false
let applying = false

const THEME = {
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--ink-2)',
    fontSize: '12.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    fontSize: '12px',
    lineHeight: '1.62',
    overflow: 'auto',
  },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 18px' },
  '.cm-gutters': {
    border: '0',
    borderRight: '1px solid var(--border)',
    backgroundColor: 'var(--surface)',
    color: 'var(--muted)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in oklab, var(--surface) 62%, transparent)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 28%, transparent)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
}

watch(
  () => props.modelValue,
  (value) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (value === current) return
    applying = true
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    applying = false
  },
)

onMounted(async () => {
  try {
    const [cm, stateMod, pythonMod] = await Promise.all([
      import('codemirror'),
      import('@codemirror/state'),
      props.language === 'python' ? import('@codemirror/lang-python') : Promise.resolve(null),
    ])
    if (destroyed || !host.value) return
    const { basicSetup, EditorView } = cm
    const { EditorState } = stateMod
    const extensions = [
      basicSetup,
      EditorView.lineWrapping,
      EditorState.readOnly.of(props.disabled),
      EditorView.editable.of(!props.disabled),
      EditorView.theme(THEME),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applying) return
        emit('update:modelValue', update.state.doc.toString())
      }),
    ]
    if (pythonMod) extensions.push(pythonMod.python())
    view = new EditorView({
      parent: host.value,
      state: EditorState.create({ doc: props.modelValue, extensions }),
    })
    ready.value = true
  } catch (error) {
    failed.value =
      error?.message || 'The code editor could not load. The file is still readable as text.'
  }
})

onBeforeUnmount(() => {
  destroyed = true
  view?.destroy()
  view = null
})
</script>

<template>
  <div class="code-editor" :data-ready="ready ? '1' : '0'" :data-language="language">
    <div ref="host" class="code-editor-host"></div>
    <p v-if="failed" class="mnote code-editor-error" role="status">{{ failed }}</p>
  </div>
</template>
