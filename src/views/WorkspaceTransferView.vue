<script setup>
/**
 * Transfer — one file out of this workspace, one file in.
 *
 * The page is two jobs, so it is two tabs and not one form with a mode switch:
 * sending decides a scope and a seal, receiving decides a mode and confirms a
 * diff. Each keeps its own state, and the tab lives in the URL (`?mode=`), so a
 * link lands on Receive and Back returns to Send.
 *
 * Every number and every name on this page comes from `electron/transfer-store.cjs`
 * through the call table, including the dry header the Send aside paints. A
 * second copy of the presets, the naming rule or the diff in the renderer is how
 * the preview starts disagreeing with the file on disk.
 *
 * Nothing is written to this workspace until a body is inspected and a mode is
 * chosen — reading a file is memory only, and a refusal always leaves the
 * workspace exactly as it was.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import TransferPlacementDialog from '@/components/TransferPlacementDialog.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { call } from '@/composables/localBridge'
import { TRANSFER_EXTENSIONS, humanBytes, plural, readTransferFile } from '@/lib/transfer'
import { hub, toast } from '@/stores/hub'

const route = useRoute()
const router = useRouter()

const MODES = ['send', 'receive']
const mode = ref(MODES.includes(String(route.query.mode)) ? String(route.query.mode) : 'send')

function setMode(next) {
  if (!MODES.includes(next) || next === mode.value) return
  mode.value = next
  const query = { ...route.query, tab: 'transfer' }
  if (next === 'send') delete query.mode
  else query.mode = next
  router.replace({ name: 'workspace', params: { workspace: route.params.workspace }, query })
}

watch(
  () => route.query.mode,
  (value) => {
    const next = MODES.includes(String(value)) ? String(value) : 'send'
    if (next !== mode.value) mode.value = next
  },
)

/* ── send ─────────────────────────────────────────────────────────────
   Three presets, because a preset is what the store can name and diff. The
   mockup's "choose individual groups" is a fourth preset (`custom`) with a path
   list, and it is not built yet: three rows that always work beat a disclosure
   that half works. Ceiling noted, upgrade path is `PRESETS.custom`. */
const PRESETS = [
  {
    id: 'agents',
    label: 'Agents & skills',
    note: 'The entities, the skills they read and the artifacts they made.',
  },
  {
    id: 'connections',
    label: 'Connections',
    note: 'The server definitions and the connector rows. Names and settings only, unless you include the tokens.',
  },
  {
    id: 'whole',
    label: 'Whole workspace',
    note: 'Everything, including the context and who belongs. Use it to restore on a new machine.',
  },
]

/* The store refuses a shorter passphrase too; this copy exists only so the field
   can answer while someone is typing, without a round trip per keystroke. */
const MIN_PASS = 12

const preset = ref('agents')
const includeCredentials = ref(false)
const seal = ref(false)
const sendPass = ref('')
const preview = ref(null)
const sendError = ref('')
const sending = ref(false)

const sealed = computed(() => seal.value || includeCredentials.value)
const short = computed(() => sealed.value && sendPass.value.length < MIN_PASS)
const name = computed(() => String(preview.value?.filename || ''))

/* The dry header names the unsealed file. The extension is the one thing the
   seal changes about a name, and it has to flip in the frame the switch does —
   so it is swapped here, on the store's own string, rather than re-derived. */
const shownName = computed(() => {
  if (!name.value) return ''
  return sealed.value
    ? name.value.replace(/\.entity\.json$/, '.entity.zip')
    : name.value.replace(/\.entity\.zip$/, '.entity.json')
})

const ROWS = [
  { key: 'entities', label: 'Entities', in: ['agents', 'whole'] },
  { key: 'skills', label: 'Skills', in: ['agents', 'whole'] },
  { key: 'artifacts', label: 'Artifacts', in: ['agents', 'whole'] },
  { key: 'chats', label: 'Conversations', in: ['whole'] },
  { key: 'connectors', label: 'Connectors', in: ['connections', 'whole'] },
  { key: 'servers', label: 'MCP servers', in: ['connections', 'whole'] },
]

