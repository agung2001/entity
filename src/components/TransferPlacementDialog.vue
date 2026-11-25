<script setup>
/**
 * Where a whole workspace file goes.
 *
 * A preset file is a diff — paths, modes, one button — because a file with
 * fifteen paths has fifteen answers. A whole workspace does not: it carries a
 * `workspace.json`, a `members.json` and a `chats/` directory, and there is no
 * sensible "add alongside" for a context string. So the question is asked once,
 * here, and it is asked about the workspace rather than about the file.
 *
 * The two modes are not symmetrical and the sheet says so:
 *   - `beside` creates a second workspace and touches nothing here;
 *   - `replace` is the only operation in this feature that loses state, so the
 *     primary stays `--surface-2` until the id is typed, case-sensitively. A
 *     disabled primary with the expected id visible in the hint is the whole
 *     message; no error text is needed to explain a button that is not on.
 *
 * What it numbers is what the file carries, not what this workspace holds: the
 * reader never reads a chat body to count it, and a sheet that claimed "removes
 * 7 conversations" from a count it did not take would be the one lie that costs
 * somebody a week of writing. The snapshot line is the answer to that: whatever
 * a replace overwrites is on disk first.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { humanBytes, plural } from '@/lib/transfer'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** `transfer.inspect`'s answer — counts, sender, workspace, exportedAt. */
  file: { type: Object, default: null },
  /** The workspace receiving it: `{ id, label }`. The id is what unlocks replace. */
  here: { type: Object, default: () => ({ id: '', label: '' }) },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'place'])

const mode = ref('beside')
const typed = ref('')
const firstRow = ref(null)
const secondRow = ref(null)
const idField = ref(null)

const counts = computed(() => props.file?.counts || {})
/* Empty when the file names nobody: the possessive below is only ours to write
   when there is a person to hang it on. */
const senderName = computed(() => props.file?.sender?.name || props.file?.sender?.email || '')
const from = computed(() => props.file?.workspace || { label: '', id: '' })

/* The rows the sheet numbers. `files` is the total and the four counts are what
   a person actually destructured the workspace into; the two are different
   questions and both are on the sheet. */
const rows = computed(() => {
  const n = counts.value
  return [
    { key: 'Entities', value: n.entities },
    { key: 'Skills', value: n.skills },
    { key: 'Artifacts', value: n.artifacts },
    { key: 'Conversations', value: n.chats },
    { key: 'Connections', value: (n.connectors || 0) + (n.servers || 0) },
  ].filter((row) => row.value !== undefined && row.value !== null)
})

const replacing = computed(() => mode.value === 'replace')
const matches = computed(() => Boolean(typed.value) && typed.value === props.here.id)

useDialogDismiss({
  active: () => props.open,
  close: () => {
    if (!props.busy) emit('close')
  },
  guard: () => props.busy,
})

watch(
  () => props.open,
  (open) => {
    if (!open) {
      mode.value = 'beside'
      typed.value = ''
      return
    }
    /* Beside is preselected on every open — the second mode is never remembered,
       because "the last one I picked" is the worst possible default here. */
    mode.value = 'beside'
    typed.value = ''
    nextTick(() => firstRow.value?.focus())
  },
)

function choose(next) {
  mode.value = next
  /* Choosing row 2 moves the person to the field it just asked for; the arrow
     keys are still the mode's, so `Tab` is the one step to the id. */
  if (next === 'replace') nextTick(() => idField.value?.focus())
}

/* The arrows walk the group and the group's choice follows focus — two modes,
   so either direction is the other row. Typing moves to the field; an arrow does
   not, or the keys would be a shortcut out of the group they move in. */
function onRowKey(event) {
  const on = event.key === 'ArrowDown' || event.key === 'ArrowRight'
  const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
  if (!on && !back) return
  event.preventDefault()
  mode.value = on ? 'replace' : 'beside'
  nextTick(() => (on ? secondRow.value : firstRow.value)?.focus())
}

