<script setup>
/**
 * Two answers about one arriving connector file, in one sheet.
 *
 * The common case is that the workspace already has this connector: one
 * definition either replaces the one here or lands beside it under a free name.
 * Update is the default because it is what "someone fixed the server URL" looks
 * like, and a second copy of the same connector is the rarer intent.
 *
 * The other case is a sealed file. A sealed file is the only kind that can carry
 * a token, so it is the only kind that cannot be read before a passphrase is
 * typed — and that question comes first, before `present` is even known. The
 * sheet asks it in the same frame rather than in a second dialog, and the page
 * re-reads the file afterwards.
 *
 * What it cannot do is overwrite a token. `transfer.connectorInstall` hands the
 * definition to `writeMcp`, which keeps a local `env`/`headers` value wherever
 * the incoming one is `***` — so the body says that the token here survives.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** `transfer.connectorInspect`'s answer; `null` while the file is still locked. */
  file: { type: Object, default: null },
  /** The sealed file's name, when a passphrase is what stands between here and an answer. */
  locked: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'install', 'unlock'])

const mode = ref('update')
const typed = ref('')
const firstField = ref(null)

const besideId = computed(() => props.file?.beside || '')
const label = computed(() => props.file?.label || props.file?.id || 'this connector')
const signIn = computed(() => props.file?.needsSignIn === true)

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
    if (!open) return
    mode.value = 'update'
    typed.value = ''
    nextTick(() => firstField.value?.focus())
  },
)

function submit() {
  if (props.busy) return
  emit('install', { mode: mode.value })
}
</script>

<template>
  <div class="scrim scrim-dialog" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal tr-place"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tr-here-title"
  >
    <header class="mo-head">
      <div class="tr-place-head">
        <span class="tr-place-mark" aria-hidden="true">{{ locked ? '∗' : 'H' }}</span>
        <h2 id="tr-here-title">
          {{ locked ? 'This file is sealed' : `${label} is already here` }}
        </h2>
      </div>
      <p class="tr-place-sub">
        <template v-if="locked">
          Enter the passphrase that made <b class="mono">{{ locked }}</b>. Nothing has been
          installed, and nothing will be until it opens.
        </template>
        <template v-else>
          The file carries a connector this workspace already has. Nothing has been read into
          it yet — pick one, or close this and nothing changes.
        </template>
      </p>
    </header>

    <div class="mo-body">
      <div v-if="locked" class="fld tr-pass">
        <label class="lbl" for="tr-here-pass">Passphrase</label>
        <input
          id="tr-here-pass"
          ref="firstField"
          v-model="typed"
          class="acct-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
          @keyup.enter="typed && emit('unlock', typed)"
        />
      </div>

      <div v-else class="tr-modes" role="radiogroup" aria-label="What to do with the connector">
        <button
          ref="firstField"
          class="tr-mode"
          type="button"
          role="radio"
          :aria-checked="mode === 'update' ? 'true' : 'false'"
          :disabled="busy"
          @click="mode = 'update'"
        >
          <span class="tr-mode-dot" aria-hidden="true"></span>
          <span class="tr-mode-copy">
            <b>Update the one I have</b>
            <span>
              <b class="mono">{{ file?.id }}</b> keeps its place and its sign-in. What the file
              changed about the definition is applied; a token it does not carry is left alone.
            </span>
          </span>
        </button>

        <button
          class="tr-mode"
          type="button"
          role="radio"
          :aria-checked="mode === 'beside' ? 'true' : 'false'"
          :disabled="busy || !besideId"
          @click="mode = 'beside'"
        >
          <span class="tr-mode-dot" aria-hidden="true"></span>
          <span class="tr-mode-copy">
            <b>
              Install beside it<template v-if="besideId"> as <span class="mono">{{ besideId }}</span></template>
            </b>
            <span>
              A second connector with the same definition and its own name. The one here is
              untouched, including its sign-in.
            </span>
          </span>
        </button>
      </div>

      <div v-if="signIn && !locked" class="tr-band" data-tone="warn" role="note">
        <b>This file carries no token.</b>
        Either way, <b class="mono">{{ label }}</b> needs a sign-in on this machine before it
        answers.
      </div>

      <p v-if="error" class="acct-error" role="alert">{{ error }}</p>
    </div>

    <footer class="mo-foot tr-place-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="spacer"></span>
      <button
        v-if="locked"
        class="btn btn-ink"
        type="button"
        :disabled="busy || !typed"
        @click="emit('unlock', typed)"
      >
        {{ busy ? 'Opening…' : 'Open the file' }}
      </button>
      <button v-else class="btn btn-ink" type="button" :disabled="busy" @click="submit">
        {{ busy ? 'Installing…' : mode === 'beside' ? `Install as ${besideId}` : 'Update it' }}
      </button>
    </footer>
  </div>
</template>