const sendRows = computed(() => {
  const counts = preview.value?.counts || {}
  return ROWS.filter((row) => row.in.includes(preset.value)).map((row) => ({
    key: row.key,
    label: row.label,
    value: counts[row.key] ?? 0,
  }))
})

/* A dry header: the counts and the name, nothing on disk. It is asked without a
   passphrase and without the tokens, because neither changes a count and asking
   for a credential without a seal is a refusal, not a preview. */
async function refreshPreview() {
  if (!hub.workspace) return
  sendError.value = ''
  try {
    preview.value = await call('transfer.send', {
      workspace: hub.workspace,
      preset: preset.value,
      dry: true,
    })
  } catch (error) {
    preview.value = null
    sendError.value = error.message
  }
}

/* Connections can carry a credential, and a credential forces the seal: the
   switch is the thing that turns it off, so the credential is the only thing
   that can turn it back on. */
function pickPreset(next) {
  preset.value = next
  includeCredentials.value = false
  if (next === 'connections') seal.value = true
}

/* The workspace arrives from the store a tick after this page mounts, so the
   dry header is re-asked when it does — and only then is there anything to read. */
watch([preset, () => hub.workspace], refreshPreview, { immediate: true })

const createLabel = computed(() => (sealed.value ? 'Create sealed file' : 'Create file'))
const canCreate = computed(() => Boolean(hub.workspace) && !sending.value && !short.value)

async function create() {
  if (!canCreate.value) return
  sending.value = true
  sendError.value = ''
  try {
    const result = await call('transfer.send', {
      workspace: hub.workspace,
      preset: preset.value,
      includeCredentials: includeCredentials.value,
      passphrase: sealed.value ? sendPass.value : '',
    })
    toast(
      `${result.filename} · ${result.sealed ? 'sealed, and the passphrase cannot be recovered' : 'no secrets in this file'}`,
      {
        actionLabel: 'Reveal in Finder',
        onAction: () =>
          call('transfer.reveal', { filename: result.filename }).catch((error) => toast(error.message)),
      },
    )
    await refreshPreview()
  } catch (error) {
    sendError.value = error.message
  } finally {
    sending.value = false
  }
}

/* ── receive ────────────────────────────────────────────────────────── */

const chooser = ref(null)
const dragging = ref(0)
const picked = ref(null)
const readPass = ref('')
const inspect = ref(null)
const locked = ref('')
const warn = ref('')
const reading = ref(false)
const writing = ref(false)
const applyMode = ref('add')
const snapshot = ref(true)
const placeOpen = ref(false)
const placeError = ref('')

const GROUP_LABELS = {
  entities: 'Entities',
  skills: 'Skills',
  artifacts: 'Artifacts',
  chats: 'Conversations',
  connections: 'Connections',
  workspace: 'Workspace',
}

const whole = computed(() => inspect.value?.scope === 'workspace')
/* Before the first read answers there is still an answer: the extension is the
   contract (a `.zip` is sealed whatever it carries), and a sealed file that has
   not been unlocked yet must not be labelled "readable" — that is the one pill a
   person reads while the passphrase field is asking them for it. */
const readable = computed(() =>
  inspect.value ? !inspect.value.sealed : !/\.entity\.zip$/i.test(picked.value?.name || ''),
)
const totals = computed(() => inspect.value?.totals || {})
const writeCount = computed(() => (totals.value.add || 0) + (totals.value.replace || 0))
const same = computed(() => Boolean(inspect.value?.same))
const open = ref({})

function toggle(key) {
  open.value = { ...open.value, [key]: !open.value[key] }
}

function reset() {
  picked.value = null
  inspect.value = null
  readPass.value = ''
  locked.value = ''
  warn.value = ''
  placeError.value = ''
  open.value = {}
  applyMode.value = 'add'
  snapshot.value = true
}

/* `passphrase` is only sent on the retry: the first read of a sealed file is
   supposed to refuse, and that refusal is the field's invitation, not an error. */
