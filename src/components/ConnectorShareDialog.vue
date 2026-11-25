<script setup>
/**
 * One connector leaving this workspace.
 *
 * The sheet's whole job is the list: what travels and what stays. A share button
 * next to a token is a share button that leaks, so the two lists are the first
 * thing in the body and the token is a separate, off-by-default decision made
 * after reading them.
 *
 * The file name is not built here. `transfer.connectorSend` answers a dry header
 * with the name it would write, and the sheet prints that — the extension flips
 * to `.entity.zip` in the frame the token is ticked, because the store is the
 * one that decided it.
 */
import { computed, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { hub, toast } from '@/stores/hub'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** The row being sent: `{ id, label, kind }`. */
  row: { type: Object, default: null },
  /** The workspace it leaves, so the sheet can say which one. */
  workspace: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const MIN_PASS = 12

const includeToken = ref(false)
const passphrase = ref('')
const preview = ref(null)
const error = ref('')
const busy = ref(false)
const passField = ref(null)

const sealed = computed(() => includeToken.value)
const short = computed(() => sealed.value && passphrase.value.length < MIN_PASS)
const canSend = computed(() => Boolean(props.row?.id) && !busy.value && !short.value)
/* `Array.isArray` is the contract, not a courtesy: the store used to answer these
   two nested, and a `v-for` over the object printed the arrays themselves. */
const travels = computed(() => (Array.isArray(preview.value?.travels) ? preview.value.travels : []))
const stays = computed(() => (Array.isArray(preview.value?.stays) ? preview.value.stays : []))
/* Whether a token can travel at all is the store's answer, not this sheet's guess
   from the kind: only a credential the file can actually hold gets a switch. */
const hasToken = computed(() => preview.value?.token === true)
const oauth = computed(() => preview.value?.oauth === true)
/* The line the mock-up's sheet opens with — what this connector *is*: `mcp ·
   workspace scope · @youtrack:`. A connector file is always workspace scope; the
   store refuses a machine one. */
const facts = computed(() =>
  [preview.value?.kind || '', 'workspace scope', preview.value?.mention || '']
    .filter(Boolean)
    .join(' · '),
)

useDialogDismiss({
  active: () => props.open,
  close: () => {
    if (!busy.value) emit('close')
  },
  guard: () => busy.value,
})

/* A dry ask per open and per tick of the token. It never writes and it never
   needs the passphrase — it is the sheet's own name and its two lists. */
async function refresh() {
  if (!props.open || !props.row?.id || !props.workspace) {
    preview.value = null
    return
  }
  error.value = ''
  try {
    preview.value = await call('transfer.connectorSend', {
      workspace: props.workspace,
      id: props.row.id,
      includeToken: includeToken.value,
      dry: true,
    })
  } catch (failure) {
    preview.value = null
    error.value = failure.message
  }
}

/* Opening is a reset; ticking the token is not. Two watchers, because one reset
   on every tick would make the switch untickable. */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    includeToken.value = false
    passphrase.value = ''
    error.value = ''
    refresh()
  },
  { immediate: true },
)

watch(includeToken, () => {
  if (props.open) refresh()
})

function toggleToken() {
  includeToken.value = !includeToken.value
  if (includeToken.value) setTimeout(() => passField.value?.focus(), 0)
}

async function send() {
  if (!canSend.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await call('transfer.connectorSend', {
      workspace: props.workspace,
      id: props.row.id,
      includeToken: includeToken.value,
      passphrase: sealed.value ? passphrase.value : '',
    })
    toast(
      `${result.label} · ${result.filename}`,
      {
        actionLabel: 'Reveal in Finder',
        onAction: () =>
          call('transfer.reveal', { filename: result.filename }).catch((failure) => toast(failure.message)),
      },
    )
    emit('close')
  } catch (failure) {
    error.value = failure.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="scrim scrim-dialog" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal tr-place"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tr-share-title"
  >
    <header class="mo-head">
      <div class="tr-place-head">
        <span class="tr-place-mark" aria-hidden="true">{{ (row?.label || '?').slice(0, 1) }}</span>
        <h2 id="tr-share-title">Send {{ row?.label || 'this connector' }}</h2>
      </div>
      <p class="tr-place-sub">
        <b class="mono">{{ facts }}</b><br />
        One file, written to Downloads. The other machine drops it on its Connectors page and
        gets a connector of the same name.
      </p>
    </header>

    <div class="mo-body">
      <!-- Two lists, side by side, before any control: this is the sheet's answer
           to "what am I actually sending". -->
      <div v-if="preview" class="tr-travel">
        <div>
          <h3>Travels</h3>
          <ul>
            <li v-for="item in travels" :key="item">{{ item }}</li>
          </ul>
        </div>
        <div data-stays="1">
          <h3>Stays here</h3>
          <ul>
            <li v-for="item in stays" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>

      <p v-else class="mnote">Reading the connector…</p>

      <!-- The one question this sheet cannot answer with a list: why an OAuth
           connector's file is this thin. The rule is the app's, not a gap
           (docs/connectors.md — one app-wide client per machine). -->
      <p v-if="oauth" class="mnote">
        A sign-in is not a file. The OAuth client and the refresh token are this machine's and
        no transfer carries them, so the other machine signs in to its own account.
      </p>

      <div v-if="hasToken" class="tr-row tr-share-token">
        <span class="tr-copy">
          <b>Include the bearer token</b>
          <span>
            Off, the token travels as <b class="mono">***</b> and the other machine signs in
            again. On, the file is a <b class="mono">.entity.zip</b> that will not open without
            a passphrase.
          </span>
        </span>
        <button
          class="sfx-switch"
          type="button"
          role="switch"
          :aria-checked="includeToken ? 'true' : 'false'"
          :disabled="busy"
          aria-label="Include the bearer token"
          @click="toggleToken"
        >
          <span></span>
        </button>
      </div>

      <div v-if="sealed" class="fld tr-pass">
        <label class="lbl" for="tr-share-pass">Passphrase</label>
        <input
          id="tr-share-pass"
          ref="passField"
          v-model="passphrase"
          class="acct-input"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :disabled="busy"
          :aria-invalid="short ? 'true' : 'false'"
        />
        <p class="mnote">
          <template v-if="short">Use at least {{ MIN_PASS }} characters; there is no way to recover it.</template>
          <template v-else>At least {{ MIN_PASS }} characters. The token is in this file — the passphrase is the only lock on it.</template>
        </p>
      </div>

      <div v-if="sealed" class="tr-band" data-tone="warn" role="note">
        <b>This file will not open without that passphrase.</b>
        Send it to the other person by something other than the file itself.
      </div>

      <p v-if="preview?.filename" class="tr-name mono">{{ preview.filename }}</p>
      <p v-if="error" class="acct-error" role="alert">{{ error }}</p>
    </div>

    <footer class="mo-foot tr-place-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-ink" type="button" :disabled="!canSend" @click="send">
        {{ busy ? 'Writing…' : sealed ? 'Create sealed file' : 'Create file' }}
      </button>
    </footer>
  </div>
</template>