function submit() {
  if (props.busy) return
  if (replacing.value && !matches.value) return
  emit('place', { mode: mode.value, confirm: replacing.value ? typed.value : '' })
}
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal tr-place"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tr-place-title"
  >
    <header class="mo-head">
      <div class="tr-place-head">
        <span class="tr-place-mark" aria-hidden="true">W</span>
        <h2 id="tr-place-title">Where should this workspace go?</h2>
      </div>
      <p class="tr-place-sub">
        <b>{{ from.label || 'That workspace' }}</b> ·
        {{ plural(counts.files || 0, 'file') }} · {{ humanBytes(counts.bytes) }} ·
        from {{ senderName ? `${senderName}'s machine` : 'another machine' }}.
      </p>
    </header>

    <div class="mo-body">
      <div class="tr-modes" role="radiogroup" aria-label="Where it goes" @keydown="onRowKey">
        <button
          ref="firstRow"
          class="tr-mode"
          type="button"
          role="radio"
          :aria-checked="mode === 'beside' ? 'true' : 'false'"
          :disabled="busy"
          @click="choose('beside')"
        >
          <span class="tr-mode-dot" aria-hidden="true"></span>
          <span class="tr-mode-copy">
            <b>Beside this one, as a new workspace</b>
            <span>
              A second workspace appears next to <b class="mono">{{ here.id }}</b>, with its
              own folder. Nothing here is read, moved or overwritten.
            </span>
          </span>
        </button>

        <button
          ref="secondRow"
          class="tr-mode"
          type="button"
          role="radio"
          data-danger="1"
          :aria-checked="replacing ? 'true' : 'false'"
          :disabled="busy"
          @click="choose('replace')"
        >
          <span class="tr-mode-dot" aria-hidden="true"></span>
          <span class="tr-mode-copy">
            <b>Into this one, replacing what is here</b>
            <span>
              <b class="mono">{{ here.id }}</b> keeps its folder and its id, and takes the
              file's record, members and conversations over its own.
            </span>
          </span>
        </button>
      </div>

      <dl v-if="rows.length" class="tr-place-nums">
        <div v-for="row in rows" :key="row.key">
          <dt>{{ row.key }}</dt>
          <dd class="mono" :data-take="replacing ? '1' : '0'">{{ row.value }}</dd>
        </div>
      </dl>

      <div v-if="replacing" class="tr-band" data-tone="warn" role="note">
        <b>This is the one thing in Transfer that loses state.</b>
        A snapshot of <b class="mono">{{ here.id }}</b> is written first, and it lands in
        Account → Backups, so what it overwrites is on disk — but the workspace you have
        now stops being the workspace you open tomorrow.
      </div>

      <div v-if="replacing" class="fld tr-place-word">
        <label class="lbl" for="tr-place-id">
          Type <b class="mono">{{ here.id }}</b> to confirm
        </label>
        <input
          id="tr-place-id"
          ref="idField"
          v-model="typed"
          class="acct-input mono"
          type="text"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          :disabled="busy"
          :placeholder="here.id"
          :aria-describedby="'tr-place-word-hint'"
        />
        <p id="tr-place-word-hint" class="mnote">
          <template v-if="matches">Snapshot first, then the replace.</template>
          <template v-else>
            Case matters. Nothing is written until the word matches exactly.
          </template>
        </p>
      </div>

      <p v-if="error" class="acct-error" role="alert">{{ error }}</p>
    </div>

    <footer class="mo-foot tr-place-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="spacer"></span>
      <button
        v-if="!replacing"
        class="btn btn-ink"
        type="button"
        :disabled="busy"
        @click="submit"
      >
        {{ busy ? 'Placing…' : `Place it beside ${here.id}` }}
      </button>
      <button
        v-else
        class="btn btn-danger"
        type="button"
        :disabled="busy || !matches"
        :title="matches ? '' : `Type ${here.id} to enable this`"
        @click="submit"
      >
        {{ busy ? 'Replacing…' : 'Replace everything' }}
      </button>
    </footer>
  </div>
</template>
