<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * Tags are a comma-separated field, not a chip composer: the same tags are
 * written by hand in the thread file and typed here, and one syntax keeps the
 * two in step. The preview below the input is what will be saved, so a trailing
 * comma or a duplicate is visible before the write.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  tags: { type: Array, default: () => [] },
  suggestions: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'save'])

const MAX_TAGS = 12
const MAX_TAG_CHARS = 32

const draft = ref('')
const field = ref(null)

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
  guard: () => props.busy,
})

watch(
  () => [props.open, props.tags],
  ([open]) => {
    if (!open) return
    draft.value = props.tags.join(', ')
    nextTick(() => {
      field.value?.focus()
      field.value?.select()
    })
  },
  { immediate: true },
)

/** The preview and the save path share one parser, so they cannot disagree. */
function parse(value) {
  const out = []
  const seen = new Set()
  for (const entry of String(value || '').split(',')) {
    const tag = entry.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_CHARS)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

const parsed = computed(() => parse(draft.value))
const dirty = computed(
  () => parsed.value.join('\u0000') !== props.tags.map((tag) => String(tag)).join('\u0000'),
)
const fresh = computed(() => {
  const used = new Set(parsed.value.map((tag) => tag.toLowerCase()))
  return props.suggestions.filter((tag) => !used.has(String(tag).toLowerCase()))
})

function addSuggestion(tag) {
  const current = draft.value.trim().replace(/,\s*$/, '')
  draft.value = current ? `${current}, ${tag}` : tag
  nextTick(() => field.value?.focus())
}

/** Removing a chip rewrites the one field, so the input and preview never drift. */
function removeTag(tag) {
  const key = String(tag).toLowerCase()
  draft.value = parsed.value.filter((entry) => entry.toLowerCase() !== key).join(', ')
  nextTick(() => field.value?.focus())
}

function submit() {
  if (props.busy || !dirty.value) return
  emit('save', parsed.value)
}

function onKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
    <div
      class="modal modal-narrow tagdlg"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      aria-label="Thread tags"
    >
      <div class="mo-head">
        <h2>Tags</h2>
        <p>Label this conversation so the rail can filter it without remembering the title.</p>
        <button class="x mo-x" aria-label="Close" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
      <div class="mo-body">
        <div class="fld">
          <label class="lbl" for="tagdlg-input">Tags</label>
          <input
            id="tagdlg-input"
            ref="field"
            v-model="draft"
            class="tagdlg-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="design, billing, follow-up"
            :aria-describedby="'tagdlg-note'"
            @keydown="onKey"
          />
        </div>
        <div v-if="parsed.length" class="tagdlg-chips" aria-label="Tags to save">
          <span v-for="tag in parsed" :key="tag" class="tagdlg-chip">
            {{ tag }}
            <button
              class="tagdlg-chip-x"
              type="button"
              :aria-label="`Remove ${tag}`"
              :title="`Remove ${tag}`"
              @click="removeTag(tag)"
            >
              <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" />
              </svg>
            </button>
          </span>
        </div>
        <div v-if="fresh.length" class="tagdlg-suggest">
          <span class="tagdlg-suggest-label">Used in this workspace</span>
          <div>
            <button
              v-for="tag in fresh"
              :key="tag"
              class="tagdlg-chip tagdlg-chip--button"
              type="button"
              @click="addSuggestion(tag)"
            >
              {{ tag }}
            </button>
          </div>
        </div>
        <p id="tagdlg-note" class="mnote">
          Comma separated, up to {{ MAX_TAGS }} tags, {{ MAX_TAG_CHARS }} characters each. A tag is
          saved with the thread and shown in the history rail.
        </p>
      </div>
      <div class="mo-foot">
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-ink" type="button" :disabled="busy || !dirty" @click="submit">
          {{ busy ? 'Saving…' : 'Save tags' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
