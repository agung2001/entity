<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { heroColorFor } from '@/composables/entityMark'
import IntegrationMark from '@/components/IntegrationMark.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import McpServerView from '@/views/McpServerView.vue'
import {
  connectors,
  loadConnectors,
  probeConnectors,
  removeConnector,
  testConnector,
} from '@/stores/connectors'

/**
 * One connector's own page — the address every row of the Connectors roster
 * shares.
 *
 * An MCP server and a `cli` row are two kinds of one roster, so they are two
 * kinds of one address (`connectors/:id`); the route is not duplicated per kind.
 * This view picks the page from the row's `kind` and renders `McpServerView`
 * verbatim for an MCP server — it draws the transport, the tool list and the
 * `mcp.json` binding, and this page draws the fields a `cli`/`rest` row has.
 *
 * The switch is on `kind`, never on which route object the router matched: a
 * name both kinds could hold (`youtrack` is shipped as an MCP row, and a custom
 * `cli` row may take any id) must not depend on matcher order. It waits for the
 * roster to load, because `kind` is the only thing that can answer.
 *
 * The shape is the entity page's: a bar with the way back, a hero that says what
 * this is, then the fields the kind actually has. **No credential field for a
 * `cli` row** — that credential lives in the CLI's own store, and a box here that
 * pretended to hold it would be a lie about where it lives.
 */
const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id || ''))
const busy = ref('')
const error = ref('')
const notice = ref('')
/* What the probe actually saw: projects, an identity and its scopes. A count
   proves it is alive; the list proves it is the one you meant. */
const facts = ref([])
const reveal = ref(false)
const draft = ref({ host: '', token: '' })
const confirming = ref(false)

const row = computed(() => connectors.rows.find((entry) => entry.id === id.value) || null)
/* Which page this address is: the row's own kind. Only a *known* cli/rest row
   gets the smaller page — an unknown id stays on the MCP page, because that one
   already draws the states an unknown id can be in (`not attached · <harness>
   declares it`, `no definition`) and this page would report them as "no connector
   called that". Defaulting to the superset is what keeps those states reachable. */
const isCliPage = computed(() => Boolean(row.value) && row.value.kind !== 'mcp')
const isCli = computed(() => row.value?.kind === 'cli')
/* Reading the roster is the only way to know the kind, so this is the one thing
   worth waiting for — but only while the answer is still coming. A read that
   failed must fall through: `loaded` never turns true on an error, and gating on
   it alone leaves the page blank for as long as the call table is unhappy. */
const pending = computed(() => !connectors.loaded && !connectors.error)
const builtIn = computed(() => Boolean(row.value?.builtIn))
/* The same banner the MCP page opens with — one recipe, one derived colour, so a
   cli row and an mcp row read as two pages of one product instead of two
   generations of it. */
const heroColor = computed(() => heroColorFor(row.value?.id || id.value))
/* What the probe saw, once it has seen anything: `@login` and the scopes for a
   CLI, the projects for Orca. It is real probe output, never a count invented to
   fill the panel — with nothing probed the panel says so. */
const seen = computed(() => (Array.isArray(row.value?.samples) ? row.value.samples : []))
const seenTotal = computed(() =>
  Number.isFinite(row.value?.total) ? row.value.total : seen.value.length,
)
/* The shipped contract for this mention, or null when nothing resolves it. */
const work = computed(() => row.value?.work || null)
const searchKey = shortcutLabel('inventory-search')

const tone = computed(() => {
  const word = String(row.value?.status || '')
  if (/fail|missing|needs sign-in/i.test(word)) return 'fail'
  if (/unmanaged|untracked|parked|not probed|not set up/i.test(word)) return 'warn'
  if (/found|connected|in the pool|ok/i.test(word)) return 'ok'
  return 'off'
})

