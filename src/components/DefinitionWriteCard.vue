<script setup>
/**
 * A run asked to rewrite an entity's standing instructions.
 *
 * This is not a dialog: it sits on the composer, in the clone-consent slot, and
 * shows the lines that would change before any of them land. `Apply` is the only
 * action; `Not now` and `Esc` are the same answer and neither is guarded — the
 * diff *is* the confirmation. The write is conditional on the stamp the proposal
 * was read at, so a file edited in between makes the card stale instead of
 * overwriting a line nobody reviewed.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { copyText } from '@/lib/clipboard'
import { diffRows } from '@/lib/diff'
import { shortcutLabel } from '@/lib/shortcuts'
import { approveWriteRequest, dismissWriteRequest, pendingWriteProposal } from '@/stores/entities'
import { toast } from '@/stores/hub'

const props = defineProps({
  workspace: { type: String, required: true },
  /* the metadata `write.pending` returns; the bodies arrive through `proposal` */
  request: { type: Object, required: true },
})
const emit = defineEmits(['applied', 'dismissed', 'gone'])

/* The diff stops drawing past this many changed rows: a rewrite belongs on the
   entity page, not in a composer. */
const CAP = 240
/* Rows that fit the 244 px body before it starts scrolling. Used only to decide
   whether the "scroll for the rest" row is honest, never to drop a row. */
const FIT = 12

const rootEl = ref(null)
const rows = ref([])
const proposal = ref(null)
const phase = ref('loading')
const error = ref('')
const cause = ref('')
const showDiff = ref(false)
const armed = ref(false)
const settledAt = ref('')
let armTimer = null

const name = computed(() => props.request?.name || '')
/* Which decision this is: `write` rewrites a body, `create` adds a new file. */
const kind = computed(() => props.request?.kind || 'write')
const isCreate = computed(() => kind.value === 'create')
const previousBytes = computed(() => Number(props.request?.previousBytes || 0))
const bytes = computed(() => Number(props.request?.bytes || 0))
const escKey = shortcutLabel('escape')

/* The primary is only clickable once the Enter that sent the message has
   finished travelling — DelegationHold's pattern, for the same reason. */
onMounted(async () => {
  rootEl.value?.focus?.()
  armTimer = setTimeout(() => {
    armed.value = true
  }, 250)
  try {
    const read = await pendingWriteProposal(props.workspace, props.request.id)
    proposal.value = read
    /* A create has no "before" to diff: it shows the brief the new file will
       carry. A rewrite shows what would change. */
    rows.value = read.kind === 'create' ? [] : diffRows(read.previousBody, read.body)
    phase.value = 'ready'
  } catch (failure) {
    cause.value = String(failure?.message || failure)
    /* A request that was already answered elsewhere is not a failure: the card
       just leaves. */
    if (failure?.code === 'not_found') {
      phase.value = 'denied'
      emit('gone')
      return
    }
    phase.value = 'failed'
  }
})

onBeforeUnmount(() => {
  if (armTimer) clearTimeout(armTimer)
  armTimer = null
})

/** Whether a body was read at all; the count strip and the table depend on it. */
const loaded = computed(() => phase.value !== 'loading' && (isCreate.value || rows.value.length > 0))

/** The brief a new entity would carry — the same shape `scaffold` writes when no
    custom body is given, so the card shows the file rather than a summary of it. */
const briefBody = computed(() => {
  const read = proposal.value || {}
  const body = String(read.body || '').trim()
  if (body) return body
  const one = String(read.description || '').trim()
  return `# ${name.value}\n\n${one || 'What this entity is for.'}\n\n## Rules\n- One rule per line.\n`
})
const briefLines = computed(() => briefBody.value.split('\n').filter((line) => line.length > 0).length)
const briefBytes = computed(() => new TextEncoder().encode(briefBody.value).length)

