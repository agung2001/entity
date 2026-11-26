<script setup>
/**
 * The `Accounts` card — one row per connected account, on the connector's own page.
 *
 * It is its own component because it is the surface that grows: every account-
 * bearing connector needs this card, and nothing about it is Gmail-specific. The
 * props are the connector and its provider; everything else (tiers, the OAuth
 * client form, the account table, the verbs) belongs here.
 *
 * Four rules it keeps, all of them paid for:
 *
 *   1. **One row per account, one verb per row** — the dead row is the only one
 *      with a primary verb, and colour is never the only signal (a dot always
 *      carries a word).
 *   2. **A refresh token is never rendered** — the store hands over seven public
 *      fields and nothing else, so there is nothing here to leak.
 *   3. **Loading is the real four tracks with skeletons**, not a spinner over
 *      nothing (`DESIGN.md`).
 *   4. **A non-owner sees the list and no verbs**, with the foot saying who can.
 */
import { computed, onMounted, ref } from 'vue'
import { ago, hub, toast } from '@/stores/hub'
import { googleCalendar, readAccounts as readCalendarAccounts } from '@/composables/googleCalendar'
import {
  clearOauthClient,
  connectAccount,
  loadAccounts,
  loadTiers,
  oauthLabel,
  oauthStatus,
  readOauthClientFile,
  removeAccount,
  setOauthClient,
  setOauthClientFile,
  setTier,
  testAccounts,
} from '@/stores/connectors'

const props = defineProps({
  /* the connector's id — the account rows are keyed by it */
  connector: { type: String, required: true },
  /* `google` | `x`: which client and which consent this card runs under */
  provider: { type: String, default: 'google' },
})

/* Emitted so the page's Definition card can show the same aggregate the roster
   does, without a second read. */
const emit = defineEmits(['changed'])

/* ── the account list ──────────────────────────────────────────────────
   A second read, and the one thing on this page that can arrive late: the roster
   already knows the connector. Starts `true` so the card never paints "no account
   is connected yet" for the frame before the read begins. */
const accounts = ref([])
const accountsLoading = ref(true)
/* Two boxes: one for a consent answer (it carries `Try again`), one for any other
   verb's refusal. */
const accountsError = ref('')
const accountsFail = ref('')
const accountsNotice = ref('')
const confirmingAccount = ref('')
const busy = ref('')

/* Only an owner may add an account: the credential is the whole point, and a
   viewer's read-only card says who can (spec §5 `permission · card`). */
const canConnect = computed(() => hub.session?.role === 'owner')

/* ── the OAuth client ──────────────────────────────────────────────────
   One app-wide client per machine, not per workspace: a client per workspace would
   put the same secret in a synced folder N times. The form is the only way it gets
   here — the app never ships one, and the renderer reads back a hint only. */
const client = ref({ configured: false, hint: '', consoleUrl: '' })
/* The provider's own name: an X page must not offer to "Connect Google account". */
const providerLabel = ref('Google')
const clientForm = ref({ clientId: '', clientSecret: '' })
const clientOpen = ref(false)
const clientBusy = ref(false)
const clientError = ref('')
/* A dropped or picked `credentials.json`, held as text until Save. The main
   process parses it; this is only the courier, it is never rendered, and it is
   dropped the moment it is stored or cancelled. */
const pickedText = ref('')
const pickedRead = ref(false)
/* The mask the main process answered with — fixed length, never a slice. */
const pickedMask = ref('')
const clientDrop = ref(false)

/* ── how much access ───────────────────────────────────────────────────
   The tier is written to the workspace's index row, so two workspaces may want
   different access from the same mailbox. */
const tiers = ref([])
const tierBusy = ref('')
const currentTier = computed(() => tiers.value.find((entry) => entry.current) || null)

async function readTiers() {
  try {
    tiers.value = await loadTiers(props.connector)
  } catch {
    tiers.value = []
  }
}

async function chooseTier(tier) {
  if (tierBusy.value || tier.current) return
  tierBusy.value = tier.id
  accountsError.value = ''
  accountsNotice.value = ''
  try {
    await setTier({ connector: props.connector, tier: tier.id })
    await readTiers()
    /* The grant does not change by itself: a token already issued keeps what it
       has, so the card says what happens next rather than implying otherwise. */
    accountsNotice.value = accounts.value.length
      ? `${tier.label} chosen. Existing accounts keep their current grant until you press Re-consent or Sign in.`
      : `${tier.label} chosen. The account will ask for exactly this.`
  } catch (problem) {
    accountsError.value = String(problem?.message || problem)
  } finally {
    tierBusy.value = ''
  }
}