const fields = computed(() => {
  const entry = row.value
  if (!entry) return []
  const rows = [
    { k: 'kind', v: entry.kind },
    { k: 'scope', v: entry.scope === 'machine' ? 'machine — this computer only' : 'workspace — travels with the workspace' },
    { k: 'binding', v: entry.binding || '—' },
    { k: 'mention', v: entry.mention || 'not offered in the composer' },
    { k: 'origin', v: builtIn.value ? 'built in — the app ships this definition' : 'added in this workspace' },
    { k: 'status', v: entry.statusDetail ? `${entry.status} · ${entry.statusDetail}` : entry.status },
  ]
  return rows
})

async function load() {
  if (!connectors.loaded || connectors.workspace !== hub.workspace) await loadConnectors()
  draft.value = { host: row.value?.statusDetail || '', token: '' }
}

onMounted(async () => {
  await load()
  probeConnectors().catch(() => {})
})

const back = () => {
  hub.rail.connectors = true
  router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'connectors' } })
}

async function runTest() {
  if (!row.value || busy.value) return
  busy.value = 'test'
  error.value = ''
  notice.value = ''
  try {
    const answer = await testConnector({
      kind: row.value.kind,
      id: id.value,
      token: draft.value.token,
      host: draft.value.host,
      /* A shipped row is tested by the app's own code; a custom one runs the
         self-report its person declared. */
      verify: row.value.verify || null,
      binary: row.value.binary || '',
    })
    notice.value = answer?.detail || 'The connection answered.'
    facts.value = Array.isArray(answer?.samples) ? answer.samples : []
    await probeConnectors({ force: true })
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

async function later() {
  /* nothing to save yet beyond the definition the roster already holds: a token
     write is Batch C's `.secrets.json`, and promising it here would be a lie */
  notice.value = isCli.value
    ? 'Nothing to save: this row uses the binary on PATH and the CLI keeps its own sign-in.'
    : 'Token storage lands with the connector catalog; the definition itself is already saved.'
}

function remove() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  if (busy.value) return
  busy.value = 'remove'
  removeConnector(id.value)
    .then(() => {
      toast(`${row.value?.label || id.value} removed from this workspace.`)
      back()
    })
    .catch((problem) => {
      error.value = String(problem?.message || problem)
    })
    .finally(() => {
      busy.value = ''
    })
}

useDialogDismiss({ active: () => confirming.value, close: () => (confirming.value = false) })
</script>

<template>
  <!-- An MCP row is `McpServerView`'s page, drawn verbatim: it owns the transport,
       the tool list, the probe and the `mcp.json` binding. This view is a shell
       above it so the address can be one address. Waiting for the roster is what
       makes the first paint a spinner rather than the wrong page: `kind` is only
       known once the rows are read, and an MCP page bent into the cli shell (or
       the reverse) would flash for a frame and then repaint. -->
  <div v-if="pending" class="view detail-view">
    <section class="cpanel cpanel-empty">
      <div class="empty-note">
        <b>Reading this workspace's connectors…</b>
        <span>A connector's kind decides which page it gets, so this is the one thing worth waiting for.</span>
      </div>
    </section>
  </div>

  <McpServerView v-else-if="!isCliPage" />

  <div v-else class="view detail-view">
    <header class="entp-bar">
      <button class="back" type="button" title="Back to Connectors" @click="back">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M13 8H3.4M7.4 3.4L3 8l4.4 4.6" />
        </svg>
        Connectors
      </button>
      <span class="entp-crumb">{{ hub.workspaceLabel || hub.workspace }} · connector</span>
    </header>

    <div v-if="!row" class="empty-note">
      <b>No connector called “{{ id }}”.</b>
      <span>It may have been removed from this workspace.</span>
      <button class="btn" type="button" @click="back">Back to Connectors</button>
    </div>

    <template v-else>
      <section class="entp-hero cxn-hero" :style="{ '--hero': heroColor }">
        <PixelBackdrop variant="hero" :color="heroColor" :count="18" />
        <div class="entp-hero-inner">
          <header class="entp-idhead">
            <span class="cxn-hero-mark" aria-hidden="true">
              <IntegrationMark v-if="row.builtIn" :name="row.builtIn" :size="34" />
              <template v-else>{{ row.initial }}</template>
            </span>
            <div class="entp-title">
              <p class="eyebrow">{{ row.kind }} · {{ row.scope }} · {{ hub.workspaceLabel || hub.workspace }}</p>
              <h1>{{ row.label }}</h1>
              <p class="entp-desc">{{ row.binding || 'no binding recorded' }}</p>
              <div class="entp-chips">
                <span class="mcpp-chip" :data-tone="tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'fail' ? 'bad' : 'mute'">
                  <i aria-hidden="true"></i>{{ row.status }}
                  <span v-if="row.mention" class="mcpp-chip-note">{{ row.mention }}</span>
                </span>
                <span v-if="builtIn" class="entp-chip">built in</span>
                <span class="entp-chip">{{ row.kind === 'cli' ? 'local · cli' : 'remote · http' }}</span>
                <span class="entp-chip">every entity</span>
              </div>
            </div>
          </header>

          <!-- The MCP page's panel, on a CLI's facts: what the probe saw and how
               much of it. `samples` is the probe's own answer, so an unprobed row
               says so instead of printing a zero. -->
          <aside
            class="entp-xp"
            :title="`${seenTotal} ${row.samplesLabel || 'reported'} · ${row.status}`"
            :aria-label="`${seenTotal} ${row.samplesLabel || 'reported'}, ${row.status}, using ${row.binary || row.binding || 'its own binary'}`"
          >
            <div class="entp-lv">
              <span>{{ row.samplesLabel ? row.samplesLabel.slice(0, 6).toUpperCase() : 'SEEN' }}</span>
              <b>{{ seen.length ? seenTotal : '—' }}</b>
            </div>
            <div class="entp-xp-main">
              <div class="entp-xp-head">
                <span>{{ row.kind === 'cli' ? 'binary' : 'binding' }}</span>
                <b>{{ row.binary || row.binding || '—' }}</b>
              </div>
              <div class="entp-xp-track">
                <i :style="{ width: seen.length ? '100%' : '0%' }"></i>
              </div>
              <div class="entp-xp-foot">
                <span>{{ row.scope === 'machine' ? 'this machine' : 'this workspace' }}</span>
                <span>{{ tone === 'ok' ? 'answering' : 'not answering' }}</span>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <!-- Two columns, the MCP page's own split: what this connector *is* reads
           in the right column, and what you do with it — the mention, the
           sign-in, removing it — stays in the wide one, because those are the
           blocks with a control in them. The definition is the only card with no
           verb, so it is the only one that belongs on the right. -->
      <div class="cxn-page cxn-split">
        <div class="cxn-main">
          <section v-if="work" class="cxn-card cxn-work">
            <h2>In the chat</h2>
            <p class="cxn-work-lead">
              Type <code class="mono">{{ work.mention }}</code> and Entity resolves
              <strong>{{ work.resolves }}</strong> before the turn starts.
            </p>
            <dl class="cxn-facts">
              <dt>syntax</dt>
              <dd><code class="mono">{{ work.syntax }}</code></dd>
              <dt>returns</dt>
              <dd class="cxn-work-wrap">{{ work.returns }}</dd>
              <template v-if="work.needs">
                <dt>needs</dt>
                <dd>{{ work.needs }}</dd>
              </template>
              <template v-if="work.page">
                <dt>binding</dt>
                <dd><code class="mono">{{ work.page }}</code> — this connector's definition and token</dd>
              </template>
            </dl>
            <ul v-if="work.how?.length" class="cxn-how">
              <li v-for="line in work.how" :key="line">{{ line }}</li>
            </ul>

            <!-- Worked examples, each with what it turns into. A syntax alone is a
                 riddle; a syntax plus its result is a thing you can copy. -->
            <ul v-if="work.samples?.length" class="cxn-samples">
              <li v-for="sample in work.samples" :key="sample.code">
                <code class="mono">{{ sample.code }}</code>
                <span class="cxn-sample-then">{{ sample.then }}</span>
              </li>
            </ul>
            <ul v-else class="cxn-work-eg">
              <li v-for="example in work.examples" :key="example">
                <code class="mono">{{ example }}</code>
              </li>
            </ul>
            <p class="cxn-note">
              Resolved by Entity's <code class="mono">{{ work.resolver }}</code> resolver — the
              same one the composer offers, so this row cannot promise a mention that fails.
            </p>
          </section>

          <section v-else class="cxn-card">
            <h2>In the chat</h2>
            <p class="cxn-note">
              No resolver is shipped for this connector, so there is no
              <code class="mono">@{{ row.id }}:</code> form. A mention attaches this
              connector's definition and status as context, and the entity uses its own
              tools.
            </p>
          </section>

          <section class="cxn-card">
            <h2>{{ isCli ? 'Sign-in' : 'Endpoint and token' }}</h2>
            <template v-if="isCli">
              <p class="cxn-note">
                This row's credential belongs to the CLI's own store on this machine. Signing in
                happens in the CLI, never here.
              </p>
              <p v-if="row.verify" class="cxn-note">
                Verified by <code class="mono">{{ row.binary || row.id }} {{ row.verify.argv.join(' ') }}</code>
                — exit {{ row.verify.okExit }} means usable.
              </p>
              <p v-else class="cxn-note">
                No verify command is declared, so there is nothing to ask it. Add one when you add
                the connector.
              </p>
              <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="runTest">
                {{ busy === 'test' ? 'Asking…' : 'Test connection' }}
              </button>
            </template>
            <template v-else>
              <div class="cxn-fields">
                <label>
                  base URL
                  <input v-model="draft.host" type="text" placeholder="https://…" autocomplete="off" spellcheck="false" />
                </label>
                <label>
                  token
                  <input
                    v-model="draft.token"
                    :type="reveal ? 'text' : 'password'"
                    placeholder="verified before it is saved"
                    autocomplete="off"
                  />
                </label>
              </div>
              <div class="cxn-acts">
                <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="runTest">
                  {{ busy === 'test' ? 'Testing…' : 'Test connection' }}
                </button>
                <button class="btn btn-sm" type="button" @click="reveal = !reveal">
                  {{ reveal ? 'Hide token' : 'Show token' }}
                </button>
                <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="later">Save</button>
              </div>
              <p class="cxn-note">
                A rejected credential rolls back — nothing is written. Definitions travel with the
                workspace; tokens stay on this machine.
              </p>
            </template>
            <div v-if="error" class="cxn-error" role="alert">{{ error }}</div>
            <div v-else-if="notice" class="cxn-ok" role="status">
              <div>
                <b>{{ notice }}</b>
                <ul v-if="facts.length" class="cxn-facts-list">
                  <li v-for="fact in facts" :key="fact"><code class="mono">{{ fact }}</code></li>
                </ul>
              </div>
            </div>
          </section>

          <section class="cxn-card cxn-danger">
            <h2>Remove</h2>
            <p class="cxn-note">
              Takes the connector out of this workspace. A credential held by the CLI or by
              <code class="mono">mcp.json</code> stays where it is.
            </p>
            <button class="btn btn-sm btn-danger" type="button" :disabled="Boolean(busy)" @click="remove">
              {{ confirming ? 'Remove for good?' : 'Remove connector' }}
            </button>
          </section>
        </div>

        <section class="cxn-card cxn-rail cxn-def">
          <h2>Definition</h2>
          <dl class="cxn-facts">
            <template v-for="field in fields" :key="field.k">
              <dt>{{ field.k }}</dt>
              <dd :title="String(field.v)">{{ field.v }}</dd>
            </template>
          </dl>
        </section>
      </div>
    </template>
  </div>
</template>