const changed = computed(() => rows.value.filter((row) => row.kind !== 'same').length)
const added = computed(() => rows.value.filter((row) => row.kind === 'add' || row.kind === 'change').length)
const removed = computed(() => rows.value.filter((row) => row.kind === 'remove' || row.kind === 'change').length)
const totalLines = computed(() => rows.value.length)

/* A hunk is a contiguous run of changed rows: the count that says "three places"
   rather than "eight rows". */
const hunks = computed(() => {
  let runs = 0
  let inside = false
  for (const row of rows.value) {
    const dirty = row.kind !== 'same'
    if (dirty && !inside) runs += 1
    inside = dirty
  }
  return runs
})

const settled = computed(() => phase.value === 'applied' || phase.value === 'dismissed')
const busy = computed(() => phase.value === 'busy')

/* `ready` has three outcomes of its own, so it is named here rather than left to
   the template: Apply must not be offered where pressing it would be a lie. A
   create has no diff to be identical to and nothing to cap — its brief is one
   small file — so it is always decidable. */
const state = computed(() => {
  if (phase.value !== 'ready') return phase.value
  if (isCreate.value) return 'pending'
  if (!changed.value) return 'identical'
  if (changed.value > CAP) return 'large'
  return 'pending'
})

/* Blocked is about the write, not the diff: an over-large rewrite keeps the
   neutral left edge, because its banner explains rather than accuses. */
const blockedEdge = computed(() => ['stale', 'denied', 'failed'].includes(phase.value))
const blocked = computed(
  () => blockedEdge.value || (phase.value === 'ready' && state.value === 'large'),
)

const variant = computed(() => {
  if (state.value === 'applied' || state.value === 'dismissed' || state.value === 'identical') return 'settled'
  if (state.value === 'busy') return 'busy'
  if (blockedEdge.value) return 'blocked'
  return 'pending'
})

const title = computed(() => {
  const rewrite = `${name.value} wants to rewrite its instructions`
  const create = `${name.value} wants to join this workspace`
  if (state.value === 'loading') {
    return isCreate.value ? `Reading the brief for ${name.value}.md` : `Reading ${name.value}.md to build the diff`
  }
  if (state.value === 'identical') return 'The proposal is the file\u2019s current content'
  if (state.value === 'large') return 'This is a rewrite, not an edit'
  if (state.value === 'denied') return 'Refused before it was built'
  if (state.value === 'stale') {
    return isCreate.value ? `${name.value}.md exists now` : `${name.value}.md moved under the proposal`
  }
  if (state.value === 'failed') {
    return isCreate.value ? 'The brief is fine; the create was not' : 'The diff is fine; the write was not'
  }
  return isCreate.value ? create : rewrite
})

const tag = computed(() => {
  if (state.value === 'loading' || state.value === 'identical' || state.value === 'pending') return 'nothing written yet'
  if (state.value === 'busy') return 'applying…'
  if (state.value === 'applied') return 'applied'
  if (state.value === 'dismissed') return 'not applied'
  if (state.value === 'large') return `${changed.value} lines`
  return state.value
})

