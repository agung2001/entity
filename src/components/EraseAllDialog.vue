<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'

/**
 * The confirmation behind "Erase all" on the Chats and Artifacts cards.
 *
 * An erase-all is the one write in settings that is not a threshold and has no
 * undo — the retention sweep can be undone by a number, this cannot. So it is a
 * dialog, never a `confirm()` and never a click-twice row: the dialog names the
 * population it is about to remove (the counts come from the card, computed
 * from the same store the erase reads), states what survives, and requires the
 * person to type the word before the primary will fire.
 *
 * Two rules from DESIGN.md that this surface has to keep:
 *   - `Esc` closes it through `useDialogDismiss`, like every other surface, and
 *     it is guarded while the write is in flight — a dismissed dialog over a
 *     half-erased folder is how a workspace ends up in a state nobody chose;
 *   - the confirm word is a guard, not a ceremony: typos are ignored
 *     case-sensitively, because "ERASE" typed by accident is not consent.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /** `chats` or `artifacts` — what the card erases. */
  kind: { type: String, default: 'chats' },
  /** which shelf: `shared`, `personal` or `all` (artifacts only) */
  scope: { type: String, default: '' },
  /** the workspace label, so the dialog says which room it is about */
  workspace: { type: String, default: '' },
  /** the rows the erase will remove: `{ count, bytes, extra }` */
  summary: { type: Object, default: () => ({ count: 0, bytes: 0, extra: '' }) },
  /** a path example, e.g. `chats/*.json` */
  target: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'confirm'])

const WORD = 'ERASE'
const typed = ref('')
const field = ref(null)

const noun = computed(() => (props.kind === 'artifacts' ? 'artifact' : 'thread'))

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const title = computed(() => {
  if (props.kind !== 'artifacts') return 'Erase every chat?'
  if (props.scope === 'shared') return 'Erase the shared shelf?'
  if (props.scope === 'personal') return 'Erase your personal shelf?'
  return 'Erase every artifact?'
})

/* The primary names the population it is about to remove, because three buttons
   open this one dialog and "Erase all" on a per-scope confirmation would be the
   lie the three buttons exist to avoid. */
const actionLabel = computed(() => {
  if (props.kind !== 'artifacts') return 'Erase all chats'
  if (props.scope === 'shared') return 'Erase shared'
  if (props.scope === 'personal') return 'Erase personal'
  return 'Erase everything'
})

const counts = computed(() => {
  const n = Number(props.summary?.count) || 0
  return n ? plural(n, noun.value) : `Every ${noun.value}`
})

const matches = computed(() => typed.value === WORD)

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
      typed.value = ''
      return
    }
    typed.value = ''
    /* The field is where the next keystroke goes: a dialog that opens with focus
       on the page behind it swallows the word the person starts typing. */
    nextTick(() => field.value?.focus())
  },
)

function submit() {
  if (props.busy || !matches.value) return
  emit('confirm')
}
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal modal-narrow confirm-modal erase-modal"
    :data-open="open ? '1' : '0'"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="erase-all-title"
    aria-describedby="erase-all-body"
  >
    <header class="mo-head">
      <div>
        <p class="eyebrow">Erase all</p>
        <h2 id="erase-all-title">{{ title }}</h2>
      </div>
      <button class="x mo-x" type="button" aria-label="Close" :disabled="busy" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>

    <div class="mo-body">
      <p id="erase-all-body" class="confirm-lead">
        This removes <b>{{ counts }}</b> in
        <b>{{ workspace || 'this workspace' }}</b> from the disk. There is no Trash,
        no undo and no restore from a backup that this dialog takes.
      </p>

      <ul class="confirm-list">
        <li>
          <b>{{ counts }}</b>
          <span>{{ summary.bytes ? `${summary.bytes} on disk` : 'on this machine' }}</span>
        </li>
        <li v-if="summary.extra">
          <b>{{ summary.extra }}</b>
          <span>also removed</span>
        </li>
        <li v-if="target">
          <b class="mono">{{ target }}</b>
          <span>the folder that is emptied</span>
        </li>
      </ul>

      <p class="confirm-note">
        <template v-if="kind !== 'artifacts'">
          Every thread in this workspace is erased, archived ones included, and the
          unsent drafts on this machine with them. A thread another account started
          is not yours and stays.
        </template>
        <template v-else-if="scope === 'shared'">
          The shared shelf and its hidden folders are erased —
          <code class="mono">.archive/</code>, <code class="mono">.trash/</code> and the
          scope index. Every personal shelf under
          <code class="mono">.personal/</code> stays where it is.
        </template>
        <template v-else-if="scope === 'personal'">
          <code class="mono">.personal/&lt;account&gt;/artifacts/</code> for the account this
          window is signed in as is erased. Another account on this machine has its own
          shelf, and it is not on this page. The shared shelf keeps its files.
        </template>
        <template v-else>
          The shared shelf is erased with its <code class="mono">.archive/</code> and
          <code class="mono">.trash/</code>, and this account's personal shelf goes with
          it.
        </template>
      </p>

      <p class="confirm-note">
        The workspace itself, its entities and its retention rule stay as they are.
      </p>

      <div class="erase-word">
        <label class="erase-word-label" for="erase-all-word">
          Type <b class="mono">{{ WORD }}</b> to confirm
        </label>
        <input
          id="erase-all-word"
          ref="field"
          v-model="typed"
          class="acct-input mono erase-word-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          :disabled="busy"
          :placeholder="WORD"
          :aria-invalid="typed && !matches ? 'true' : 'false'"
          @keydown.enter.prevent="submit"
        />
      </div>

      <p v-if="error" class="confirm-error" role="alert">{{ error }}</p>
    </div>

    <footer class="mo-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Keep it</button>
      <button
        class="btn btn-danger"
        type="button"
        :disabled="busy || !matches"
        :title="matches ? '' : `Type ${WORD} to enable this`"
        @click="submit"
      >
        {{ busy ? 'Erasing…' : actionLabel }}
      </button>
    </footer>
  </div>
</template>