async function readClient() {
  try {
    const [status, label] = await Promise.all([
      oauthStatus(props.provider),
      oauthLabel(props.provider),
    ])
    client.value = status
    if (label) providerLabel.value = label
  } catch {
    client.value = { configured: false, hint: '', consoleUrl: '' }
  }
}

async function saveClient() {
  if (clientBusy.value) return
  clientBusy.value = true
  clientError.value = ''
  try {
    /* A dropped file and a typed pair land in the same entry: the file path just
       skips the transcription. */
    client.value = pickedText.value
      ? await setOauthClientFile({ provider: props.provider, text: pickedText.value })
      : await setOauthClient({
          provider: props.provider,
          clientId: clientForm.value.clientId,
          clientSecret: clientForm.value.clientSecret,
        })
    /* Cleared the moment it is stored: it lives in a 0600 file now, and a form
       that keeps it is a second copy on screen. */
    dropPicked()
    clientOpen.value = false
    accountsNotice.value = 'Client saved on this machine. Connect the account when you are ready.'
    /* A client alone cannot add an account, so the flow continues by itself. */
    await connectOauth()
  } catch (problem) {
    clientError.value = String(problem?.message || problem)
  } finally {
    clientBusy.value = false
  }
}

/** The text is the courier's copy: dropping it is the whole cleanup. */
function dropPicked() {
  pickedText.value = ''
  pickedRead.value = false
  pickedMask.value = ''
  clientForm.value = { clientId: '', clientSecret: '' }
}

async function cancelClient() {
  dropPicked()
  clientError.value = ''
  clientOpen.value = false
}

/** Read one file: `File.text()`, so the renderer never opens a descriptor. */
async function readClientFile(file) {
  if (!file) return
  clientError.value = ''
  try {
    const text = await file.text()
    /* Read for the confirmation line first, so a wrong file is visible before
       anything is written. A refusal names the field, never the contents. */
    const preview = await readOauthClientFile({ provider: props.provider, text })
    pickedText.value = text
    pickedRead.value = true
    pickedMask.value = preview.secretMasked
    /* Editable after a read, so one wrong value does not send a person back to
       the picker. */
    clientForm.value = { clientId: preview.clientId, clientSecret: '' }
  } catch (problem) {
    /* Only the picked state goes: a typed pair is the person's own work, and a
       refused file must not destroy it. */
    pickedText.value = ''
    pickedRead.value = false
    pickedMask.value = ''
    clientError.value = String(problem?.message || problem)
  }
}

/** The picker: the input's change, or a drop. Reset, so the same file re-reads. */
function pickClientFile(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  return readClientFile(file)
}

function dropClientFile(event) {
  clientDrop.value = false
  return readClientFile(event.dataTransfer?.files?.[0])
}

async function forgetClient() {
  if (clientBusy.value) return
  clientBusy.value = true
  clientError.value = ''
  try {
    client.value = await clearOauthClient(props.provider)
  } catch (problem) {
    clientError.value = String(problem?.message || problem)
  } finally {
    clientBusy.value = false
  }
}

/** The account list. A failure says so; it is not silently "no accounts". */
async function readAccounts() {
  accountsLoading.value = true
  try {
    accounts.value = await loadAccounts(props.connector)
    emit('changed', accounts.value)
  } catch (problem) {
    accounts.value = []
    accountsFail.value = `Could not read this machine's account list. ${String(problem?.message || problem)}`
  } finally {
    accountsLoading.value = false
  }
}

/** One consent screen, in the system browser. */
async function connectOauth() {
  if (busy.value) return
  busy.value = 'connect'
  accountsError.value = ''
  accountsNotice.value = ''
  try {
    /* A consent screen with no client cannot open: ask for the credentials in the
       card instead of walking the person to an error they cannot act on. */
    if (!client.value.configured) {
      clientOpen.value = true
      busy.value = ''
      return
    }
    /* The browser is open and the round-trip is a wait, so the card says so
       instead of sitting still on a button that looks unpressed (spec §5). */
    accountsNotice.value = `Waiting for ${providerLabel.value} — finish the consent screen in your browser.`
    const answer = await connectAccount(props.connector)
    if (answer?.ok) {
      accountsNotice.value = `${answer.account?.email || 'The account'} was added.`
      await readAccounts()
    } else {
      accountsNotice.value = ''
      accountsError.value = answer?.message || 'Nothing was saved.'
    }
  } catch (problem) {
    accountsError.value = `Nothing was saved. ${String(problem?.message || problem)}`
  } finally {
    busy.value = ''
  }
}