const size = (value) => {
  const n = Number(value || 0)
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

const delta = computed(() => `${size(previousBytes.value)} → ${size(bytes.value)}`)

/** `asked 41 s ago` — a timestamp is only worth the line if it reads as one. */
const askedAgo = computed(() => {
  const at = Date.parse(String(props.request?.at || ''))
  if (!Number.isFinite(at)) return ''
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `asked ${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `asked ${m} min ago`
  return `asked ${Math.round(m / 60)} h ago`
})

const stampBytes = computed(() => Number(props.request?.stamp?.bytes || 0))

/* The file that is written. Only the directory shrinks, so the filename always
   survives; the whole path is in the row's `title` and in Copy. */
const filePath = computed(() => props.request?.displayPath || `${name.value}.md`)
const dirPath = computed(() =>
  filePath.value.endsWith(`${name.value}.md`)
    ? filePath.value.slice(0, filePath.value.length - `${name.value}.md`.length)
    : '',
)

const banner = computed(() => {
  if (state.value === 'identical') {
    return {
      info: true,
      alert: false,
      head: 'Zero lines would change. Nothing is written.',
      body: `${name.value} proposed the body it already has — a no-op, not an edit.`,
    }
  }
  if (state.value === 'stale') {
    /* A create cannot go stale from a drift — it goes stale when somebody added
       the file first, which is the same answer: read it again, do not clobber. */
    if (isCreate.value) {
      return {
        info: false,
        alert: true,
        head: `${name.value}.md already exists in this workspace.`,
        body: 'This proposal would have created it. Nothing was written — pick another name, or edit the file that is there.',
      }
    }
    return {
      info: false,
      alert: true,
      head: `${name.value}.md changed since this was read.`,
      body: 'Applying now would overwrite a line nobody reviewed. Ask the run to prepare it again.',
    }
  }
  if (state.value === 'denied') {
    return {
      info: false,
      alert: true,
      head: 'This run may not write here.',
      body: `${cause.value || 'The verb refused before any body was read.'} Ask the run to prepare it again in the window that owns this workspace.`,
    }
  }
  if (state.value === 'failed') {
    return {
      info: false,
      alert: true,
      head: error.value || 'The write failed.',
      body: 'The file was not modified. Its mtime is unchanged and the diff is still valid.',
    }
  }
  if (state.value === 'large') {
    return {
      info: true,
      alert: true,
      head: `Above ${CAP} changed lines the card stops drawing a diff.`,
      body: `${changed.value} lines would change (${delta.value}). Open ${name.value} → Instructions to read it where the whole file fits, then come back.`,
    }
  }
  return null
})

/* Apply is absent, not disabled, wherever pressing it would be a lie. */
const applyHidden = computed(() => ['identical', 'denied', 'large'].includes(state.value))
/* Present but unreachable while the body is still being read or the file moved. */
const applyDisabled = computed(
  () => busy.value || !armed.value || ['loading', 'stale'].includes(state.value),
)

const primaryLabel = computed(() => {
  if (state.value === 'busy') return 'Applying…'
  if (state.value === 'failed') return 'Try again'
  return 'Apply'
})

const summary = computed(() => {
  if (isCreate.value && loaded.value) {
    const read = proposal.value || {}
    const where = String(read.dir || '~')
    const harness = String(read.harness || 'the default harness')
    return `${harness} · ${where} · ${briefLines.value} lines · frontmatter is new`
  }
  if (!loaded.value) {
    return state.value === 'loading'
      ? 'Reading the file to build the diff'
      : 'No diff exists — the verb failed before any body was read'
  }
  if (state.value === 'large') return `${changed.value} of ${totalLines.value} lines · over the cap`
  if (state.value === 'identical') return `0 of ${totalLines.value} lines · nothing would change`
  return `${changed.value} of ${totalLines.value} lines · frontmatter kept as is`
})

const settledLine = computed(() => {
  if (state.value === 'applied') {
    return {
      out: 'ok',
      head: `${name.value}.md written`,
      rest: isCreate.value ? 'added to the roster' : `${changed.value} lines changed · ${delta.value}`,
    }
  }
  return {
    out: 'none',
    head: 'Not applied',
    rest: isCreate.value ? `${name.value}.md was not created` : `${name.value}.md is unchanged`,
  }
})

/** The cell shade for one side of a row; `blank` is the empty half of an insert
    or a delete, which the narrow layout hides. */
function cellKind(row, side) {
  if (row.kind === 'same') return 'same'
  if (row.kind === 'change') return side === 'left' ? 'remove' : 'add'
  if (row.kind === 'remove') return side === 'left' ? 'remove' : 'blank'
  return side === 'left' ? 'blank' : 'add'
}

/** Colour is never the only signal: a changed cell says so in words too. */
function spokenPrefix(kind) {
  if (kind === 'remove') return 'Removed: '
  if (kind === 'add') return 'Added: '
  return ''
}

async function dismiss() {
  if (busy.value || settled.value) return
  phase.value = 'busy'
  /* The card leaves even when the answer is a no: a request already cleared
     elsewhere is the same outcome as clearing it here. */
  try {
    await dismissWriteRequest(props.workspace, props.request.id)
  } catch {
    /* nothing left to clear */
  }
  settledAt.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  phase.value = 'dismissed'
  emit('dismissed')
}

async function apply() {
  if (!armed.value || busy.value) return
  if (state.value !== 'pending' && state.value !== 'failed') return
  phase.value = 'busy'
  try {
    const result = await approveWriteRequest(props.workspace, props.request.id)
    settledAt.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    phase.value = 'applied'
    emit('applied', result)
  } catch (failure) {
    const code = String(failure?.code || '')
    const message = String(failure?.message || failure)
    /* The stamp is the whole mechanism: a file that moved is a conflict, and the
       diff is kept (dimmed) because "changed since you read it" without it is a
       dead end. */
    if (code === 'conflict' || /changed since/.test(message)) {
      phase.value = 'stale'
      return
    }
    /* A verb that refuses before any body is read has no diff and no Apply:
       one sentence of cause plus the one action that resolves it. */
    if (code === 'denied' || code === 'not_found' || code === 'invalid') {
      cause.value = message
      phase.value = 'denied'
      return
    }
    error.value = message
    phase.value = 'failed'
  }
}

async function copyBody() {
  /* A rewrite copies the proposal; a create copies the brief it would write. */
  const body = isCreate.value ? briefBody.value : proposal.value?.body
  if (!body) return
  const copied = await copyText(body)
  toast(copied ? 'Proposed instructions copied' : 'Could not copy to the clipboard')
}

async function copyPath() {
  const copied = await copyText(filePath.value)
  toast(copied ? 'The file path is on your clipboard' : 'Could not copy to the clipboard')
}

/* Only the card itself: a focused button fires its own click, and two writes from
   one keypress is the bug this guard exists for. */
function onEnter(event) {
  if (event.target !== rootEl.value) return
  apply()
}

useDialogDismiss({ active: () => !settled.value, close: dismiss, guard: () => busy.value })
</script>

<template>
  <div
    ref="rootEl"
    class="dw"
    :data-state="variant"
    role="group"
    :aria-label="`Pending write to ${name}.md instructions`"
    :aria-busy="busy ? 'true' : null"
    tabindex="-1"
    @keydown.enter="onEnter"
  >
    <!-- Settled: one line in the same slot, like the delegation hold. -->
    <template v-if="settled">
      <div class="dw-settled" :data-out="settledLine.out" role="status">
        <!-- The settled line is one line tall, so the person keeps a small mark
             to know whose file this was; larger and it is no longer one line. -->
        <EntityMark class="dw-mark dw-mark--settled" :entity="name" mini />
        <span class="dot" aria-hidden="true"></span>
        <span class="txt"><b>{{ settledLine.head }}</b> · {{ settledLine.rest }}</span>
        <span class="when">{{ settledAt }}</span>
      </div>
      <div class="dw-foot">
        <span class="dw-sum">
          audit <b>{{ isCreate ? 'entity.create' : 'entity.setInstructions' }}</b> ·
          {{ state === 'applied' ? 'applied by you' : 'not applied' }}
        </span>
        <span class="dw-acts">
          <button v-if="!isCreate" class="dw-lk" type="button" @click="showDiff = !showDiff">
            {{ showDiff ? 'Hide what changed' : 'Show what changed' }}
          </button>
          <button v-else class="dw-lk" type="button" @click="showDiff = !showDiff">
            {{ showDiff ? 'Hide the brief' : 'Show the brief' }}
          </button>
          <button class="dw-lk dw-copy" type="button" @click="copyBody">Copy body</button>
        </span>
      </div>
      <div v-if="showDiff && isCreate" class="dw-diff dw-brief" role="region" :aria-label="`The brief ${name}.md carries`">
        <pre class="dw-brief-body"><code>{{ briefBody }}</code></pre>
      </div>
      <div v-else-if="showDiff" class="dw-diff" role="table" :aria-label="`What changed in ${name}.md`">
        <div class="dw-diff-head" role="row">
          <span class="wide" role="columnheader">Current instructions</span>
          <span class="wide" role="columnheader">Proposed</span>
          <span class="narrow" role="columnheader">Proposed changes</span>
        </div>
        <div v-for="(row, index) in rows" :key="index" class="dw-row" role="row">
          <div class="dw-cell" :data-kind="cellKind(row, 'left')" role="cell">
            <span class="dw-no" aria-hidden="true">{{ row.leftNo }}</span>
            <code><span class="dw-sr">{{ spokenPrefix(cellKind(row, 'left')) }}</span>{{ row.left ?? '' }}</code>
          </div>
          <div class="dw-cell" :data-kind="cellKind(row, 'right')" role="cell">
            <span class="dw-no" aria-hidden="true">{{ row.rightNo }}</span>
            <code><span class="dw-sr">{{ spokenPrefix(cellKind(row, 'right')) }}</span>{{ row.right ?? '' }}</code>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="dw-head">
        <!-- The entity the card is *about*, as itself: the voxel character in its
             own shape, colour and mood badge, driven by the shared frame loop like
             every other mark. `animate` keeps the gaze and blink; a `mini` mark
             never animates. A create shows the new name's default mark — the same
             one the create dialog previews — because that file has no look yet. -->
        <EntityMark class="dw-mark" :entity="name" animate />
        <span class="dw-kick">{{ isCreate ? 'Create' : 'Write' }} · {{ name }}.md</span>
        <span class="dw-title">{{ title }}</span>
        <span class="dw-tag">{{ tag }}</span>
      </div>

      <p class="dw-meta">
        <span>@<b>{{ name }}</b></span>
        <i aria-hidden="true">·</i>
        <span>asked by <b>{{ request.requestedBy || name }}</b></span>
        <i v-if="askedAgo" aria-hidden="true">·</i>
        <span v-if="askedAgo">{{ askedAgo }}</span>
        <template v-if="!isCreate">
          <i aria-hidden="true">·</i>
          <span>read at <b>{{ stampBytes }}</b> bytes</span>
        </template>
        <template v-else-if="proposal">
          <i aria-hidden="true">·</i>
          <span>new file · <b>{{ proposal.harness || 'default harness' }}</b></span>
        </template>
      </p>

      <div
        v-if="banner"
        class="dw-banner"
        :class="{ 'dw-banner--info': banner.info }"
        :role="banner.alert ? 'alert' : null"
      >
        <svg v-if="banner.alert" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 1.6l4.6 8.2H1.4z" />
          <path d="M6 4.6v2.2M6 8.2v.1" />
        </svg>
        <svg v-else viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="6" cy="6" r="4.6" />
          <path d="M6 5.4v3M6 3.6v.1" />
        </svg>
        <span>
          <span class="t">{{ banner.head }}</span>
          <span class="s">{{ banner.body }}</span>
        </span>
      </div>

      <!-- A create has no delta to count: it states the fields the new file gets,
           which is the whole of what a person is agreeing to. -->
      <div v-if="isCreate && loaded" class="dw-count">
        <span class="dw-chip" data-kind="add"><b>{{ briefLines }}</b> lines</span>
        <span class="dw-chip"><b>{{ proposal?.harness || 'default' }}</b> harness</span>
        <span class="dw-chip" v-if="proposal?.dir"><b>{{ proposal.dir }}</b></span>
        <span class="dw-bytes">{{ size(briefBytes) }} new file</span>
      </div>
      <div v-else-if="loaded && state !== 'large' && state !== 'identical'" class="dw-count">
        <span class="dw-chip" data-kind="change"><b>{{ changed }}</b> changed</span>
        <span class="dw-chip" data-kind="add"><b>{{ added }}</b> added</span>
        <span class="dw-chip" data-kind="del"><b>{{ removed }}</b> removed</span>
        <span class="dw-chip"><b>{{ hunks }}</b> hunks</span>
        <span class="dw-bytes">{{ delta }}</span>
      </div>

      <!-- The skeleton keeps the table's own rhythm: a spinner over nothing is
           how a card teaches somebody to press Apply blind. -->
      <div v-if="state === 'loading'" class="dw-diff dw-skel" aria-hidden="true">
        <span class="sk"></span><span class="sk"></span><span class="sk"></span><span class="sk"></span>
      </div>

      <!-- A create shows the file it would add, whole: the brief is the thing a
           person is agreeing to, and there is no "before" to compare it to. -->
      <div
        v-else-if="isCreate && loaded && state !== 'large'"
        class="dw-diff dw-brief"
        :data-stale="state === 'stale' ? '1' : '0'"
        role="region"
        :aria-label="`The brief ${name}.md would carry`"
      >
        <pre class="dw-brief-body"><code>{{ briefBody }}</code></pre>
      </div>

      <div
        v-else-if="loaded && state !== 'large' && state !== 'identical'"
        class="dw-diff"
        :data-stale="state === 'stale' ? '1' : '0'"
        role="table"
        :aria-label="`Proposed changes to ${name}.md`"
      >
        <div class="dw-diff-head" role="row">
          <span class="wide" role="columnheader">Current instructions</span>
          <span class="wide" role="columnheader">Proposed</span>
          <span class="narrow" role="columnheader">Proposed changes</span>
        </div>
        <div v-for="(row, index) in rows" :key="index" class="dw-row" role="row">
          <div class="dw-cell" :data-kind="cellKind(row, 'left')" role="cell">
            <span class="dw-no" aria-hidden="true">{{ row.leftNo }}</span>
            <code><span class="dw-sr">{{ spokenPrefix(cellKind(row, 'left')) }}</span>{{ row.left ?? '' }}</code>
          </div>
          <div class="dw-cell" :data-kind="cellKind(row, 'right')" role="cell">
            <span class="dw-no" aria-hidden="true">{{ row.rightNo }}</span>
            <code><span class="dw-sr">{{ spokenPrefix(cellKind(row, 'right')) }}</span>{{ row.right ?? '' }}</code>
          </div>
        </div>
        <!-- The body caps at 244 px (see .dw-diff). The marker is sticky, so it
             rides the bottom edge of whatever is visible rather than pretending
             the file is short. ponytail: it is a hint, not a measurement — the
             upgrade path is to trim to the last hunk that fits and keep the rest
             behind Show. -->
        <div v-if="rows.length > FIT" class="dw-more">
          {{ totalLines }} rows · scroll for all {{ hunks }} hunks
        </div>
      </div>

      <!-- The target: the path that will be written, once, next to a copy. Only
           the directory shrinks so the filename always survives. -->
      <div v-if="loaded" class="dw-target" :title="filePath">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" />
          <path d="M1.8 5.8v-2h4" />
        </svg>
        <span class="p"><span class="dir">{{ dirPath }}</span><b>{{ name }}.md</b></span>
        <button class="dw-hit" type="button" @click="copyPath">Copy</button>
      </div>

      <div class="dw-foot">
        <span class="dw-sum">{{ summary }}</span>
        <span class="dw-acts">
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="dismiss">Not now</button>
          <button
            v-if="!applyHidden"
            class="btn btn-ink"
            type="button"
            :disabled="applyDisabled"
            @click="apply"
          >
            {{ primaryLabel }}
            <span v-if="state === 'failed'" class="btn-kbd" aria-hidden="true">↵</span>
          </button>
        </span>
      </div>
      <p class="dw-hint">
        Nothing is written until you apply.
        <span class="dw-esc"><kbd>{{ escKey }}</kbd> not now</span>
        <span v-if="state === 'failed'" class="dw-esc"><kbd>↵</kbd> try again</span>
      </p>
    </template>
  </div>
</template>
