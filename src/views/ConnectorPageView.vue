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
import ConnectorDashboard from '@/components/ConnectorDashboard.vue'
import GoogleCalendarDashboard from '@/components/GoogleCalendarDashboard.vue'
import ConnectorGithubAccounts from '@/components/ConnectorGithubAccounts.vue'
import { github, readDashboard, readLogins } from '@/composables/githubDashboard'
import {
  canRead as calendarCanRead,
  googleCalendar,
  readAccounts as readCalendarAccounts,
  readDashboard as readCalendarDashboard,
} from '@/composables/googleCalendar'
import TailscalePanel from '@/components/TailscalePanel.vue'
import {
  connectors,
  installConnector,
  loadConnectors,
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
/* The fourth kind has no credential to ask for and no mention to resolve, so every
   card on the generic page would say something untrue about it: a pitch selling an
   install, a sign-in that lives in the CLI, a mention the composer does not offer.
   Its page body is `TailscalePanel`, and the cards below stand down for it. */
const isTailscale = computed(() => id.value === 'tailscale')
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
const onAccountsChanged = () => {
  accountsFact.value = accountsCard.value?.accountsFact() || 'no account connected'
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
  if (entry.oauth) return 'on this machine, as a consent you grant per account; never in the workspace'
  if (entry.credential === 'token') return 'on this machine, as one API key you paste once; never in the workspace'
  return 'on this machine'
})