async function testAllAccounts() {
  if (busy.value) return
  busy.value = 'accounts-test'
  accountsFail.value = ''
  accountsNotice.value = ''
  try {
    const answer = await testAccounts(props.connector)
    accountsNotice.value = answer?.detail || 'The accounts answered.'
    await readAccounts()
  } catch (problem) {
    accountsFail.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

/** `Remove` is confirm-on-second-press: one row leaves, the provider grant stays. */
async function removeAccountRow(account) {
  if (busy.value) return
  const key = account.email
  if (confirmingAccount.value !== key) {
    confirmingAccount.value = key
    return
  }
  confirmingAccount.value = ''
  busy.value = `remove:${key}`
  accountsFail.value = ''
  try {
    accounts.value = await removeAccount({ connector: props.connector, account: account.localpart })
    toast(`${account.email} removed. The ${providerLabel.value} consent stays on this machine.`)
    emit('changed', accounts.value)
  } catch (problem) {
    accountsFail.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

/** `Sign in` and `Re-consent` are the same round-trip as `Connect`. */
function accountVerb(account) {
  if (verbOf(account).label === 'Remove') return removeAccountRow(account)
  return connectOauth()
}

/* The box leads with the fact that carries the state. `connect()` already says it,
   so it is not repeated twice in one sentence. */
const accountsErrorBody = computed(() =>
  String(accountsError.value || '')
    .replace(/^Nothing was saved\.?\s*/i, '')
    .replace(/\s*Nothing was saved\.?$/i, ''),
)

const accountTone = (account) => {
  const word = String(account?.status || '')
  if (/needs sign-in/i.test(word)) return 'fail'
  if (/signing in|parked/i.test(word)) return 'warn'
  return 'ok'
}

const accountDetail = (account) => {
  if (account?.status === 'needs sign-in') return 'refresh token rejected'
  if (account?.status === 'signing in') return 'in the system browser'
  if (account?.status === 'parked') return `consent withdrawn in ${providerLabel.value}`
  return account?.refreshedAt ? `refreshed ${ago(account.refreshedAt)}` : 'not probed'
}

/* `added 14 Mar` once, absolutely, and the relative half from the app's own
   formatter: a date column would be a second way to say the same thing. */
const accountLine = (account) => {
  const at = Date.parse(String(account?.addedAt || ''))
  const added = Number.isFinite(at)
    ? `added ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : 'added —'
  return account?.refreshedAt ? `${added} · used ${ago(account.refreshedAt)}` : added
}

/* The second empty sentence changes per connector (one mailbox, one file, one
   channel); the first is the same everywhere. */
const EMPTY_HINT = {
  gmail: 'One Google sign-in adds one mailbox. Repeat for a shared inbox.',
  'google-drive': 'One Google sign-in adds one Drive. Repeat for a shared drive.',
  youtube: 'One Google sign-in adds one channel. Repeat for a shared channel.',
  'youtube-studio':
    'Sign in with the Google account that manages the channel. A personal account that owns no channel is refused, not saved.',
  x: 'One sign-in adds one X account. Repeat for a second handle.',
}
const emptyHint = computed(
  () => EMPTY_HINT[props.connector] || `One ${providerLabel.value} sign-in adds one account.`,
)

/* Verbatim scope ids, never translated. A missing scope names itself, because that
   is the string `Re-consent` asks for. More than three collapses to `<first> +N`
   with the full list in `title`. */
function scopeView(account) {
  const granted = account?.scopes || []
  /* The calendar page is gated on one scope, so that scope is the chip that has to
     survive the collapse — a chip reading `userinfo.email +3` hides the only grant
     a person is being asked about. Other connectors keep the store's order. */
  const ordered =
    props.connector === 'google-calendar'
      ? [...granted].sort((a, b) => Number(b === 'calendar.readonly') - Number(a === 'calendar.readonly'))
      : granted
  const cells = [
    ...ordered.map((scope) => ({ text: scope, miss: false })),
    ...(account?.missing || []).map((scope) => ({ text: `${scope} not granted`, miss: true })),
  ]
  const full = cells.map((cell) => cell.text).join(', ')
  if (cells.length <= 3) return { cells, title: props.connector === 'google-calendar' ? full : '' }
  return {
    cells: [{ text: `${cells[0].text} +${cells.length - 1}`, miss: false }],
    /* The collapsed names are only reachable from the `title`, so the calendar tab
       always sets it — an empty tooltip on `+3` is three scopes with no way to read
       them. */
    title: full,
  }
}

/* One verb, and the dead row is the only primary in the table. */
function verbOf(account) {
  if (account?.status === 'needs sign-in') return { label: 'Sign in', primary: true, disabled: false }
  if (account?.status === 'signing in') return { label: 'Remove', primary: false, disabled: true }
  if (account?.status !== 'parked' && account?.missing?.length) {
    return { label: 'Re-consent', primary: false, disabled: false }
  }
  return { label: 'Remove', primary: false, disabled: false }
}

/* `3 · 2 usable, 1 needs sign-in`, or the zero state in words. */
const accountsFact = computed(() => {
  const total = accounts.value.length
  if (!total) return 'no account connected'
  const usable = accounts.value.filter((account) => account.status === 'connected').length
  const dead = total - usable
  return dead
    ? `${total} · ${usable} usable, ${dead} need${dead === 1 ? 's' : ''} sign-in`
    : `${total} · ${usable} usable`
})

/* ── the calendars column ──────────────────────────────────────────
   Only Google Calendar has one, and it is the *gate's evidence*: the Dashboard tab
   is enabled by a grant, and this column is how many calendars that grant actually
   answered on the last read. `null` is "nothing read yet" and prints `—`; `0` would
   claim a read that never happened. The other four connectors keep four tracks, so
   their card is byte-identical to what shipped. */
const showCalendars = computed(() => props.connector === 'google-calendar')
const calendarsOf = (account) => {
  const row = googleCalendar.accounts.find(
    (entry) => String(entry.localpart || '') === String(account?.localpart || ''),
  )
  const count = row?.calendars
  if (!Number.isFinite(Number(count))) return '—'
  const n = Number(count)
  return `${n} ${n === 1 ? 'calendar' : 'calendars'}`
}

/* The page's Definition card shows this, so the two cannot disagree about the
   same connector.
   Exposed as a **function**, not the computed: `defineExpose` hands the ref object
   through a template ref without unwrapping, so a parent reading `.accountsFact`
   would get `[object Object]` instead of the sentence. */
defineExpose({ accountsFact: () => accountsFact.value })


onMounted(async () => {
  /* The client first: with none saved, `Connect` opens the form instead of asking
     the browser for a consent screen it cannot run. */
  await Promise.all([
    readClient(),
    readAccounts(),
    readTiers(),
    /* The Calendars column is answered by the connector's own read, and asking here
       is what keeps the column and the Dashboard tab's gate the same fact. */
    showCalendars.value ? readCalendarAccounts().catch(() => {}) : null,
  ])
  emit('changed', accounts.value)
})
</script>

<template>
  <section class="cxn-card">
    <div class="cxn-card-head">
      <h2>Accounts</h2>
      <span class="n">{{ accounts.length }}</span>
      <span class="spacer"></span>
      <button
        v-if="canConnect"
        class="btn btn-sm btn-primary"
        type="button"
        :disabled="Boolean(busy)"
        @click="connectOauth"
      >
        Connect {{ providerLabel }} account
      </button>
    </div>

    <!-- How much access. Three tiers, because one broad grant is what people
         flinch at, and a mailbox agent needs no send permission to read mail. -->
    <div v-if="canConnect && tiers.length" class="acct-tiers">
      <p class="acct-tiers-lead">
        What these accounts may do —
        <span class="acct-tiers-now">{{ currentTier?.label || 'Full access' }}</span>
      </p>
      <div class="acct-tiers-list" role="radiogroup" aria-label="Access level">
        <button
          v-for="tier in tiers"
          :key="tier.id"
          class="acct-tier"
          type="button"
          role="radio"
          :aria-checked="tier.current ? 'true' : 'false'"
          :disabled="Boolean(tierBusy)"
          @click="chooseTier(tier)"
        >
          <span class="acct-tier-h">
            <span class="acct-tier-nm">{{ tier.label }}</span>
            <span v-if="tier.current" class="acct-tier-on">chosen</span>
          </span>
          <span class="acct-tier-detail">{{ tier.detail }}</span>
          <span class="acct-tier-scopes">
            <code v-for="scope in tier.scopes" :key="scope" class="mono">{{ scope }}</code>
          </span>
        </button>
      </div>
    </div>

    <!-- The client the consent screen runs under: asked once per machine, stored
         0600, never returned. -->
    <div v-if="clientOpen && canConnect" class="acct-client">
      <p class="acct-client-lead">
        A consent screen needs an OAuth client.
        {{ client.instruction || 'Create one, then paste its id here.' }}
        Open the
        <a :href="client.consoleUrl" target="_blank" rel="noreferrer noopener">
          {{ providerLabel }} console</a>,
        then paste it here — saved on this machine only, never in the workspace.
      </p>
      <!-- Google's console downloads the client as a file, so the common path is
           dropping it rather than transcribing two values. A `<label>` wraps the
           input: the zone is reachable and activatable from the keyboard. -->
      <label
        v-if="client.acceptsClientFile"
        class="acct-client-drop"
        :class="{ 'is-over': clientDrop }"
        :aria-label="`Drop or pick a credentials.json for ${providerLabel}`"
        @dragenter.prevent="clientDrop = true"
        @dragover.prevent="clientDrop = true"
        @dragleave.prevent="clientDrop = false"
        @drop.prevent="dropClientFile"
      >
        <input class="sr-only" type="file" accept="application/json,.json" @change="pickClientFile" />
        <span class="acct-client-drop-h">
          Drop credentials.json, or pick it
        </span>
        <span class="acct-client-drop-d">
          Read here and stored on this machine — the file itself is not kept.
        </span>
      </label>
      <!-- X validates the redirect URL by exact match, so it has to be registered
           literally. Google documents a loopback exemption and needs nothing. -->
      <p v-if="client.callback" class="acct-client-callback">
        Callback URL to register:
        <code class="mono">{{ client.callback }}</code>
      </p>
      <div class="cxn-fields">
        <label>
          client id
          <input
            v-model="clientForm.clientId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="providerLabel === 'Google' ? '…apps.googleusercontent.com' : 'the app\'s client id'"
          />
        </label>
        <!-- A public client (X, under PKCE) has no secret; asking for one would
             make the form look broken. -->
        <label v-if="client.secretRequired !== false">
          client secret
          <input
            v-model="clientForm.clientSecret"
            type="password"
            autocomplete="off"
            placeholder="stored 0600 on this machine"
          />
        </label>
      </div>
      <div v-if="clientError" class="cxn-error" role="alert">{{ clientError }}</div>
      <!-- The id that was read and a mask, so a wrong file is visible before
           Save. The file's text is never rendered. -->
      <p v-if="pickedRead" class="acct-client-read">
        Read <code class="mono">{{ clientForm.clientId }}</code> · secret
        <code class="mono">{{ pickedMask }}</code>
      </p>
      <div class="acct-client-acts">
        <button class="btn btn-sm btn-primary" type="button" :disabled="clientBusy" @click="saveClient">
          {{ clientBusy ? 'Saving…' : 'Save and continue' }}
        </button>
        <button class="btn btn-sm btn-ghost" type="button" :disabled="clientBusy" @click="cancelClient">
          Cancel
        </button>
        <span class="spacer"></span>
        <button
          v-if="client.configured"
          class="btn btn-sm btn-ghost"
          type="button"
          :disabled="clientBusy"
          @click="forgetClient"
        >
          Forget this client
        </button>
      </div>
    </div>

    <!-- A saved client is a fact worth one line: which one, never the secret. -->
    <p v-else-if="client.configured && canConnect" class="acct-client-note">
      Client <code class="mono">{{ client.hint }}</code> on this machine ·
      <button class="empty-link" type="button" @click="clientOpen = true">replace it</button>
    </p>

    <!-- A refused or timed-out consent, verbatim: the honest state. -->
    <div v-if="accountsError" class="cxn-error" role="alert">
      <b>Nothing was saved.</b> {{ accountsErrorBody }}
      <div class="acct-retry">
        <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="connectOauth">
          Try again
        </button>
      </div>
    </div>
    <div v-else-if="accountsFail" class="cxn-error" role="alert">{{ accountsFail }}</div>
    <div v-else-if="accountsNotice" class="cxn-ok" role="status">{{ accountsNotice }}</div>

    <div class="acct-box">
      <!-- 0 accounts: the copy states the rule, and the primary is the one action. -->
      <div v-if="!accounts.length && !accountsLoading" class="acct-empty">
        <p><b>No account is connected yet.</b></p>
        <p class="acct-empty-hint">{{ emptyHint }}</p>
        <div v-if="canConnect">
          <button class="btn btn-sm btn-primary" type="button" :disabled="Boolean(busy)" @click="connectOauth">
            Connect {{ providerLabel }} account
          </button>
        </div>
      </div>

      <div v-else class="acct" :class="{ 'has-cals': showCalendars }" role="table" aria-label="Connected accounts">
        <div class="acct-cols" role="row">
          <span role="columnheader">Account</span>
          <span role="columnheader" data-col="scopes">Scopes</span>
          <span v-if="showCalendars" role="columnheader">Calendars</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Action</span>
        </div>

        <!-- the read is in flight: the skeleton repeats the real tracks -->
        <div v-for="n in accountsLoading ? 2 : 0" :key="`skel-${n}`" class="acct-row is-skel" role="row">
          <span class="ct-who" role="cell">
            <span class="ct-mk acct-skel" aria-hidden="true"></span>
            <span class="ct-copy">
              <span class="acct-skel acct-skel-line acct-skel-wide"></span>
              <span class="acct-skel acct-skel-line acct-skel-narrow"></span>
            </span>
          </span>
          <span class="acct-scopes" role="cell"><span class="acct-skel acct-skel-line acct-skel-scope"></span></span>
          <span v-if="showCalendars" class="acct-cals" role="cell"><span class="acct-skel acct-skel-line acct-skel-scope"></span></span>
          <span class="ct-status" role="cell"></span>
          <span class="ct-act" role="cell"></span>
        </div>

        <div
          v-for="account in accountsLoading ? [] : accounts"
          :key="account.email"
          class="acct-row"
          role="row"
          :data-s="accountTone(account)"
        >
          <span class="ct-who" role="cell">
            <span class="ct-mk" aria-hidden="true">{{ account.email[0] }}</span>
            <span class="ct-copy">
              <span class="ct-name" :title="account.email">{{ account.email }}</span>
              <span class="ct-line">{{ accountLine(account) }}</span>
            </span>
          </span>
          <span class="acct-scopes" role="cell" :title="scopeView(account).title || undefined">
            <span
              v-for="cell in scopeView(account).cells"
              :key="cell.text"
              :class="{ miss: cell.miss }"
            >{{ cell.text }}</span>
          </span>
          <span v-if="showCalendars" class="acct-cals" role="cell">{{ calendarsOf(account) }}</span>
          <span class="ct-status" role="cell" :data-s="accountTone(account)">
            <span class="ct-s1">
              <span class="dot" aria-hidden="true"></span>
              <span class="ct-word">{{ account.status }}</span>
            </span>
            <small>{{ accountDetail(account) }}</small>
          </span>
          <span class="ct-act" role="cell">
            <button
              v-if="canConnect"
              class="btn btn-sm"
              :class="verbOf(account).primary ? 'btn-primary' : 'btn-ghost'"
              type="button"
              :disabled="verbOf(account).disabled || Boolean(busy)"
              :aria-label="`${verbOf(account).label}, ${account.email}`"
              @click="accountVerb(account)"
            >
              {{ confirmingAccount === account.email ? 'Remove for good?' : verbOf(account).label }}
            </button>
          </span>
        </div>
      </div>

      <div class="acct-foot">
        <span v-if="canConnect">Tokens live on this machine and never sync with the workspace.</span>
        <span v-else>Only a workspace owner can add an account.</span>
        <span class="spacer"></span>
        <button
          v-if="canConnect"
          class="btn btn-sm btn-ghost"
          type="button"
          :disabled="Boolean(busy)"
          @click="testAllAccounts"
        >
          {{ busy === 'accounts-test' ? 'Testing…' : 'Test all accounts' }}
        </button>
      </div>
    </div>
  </section>
</template>
