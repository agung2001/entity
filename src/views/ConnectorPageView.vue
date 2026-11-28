<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { heroColorFor } from '@/composables/entityMark'
import IntegrationMark from '@/components/IntegrationMark.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import McpServerView from '@/views/McpServerView.vue'
import ConnectorAccountsCard from '@/components/ConnectorAccountsCard.vue'
import ConnectorGithubAccounts from '@/connectors/github/AccountsCard.vue'
import { call } from '@/composables/localBridge'
import { github } from '@/connectors/github/useGithub'
import { dropLynkAnswer } from '@/connectors/lynk/useLynk'
import { openFolderPicker } from '@/connectors/lynk/useReportCard'
import { afterKeySaved, tokenScope } from '@/connectors/clockify/useClockify'
import { habitify, readDashboard as readHabitifyDashboard } from '@/connectors/habitify/useHabitify'
import ClockifyWorkspaceCard from '@/connectors/clockify/WorkspaceCard.vue'
import ConnectorDashboardPane from '@/connectors/ConnectorDashboardPane.vue'
import LynkReportCard from '@/connectors/lynk/ReportCard.vue'
import TailscalePanel from '@/connectors/tailscale/TailscalePanel.vue'
import BinaryPathCard from '@/connectors/parts/BinaryPathCard.vue'
import {
  answerGate,
  dashboardHint as hintFor,
  dashboardKind,
  gateFor,
  paneShown,
  readPane,
} from '@/connectors/dashboards'
import {
  connectors,
  installConnector,
  loadConnectors,
  loadLynkConfig,
  lynkConfig,
  probeConnectors,
  providerOf,
  removeConnector,
  testConnector,
  uninstallConnector,
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

/* The installed row, or — when this workspace has none — the catalog's own entry
   for it. Reading a pitch before installing is the whole point of the Built-in
   pane: `connector.available` is the same catalog row the sheet draws, marked
   `installed: false`, and without this fallback its address reported "no
   connector called that" and sent a person back to the list they came from. */
const installedRow = computed(() => connectors.rows.find((entry) => entry.id === id.value) || null)
const catalogRow = computed(() => connectors.available.find((entry) => entry.id === id.value) || null)
const row = computed(() => installedRow.value || catalogRow.value)
/* Not installed, and it *could* be: the one fact that changes which verbs this
   page offers. A custom row that was removed lands here with no catalog entry
   and is therefore not reinstatable — the `!row` note below covers it. */
const notInstalled = computed(() => !installedRow.value && Boolean(catalogRow.value))
/* The catalog's provider is on the entry; the installed row does not carry it, so
   the account card's provider is read from the row the catalog answered. */
const rowProvider = computed(() => String(catalogRow.value?.provider || ''))
/* Which page this address is: the row's own kind. Only a *known* cli/rest row
   gets the smaller page — an unknown id stays on the MCP page, because that one
   already draws the states an unknown id can be in (`not attached · <harness>
   declares it`, `no definition`) and this page would report them as "no connector
   called that". Defaulting to the superset is what keeps those states reachable. */
const isCliPage = computed(() => Boolean(row.value) && row.value.kind !== 'mcp')
const isCli = computed(() => row.value?.kind === 'cli')
/* An account-bearing connector: a `rest` row whose credential is one refresh
   token per account, on this machine. It is the only kind with an Accounts card. */
const isOAuth = computed(() => row.value?.kind === 'rest' && row.value?.oauth === true)
/* A connector whose whole credential is one pasted API key: the endpoint lives in
   the connector's own `verify()`, so the page asks for the key and nothing else.
   The card heading follows, or it would sell an "endpoint" field it does not show. */
const isTokenKey = computed(() => row.value?.credential === 'token')
/* A feed is an address and a ceiling — no token to paste, no account to sign in to.
   Its own card, because every field the generic one draws would be a lie here: a
   token box for a credentialless read, and a Save verb behind a definition the
   roster already holds. */
const isFeed = computed(() => row.value?.kind === 'rss')
const feedUrl = computed(() => String(row.value?.url || ''))
/* The fourth kind has no credential to ask for and no mention to resolve, so every
   card on the generic page would say something untrue about it: a pitch selling an
   install, a sign-in that lives in the CLI, a mention the composer does not offer.
   Its page body is `TailscalePanel`, and the cards below stand down for it. */
const isTailscale = computed(() => id.value === 'tailscale')
/* The two `cli` rows this app may have to be *told* about: a desktop app with its
   own installer, and a package manager's binary that an app launched from Finder
   never inherited. One card owns that field for both (`BinaryPathCard`), and each
   connector's resolver reads its own file — `~/.entity/orca.json`, `gh.json`. */
const isOrca = computed(() => id.value === 'orca')
/* A binary worth naming, and the calls its card answers: the connector id is the
   prefix, so a third one is a line here rather than a second component. */
const binaryRow = computed(() => {
  if (isOrca.value) return { fn: 'orca', environment: 'ENTITY_ORCA_BIN' }
  if (id.value === 'github') return { fn: 'github', environment: 'ENTITY_GH_BIN' }
  return null
})
/* Lynk.id's own settings card is the folder and the marketplace document, and both
   are read off this connector's row. Two templates below gate on this name —
   `LynkReportCard` and the "what it resolves" card — and it was never declared, so
   `v-if="isLynk"` was `v-if="undefined"` and the settings card could not appear on
   the page that was supposed to hold it. A missing binding is not a compile error in
   a template; it is an invisible feature. */
const isLynk = computed(() => id.value === 'lynk')
/* The panel's own read, published upward. The hero states the same three facts the
   cards below it do, and a second `tailscale status --json` would let the two
   disagree. `null` means "still reading" — never a zero (DESIGN.md:118). */
const tsRead = ref(null)
const tsTone = computed(() => (tsRead.value?.tone === 'ok' ? 'ok' : tsRead.value?.tone === 'fail' ? 'bad' : 'mute'))

/* A `cli` row's accounts are the CLI's own sign-ins — read from `gh auth status`,
   never written here, and never a token field. GitHub is the only such row this
   app ships. */
const isGithubCli = computed(() => isCli.value && row.value?.builtIn === 'github')
/* The binary line the read-only card prints: `gh <version> · <path>`. The status
   read answers the path and never a version, so an unknown part is left out
   rather than invented — and a binary nobody found is the whole `—`. */
const ghBinary = computed(() => {
  const { found, path, version } = github.binary || {}
  if (!found || !path) return '—'
  return `gh${version ? ` ${version}` : ''} · ${path}`
})

/* ── the accounts card ─────────────────────────────────────────────────
   The card is its own component (`ConnectorAccountsCard`); the page keeps only what
   the page needs from it — the aggregate fact for the Definition rail. */
const accountsCard = ref(null)
const accountsFact = ref('no account connected')
/**
 * A sign-in, a reauthorize or a removal landed on the accounts card.
 *
 * The card holds no dashboard state, so this is the one place that knows an
 * account list changed — and every gate on this page is made of an account list.
 * Re-reading it **here**, with `force`, is the fix for the bug where a completed
 * authentication left the page unchanged until a manual reload: the gate used to
 * be answered once on mount, so a card that signed somebody in afterwards changed
 * a lock nobody recomputed. The tab now lifts under the strip in place, and a
 * Dashboard that is already open is asked for again because its answer is one the
 * new account produces differently.
 */
const onAccountsChanged = async () => {
  accountsFact.value = accountsCard.value?.accountsFact() || 'no account connected'
  const kind = dashKind.value
  if (!kind) return
  await answerGate(kind, { id: id.value, force: true })
  if (tab.value === 'dashboard' && !gate.value.locked) await readPane(kind, { day: day.value, force: true })
}

/* The provider a connector authenticates against, from the provider table in main
   — never re-derived from the id here, where it would drift the moment a second
   provider is added. */
const provider = ref('google')
watch(id, async () => {
  /* A catalog entry that names its provider answers without a round-trip; only an
     installed row the catalog does not ship (`oauth: true`, no entry) needs the
     call table's answer. */
  if (rowProvider.value) {
    provider.value = rowProvider.value
    return
  }
  try {
    provider.value = await providerOf(id.value)
  } catch {
    provider.value = 'google'
  }
}, { immediate: true })

/* Reading the roster is the only way to know the kind, so this is the one thing
   worth waiting for — but only while the answer is still coming. A read that
   failed must fall through: `loaded` never turns true on an error, and gating on
   it alone leaves the page blank for as long as the call table is unhappy. */
const pending = computed(() => !connectors.loaded && !connectors.error)
/* A catalog row's `provider` lands after the roster read, so the watch above runs
   once more when it arrives. */
watch(rowProvider, (next) => {
  if (next) provider.value = next
})
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

/* The service's own site, as a host — the same short label the MCP page uses. */
const websiteLabel = computed(() => {
  try {
    return new URL(row.value?.website || '').host.replace(/^www\./, '')
  } catch {
    return row.value?.website || ''
  }
})

/**
 * Where this kind's credential lives, in the one sentence that stops a person
 * looking for a token box that will never exist.
 *
 * Read from the same facts `bindingFor` writes on the installed row, so the pitch
 * cannot promise a different home from the one the binding reports afterwards.
 */
const credentialWhere = computed(() => {
  const entry = row.value
  if (!entry) return ''
  if (entry.kind === 'mcp') return 'in mcp.json — the definition travels with the workspace, a token in it does not'
  if (entry.kind === 'cli') return "in the CLI's own store on this machine — Entity never holds it"
  /* A feed is a URL and nothing else: there is no credential to hold, which is
     the whole reason `news-store` can fetch it without a secret. */
  if (entry.kind === 'rss') return 'nowhere — a feed URL needs no credential'
  if (entry.oauth) return 'on this machine, as a credential you grant per account; never in the workspace'
  if (entry.credential === 'token') return 'on this machine, as one API key you paste once; never in the workspace'
  return 'on this machine'
})

const tone = computed(() => {
  const word = String(row.value?.status || '')
  if (/fail|missing|needs sign-in/i.test(word)) return 'fail'
  if (/unmanaged|untracked|parked|not probed|not set up|not installed/i.test(word)) return 'warn'
  /* `installed` is a feed's whole status word: it is not probed and never will be,
     so it matched neither list and fell to `off` — the hero then said "not
     answering" about a row the Definition card calls `installed · a feed URL · read
     by News`. The warn branch above takes `not installed` first, so this cannot
     catch an entry nobody installed. */
  if (/found|connected|in the pool|ok|installed/i.test(word)) return 'ok'
  return 'off'
})

const fields = computed(() => {
  const entry = row.value
  if (!entry) return []
  /* An entry nobody installed has no binding yet, and printing the catalog's
     sentence in a `binding` slot would read as if one existed. The pitch says where
     the credential *would* live, in prose, in the card above. */
  const rows = []
  /* The rail is the page's definition, and this connector's definition is what it
     reads, what it runs and what that binds — not a `binding` file, of which it has
     none. `<port>` rather than a number: the field above is where the number lives. */
  if (isTailscale.value) {
    return [
      { k: 'kind', v: 'cli · this machine' },
      { k: 'reads', v: 'tailscale status --json', mono: true },
      /* Two shapes, one row: a checkout runs the repo's Vite, a packaged app
         serves its own build. The panel read `mode` off the daemon read, so the
         rail and the card cannot disagree about what Start will do. */
      tsRead.value?.mode === 'build'
        ? { k: 'serves', v: "this app's own build", mono: true }
        : { k: 'runs', v: 'npm run dev:lan', mono: true },
      { k: 'binds', v: '0.0.0.0:<port>', mono: true },
      { k: 'requires', v: 'Tailscale running' },
      { k: 'for', v: 'every entity · this workspace' },
    ]
  }
  if (notInstalled.value) {
    rows.push(
      { k: 'kind', v: entry.kind },
      { k: 'ships with', v: 'the app — nothing to download' },
      { k: 'installs into', v: 'this workspace, when you press Install' },
    )
    return rows
  }
  rows.push(
    { k: 'kind', v: entry.kind },
    { k: 'scope', v: entry.scope === 'machine' ? 'machine — this computer only' : 'workspace — travels with the workspace' },
    { k: 'binding', v: entry.binding || '—' },
  )
  /* An account-bearing connector binds through a consent, not a file, and its
     account count is a fact of the connector, not of a folder (frame C). */
  /* Only an installed row has accounts; a pitch says what it *would* need instead
     of an empty count. */
  if (isOAuth.value && !notInstalled.value) rows.push({ k: 'accounts', v: accountsFact.value })
  rows.push(
    { k: 'mention', v: entry.mention || 'not offered in the composer' },
    { k: 'origin', v: builtIn.value ? 'built in — the app ships this definition' : 'added in this workspace' },
    {
      k: 'status',
      v: entry.statusDetail ? `${entry.status} · ${entry.statusDetail}` : entry.status,
    },
  )
  return rows
})

async function load() {
  if (!connectors.loaded || connectors.workspace !== hub.workspace) await loadConnectors()
  draft.value = { host: row.value?.statusDetail || '', token: '' }
}

/* ── the tabs ────────────────────────────────────────────────────────
   The strip exists only for the connectors this app ships a dashboard for, and the
   list of them is `dashboardKind()` in `connectors/dashboards` — not a sentence
   here that has to be kept in step with it. A tab that led to another connector's
   half-built dashboard would be a promise nobody kept, so every other row — including
   a custom `cli` row, or a custom row that borrowed a shipped name — gets no tab at
   all rather than a disabled one.

   The two tabs live in the address: `?tab=dashboard` is a place a person can
   bookmark, and the bare address / `?tab=overview` drops the parameter rather than
   spelling the default out. `SkillsView` set the precedent for the guard. */
const TABS = ['overview', 'dashboard']
const tab = computed(() =>
  TABS.includes(String(route.query.tab)) ? String(route.query.tab) : 'overview',
)
/* Which dashboard this page is, if any — asked in one place, `connectors/dashboards`,
   because the strip, the gate and the pane body have to agree about it and three
   copies of that answer is three ways to disagree. */
const dashKind = computed(() => dashboardKind(installedRow.value, connectors.rows))
/* Which shipped rows have a second tab. One list — `dashKind` — because the strip,
   the gate and the body must agree about it: a row that shipped a report but is not
   named there would draw a Dashboard it cannot fill. */
const dashboardTab = computed(() => Boolean(dashKind.value))
/* The day is part of the address for the same reason the tab is: `?tab=dashboard&day=`
   is a place a person can send somebody. Anything that is not a civil date is not a
   day, so it falls back to the main process's "today" rather than being forwarded. */
const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = computed(() => (DAY.test(String(route.query.day || '')) ? String(route.query.day) : ''))
/* Fitbit's second spelling of a day: its strip offers Yesterday, and the word has
   to keep meaning yesterday next week — so it travels as a word, exactly as the
   absent value travels as "today". */
const fitbitDay = computed(() => {
  const raw = String(route.query.day || '')
  return raw === 'yesterday' || DAY.test(raw) ? raw : ''
})
/* What the tab offers, in the connector's own words — the hint is the dashboard's
   own copy too, so it travels with the rest of that connector's knowledge. */
const dashboardHint = computed(() => hintFor(dashKind.value))

/* What the token store answered for a `credential: 'token'` row: whether a key is on
   this machine and the four characters that say which one. Its own read because the
   card that replaces the key needs it whether or not that row has a dashboard. */
const storedKey = ref({ configured: false, hint: '' })
async function readStoredKey() {
  if (row.value?.credential !== 'token') return
  try {
    const answer = await call('connector.token.status', { connector: id.value })
    storedKey.value = { configured: Boolean(answer?.configured), hint: String(answer?.hint || '') }
  } catch {
    /* Unreadable reads as no key: the card then offers the field instead of
       claiming a key it could not confirm. */
    storedKey.value = { configured: false, hint: '' }
  }
}

/* Clockify's key and workspace, the calendar's account list, GitHub's `gh` logins,
   the channel roster, Habitify's consent, Fitbit's roster and Lynk.id's folder: every
   gate this page can meet lives in `connectors/dashboards`, beside the read that
   answers it. The page asks one question — "may this tab open?" — and holds none of
   the answers, which is what stopped it growing a fourth `if` per connector. */

/* One shape for every lock, whichever way it was written: the dashboard's own
   module picks it, and `opens` stays the folder lock's own answer — the one lock on
   this page whose fix is a control here rather than a card on Overview. */
const gate = computed(() => gateFor(dashKind.value, installedRow.value))
const lock = computed(() => (gate.value.locked ? gate.value.why : null))
/* Both tabs are always present in the tablist; a locked Dashboard still takes
   focus, because the reason under the strip is the thing to read and a
   `disabled` attribute would make it unreachable by keyboard. */
const canOpen = (name) => name === 'overview' || !gate.value.locked
/* Whether the Dashboard tab's body is in the document at all — asked of the
   dashboard's own module, because *which* connector gates its render is that
   connector's rule, not the router's. */
const dashboardShown = computed(() =>
  paneShown(dashKind.value, { tab: tab.value, locked: Boolean(lock.value) }),
)
/* Which pane the Dashboard tab actually controls, and it is not always its own.
   The two bodies whose lock is part of their `v-if` — Fitbit's and Lynk.id's — fall
   through to the Overview pane while locked, so `aria-controls` names the id that is
   in the document rather than the one the tab would have drawn. Derived from the
   same boolean the body is mounted on, so the two cannot disagree. */
const dashboardPane = computed(() => (dashboardShown.value ? 'cxn-pane-dashboard' : 'cxn-pane-overview'))

function select(name) {
  if (name === 'dashboard' && gate.value.locked) {
    /* Activating a locked tab does not switch it. A tab waiting for a folder is
       the one case with an action behind it, so it opens the picker where that
       connector's card lives; the others focus the sentence that says where to
       fix it. */
    if (gate.value.opens === 'picker') openFolderPicker()
    else document.getElementById('cxn-tab-why')?.focus?.()
    return
  }
  const query = { ...route.query }
  if (name === 'overview') {
    delete query.tab
    /* The day belongs to the tab: a bare Overview address is the whole place, and
       leaving `?day=` on it would keep a parameter nothing on screen reads. */
    delete query.day
  } else query.tab = name
  /* `replace`, not `push`: switching a tab is not a step in a history a person
     wants to walk back through one press at a time. */
  router.replace({ query })
}
/* A day picked in the tab is a different address, and the tab's own read follows it:
   the address is what the read is keyed on, so going through it keeps a reload and a
   shared link asking for the same day rather than whichever one was read last. */
function selectDay({ day: wanted = '', force = false } = {}) {
  const query = { ...route.query, tab: 'dashboard' }
  if (DAY.test(String(wanted))) query.day = wanted
  else delete query.day
  router.replace({ query }).catch(() => {})
  /* `force` is Refresh: the same day, asked again, past the day-long cache. */
  if (force || wanted !== habitify.day) readHabitifyDashboard({ day: wanted, force }).catch(() => {})
}
/* Fitbit's chips and date field ask for a day; the address answers and the pane
   reads it, so a reload or a shared link asks for the same day. `today` is the
   absence of the parameter, because that is where a bookmark should land tomorrow. */
function pickFitbitDay(value) {
  const next = String(value || '')
  const query = { ...route.query, tab: 'dashboard' }
  if (next === '' || next === 'today') delete query.day
  else if (next === 'yesterday' || DAY.test(next)) query.day = next
  else return
  router.replace({ query }).catch(() => {})
}
/* The address spells the default out as little as possible: a bare address and
   `?tab=overview` are the same place, and a value nobody defined is not a place at
   all — both end up with no `tab` parameter at all. Only a load that actually
   carries a stray `tab` pays for the rewrite, so `?tab=dashboard` never touches
   the address it was given. */
function normalizeTab() {
  const query = { ...route.query }
  let touched = false
  if (query.tab !== undefined && String(query.tab) !== 'dashboard') {
    delete query.tab
    touched = true
  }
  /* `day` is only a place when the dashboard is the tab on screen and the value is
     one a dashboard defines: a stray day would otherwise ride along on a page that
     reads nothing with it. */
  if (query.day !== undefined && (query.tab !== 'dashboard' || !(fitbitDay.value || day.value))) {
    delete query.day
    touched = true
  }
  if (touched) router.replace({ query }).catch(() => {})
}
/* Roving tabindex, the pattern `SkillsView`'s strip already uses: one stop for the
   whole strip, and the arrows walk it. A locked tab is the exception — it keeps
   `tabindex="0"` so the reason under the strip is reachable by Tab, which is what
   `aria-disabled` is for. */
function onTabKey(event) {
  const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
  if (delta === undefined) return
  event.preventDefault()
  const next = TABS[(TABS.indexOf(tab.value) + delta + TABS.length) % TABS.length]
  /* A locked tab still takes the arrow: one press has to reach the reason line, and
     a strip where the arrow key silently stops at the first button reads as broken.
     Focus only — no `select()`, so the address does not change and nothing reads
     until the person presses Enter on it. */
  if (!canOpen(next)) {
    document.getElementById(`cxn-tab-${next}`)?.focus?.()
    return
  }
  select(next)
  /* The strip is a roving tabindex: the selected tab is the one stop. Moving the
     selection without moving focus would leave it on a button that has just become
     `-1`, so the next Tab would skip the strip entirely. */
  document.getElementById(`cxn-tab-${next}`)?.focus?.()
}

/**
 * Answer this dashboard's gate, and read its pane if that is the tab on screen.
 *
 * Two reads, not seven: the gate comes from the dashboard's own module and the
 * numbers from the pane that draws them (`readPane`). Both are asked for by *kind*,
 * so a new connector is a row in one table rather than a branch here — and the same
 * two calls are what the accounts card runs after a sign-in, which is why a
 * completed authentication no longer needs a reload to show its dashboard.
 */
async function openDashboard() {
  const kind = dashKind.value
  if (!kind) return
  await answerGate(kind, { id: id.value })
  /* A locked tab is not a place, and `select()` already refuses one — a deep link
     has to reach the same conclusion, or `?tab=dashboard` would land on a pane that
     has nothing it may read. */
  if (tab.value === 'dashboard' && gate.value.locked) {
    select('overview')
    return
  }
  if (tab.value === 'dashboard') await readPane(kind, { day: day.value })
}

onMounted(async () => {
  normalizeTab()
  await load()
  probeConnectors().catch(() => {})
  /* The stored key comes first: it is half of the gate under the strip and the
     whole of the sentence on the card that can replace it. */
  await readStoredKey()
  /* A feed's ceiling is its only setting, and a card that opened on a default would
     invite somebody to "save" a number that was never theirs. */
  await readFeedLimit()
  /* The gate is answered by `gh`, the token store or the account store, so it is
     asked once the row is known: reading it on every connector's page would run a
     CLI, open a key file or read a keyring for a tab that cannot exist. */
  if (dashboardTab.value) await openDashboard()
})
/* A deep link straight to the tab, a tab click, or a connector installed on this
   page crossing the tab into existence: the strip rendered before the gate answered,
   so the read has to wait for it rather than run against a lock it does not know
   about yet. One watcher, because `openDashboard` is the whole of "answer the gate,
   then read the pane". */
watch(
  () => [tab.value, dashKind.value, dashboardTab.value],
  async () => {
    if (!dashKind.value) return
    await openDashboard()
  },
)
/* A day in the address that this renderer has not read yet — a link followed, or a
   reload — is read here rather than left showing the day before it. */
watch(day, (next) => {
  if (dashKind.value !== 'habitify' || tab.value !== 'dashboard' || lock.value) return
  if (next && next !== habitify.day) readPane('habitify', { day: next }).catch(() => {})
})
/*
 * The gate itself, watched once instead of six times.
 *
 * Every one of the old watchers was a variation on the same sentence: a grant,
 * a key, a roster or a folder changed, so the tab must close if it just became
 * locked and re-ask if it just became open. They differed only in which field of
 * which connector they watched — which is exactly the per-connector knowledge that
 * now lives in `connectors/dashboards`. `gate` is the one value all of them
 * derive, so it is the one value worth watching, and a seventh connector gets this
 * for free.
 *
 * Only a transition counts: an unread state answers "not locked", so a page whose
 * gate has not arrived cannot close a deep link before its accounts answer.
 */
watch(
  () => gate.value.locked,
  async (locked, was) => {
    if (was === undefined || locked === was) return
    if (tab.value !== 'dashboard') return
    if (locked) {
      select('overview')
      return
    }
    /* The gate just opened under an open tab: a sign-in, a reauthorize or a folder
       picked means the numbers on screen are not the ones this tab would read now,
       so they are asked for again instead of waiting for the next page load. */
    await readPane(dashKind.value, { day: day.value, force: true })
  },
)
/*
 * The folder whose rows were read is no longer the folder being read, so the
 * numbers on screen belong to somebody else's folder. Dropping the answer is what
 * turns that into a skeleton and a real read; leaving `readAt` alone is what left
 * the previous folder's revenue under the new folder's name.
 */
watch(
  /* The marketplace URL is in here with the folder: every row's landing link is
     resolved against it, so changing it dates the answer on screen exactly as
     changing the folder does. */
  () => [lynkConfig.folderId, lynkConfig.sheetSuffix, lynkConfig.marketplaceUrl],
  ([nextFolder, nextSuffix, nextMarket], [wasFolder, wasSuffix, wasMarket]) => {
    if (nextFolder === wasFolder && nextSuffix === wasSuffix && nextMarket === wasMarket) return
    if (installedRow.value?.builtIn !== 'lynk') return
    dropLynkAnswer()
    if (tab.value === 'dashboard' && !gate.value.locked) readPane('lynk')
  },
)

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
    /* A paste-once key has its own check, and it is the connector's: `verify()` is
       the only code that knows which call proves this service's key, and the
       generic path would write to a store this row does not use. */
    if (row.value.credential === 'token') {
      const answer = await call('connector.token.test', {
        connector: id.value,
        token: draft.value.token,
        ...tokenScope(id.value),
      })
      notice.value = answer?.detail || 'The service accepted this key.'
      facts.value = []
      await readStoredKey()
      return
    }
    const answer = await testConnector({
      kind: row.value.kind,
      id: id.value,
      token: draft.value.token,
      host: draft.value.host,
      /* A feed's address is the row's own `url`, not the base-URL draft — that
         draft exists for a REST endpoint and a feed has no other spelling. */
      url: isFeed.value ? feedUrl.value : '',
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

/* ── the feed: its address and its ceiling ────────────────────────────
   Both are the row's own state, read and written through the same plain pair
   Clockify's workspace and Lynk.id's folder use — no vault, because neither is a
   secret, and no token verb, because a feed has no credential to check.

   The **address is editable** because a shipped feed is a shape, not a country:
   Google Trends is `?geo=` and Reddit is `/r/<name>/`, so `?geo=US` and
   `/r/worldnews/` are the same connector pointed somewhere else. `setFields`
   checks the scheme and moves `url` and `binding` together. */
const feedDraft = ref('')
const itemLimit = ref(100)

async function readFeedLimit() {
  if (!isFeed.value) return
  feedDraft.value = feedUrl.value
  try {
    const answer = await call('connector.fields', { workspace: hub.workspace, id: id.value })
    /* The main process always answers this key (`fieldsOf` defaults it), so the
       fallback only covers a read that failed — and it is the ceiling a new feed
       gets, never a zero a person would read as "no items". */
    itemLimit.value = Number(answer?.itemLimit) || 100
  } catch {
    itemLimit.value = 100
  }
}

/**
 * Save the address. `connector.setFields` refuses anything but http(s) with a
 * sentence, and the roster is re-read afterwards so the URL, the Definition card's
 * binding and this page all print the one that is stored — not the one somebody
 * typed hopefully.
 */
async function saveFeedUrl() {
  if (!isFeed.value || busy.value) return
  const next = String(feedDraft.value || '').trim()
  if (!next || next === feedUrl.value) {
    feedDraft.value = feedUrl.value
    return
  }
  busy.value = 'url'
  error.value = ''
  notice.value = ''
  try {
    await call('connector.setFields', { workspace: hub.workspace, id: id.value, fields: { url: next } })
    await loadConnectors()
    feedDraft.value = feedUrl.value
    notice.value = `Saved — this feed reads ${feedUrl.value} on its next read.`
  } catch (problem) {
    error.value = String(problem?.message || problem)
    feedDraft.value = feedUrl.value
  } finally {
    busy.value = ''
  }
}

/**
 * Save the ceiling. `connector.setFields` is the only writer, and it refuses a value
 * outside 1..500 with a sentence — that refusal is shown as it came, and the field is
 * put back to what is stored rather than left claiming a number nobody saved.
 */
async function saveFeedLimit() {
  if (!isFeed.value || busy.value) return
  busy.value = 'limit'
  error.value = ''
  notice.value = ''
  try {
    const answer = await call('connector.setFields', {
      workspace: hub.workspace,
      id: id.value,
      fields: { itemLimit: Number(itemLimit.value) },
    })
    itemLimit.value = Number(answer?.itemLimit) || itemLimit.value
    notice.value = `Saved — one read carries up to ${itemLimit.value} items from this feed.`
  } catch (problem) {
    error.value = String(problem?.message || problem)
    await readFeedLimit()
  } finally {
    busy.value = ''
  }
}

async function later() {
  /* A `credential: 'token'` row has a real write behind Save, so it goes to the
     token verbs. Every other row has only its definition, which the roster already
     holds — promising more here would be a lie. */
  if (row.value?.credential === 'token') return saveKey()
  notice.value = isCli.value
    ? 'Nothing to save: this row uses the binary on PATH and the CLI keeps its own sign-in.'
    : 'Token storage lands with the connector catalog; the definition itself is already saved.'
}

/* Verify, then write — the order is the main process's (`connector.token.save`
   checks upstream first), so a key that failed never reaches the `0600` file, and
   the field is cleared only after it did. */
async function saveKey() {
  if (!row.value || busy.value) return
  busy.value = 'save'
  error.value = ''
  notice.value = ''
  try {
    await call('connector.token.save', {
      connector: id.value,
      token: draft.value.token,
      ...tokenScope(id.value),
    })
    draft.value = { ...draft.value, token: '' }
    await readStoredKey()
    /* A key is half of a gate for the one connector that has a second half, so the
       connector re-reads its own state here: the workspace it reads, and the list the
       Overview card draws. */
    await afterKeySaved()
    notice.value = 'Key saved on this machine — it is written 0600 and never leaves it.'
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

/**
 * Install this entry from its own page.
 *
 * The roster's Built-in pane offers the same verb; this one exists so a person who
 * read the pitch here does not have to go back to the list to act on it. It does
 * **not** navigate: the page stays, and `row` flips from the catalog's entry to the
 * installed row as soon as the answer lands, which is what makes the accounts,
 * endpoint and Remove cards appear in place.
 */
async function install() {
  if (busy.value) return
  busy.value = 'install'
  error.value = ''
  notice.value = ''
  try {
    await installConnector(id.value)
    notice.value = `${row.value?.label || id.value} installed. Its credential is the next step.`
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

/** The reverse, so `Uninstall` on a page a person reached from the roster works. */
async function uninstall() {
  if (busy.value) return
  busy.value = 'uninstall'
  error.value = ''
  try {
    await uninstallConnector(id.value)
    back()
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
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
            <!-- Lynk.id's mark is a wordmark, and its lettering is near-white: at 34 px
                 on the hero's tinted plate it would be an invisible word next to a
                 small green dot. So the one row whose mark is a wordmark gets the
                 brand's own plate behind it — `#0d1512`, the surface Lynk.id draws
                 its wordmark on — and every other row keeps the 66 px box. -->
            <span v-if="row.builtIn === 'lynk'" class="cxn-hero-mark cxn-hero-mk" aria-hidden="true">
              <svg width="104" height="26" viewBox="0 0 95 24" role="img" aria-label="Lynk.id">
                <path fill="currentColor" d="M2.85069 0.0341797C3.6847 0.0341797 4.36131 0.681912 4.36143 1.48047V19.8232H13.0177C14.8405 19.8233 16.3174 20.4713 16.3175 21.2695V22.5537C16.317 23.3522 14.8398 23.999 13.0177 23.999H2.87022C2.86373 23.9991 2.8572 24 2.85069 24H1.51085C1.50445 24 1.49769 23.9991 1.49132 23.999H0.867294V23.8604C0.355263 23.6288 0.000106812 23.1318 0.000106812 22.5537V1.48047C0.000235127 0.681912 0.676844 0.0341797 1.51085 0.0341797H2.85069ZM76.047 0.00195312C76.881 0.00196395 77.5577 0.649602 77.5577 1.44824V9.38574H81.9181C86.6475 9.46901 90.5525 5.86511 90.6398 1.33691C90.6415 1.23622 90.6415 1.13528 90.6398 1.03418C90.6399 0.48206 91.1075 0.0341797 91.6837 0.0341797H93.9562C94.5323 0.0342368 94.999 0.481686 94.9991 1.03418C94.9991 5.51618 93.0517 8.99563 89.1564 11.4727C93.0519 13.9505 94.9997 17.4308 95.0001 21.9121V22.5537C95.0001 23.3523 94.3243 23.9999 93.4903 24H92.1495C91.3155 24 90.6398 23.3528 90.6398 22.5537V21.9121C90.7265 17.3835 86.9625 13.6442 82.2335 13.5605H77.5577V22.5537C77.5577 23.3523 76.881 24 76.047 24H74.7062C73.8726 23.9999 73.1964 23.3527 73.1964 22.5537V1.44824C73.1964 0.65004 73.8726 0.00200898 74.7062 0.00195312H76.047ZM19.0226 0C19.8566 6.91459e-05 20.5323 0.64767 20.5323 1.44629V3.6416C20.4451 8.17032 24.209 11.9086 28.9386 11.9922C29.0433 11.9938 29.1488 11.9938 29.254 11.9922C33.9835 12.0756 37.8874 8.47252 37.9747 3.94434V1.44629C37.9747 0.647628 38.6514 0 39.4855 0H40.8253C41.6594 0 42.336 0.647628 42.336 1.44629V3.6416C42.3445 9.83017 37.6639 14.9752 31.505 15.998V22.5537C31.5047 23.3522 30.8291 23.999 29.9952 23.999H28.6544C27.8211 23.9989 27.1449 23.3521 27.1446 22.5537V16.0205C20.9293 15.0559 16.1801 9.89891 16.172 3.67383V1.44629C16.172 0.647628 16.8477 0 17.6817 0H19.0226ZM56.7833 0.0175781C64.0081 0.00880411 69.8724 5.6094 69.8819 12.5273V22.5527C69.8817 23.3508 69.2052 23.998 68.3712 23.998H67.0304C66.1966 23.9978 65.5208 23.3507 65.5206 22.5527V12.5596C65.6074 8.03041 61.843 4.29208 57.1134 4.20898C57.0089 4.20735 56.9044 4.20735 56.7999 4.20898C52.0704 4.12589 48.1652 7.72925 48.0782 12.2578V22.5527C48.078 23.3507 47.4023 23.9979 46.5685 23.998H45.2276C44.3937 23.998 43.7181 23.3508 43.7179 22.5527V12.5596C43.7085 5.64139 49.5583 0.026584 56.7833 0.0175781Z" />
                <path fill="#00bb79" fill-rule="evenodd" clip-rule="evenodd" d="M56.9181 8.26221C59.8583 8.26221 62.2414 10.4467 62.2414 13.1407V22.2254C62.2414 23.2056 61.3741 23.9999 60.3051 23.9999H53.5312C52.4616 23.9999 51.5949 23.2056 51.5949 22.2254V13.1407C51.5949 10.4467 53.978 8.26221 56.9181 8.26221Z" />
              </svg>
            </span>
            <span v-else class="cxn-hero-mark" aria-hidden="true">
              <IntegrationMark v-if="row.builtIn" :name="row.builtIn" :size="34" />
              <template v-else>{{ row.initial }}</template>
            </span>
            <div class="entp-title">
              <p class="eyebrow">
                {{ row.kind }} · {{ isTailscale ? 'this machine' : row.scope }} ·
                {{ hub.workspaceLabel || hub.workspace }}
              </p>
              <h1>{{ row.label }}</h1>
              <p class="entp-desc">
                {{ isTailscale ? row.summary : notInstalled ? row.summary || row.work?.resolves : row.binding || 'no binding recorded' }}
              </p>
              <!-- Tailscale's hero, from the daemon read the panel made: the state
                   word, the build, and whether the name or the address is what a
                   phone will use. Nothing here is a count or a zero. -->
              <div v-if="isTailscale" class="entp-chips">
                <span class="mcpp-chip" :data-tone="tsTone">
                  <i aria-hidden="true"></i>{{ tsRead ? tsRead.word : 'reading' }}
                </span>
                <span v-if="tsRead?.version" class="entp-chip">v{{ tsRead.version }}</span>
                <span v-if="tsRead?.serving" class="entp-chip">serving :{{ tsRead.port }}</span>
                <span v-else-if="tsRead" class="entp-chip">magicdns {{ tsRead.magicdns ? 'on' : 'off' }}</span>
              </div>
              <div v-else class="entp-chips">
                <span
                  class="mcpp-chip"
                  :data-tone="notInstalled ? 'mute' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'fail' ? 'bad' : 'mute'"
                >
                  <i aria-hidden="true"></i>{{ notInstalled ? 'not installed' : row.status }}
                  <span v-if="row.mention" class="mcpp-chip-note">{{ row.mention }}</span>
                </span>
                <span v-if="builtIn" class="entp-chip">built in</span>
                <span class="entp-chip">{{ row.kind === 'cli' ? 'local · cli' : 'remote · http' }}</span>
                <span class="entp-chip">every entity</span>
                <a
                  v-if="row.website && notInstalled"
                  class="entp-chip"
                  :href="row.website"
                  target="_blank"
                  rel="noreferrer noopener"
                >{{ websiteLabel }}</a>
              </div>
            </div>
          </header>

          <!-- The MCP page's panel, on a CLI's facts: what the probe saw and how
               much of it. `samples` is the probe's own answer, so an unprobed row
               says so instead of printing a zero. Tailscale has none of this: it
               stores nothing and resolves no mention, so its hero is one child. -->
          <aside v-if="notInstalled && !isTailscale" class="entp-xp" title="Nothing to probe yet">
            <div class="entp-lv">
              <span>MENTION</span>
              <b>{{ row.work?.mention ? '1' : '—' }}</b>
            </div>
            <div class="entp-xp-main">
              <div class="entp-xp-head">
                <span>in the composer</span>
                <b>{{ row.work?.mention || 'context only' }}</b>
              </div>
              <div class="entp-xp-track"><i style="width: 0%"></i></div>
              <div class="entp-xp-foot">
                <span>not installed</span>
                <span>nothing to ask yet</span>
              </div>
            </div>
          </aside>
          <aside
            v-else-if="!isTailscale"
            class="entp-xp"
            :title="`${seenTotal} ${row.samplesLabel || 'reported'} · ${row.status}`"
            :aria-label="`${seenTotal} ${row.samplesLabel || 'reported'}, ${row.status}, using ${row.binary || row.binding || 'its own binary'}`"
          >
            <div class="entp-lv">
              <!-- A feed has no per-read item count to put here: the number that
                   matters is its ceiling, and that is a field on the Feed card.
                   So the slot keeps its dash and names what the page is reading. -->
              <span>{{ isFeed ? 'FEEDS' : row.samplesLabel ? row.samplesLabel.slice(0, 6).toUpperCase() : 'SEEN' }}</span>
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
                <!-- `answering` is a probe's verdict, and a feed is never probed:
                     News reads it, which is a different verb and the true one. -->
                <span>{{ isFeed ? 'read by News' : tone === 'ok' ? 'answering' : 'not answering' }}</span>
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
      <!-- The page is the `cxn` container, so the strip and the tab body are
           inside it: the dashboard's own breakpoints are about this column's
           width, not the window's, and a container query cannot see out of an
           ancestor it is not nested in. -->
      <div class="cxn-page">
        <nav
          v-if="dashboardTab"
          class="sk-tabs cxn-tabs"
          role="tablist"
          aria-label="Connector sections"
          @keydown="onTabKey"
        >
          <button
            id="cxn-tab-overview"
            type="button"
            role="tab"
            :aria-selected="tab === 'overview'"
            :tabindex="tab === 'overview' ? 0 : -1"
            aria-controls="cxn-pane-overview"
            @click="select('overview')"
          >Overview</button>
          <!-- A locked tab is not `disabled`: it keeps its place in the tab order
               so the reason under the strip is reachable, and activating it does
               nothing rather than moving focus somewhere a person did not ask to
               go. -->
          <button
            id="cxn-tab-dashboard"
            type="button"
            role="tab"
            :aria-selected="tab === 'dashboard'"
            :tabindex="tab === 'dashboard' || lock ? 0 : -1"
            :aria-controls="dashboardPane"
            :aria-disabled="lock ? 'true' : undefined"
            :class="{ 'is-locked': Boolean(lock) }"
            :aria-describedby="lock ? 'cxn-tab-why' : undefined"
            :title="lock ? lock.title : dashboardHint"
            @click="select('dashboard')"
          >
            <svg
              v-if="lock"
              class="lk"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            ><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            Dashboard
          </button>
          <!-- The reason is a line, not a tooltip: it stays on screen for as long
               as the tab is locked, which is the only way it can be read by
               somebody who never hovers. -->
          <p v-if="lock" id="cxn-tab-why" class="tab-why" tabindex="-1">
            {{ lock.before }}<code v-if="lock.code" class="mono">{{ lock.code }}</code>{{ lock.after }}<template
              v-if="lock.code2"
            ><code class="mono">{{ lock.code2 }}</code>{{ lock.after2 }}</template>
          </p>
        </nav>

        <!-- One dashboard, one id: the strip's `aria-controls` names the pane, and a
             pane that swapped its own name per connector would be six tabs. The body
             is one component (`connectors/ConnectorDashboardPane.vue`) because *which*
             connector a dashboard is, is that connector's business; the page passes
             the pane's id and the day, and nothing else.
             A locked Dashboard never renders its body: the gate's sentence under the
             strip is the whole answer, and a body that could not fill itself would
             draw six zeroes nobody earned. `dashboardShown` is that decision, in one
             place, because `aria-controls` has to name the pane that is actually in
             the document. -->
        <ConnectorDashboardPane
          v-if="dashboardShown"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
          :kind="dashKind"
          :day="day"
          :fitbit-day="fitbitDay"
          @overview="select('overview')"
          @select-day="selectDay"
          @pick="pickFitbitDay"
        />

        <div
          v-else
          id="cxn-pane-overview"
          class="cxn-split"
          role="tabpanel"
          :aria-labelledby="tab === 'dashboard' ? 'cxn-tab-dashboard' : dashboardTab ? 'cxn-tab-overview' : undefined"
        >
          <div class="cxn-main">
          <!-- What this connector is, in the app's own words. Shown for an entry
               this workspace has not installed: the pitch is the page, and a page
               that only says "not installed" introduces nothing. The prose comes
               from the catalog (`summary`, then the mention's own `resolves`), so it
               cannot drift from what the resolver actually does. -->
          <!-- Tailscale's page body: the daemon read and the one server it gates.
               It is the whole of `.cxn-main` for that connector — see `isTailscale`. -->
          <TailscalePanel v-if="isTailscale" @read="tsRead = $event" />

          <section v-if="notInstalled && !isTailscale" class="cxn-card cxn-about">
            <h2>What {{ row.label }} gives you</h2>
            <p class="cxn-about-lead">
              {{ row.summary || (work?.resolves ? `${row.label} resolves ${work.resolves}.` : `${row.label} is a connector this app ships.`) }}
            </p>
            <dl class="cxn-facts">
              <dt>kind</dt>
              <dd>
                <template v-if="row.kind === 'mcp'">an MCP server — a definition in this workspace's <code class="mono">mcp.json</code></template>
                <template v-else-if="row.kind === 'cli'">a command-line tool already on this machine</template>
                <template v-else-if="row.kind === 'rss'">a feed — one URL, read by News, stored nowhere</template>
                <template v-else-if="row.oauth">a REST service you add one account at a time</template>
                <template v-else-if="row.credential === 'token'">a REST service reached with one API key you paste once</template>
                <template v-else>a REST service</template>
              </dd>
              <dt v-if="row.work?.mention">mention</dt>
              <dd v-if="row.work?.mention">
                <code class="mono">{{ row.work.mention }}</code> — {{ row.work.resolves }}
              </dd>
              <dt>where its credential lives</dt>
              <dd>{{ credentialWhere }}</dd>
              <dt v-if="row.work?.needs">needs</dt>
              <dd v-if="row.work?.needs">{{ row.work.needs }}</dd>
              <dt v-if="row.website">read more</dt>
              <dd v-if="row.website">
                <a :href="row.website" target="_blank" rel="noreferrer noopener">{{ websiteLabel }}</a>
              </dd>
            </dl>
            <p class="cxn-note">
              <template v-if="isFeed">
                Installing records this feed's address in the workspace. There is no
                credential to copy and none is asked for afterwards — a feed URL is the
                whole connector, and <b>News</b> reads it from the main process.
              </template>
              <template v-else>
                Installing records the definition in this workspace. It copies no
                credential — that is asked for here, afterwards, and it stays on this
                machine.
              </template>
            </p>
          </section>

          <!-- Lynk.id's one setting, in Lynk.id's own component: the folder the
               report reads and the three verbs beside it belong to that connector,
               not to the router. It sits above the accounts card because the folder
               is the thing a person came to change; the grant is already done by the
               time they get here. -->
          <LynkReportCard v-if="isLynk && !notInstalled" :label="row.label" />

          <!-- Where the CLI's binary is, for the machine whose install the automatic
               search cannot find. It sits above the sign-in card because the path is
               what `Test connection` below it actually runs, and it is drawn even for
               an entry this workspace has not installed: the binary is a machine fact,
               and it is the very thing the pitch above names as this connector's need. -->
          <BinaryPathCard
            v-if="binaryRow"
            :fn="binaryRow.fn"
            :label="row.label"
            :environment="binaryRow.environment"
          />

          <!-- The accounts card: one row per connected account, on the connector's
               own page. A component of its own because every account-bearing
               connector needs it and nothing about it is Gmail-specific. -->
          <ConnectorAccountsCard
            v-if="isOAuth && !notInstalled"
            ref="accountsCard"
            :connector="id"
            :provider="provider"
            @changed="onAccountsChanged"
          />
          <!-- A `cli` row's accounts are the CLI's own sign-ins: read from `gh auth
               status`, never written here, and never a token field. -->
          <ConnectorGithubAccounts v-else-if="isGithubCli && !notInstalled" />

          <!-- Lynk.id has no mention, by design: it is a report, not a lookup. The
               card says so rather than drawing an empty syntax row, which is how a
               person comes to type `@lynk:` into a composer that never answers. -->
          <section v-if="isLynk && work && !notInstalled" class="cxn-card cxn-work">
            <h2>In the chat</h2>
            <p class="cxn-work-lead">
              No mention: {{ row.label }} is a report, not a lookup. Its answer is one table
              over a folder of spreadsheets, so it lives on the
              <template v-if="dashboardTab">Dashboard tab</template><template v-else>Dashboard tab once this row is installed</template>
              and its only setting is the folder above.
            </p>
            <dl class="cxn-facts">
              <dt>returns</dt>
              <dd class="cxn-work-wrap">{{ work.returns }}</dd>
              <template v-if="work.needs">
                <dt>needs</dt>
                <dd>{{ work.needs }}</dd>
              </template>
              <template v-if="work.page">
                <dt>binding</dt>
                <dd><code class="mono">{{ work.page }}</code> — this connector's definition and its folder</dd>
              </template>
            </dl>
          </section>

          <section v-if="work?.mention && !isTailscale" class="cxn-card cxn-work">
            <h2>In the chat</h2>
            <!-- The account-bearing four put the account first, and their `mention`
                 is only the head (`@gmail:`), so the lead names the shape rather
                 than leaving a person to guess it from the syntax row. -->
            <p v-if="isOAuth" class="cxn-work-lead">
              Type <code class="mono">{{ work.syntax }}</code> — the account comes first, as the
              card lists it — and Entity resolves <strong>{{ work.resolves }}</strong> before the
              turn starts.
            </p>
            <p v-else class="cxn-work-lead">
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

          <section v-else-if="!isTailscale" class="cxn-card">
            <h2>In the chat</h2>
            <p class="cxn-note">
              No resolver is shipped for this connector, so there is no
              <code class="mono">@{{ row.id }}:</code> form. A mention attaches this
              connector's definition and status as context, and the entity uses its own
              tools.
            </p>
          </section>

          <!-- A `cli` row's probe runs the binary the pitch is about, so it stays
               reachable before installing — "do I even have this?" is the question
               the page is answering. A `rest` row's box would be a token form with
               no binding to write it to, so that one waits. -->
          <!-- The shipped `github` row is the one cli connector whose credential
               is gh's own: there is nothing here to sign in to, so the card says
               how the app asks instead of offering a form that could only fail. -->
          <section v-if="isGithubCli" class="cxn-card">
            <div class="cxn-card-head">
              <h2>How Entity asks</h2>
              <span class="spacer"></span>
            </div>
            <dl class="cxn-facts">
              <dt>binary</dt>
              <dd>{{ ghBinary }}</dd>
              <dt>mention</dt>
              <dd>
                <code class="mono">{{ row.work?.mention || '@github:' }}</code> — the entity
                resolver reads it
              </dd>
              <dt>credential</dt>
              <dd>kept by gh in the macOS keyring — never read by Entity</dd>
              <dt>commands</dt>
              <dd>7 allow-listed reads · no write verb</dd>
            </dl>
          </section>

          <section v-else-if="!isTailscale && !isOAuth && (!notInstalled || isCli)" class="cxn-card">
            <h2>{{ isFeed ? 'Feed' : isCli ? 'Sign-in' : isTokenKey ? 'API key' : 'Endpoint and token' }}</h2>
            <!-- A feed, in its own words: the address it reads, the ceiling it reads
                 to, and one verb that asks it. No token field (there is no
                 credential), no reveal (nothing to hide) and no base URL (the URL
                 *is* the connector — changing it is a remove and a new add, which is
                 a verb this page deliberately does not offer). -->
            <template v-if="isFeed">
              <div class="cxn-fields">
                <!-- The address is editable on purpose: a shipped feed is a shape, and
                     `?geo=US` / `/r/worldnews/` are the same connector pointed
                     somewhere else. The scheme is checked in main, so a `file://`
                     address never reaches the reader. -->
                <label>
                  feed URL
                  <input
                    v-model="feedDraft"
                    class="mono"
                    type="url"
                    placeholder="https://example.org/feed.xml"
                    autocomplete="off"
                    spellcheck="false"
                    :title="feedUrl"
                    @change="saveFeedUrl"
                  />
                </label>
                <label>
                  items per read
                  <input
                    v-model.number="itemLimit"
                    type="number"
                    min="1"
                    max="500"
                    step="1"
                    inputmode="numeric"
                    @change="saveFeedLimit"
                  />
                </label>
              </div>
              <div class="cxn-acts">
                <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="runTest">
                  {{ busy === 'test' ? 'Reading…' : 'Test feed' }}
                </button>
              </div>
              <p class="cxn-note">
                This feed is shared by the workspace: <b>News</b> reads it once and every member
                sees the same rows, up to {{ itemLimit }} items per read. It is installed,
                changed and removed here — News itself adds nothing, edits nothing and can
                remove nothing. Both fields save when you leave them.
              </p>
              <p class="cxn-note">
                The address is the whole feed, so a different country or subreddit is the same
                connector pointed elsewhere: <code class="mono">?geo=US</code> on a Google
                Trends feed, <code class="mono">/r/worldnews/</code> on a Reddit one. Read in
                the main process, credentialless: 8 s per request, 512 kB per answer, and a page
                that answers HTML is refused rather than parsed.
              </p>
            </template>
            <template v-else-if="isCli">
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
              <!-- What is already on this machine. A `credential: 'token'` row's key
                   is replaced by pasting into the field below, and four characters
                   are what says which key is in place without printing it. -->
              <dl v-if="row.credential === 'token'" class="cxn-facts cxn-key-state">
                <dt>key</dt>
                <dd>
                  <template v-if="storedKey.configured">
                    <code class="mono">{{ storedKey.hint }}</code> — stored 0600 on this
                    machine; pasting another replaces it
                  </template>
                  <template v-else>none on this machine yet</template>
                </dd>
              </dl>
              <div class="cxn-fields">
                <!-- A paste-once key has no base URL to ask for: the connector's own
                     `verify()` holds the endpoint, and the token verbs
                     (`connector.token.test` / `.save`) never read this field. It used
                     to render for Clockify seeded with `statusDetail`, which is a
                     sentence — visible garbage in a box that says `https://…`. -->
                <label v-if="!isTokenKey">
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

          <!-- Clockify's one control, in Clockify's own component: the key on this
               machine, the workspaces it can see and which one this workspace reads
               are that connector's business, not the page's. -->
          <ClockifyWorkspaceCard v-if="dashKind === 'clockify'" />

          <section v-if="notInstalled && !isTailscale" class="cxn-card">
            <h2>Install</h2>
            <p class="cxn-note">
              <template v-if="isFeed">
                Records this feed's address in the workspace. <b>No credential is
                copied</b> and none is asked for — a feed is one URL, and News reads it
                without a secret.
              </template>
              <template v-else>
                Records the definition in this workspace. <b>No credential is copied</b> — a
                CLI's sign-in stays with the CLI, an MCP binding stays in
                <code class="mono">mcp.json</code>, and an account is asked for on this page
                afterwards.
              </template>
            </p>
            <button
              class="btn btn-ink"
              type="button"
              :disabled="Boolean(busy)"
              @click="install"
            >
              {{ busy === 'install' ? 'Installing…' : `Install ${row.label}` }}
            </button>
            <div v-if="error" class="cxn-error" role="alert">{{ error }}</div>
          </section>

          <section v-else-if="!isTailscale" class="cxn-card cxn-danger">
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
                <dd :class="{ mono: field.mono }" :title="String(field.v)">{{ field.v }}</dd>
              </template>
            </dl>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
