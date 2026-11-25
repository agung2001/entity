<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extension-placeholder'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * The rich-text host: Tiptap over the same Markdown the file holds. It is loaded
 * only when a document is actually written, so a page that just reviews one
 * never downloads an editor.
 *
 * The shape is Multica's issue editor. What you type is what you see — headings,
 * lists, quotes, code and links render as you go — and the formatting controls
 * are a pill over the selection, because the input rules and keymaps already
 * cover the keys and a strip that is always there costs the document a row. The
 * roundtrip runs through `@tiptap/markdown` in both directions instead of a
 * hand-written serialiser, so `Write` and `Review` cannot disagree.
 *
 * There is no find here: the document is rendered text, so `PageFind` searches
 * it with the rest of the page and highlighting never rewrites a node this
 * editor owns.
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: 'Write Markdown…' },
  /* The document's floor, carried from `rows`. */
  floor: { type: String, default: '260px' },
})
const emit = defineEmits(['update:modelValue'])

const picked = ref(null)

const editor = useEditor({
  extensions: [
    /* A link in an Instructions file is text, not a card: link it while typing,
       never follow one on a click — this is an editor. */
    StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
    Markdown,
    Placeholder.configure({ placeholder: () => props.placeholder }),
  ],
  editable: !props.disabled,
  /* The file is Markdown: open it as Markdown and save it back as Markdown. */
  content: props.modelValue,
  contentType: 'markdown',
  onUpdate: ({ editor: ed }) => {
    const next = ed.getMarkdown()
    if (next !== props.modelValue) emit('update:modelValue', next)
  },
  onSelectionUpdate: ({ editor: ed }) => {
    const { from, to } = ed.state.selection
    picked.value = from === to || props.disabled ? null : { from, to }
  },
  onBlur: () => {
    picked.value = null
  },
})

/* A parent write (a reload, a saved file) replaces the document without echoing
   back — `emitUpdate: false` is what stops the round trip. */
watch(
  () => props.modelValue,
  (value) => {
    const ed = editor.value
    if (!ed || ed.isDestroyed) return
    if ((value || '') === ed.getMarkdown()) return
    ed.commands.setContent(value || '', { contentType: 'markdown', emitUpdate: false })
  },
)

/* Tiptap reads `editable` at construction; a later permission change is a
   command, not a prop. */
watch(
  () => props.disabled,
  (disabled) => editor.value?.setEditable(!disabled),
)

/* ── the pill: over the range you picked, never in the flow ───────────── */

const pillStyle = computed(() => {
  const ed = editor.value
  if (!picked.value || !ed || ed.isDestroyed) return null
  const box = ed.view.coordsAtPos(picked.value.to)
  const top = box.bottom + 10 + 34 > window.innerHeight ? box.top - 44 : box.bottom + 10
  return {
    top: `${Math.max(8, top)}px`,
    left: `${Math.min(box.left, window.innerWidth - 236)}px`,
  }
})

function run(chain) {
  chain().focus().run()
  picked.value = null
}

function each(action) {
  const ed = editor.value
  if (!ed) return
  if (action === 'toggleHeading') {
    /* A level is required: a heading is a level, not a mark. Step h1 → h2 → h3
       and then back to a paragraph, so the one button cycles the ladder. */
    const level = ed.isActive('heading') ? ed.getAttributes('heading').level || 1 : 0
    run(() => (level >= 3 ? ed.chain().setParagraph() : ed.chain().toggleHeading({ level: level + 1 })))
    return
  }
  run(() => ed.chain()[action]())
}

const list = () => run(() => editor.value.chain().toggleBulletList())

/* What the heading button says it will do next, so a cycle is not a guess. */
const heading = computed(() => {
  const ed = editor.value
  const level = ed?.isActive('heading') ? ed.getAttributes('heading').level || 1 : 0
  return level >= 3 ? 'T' : `H${level + 1}`
})

/* A link needs an address, so the pill swaps to one field instead of writing a
   placeholder the person then has to hunt down and edit — Multica's link editor.
   `toggleLink` extends the existing mark's range when the caret is inside one,
   so the same field also edits a link that is already there. */
const linkOpen = ref(false)
const href = ref('')
const hrefField = ref(null)

function editLink() {
  const ed = editor.value
  if (!ed) return
  href.value = ed.getAttributes('link').href || 'https://'
  linkOpen.value = true
  nextTick(() => {
    hrefField.value?.focus()
    hrefField.value?.select()
  })
}

function applyLink() {
  const ed = editor.value
  if (!ed) return
  const value = href.value.trim()
  ed.chain().focus().extendMarkRange('link').toggleLink(value ? { href: value } : { href: null }).run()
  closeLink()
  picked.value = null
}

function closeLink() {
  linkOpen.value = false
  href.value = ''
  editor.value?.commands.focus()
}
useDialogDismiss({ active: () => linkOpen.value, close: closeLink })

onBeforeUnmount(() => {
  /* useEditor destroys the view; the pill and the link field are teleported to
     the body, so they leave with this component rather than staying over a page
     that no longer has a document. */
  picked.value = null
  linkOpen.value = false
})
</script>

<template>
  <div class="md-rich" :style="{ '--md-floor': floor }">
    <EditorContent :editor="editor" class="md-richtext" />

    <Teleport to="body">
      <form
        v-if="linkOpen && !disabled"
        class="md-pill md-pill--link"
        role="dialog"
        aria-label="Link address"
        :style="pillStyle"
        @submit.prevent="applyLink"
      >
        <input
          ref="hrefField"
          v-model="href"
          type="text"
          class="md-pill-input"
          placeholder="https://"
          aria-label="Link address"
          spellcheck="false"
        />
        <button type="submit" aria-label="Apply link" title="Apply link">✓</button>
        <button type="button" aria-label="Cancel link" title="Cancel link" @click="closeLink">×</button>
      </form>
    </Teleport>

    <!-- Over the selection, never in the flow: Teleported so a scroll box cannot
         clip it, and the range you picked is what its buttons act on. -->
    <Teleport to="body">
      <div
        v-if="picked && !disabled"
        class="md-pill"
        role="toolbar"
        aria-label="Format the selection"
        :style="pillStyle"
        @mousedown.prevent
      >
        <button type="button" aria-label="Bold" title="Bold" @click="each('toggleBold')"><b>B</b></button>
        <button type="button" aria-label="Italic" title="Italic" @click="each('toggleItalic')"><i>I</i></button>
        <button type="button" aria-label="Strikethrough" title="Strikethrough" @click="each('toggleStrike')"><s>S</s></button>
        <button type="button" aria-label="Inline code" title="Inline code" @click="each('toggleCode')"><span class="mono">`</span></button>
        <button type="button" aria-label="Link" title="Link" @click="editLink">↗</button>
        <span class="md-pill-sep" aria-hidden="true"></span>
        <button type="button" aria-label="Heading" title="Heading: H1, H2, H3, then text" @click="each('toggleHeading')">{{ heading }}</button>
        <button type="button" aria-label="Bullet list" title="Bullet list" @click="list">•</button>
        <button type="button" aria-label="Quote" title="Quote" @click="each('toggleBlockquote')">❝</button>
      </div>
    </Teleport>
  </div>
</template>