async function read({ passphrase = '' } = {}) {
  if (!picked.value) return
  reading.value = true
  warn.value = ''
  locked.value = ''
  placeError.value = ''
  try {
    const answer = await call('transfer.inspect', {
      workspace: hub.workspace,
      filename: picked.value.name,
      data: picked.value.data,
      passphrase,
      mode: applyMode.value,
    })
    inspect.value = answer
    open.value = {}
    if (answer.scope === 'workspace' && !placeOpen.value) placeOpen.value = true
  } catch (error) {
    inspect.value = null
    if (error.code === 'passphrase') locked.value = error.message
    else warn.value = error.message
  } finally {
    reading.value = false
  }
}

async function take(file) {
  if (!file || reading.value) return
  reset()
  try {
    picked.value = await readTransferFile(file)
    await read()
  } catch (error) {
    picked.value = null
    warn.value = error.message
  }
}

function onChoose(event) {
  const file = event.target?.files?.[0]
  if (file) take(file)
  event.target.value = ''
}

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files')

function onDragEnter(event) {
  if (!hasFiles(event)) return
  dragging.value += 1
}

function onDragOver(event) {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave() {
  dragging.value = Math.max(0, dragging.value - 1)
}

function onDrop(event) {
  dragging.value = 0
  if (!hasFiles(event)) return
  event.preventDefault()
  take(event.dataTransfer.files?.[0])
}

/* The diff's actions change with the mode (`keep` becomes `replace`), so the
   mode is a second read of the same bytes rather than a local guess. */
watch(applyMode, () => {
  if (picked.value && inspect.value && !whole.value) read({ passphrase: readPass.value })
})

const receiveLabel = computed(() => {
  if (same.value) return 'Close'
  if (applyMode.value === 'replace') return `Replace ${plural(writeCount.value, 'file')}`
  return `Add ${plural(writeCount.value, 'file')}`
})

async function receive() {
  if (!picked.value || writing.value) return
  if (same.value) {
    reset()
    return
  }
  writing.value = true
  warn.value = ''
  let queued = ''
  try {
    const result = await call('transfer.apply', {
      workspace: hub.workspace,
      filename: picked.value.name,
      data: picked.value.data,
      passphrase: readPass.value,
      mode: applyMode.value,
      snapshot: snapshot.value,
    })
    if (result.firstFailure) {
      /* The re-read below clears `warn`, so the failure is carried across it. */
      queued = `${result.firstFailure.path}: ${result.firstFailure.message}`
    }
    /* ponytail: the toast's action opens the snapshot row rather than undoing the
       write. The snapshot does exist in Account → Backups before the first byte
       lands, so nothing is lost — but `backup-store.restore()` creates a *new*
       workspace id, so it cannot put this one back in place. An in-place Undo
       needs an in-place restore the backup store does not have; upgrade path is
       `backup.restore({ inPlace: true })`, at which point this action becomes
       `Undo` and calls it. */
    toast(
      `${plural(result.written, 'file')} ${applyMode.value === 'replace' ? 'replaced' : 'added'}`,
      result.snapshot
        ? {
            actionLabel: 'Snapshot',
            onAction: () => router.push({ name: 'account-backups' }),
          }
        : {},
    )
    /* What was just written is now `keep` everywhere: the same read answers
       "everything matches", which is the honest state after a write. */
    await read({ passphrase: readPass.value })
    if (queued) warn.value = queued
  } catch (error) {
    warn.value = queued || error.message
  } finally {
    writing.value = false
  }
}

async function place(payload) {
  if (!picked.value || writing.value) return
  writing.value = true
  placeError.value = ''
  try {
    const result = await call('transfer.place', {
      workspace: hub.workspace,
      filename: picked.value.name,
      data: picked.value.data,
      passphrase: readPass.value,
      mode: payload.mode,
      confirm: payload.confirm,
    })
    placeOpen.value = false
    toast(
      result.replaced
        ? `${result.label} replaced · ${plural(result.written, 'file')}`
        : `Placed as ${result.id}`,
    )
    reset()
  } catch (error) {
    placeError.value = error.message
  } finally {
    writing.value = false
  }
}
</script>

<template>
  <div class="tr-page">
    <!-- The cabinet's banner, not a heading block: Skills and Machine →
         Harnesses open the same way, and a workspace tab that is titled like a
         settings card reads as a form even when it is a two-job page. One
         column, because this page has no collection meter to put in the second. -->
    <section class="sk-hero tr-hero">
      <PixelBackdrop variant="hero" :count="18" />
      <div class="sk-hero-in">
        <header class="sk-hero-id">
          <!-- the case: the specimen sheet's shape for a file on its way, drawn
               by the same module that draws every other page's ornament -->
          <span class="sk-crest" aria-hidden="true"><VoxelMark shape="case" /></span>
          <div class="sk-hero-text">
            <p class="eyebrow">
              Workspace settings <span class="sep">·</span>
              {{ hub.workspaceLabel || hub.workspace }}
            </p>
            <h1 class="sk-h1">Transfer</h1>
            <p class="sk-lede">
              One file out of <b class="mono">{{ hub.workspaceLabel || hub.workspace || 'this workspace' }}</b>,
              or one file in. A credential never travels in a readable file.
            </p>
            <div class="sk-chips">
              <span class="sk-chip">{{ TRANSFER_EXTENSIONS }}</span>
              <span class="sk-chip">sealed when a credential travels</span>
            </div>
          </div>
        </header>
      </div>
    </section>

    <div class="tr-tabs" role="tablist" aria-label="Send or receive">
      <button
        type="button"
        role="tab"
        :aria-selected="mode === 'send' ? 'true' : 'false'"
        @click="setMode('send')"
      >
        Send
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="mode === 'receive' ? 'true' : 'false'"
        @click="setMode('receive')"
      >
        Receive
      </button>
    </div>

    <!-- ── send ──────────────────────────────────────────────────────── -->
    <div v-if="mode === 'send'" class="tr-panes">
      <div class="tr-col">
        <section class="tr-card" aria-labelledby="tr-send-what">
          <div class="tr-card-head">
            <h2 id="tr-send-what">What goes in the file</h2>
            <span class="tr-pill">{{ PRESETS.find((row) => row.id === preset)?.label }}</span>
          </div>

          <div class="tr-opts" role="radiogroup" aria-label="What goes in the file">
            <button
              v-for="row in PRESETS"
              :key="row.id"
              class="tr-opt"
              type="button"
              role="radio"
              :aria-checked="preset === row.id ? 'true' : 'false'"
              :disabled="sending"
              @click="pickPreset(row.id)"
            >
              <span class="tr-opt-dot" aria-hidden="true"></span>
              <span class="tr-opt-copy">
                <b>{{ row.label }}</b>
                <span>{{ row.note }}</span>
              </span>
            </button>
          </div>

          <label v-if="preset === 'connections'" class="tr-check">
            <input v-model="includeCredentials" type="checkbox" :disabled="sending" />
            <span>Include the bearer tokens</span>
          </label>
          <p v-if="preset === 'connections'" class="mnote">
            Unchecked, every token travels as <b class="mono">***</b> and the other machine
            signs in again. Checked, the tokens are in the file and the file must be sealed.
          </p>
        </section>

        <section class="tr-card" aria-labelledby="tr-send-seal">
          <div class="tr-card-head">
            <h2 id="tr-send-seal">The seal</h2>
          </div>

          <div class="tr-row">
            <span class="tr-copy">
              <b>Seal this file with a passphrase</b>
              <span>
                The file becomes a <b class="mono">.entity.zip</b> that will not open
                without it. There is no recovery — the passphrase is not stored anywhere.
              </span>
            </span>
            <button
              class="sfx-switch"
              type="button"
              role="switch"
              :aria-checked="sealed ? 'true' : 'false'"
              :disabled="includeCredentials || sending"
              aria-label="Seal this file with a passphrase"
              @click="seal = !seal"
            >
              <span></span>
            </button>
          </div>

          <div v-if="sealed" class="fld tr-pass">
            <label class="lbl" for="tr-send-pass">Passphrase</label>
            <input
              id="tr-send-pass"
              v-model="sendPass"
              class="acct-input"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :disabled="sending"
              :aria-invalid="short ? 'true' : 'false'"
            />
            <p class="mnote">
              <template v-if="short">Use at least {{ MIN_PASS }} characters; there is no way to recover it.</template>
              <template v-else>At least {{ MIN_PASS }} characters. Nobody can reset it for you.</template>
            </p>
          </div>

          <p v-if="sendError" class="acct-error" role="alert">{{ sendError }}</p>
        </section>
      </div>

      <aside class="tr-aside" aria-label="What this file will carry">
        <dl class="tr-nums">
          <div v-for="row in sendRows" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd class="mono">{{ preview ? row.value : '—' }}</dd>
          </div>
        </dl>
        <p class="mnote tr-size">
          <template v-if="preview">{{ plural(preview.counts.files, 'file') }} · {{ humanBytes(preview.bytes) }}</template>
          <template v-else>Reading the workspace…</template>
        </p>
        <p v-if="shownName" class="tr-name mono">{{ shownName }}</p>
        <button class="btn btn-ink tr-go" type="button" :disabled="!canCreate" @click="create">
          {{ sending ? 'Creating…' : createLabel }}
        </button>
      </aside>
    </div>

    <!-- ── receive ───────────────────────────────────────────────────── -->
    <div v-else class="tr-panes">
      <div class="tr-col">
        <section v-if="!picked" class="tr-card">
          <div
            class="tr-drop"
            :data-drag="dragging ? '1' : '0'"
            @dragenter="onDragEnter"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <p class="tr-drop-title">Drop a transfer file here</p>
            <p class="mnote mono">.entity.json · .entity.zip</p>
            <button class="btn" type="button" @click="chooser?.click()">Choose a file</button>
            <!-- `.json,.zip`: a browser matches the last extension, so the full
                 `.entity.json` in `accept` would open nothing. -->
            <input
              ref="chooser"
              class="tr-file"
              type="file"
              accept=".json,.zip"
              @change="onChoose"
            />
          </div>
          <p v-if="warn" class="tr-band" data-tone="warn" role="alert">{{ warn }}</p>
        </section>

        <section v-else class="tr-card" aria-labelledby="tr-recv-file">
          <div class="tr-card-head">
            <h2 id="tr-recv-file">{{ picked.name }}</h2>
            <span class="tr-pill">{{ readable ? 'readable' : 'sealed' }}</span>
            <button class="btn btn-sm" type="button" :disabled="reading || writing" @click="reset">
              Choose another file
            </button>
          </div>

          <p class="mnote">
            {{ humanBytes(picked.size) }} ·
            <template v-if="inspect">
              {{ inspect.sender?.name || inspect.sender?.email || 'another machine' }} ·
              <b class="mono">{{ inspect.workspace?.id }}</b> ·
              {{ plural(inspect.counts.files, 'file') }}
            </template>
            <template v-else>reading…</template>
          </p>

          <!-- A sealed file's first read refuses on purpose: the message is the
               field's invitation, not a failure. Nothing was written. -->
          <div v-if="locked" class="tr-unlock">
            <div class="fld tr-pass">
              <label class="lbl" for="tr-read-pass">Passphrase</label>
              <input
                id="tr-read-pass"
                v-model="readPass"
                class="acct-input"
                type="password"
                autocomplete="current-password"
                spellcheck="false"
                :disabled="reading"
                @keyup.enter="read({ passphrase: readPass })"
              />
              <p class="mnote">{{ locked }}</p>
            </div>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="reading || !readPass"
              @click="read({ passphrase: readPass })"
            >
              {{ reading ? 'Unlocking…' : 'Unlock' }}
            </button>
          </div>

          <p v-if="warn" class="tr-band" data-tone="warn" role="alert">{{ warn }}</p>

          <template v-if="inspect && whole">
            <p class="tr-band" data-tone="warn" role="note">
              This file is a whole workspace, so it is not a diff: it goes beside this one
              or replaces it. The sheet asks which.
            </p>
            <button class="btn btn-ink" type="button" @click="placeOpen = true">
              Where should it go?
            </button>
          </template>

          <ul v-else-if="inspect" class="tr-diff">
            <li
              v-for="group in inspect.groups"
              :key="group.key"
              :data-same="group.same ? '1' : '0'"
            >
              <button
                class="tr-drow"
                type="button"
                :aria-expanded="open[group.key] ? 'true' : 'false'"
                @click="toggle(group.key)"
              >
                <span class="tr-gname">{{ GROUP_LABELS[group.key] || group.key }}</span>
                <span class="tr-chips">
                  <i v-if="group.counts.add" data-k="add">+{{ group.counts.add }}</i>
                  <i v-if="group.counts.replace" data-k="replace">{{ group.counts.replace }} replace</i>
                  <i v-if="group.counts.keep" data-k="keep">= {{ group.counts.keep }} same</i>
                  <i v-if="group.counts.skip" data-k="skip">{{ group.counts.skip }} skip</i>
                </span>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </button>
              <ul v-if="open[group.key]" class="tr-paths">
                <li v-for="entry in group.paths" :key="entry.path">
                  <span class="mono">{{ entry.path }}</span>
                  <i :data-k="entry.action">{{ entry.action }}</i>
                </li>
              </ul>
            </li>
          </ul>
        </section>
      </div>

      <aside v-if="picked" class="tr-aside" aria-label="What this receive will write">
        <div v-if="inspect && !whole" class="tr-opts" role="radiogroup" aria-label="How to receive it">
          <button
            class="tr-opt"
            type="button"
            role="radio"
            :aria-checked="applyMode === 'add' ? 'true' : 'false'"
            :disabled="writing"
            @click="applyMode = 'add'"
          >
            <span class="tr-opt-dot" aria-hidden="true"></span>
            <span class="tr-opt-copy">
              <b>Add alongside</b>
              <span>What is already here keeps its bytes.</span>
            </span>
          </button>
          <button
            class="tr-opt"
            type="button"
            role="radio"
            data-danger="1"
            :aria-checked="applyMode === 'replace' ? 'true' : 'false'"
            :disabled="writing"
            @click="applyMode = 'replace'"
          >
            <span class="tr-opt-dot" aria-hidden="true"></span>
            <span class="tr-opt-copy">
              <b>Overwrite what matches</b>
              <span>Every path in the file wins, including the ones that differ here.</span>
            </span>
          </button>
        </div>

        <dl v-if="inspect && !whole" class="tr-nums">
          <div>
            <dt>To write</dt>
            <dd class="mono">{{ writeCount }}</dd>
          </div>
          <div>
            <dt>Already here</dt>
            <dd class="mono">{{ totals.keep || 0 }}</dd>
          </div>
          <div>
            <dt>Skipped</dt>
            <dd class="mono">{{ totals.skip || 0 }}</dd>
          </div>
        </dl>

        <p v-if="inspect && !whole && same" class="mnote">
          Everything matches. There is nothing to write.
        </p>

        <label v-if="inspect && !whole" class="tr-check">
          <input v-model="snapshot" type="checkbox" :disabled="writing" />
          <span>Snapshot this workspace first</span>
        </label>
        <p v-if="inspect && !whole" class="mnote">
          The copy lands in Account → Backups before the first byte is written.
        </p>

        <button
          v-if="inspect && !whole"
          class="btn tr-go"
          :class="applyMode === 'replace' && !same ? 'btn-danger' : 'btn-ink'"
          type="button"
          :disabled="writing || (same === false && writeCount === 0)"
          @click="receive"
        >
          {{ writing ? 'Writing…' : receiveLabel }}
        </button>
      </aside>

      <TransferPlacementDialog
        :open="placeOpen"
        :file="inspect"
        :here="{ id: String(hub.workspace || ''), label: hub.workspaceLabel || '' }"
        :busy="writing"
        :error="placeError"
        @close="placeOpen = false"
        @place="place"
      />
    </div>
  </div>
</template>