const tone = computed(() => {
  const word = String(row.value?.status || '')
  if (/fail|missing|needs sign-in/i.test(word)) return 'fail'
  if (/unmanaged|untracked|parked|not probed|not set up|not installed/i.test(word)) return 'warn'
  if (/found|connected|in the pool|ok/i.test(word)) return 'ok'
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
      { k: 'runs', v: 'npm run dev:lan', mono: true },
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
   The strip exists only for the two connectors this app ships a dashboard for:
   GitHub (`builtIn === 'github'`) and Google Calendar (`builtIn ===
   'google-calendar'`). Every other row — including a custom `cli` row — gets no tab
   at all rather than a disabled one: a tab that led to a half-built dashboard would
   be a promise nobody kept.

   The two tabs live in the address: `?tab=dashboard` is a place a person can
   bookmark, and the bare address / `?tab=overview` drops the parameter rather than
   spelling the default out. `SkillsView` set the precedent for the guard. */
const TABS = ['overview', 'dashboard']
const tab = computed(() =>
  TABS.includes(String(route.query.tab)) ? String(route.query.tab) : 'overview',
)
/* Only the rows the catalog shipped have a `work` block to gate on. A custom `cli`
   row that happens to be called github is not it. */
const githubRow = computed(() => connectors.rows.find((entry) => entry.builtIn === 'github') || null)
const calendarRow = computed(
  () => connectors.rows.find((entry) => entry.builtIn === 'google-calendar') || null,
)
/* Which dashboard the tab body draws. Two connectors have one, and the tab strip is
   the same strip for both — so the *kind* has to be named once, here, rather than
   inferred again at the pane. It is also the only answer to whether the strip exists
   at all: asking the GitHub row first would hide the strip on a calendar page when
   both connectors are installed. */
const dashboardKind = computed(() => {
  if (installedRow.value?.builtIn === 'github' && githubRow.value?.work) return 'github'
  if (installedRow.value?.builtIn === 'google-calendar' && calendarRow.value?.work) return 'calendar'
  return ''
})
const dashboardTab = computed(() => Boolean(dashboardKind.value))

/* The locks, in the order a person meets them. Both sentences are fixed copy — a
   computed reason would drift from the state it describes — and `code`/`after` are
   split so the file names and scope ids stay mono. */
const lock = computed(() => {
  if (!dashboardTab.value) return null
  if (dashboardKind.value === 'calendar') {
    /* Nothing is pressed here: the calendar gate is answered by the account store,
       which the accounts card below already reads, so the lock exists before the
       tab is. Three states, and they are three different sentences because they are
       three different fixes. */
    if (!googleCalendar.loaded) return null
    if (googleCalendar.apiOff) {
      return {
        before: "Dashboard needs the Calendar API enabled on Entity's OAuth client.",
        title: 'Needs the Calendar API enabled in the Google Cloud project',
      }
    }
    const rows = googleCalendar.accounts
    if (!rows.length) {
      return {
        before: 'Dashboard needs a connected Google account. Overview has the only Connect button on this page.',
        title: 'Needs a connected Google account',
      }
    }
    if (!rows.some(calendarCanRead)) {
      return {
        before: "Dashboard needs ",
        code: 'calendar.readonly',
        after: ". This account's grant does not include it.",
        title: 'Needs the calendar.readonly scope',
      }
    }
    return null
  }
  if (!github.loaded) return null
  if (!github.binary?.found) {
    return {
      before: 'Dashboard needs the ',
      code: 'gh',
      after: " binary. It is not on this machine's PATH.",
      title: 'Needs the gh binary on this machine',
    }
  }
  if (!github.logins.length) {
    return {
      before: 'Dashboard needs a signed-in ',
      code: 'gh',
      after: ' account. ',
      code2: 'gh auth status',
      after2: ' found none on this machine.',
      title: 'Needs a signed-in gh account on this machine',
    }
  }
  return null
})
/* Both tabs are always present in the tablist; a locked Dashboard still takes
   focus, because the reason under the strip is the thing to read and a
   `disabled` attribute would make it unreachable by keyboard. Activating it moves
   focus to that reason and changes nothing else — no tab is selected, no page is
   loaded, and Overview's own Connect button is never pressed from here. */
const canOpen = (name) => name === 'overview' || !lock.value

function select(name) {
  if (!canOpen(name)) {
    /* `tabindex="-1"` on the reason line is what lets a press land on it; a plain
       `<p>` cannot take focus, and a locked tab that did nothing at all reads as a
       broken button. */
    document.getElementById('cxn-tab-why')?.focus?.()
    return
  }
  const query = { ...route.query }
  if (name === 'overview') delete query.tab
  else query.tab = name
  /* `replace`, not `push`: switching a tab is not a step in a history a person
     wants to walk back through one press at a time. */
  router.replace({ query })
}
/* The address spells the default out as little as possible: a bare address and
   `?tab=overview` are the same place, and a value nobody defined is not a place at
   all — both end up with no `tab` parameter at all. Only a load that actually
   carries a stray `tab` pays for the rewrite, so `?tab=dashboard` never touches
   the address it was given. */
function normalizeTab() {
  if (route.query.tab === undefined || String(route.query.tab) === 'dashboard') return
  const query = { ...route.query }
  delete query.tab
  router.replace({ query }).catch(() => {})
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

async function openDashboard() {
  if (dashboardKind.value === 'calendar') {
    await readCalendarAccounts()
    if (tab.value === 'dashboard' && !lock.value) await readCalendarDashboard()
    return
  }
  await readLogins()
  if (tab.value === 'dashboard' && !lock.value) await readDashboard()
}
onMounted(async () => {
  normalizeTab()
  await load()
  probeConnectors().catch(() => {})
  /* The gate is answered by `gh` for GitHub and by the account store for the
     calendar, so it is asked once the row is known: reading it on every
     connector's page would run a CLI, or read a keyring, for a tab that cannot
     exist. */
  if (dashboardTab.value) await openDashboard()
})
/* A deep link straight to the tab: the strip rendered before the gate answered, so
   it resolves late and the read has to wait for it rather than run against a lock
   it does not yet know about. */
watch(
  () => [tab.value, Boolean(lock.value), dashboardTab.value],
  async ([name, locked, hasTab]) => {
    if (!hasTab) return
    if (dashboardKind.value === 'calendar') {
      if (!googleCalendar.loaded) await readCalendarAccounts()
      if (name === 'dashboard' && !locked && !googleCalendar.readAt) await readCalendarDashboard()
      return
    }
    if (!github.loaded) await readLogins()
    if (name === 'dashboard' && !locked && !github.readAt) await readDashboard()
  },
)
/* Re-checking the CLI, or signing an account out from the card, changes the gate
   under the strip, so the strip follows: a tab whose reason just became true
   cannot stay open on a page with nothing to draw. */
watch(
  () => (dashboardKind.value === 'calendar' ? googleCalendar.accounts.length : github.logins.length),
  (count) => {
    if (!count && tab.value === 'dashboard') select('overview')
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
            <span class="cxn-hero-mark" aria-hidden="true">
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
            aria-controls="cxn-pane-dashboard"
            :aria-disabled="lock ? 'true' : undefined"
            :class="{ 'is-locked': Boolean(lock) }"
            :aria-describedby="lock ? 'cxn-tab-why' : undefined"
            :title="lock ? lock.title : dashboardKind === 'calendar' ? 'What is next, and where the gaps are' : 'What moved in the last 90 days'"
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
            {{ lock.before }}<template v-if="lock.code"><code class="mono">{{ lock.code }}</code></template>{{ lock.after }}<template
              v-if="lock.code2"
            ><code class="mono">{{ lock.code2 }}</code>{{ lock.after2 }}</template>
          </p>
        </nav>

        <ConnectorDashboard
          v-if="dashboardTab && tab === 'dashboard' && dashboardKind === 'github'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
        />

        <GoogleCalendarDashboard
          v-else-if="dashboardTab && tab === 'dashboard'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
        />

        <div v-else id="cxn-pane-overview" class="cxn-split" role="tabpanel" :aria-labelledby="dashboardTab ? 'cxn-tab-overview' : undefined">
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
                <template v-else-if="row.oauth">a REST service you sign in to, one account at a time</template>
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
              Installing records the definition in this workspace. It copies no
              credential — that is asked for here, afterwards, and it stays on this
              machine.
            </p>
          </section>

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

          <section v-if="work && !isTailscale" class="cxn-card cxn-work">
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

          <section v-if="notInstalled && !isTailscale" class="cxn-card">
            <h2>Install</h2>
            <p class="cxn-note">
              Records the definition in this workspace. <b>No credential is copied</b> — a
              CLI's sign-in stays with the CLI, an MCP binding stays in
              <code class="mono">mcp.json</code>, and an account is asked for on this page
              afterwards.
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
