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
import DriveFolderPicker from '@/components/DriveFolderPicker.vue'
import ConnectorClockifyDashboard from '@/components/ConnectorClockifyDashboard.vue'
import ConnectorGithubAccounts from '@/components/ConnectorGithubAccounts.vue'
import ConnectorStudioDashboard from '@/components/ConnectorStudioDashboard.vue'
import ConnectorHabitifyDashboard from '@/components/ConnectorHabitifyDashboard.vue'
import ConnectorFitbitDashboard from '@/components/ConnectorFitbitDashboard.vue'
import { call } from '@/composables/localBridge'
import { github, readDashboard, readLogins } from '@/composables/githubDashboard'
import {
  canRead as calendarCanRead,
  googleCalendar,
  readAccounts as readCalendarAccounts,
  readDashboard as readCalendarDashboard,
} from '@/composables/googleCalendar'
import {
  adoptLynkConfig,
  dropLynkAnswer,
  forgetFolder as forgetLynkFolder,
  lynk,
  readDashboard as readLynkDashboard,
  readFolders as readLynkFolders,
  saveFolder as saveLynkFolder,
  testFolder as testLynkFolder,
} from '@/composables/lynkDashboard'
import {
  habitify,
  connected as habitifyConnected,
  readAccounts as readHabitifyAccounts,
  readDashboard as readHabitifyDashboard,
} from '@/composables/habitifyDashboard'
import {
  readDashboard as readStudioDashboard,
  readRoster,
  studio,
  studioUsable,
} from '@/composables/youtubeStudioDashboard'
import TailscalePanel from '@/components/TailscalePanel.vue'
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
  /* The Dashboard tab's gate is the account list, so a sign-in or a removal has to
     reach the strip too: the card just changed the fact the lock is computed from. */
  if (dashKind.value === 'habitify') readHabitifyAccounts().catch(() => {})
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
   The strip exists only for the connectors this app ships a dashboard for: GitHub
   (`builtIn === 'github'`), Google Calendar (`builtIn === 'google-calendar'`),
   YouTube Studio (`builtIn === 'youtube-studio'`), Clockify (`builtIn ===
   'clockify'`) and Habitify (`builtIn === 'habitify'`). A tab that led to another
   connector's half-built dashboard would be a promise nobody kept, so every other
   row — including a custom `cli` row, or a custom row that borrowed one of those
   names — gets no tab at all rather than a disabled one.

   The two tabs live in the address: `?tab=dashboard` is a place a person can
   bookmark, and the bare address / `?tab=overview` drops the parameter rather than
   spelling the default out. `SkillsView` set the precedent for the guard. */
const TABS = ['overview', 'dashboard']
const tab = computed(() =>
  TABS.includes(String(route.query.tab)) ? String(route.query.tab) : 'overview',
)
/* Only a row the catalog shipped has a `work` block to gate on. A custom `cli`
   row that happens to be called github — or youtube-studio — is not one of them. */
const githubRow = computed(() => connectors.rows.find((entry) => entry.builtIn === 'github') || null)
const calendarRow = computed(
  () => connectors.rows.find((entry) => entry.builtIn === 'google-calendar') || null,
)
const studioRow = computed(
  () => connectors.rows.find((entry) => entry.builtIn === 'youtube-studio') || null,
)
/* Which dashboard this page is, if any. Named rather than boolean because the three
   have different locks, different reads and different pane bodies. Lynk.id ships no
   `work.samples`, so the row itself is the test that it has a report to draw. */
const dashKind = computed(() => {
  const builtIn = String(installedRow.value?.builtIn || '')
  if (builtIn === 'github' && githubRow.value?.work) return 'github'
  if (builtIn === 'google-calendar' && calendarRow.value?.work) return 'calendar'
  if (builtIn === 'youtube-studio' && studioRow.value?.work) return 'studio'
  if (builtIn === 'clockify' && installedRow.value?.work) return 'clockify'
  /* Habitify's reader lives in this app, so its own `work` block is the whole
     gate — there is no roster to look up beside the row. */
  if (builtIn === 'habitify' && installedRow.value?.work) return 'habitify'
  if (builtIn === 'fitbit' && installedRow.value?.work) return 'fitbit'
  if (builtIn === 'lynk') return 'lynk'
  return ''
})
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
/* What the tab offers, in the connector's own words: GitHub's board is 90 days,
   the channel board is the 28 the window chips start on, Clockify's week is a week,
   Habitify's is one day and the week around it, and the Lynk.id report is whatever
   the store sold in the folder it reads. */
const dashboardHint = computed(() => {
  if (dashKind.value === 'calendar') return 'What is next, and where the gaps are'
  if (dashKind.value === 'studio') return 'What moved in the last 28 days'
  if (dashKind.value === 'clockify') return 'Where the team’s week went, read from Clockify'
  if (dashKind.value === 'habitify') return 'What a day was scheduled with, and the week around it'
  if (dashKind.value === 'fitbit') return 'One day in steps, sleep and heart rate'
  if (dashKind.value === 'lynk') return 'What the store sold, read from a Drive folder'
  return 'What moved in the last 90 days'
})

/* Clockify needs two things this machine and this workspace answer separately: the
   API key (`connector.token.status`) and the workspace id on the connector's own
   fields. Both are read once per page, and the two sentences are fixed copy — a
   computed reason would drift from the state it describes. */
const clockify = ref({ configured: false, workspaceId: '' })
const clockifyLoaded = ref(false)
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

async function readClockifyState() {
  if (dashKind.value !== 'clockify') return
  try {
    const fields = await call('connector.fields', { workspace: hub.workspace, id: 'clockify' })
    clockify.value = {
      configured: storedKey.value.configured,
      workspaceId: String(fields?.workspaceId || ''),
    }
  } catch {
    /* A failed read leaves the workspace at its default, so the tab stays locked
       and says what is missing — the state that sends a person to the card that
       can fix it. The key half stands: the token store answered separately. */
    clockify.value = { configured: storedKey.value.configured, workspaceId: '' }
  } finally {
    clockifyLoaded.value = true
  }
}

/* The workspaces this key can read, for the Overview card's one control. Read only
   when a key exists — the call is itself a read that key makes, so a person without
   one gets the sentence instead of an error about a list they cannot have. */
const spaces = ref([])
const spacesLoaded = ref(false)
const spacesError = ref('')
async function readSpaces() {
  if (dashKind.value !== 'clockify' || !storedKey.value.configured) return
  try {
    const list = await call('connector.workspaces', { workspace: hub.workspace })
    spaces.value = Array.isArray(list) ? list : []
    spacesError.value = ''
  } catch (problem) {
    spaces.value = []
    spacesError.value = String(problem?.message || problem)
  } finally {
    spacesLoaded.value = true
  }
}
/* Choosing a workspace is the one thing on this page that changes *what the
   dashboard reads*, so it writes the field and re-reads the gate: the lock lifts
   under the strip without a reload. */
async function pickSpace(space) {
  if (busy.value || space.id === clockify.value.workspaceId) return
  busy.value = 'space'
  spacesError.value = ''
  try {
    await call('connector.setFields', {
      workspace: hub.workspace,
      id: 'clockify',
      /* The member map is per workspace — Clockify's user ids are — so a switch
         clears it rather than carrying names that now point at nobody. */
      fields: { workspaceId: space.id, members: {} },
    })
    await readClockifyState()
  } catch (problem) {
    spacesError.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

/* The calendar locks, in the order a person meets them. Nothing is pressed here:
   the gate is answered by the account store, which the accounts card below already
   reads, so the lock exists before the tab is. Three states, and they are three
   different sentences because they are three different fixes. */
const calendarLock = computed(() => {
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
      before: 'Dashboard needs ',
      code: 'calendar.readonly',
      after: ". This account's grant does not include it.",
      title: 'Needs the calendar.readonly scope',
    }
  }
  return null
})
/* The GitHub locks, in the order a person meets them: no binary, then no login.
   Both sentences are fixed copy — a computed reason would drift from the state it
   describes — and `code`/`after` are split so the two `gh` mentions stay mono. */
const githubLock = computed(() => {
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

/* The channel locks, in the same order: nothing signed in, then a row that signed
   in and got no channel back. **A grant without analytics is not a lock** — the
   Data API still lists the videos, so that tab opens and prints dashes; locking it
   would hide the half a person came for. */
const studioLock = computed(() => {
  if (!studio.loaded) return null
  if (!studio.accounts.length) {
    return {
      before: 'Dashboard needs a signed-in channel owner. No YouTube Studio account on this machine is answering — ',
      code: 'youtube.readonly',
      after: ' is what separates an account that can list videos from one that can measure them.',
      title: 'Needs a signed-in channel owner',
    }
  }
  if (!studioUsable()) {
    /* The account that answered and had nothing to show, named: `studio.accounts`
       is the roster Google answered for, not an id this page invented. */
    const who = studio.accounts.find((entry) => !entry.error) || studio.accounts[0]
    return {
      before: 'Dashboard needs a channel this account manages. ',
      code: String(who.email || who.localpart),
      after: ' signed in, but Google returned no channel for it — a personal account that owns none is refused, not saved.',
      title: 'Needs a channel this account manages',
    }
  }
  return null
})

/* The Lynk.id locks, in the order Lynk.id meets them: a grant, a grant that was
   revoked, then a folder to read. An account that exists but is not `connected` is
   not "no account" — it is the refusal, and the fix is a reauthorize rather than a
   fresh consent. The third lock is the only one on this page that opens a control
   instead of pointing at Overview, which is why `opens` is part of the answer. */
function lynkGate(entry) {
  if (!lynkConfig.loaded) return { locked: false, why: null, opens: 'overview' }
  const accounts = Array.isArray(entry?.accounts) ? entry.accounts : []
  if (!accounts.length) {
    return {
      locked: true,
      opens: 'overview',
      why: {
        before: 'Dashboard needs a Google account — ',
        code: 'drive.readonly',
        after: '',
        title: 'Needs a Google account on this machine',
      },
    }
  }
  if (!accounts.some((account) => account.status === 'connected')) {
    return {
      locked: true,
      opens: 'overview',
      why: {
        before: 'Google refused the grant — reauthorize on Overview',
        code: '',
        after: '',
        title: 'The Google grant was refused',
      },
    }
  }
  if (!lynkConfig.folderId) {
    return {
      locked: true,
      opens: 'picker',
      why: {
        before: 'Dashboard needs a Drive folder — pick one on Overview',
        code: '',
        after: '',
        title: 'Needs a Drive folder',
      },
    }
  }
  return { locked: false, why: null, opens: 'overview' }
}

/* One shape for every lock, whichever way it was written: `locked` decides whether
   the tab is a place, `why` is the sentence under the strip, and `opens` says which
   control answers it. */
function gated(why) {
  return why
    ? { locked: true, why, opens: 'overview' }
    : { locked: false, why: null, opens: 'overview' }
}
/* The week locks, in the order a person meets them: no key, then no workspace id.
   Both sentences are fixed copy for the same reason the two above are. */
const clockifyLock = computed(() => {
  if (!clockifyLoaded.value) return null
  if (!clockify.value.configured) {
    return {
      before: 'Connect Clockify first — the tab needs a verified key.',
      title: 'Needs a Clockify API key on this machine',
    }
  }
  if (!clockify.value.workspaceId) {
    return {
      before: 'Pick a workspace on Overview — every read happens inside one.',
      title: 'Needs a Clockify workspace chosen for this workspace',
    }
  }
  return null
})
/* Habitify's one lock: no account whose grant this machine holds. It is read from
   the account card's own call rather than re-derived here, and the sentence is
   fixed copy for the same reason the three above are. */
const habitifyLock = computed(() => {
  if (!habitify.loaded) return null
  if (!habitifyConnected()) {
    return {
      before: 'Dashboard needs a signed-in ',
      code: 'Habitify',
      after: ' account on this machine. Connect one above.',
      title: 'Needs a signed-in Habitify account on this machine',
    }
  }
  return null
})
/* Fitbit's one lock: no account whose grant this machine holds. The roster is the
   accounts card's own list rather than a read of this page's own, and `loaded` is
   part of the answer: a roster that has not arrived yet would lock every Fitbit
   page, which is how a deep link used to lose its address. */
const fitbitLock = computed(() => {
  if (!connectors.loaded) return null
  const accounts = Array.isArray(installedRow.value?.accounts) ? installedRow.value.accounts : []
  if (accounts.some((account) => account.status === 'connected')) return null
  return {
    before: 'Dashboard needs a signed-in Fitbit account — the accounts card above connects one.',
    title: 'Needs a signed-in Fitbit account',
  }
})
/* One shape for every lock, whichever way it was written: `dashKind` picks the
   lock, and `opens` stays the folder lock's own answer — the one lock on this page
   whose fix is a control here rather than a card on Overview. */
const gate = computed(() => {
  if (dashKind.value === 'github') return gated(githubLock.value)
  if (dashKind.value === 'calendar') return gated(calendarLock.value)
  if (dashKind.value === 'studio') return gated(studioLock.value)
  if (dashKind.value === 'clockify') return gated(clockifyLock.value)
  if (dashKind.value === 'habitify') return gated(habitifyLock.value)
  if (dashKind.value === 'fitbit') return gated(fitbitLock.value)
  if (dashKind.value === 'lynk') return lynkGate(installedRow.value)
  return { locked: false, why: null, opens: 'overview' }
})
const lock = computed(() => (gate.value.locked ? gate.value.why : null))
/* Both tabs are always present in the tablist; a locked Dashboard still takes
   focus, because the reason under the strip is the thing to read and a
   `disabled` attribute would make it unreachable by keyboard. */
const canOpen = (name) => name === 'overview' || !gate.value.locked
/* Which pane the Dashboard tab actually controls, and it is not always its own.
   The two bodies whose lock is part of their `v-if` — Fitbit's and Lynk.id's — fall
   through to the Overview pane while locked, so `aria-controls` names the id that is
   in the document rather than the one the tab would have drawn. */
const dashboardPane = computed(() =>
  tab.value === 'dashboard' && !(lock.value && (dashKind.value === 'fitbit' || dashKind.value === 'lynk'))
    ? 'cxn-pane-dashboard'
    : 'cxn-pane-overview',
)

/* The picker is the folder lock's own answer, so it lives beside the gate rather
   than inside the tab body: activating the lock is what opens it. */
const picker = ref(false)

function select(name) {
  if (name === 'dashboard' && gate.value.locked) {
    /* Activating a locked tab does not switch it. A tab waiting for a folder is
       the one case with an action behind it, so it opens the picker; the other
       two focus the sentence that says where to fix it. */
    if (gate.value.opens === 'picker') picker.value = true
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

async function openDashboard() {
  /* Fitbit draws itself: its pane reads its own day on mount, so the gate here is
     the row's own account list and there is nothing on this page to ask for. A
     locked deep link keeps its address — the pane is absent, and the sentence under
     the strip is the answer the person followed the link for. */
  if (dashKind.value === 'fitbit') return
  /* The calendar's gate is the account store, so the read that answers it is the
     same one the accounts card makes — no extra request, and no read at all while
     the tab that would spend it is not the one on screen. */
  if (dashKind.value === 'calendar') {
    if (!googleCalendar.loaded) await readCalendarAccounts()
    if (tab.value === 'dashboard' && !lock.value && !googleCalendar.readAt) await readCalendarDashboard()
    return
  }
  /* The gate for each dashboard is answered by its own read, so only the one this
     page's connector needs is run. */
  if (dashKind.value === 'lynk') {
    await loadLynkConfig({ id: id.value })
    adoptLynkConfig(lynkConfig)
    /* A locked tab is not a place, and `select()` already refuses one — a deep
       link has to reach the same conclusion, or `?tab=dashboard` would land on a
       pane that has nothing it may read. */
    if (tab.value === 'dashboard' && gate.value.locked) select('overview')
    else if (tab.value === 'dashboard') await readIfNeeded()
    return
  }
  if (dashKind.value === 'studio') {
    if (!studio.loaded) await readRoster()
    if (tab.value === 'dashboard' && lock.value) select('overview')
    else if (tab.value === 'dashboard' && !studio.readAt) await readStudioDashboard()
    return
  }
  /* Clockify draws itself: its band reads its own state on mount, so the gate is
     the only thing this page has to answer before it can. */
  if (dashKind.value === 'clockify') {
    await readClockifyState()
    await readSpaces()
    return
  }
  /* Habitify's gate is the account list, which is a file read — cheaper than `gh
     auth status` and the only thing that can answer whether the tab may open. */
  if (dashKind.value === 'habitify') {
    if (!habitify.loaded) await readHabitifyAccounts()
    if (tab.value === 'dashboard' && !lock.value) await readHabitifyDashboard({ day: day.value })
    return
  }
  await readLogins()
  if (tab.value === 'dashboard' && !lock.value) await readDashboard()
}
/*
 * Whether the tab already holds an answer for the folder it is now pointed at.
 *
 * This is the difference between "the numbers are on screen" and "the tab was
 * opened once". The read used to be guarded by `!lynk.readAt`, which is only ever
 * set by a successful read — so a refusal, a quota, or a folder picked a moment
 * later left the guard answering "already read" and the page stayed wrong until it
 * was reloaded. The folder the answer came from is the fact that makes the read
 * unnecessary, and a folder change is now what triggers the next one.
 */
function needsLynkRead() {
  if (lynk.reading) return false
  if (!lynk.readAt) return true
  return Boolean(lynk.readFolderId) && lynk.readFolderId !== lynk.folderId
}

async function readIfNeeded({ force = false } = {}) {
  if (!force && !needsLynkRead()) return
  await readLynkDashboard({ force })
}

onMounted(async () => {
  normalizeTab()
  await load()
  probeConnectors().catch(() => {})
  /* The stored key comes first: it is half of the gate under the strip and the
     whole of the sentence on the card that can replace it. */
  await readStoredKey()
  /* The gate is answered by `gh`, the token store or the account store, so it is
     asked once the row is known: reading it on every connector's page would run a
     CLI, open a key file or read a keyring for a tab that cannot exist. */
  if (dashboardTab.value) await openDashboard()
})
/* A deep link straight to the tab: the strip rendered before the gate answered, so
   it resolves late and the read has to wait for it rather than run against a lock
   it does not yet know about. */
watch(
  () => [tab.value, Boolean(gate.value.locked), dashboardTab.value, installedRow.value?.builtIn],
  async ([name, locked, hasTab, builtIn]) => {
    if (!hasTab) return
    if (builtIn === 'google-calendar') {
      /* The calendar keeps the `locked` the watcher was handed rather than
         re-reading it: its gate is the account store, and that read has already
         answered by the time the tab can be deep-linked. */
      if (!googleCalendar.loaded) await readCalendarAccounts()
      if (name === 'dashboard' && !locked && !googleCalendar.readAt) await readCalendarDashboard()
      return
    }
    if (builtIn === 'lynk') {
      if (!lynkConfig.loaded) {
        await loadLynkConfig({ id: id.value })
        adoptLynkConfig(lynkConfig)
      }
      if (name === 'dashboard' && !locked) await readIfNeeded()
      return
    }
    if (builtIn === 'youtube-studio') {
      if (!studio.loaded) await readRoster()
      /* Re-read the gate: the roster answered inside this run, so the value the
         watcher was handed is the one from before the read. */
      if (name === 'dashboard' && lock.value) select('overview')
      else if (name === 'dashboard' && !studio.readAt) await readStudioDashboard()
      return
    }
    if (dashKind.value === 'clockify') {
      if (!clockifyLoaded.value) await readClockifyState()
      /* A connector installed on this page crosses the tab into existence, so the
         gate and the workspace list are read here rather than only on mount: the
         card would otherwise wait on a list nobody asked for. */
      if (storedKey.value.configured && !spacesLoaded.value) await readSpaces()
      return
    }
    if (dashKind.value === 'habitify') {
      if (!habitify.loaded) await readHabitifyAccounts()
      if (name === 'dashboard' && !locked && !habitify.readAt) await readHabitifyDashboard({ day: day.value })
      return
    }
    if (dashKind.value === 'fitbit') return
    if (!github.loaded) await readLogins()
    if (name === 'dashboard' && !locked && !github.readAt) await readDashboard()
  },
)
/* A day in the address that this renderer has not read yet — a link followed, or a
   reload — is read here rather than left showing the day before it. */
watch(day, (next) => {
  if (dashKind.value !== 'habitify' || tab.value !== 'dashboard' || lock.value) return
  if (next && next !== habitify.day) readHabitifyDashboard({ day: next }).catch(() => {})
})
/* Re-checking the CLI, or signing an account out from the card, changes the gate
   under the strip, so the strip follows: a tab whose reason just became true
   cannot stay open on a page with nothing to draw. */
watch(
  () => github.logins.length,
  (count) => {
    if (!count && tab.value === 'dashboard' && dashKind.value === 'github') select('overview')
  },
)
/* The same for a Google account connected or signed out from the accounts card:
   the calendar's gate is that list, so it can go either way while the tab is open. */
watch(
  () => googleCalendar.accounts.length,
  (count) => {
    if (!count && tab.value === 'dashboard' && dashKind.value === 'calendar') select('overview')
  },
)
/* The same for a Habitify consent granted or revoked on the accounts card: an
   account that arrived unlocks the tab, and one that went away must not leave the
   pane open. */
watch(
  () => habitify.accounts.filter((entry) => entry.hasToken).length,
  (count) => {
    if (!count && tab.value === 'dashboard' && dashKind.value === 'habitify') select('overview')
  },
)
/*
 * The Lynk.id gate has two inputs the strip cannot read on its own: whether a
 * grant is still `connected` (the accounts card writes it) and whether a folder
 * was picked (the card below writes it). Either one can lock or unlock the tab, so
 * both are watched, and a tab that is open only while nothing is stored goes back
 * to Overview rather than staying on a body it can no longer fill.
 */
watch(
  () => [lynkConfig.folderId, lynkConfig.loaded, installedRow.value?.accounts],
  async () => {
    if (installedRow.value?.builtIn !== 'lynk') return
    if (gate.value.locked && tab.value === 'dashboard') {
      select('overview')
      return
    }
    /* The gate just unlocked under an open tab — a grant was reauthorized, or a
       folder was picked. Both mean the answer on screen is not the one this tab
       would produce now, so it is asked for again here instead of on the next
       page load. */
    if (tab.value === 'dashboard' && !gate.value.locked) await readIfNeeded({ force: true })
  },
  { deep: true },
)
/* The folder whose rows were read is no longer the folder being read, so the
   numbers on screen belong to somebody else's folder. Dropping the answer is what
   turns that into a skeleton and a real read; leaving `readAt` alone is what left
   the previous folder's revenue under the new folder's name. */
watch(
  () => [lynkConfig.folderId, lynkConfig.sheetSuffix],
  ([nextFolder, nextSuffix], [wasFolder, wasSuffix]) => {
    if (nextFolder === wasFolder && nextSuffix === wasSuffix) return
    if (installedRow.value?.builtIn !== 'lynk') return
    dropLynkAnswer()
    if (tab.value === 'dashboard' && !gate.value.locked) readIfNeeded()
  },
)
/* Fitbit's gate is the row's own account list, and the card above can sign the
   last account out under an open tab. Only an open → locked change closes it: a
   roster that has not loaded yet reads as signed-out, and closing on that would
   send a deep link to the overview before its accounts could arrive. */
const fitbitGate = computed(() =>
  dashKind.value === 'fitbit' && connectors.loaded ? Boolean(fitbitLock.value) : null,
)
watch(fitbitGate, (locked, was) => {
  if (was !== false || !locked) return
  if (tab.value === 'dashboard') select('overview')
})
/* The same for a consent granted or revoked on the accounts card: a channel that
   arrived unlocks the tab, and one that went away must not leave the pane open. */
watch(
  () => [studio.accounts.length, studioUsable()],
  () => {
    if (dashKind.value !== 'studio') return
    if (tab.value === 'dashboard' && lock.value) select('overview')
  },
)

const back = () => {
  hub.rail.connectors = true
  router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'connectors' } })
}

/* ── the Lynk.id report card ─────────────────────────────────────────────

   One card, one control: which Drive folder the report is read from. Everything
   else on it is a fact printed beside that control — the tab suffix, the currency,
   the zone — because a number without its unit is a number somebody will
   misread.

   `Test folder` is its own call, not the page's `runTest`: a probe answers a
   status line, and this answers how many spreadsheets were found and how many of
   them had anything to read. `Re-read now` is `force`, and `Forget folder` writes
   an empty id, which locks the tab again. */
const isLynk = computed(() => installedRow.value?.builtIn === 'lynk')
const folderTail = computed(() => {
  const total = lynk.test?.sheets ?? lynk.sheets.total
  return total ? `${total} ${total === 1 ? 'sheet' : 'sheets'}` : 'not read yet'
})
const testLine = computed(() => {
  const answer = lynk.test
  if (!answer) return ''
  const seconds = (Number(answer.ms || 0) / 1000).toFixed(1)
  return `${answer.sheets} ${answer.sheets === 1 ? 'spreadsheet' : 'spreadsheets'} · ${answer.withTab} with a ${lynkConfig.sheetSuffix.trim()} tab · ${answer.rows} ${answer.rows === 1 ? 'row' : 'rows'} · read in ${seconds} s`
})

async function onFolderPicked(folder) {
  picker.value = false
  try {
    await saveLynkFolder(folder)
    adoptLynkConfig(lynkConfig)
    lynk.test = null
    notice.value = `Reading ${folder.name}…`
    await readLynkDashboard({ force: true })
    notice.value = `${folder.name} is the folder this report reads.`
  } catch (problem) {
    error.value = String(problem?.message || problem)
  }
}

async function runFolderTest() {
  error.value = ''
  notice.value = ''
  try {
    await testLynkFolder()
    if (lynk.testError) throw new Error(lynk.testError)
  } catch (problem) {
    error.value = String(problem?.message || problem)
  }
}

async function reReadNow() {
  error.value = ''
  try {
    await readLynkDashboard({ force: true })
    notice.value = lynk.error ? lynk.error : `Read ${lynk.sheets.withTab} spreadsheets again.`
  } catch (problem) {
    error.value = String(problem?.message || problem)
  }
}

async function dropFolder() {
  try {
    await forgetLynkFolder()
    adoptLynkConfig({ folderId: '', folderName: '' })
    lynk.test = null
    notice.value = 'The folder is forgotten; the Dashboard is locked until you pick one.'
  } catch (problem) {
    error.value = String(problem?.message || problem)
  }
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
        workspaceId: clockify.value.workspaceId || undefined,
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
      workspaceId: clockify.value.workspaceId || undefined,
    })
    draft.value = { ...draft.value, token: '' }
    await readStoredKey()
    await readClockifyState()
    await readSpaces()
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
             pane that swapped its own name per connector would be six tabs. Every
             dashboard is a link in this one chain — a standalone `v-if` beside it
             would let the Overview pane render underneath the dashboard.
             A locked Dashboard never renders its body: the gate's sentence under the
             strip is the whole answer, and a body that could not fill itself would
             draw six zeroes nobody earned. Lynk.id is the one body that also owns a
             lock whose fix is a control on this page, so its pane waits for the
             folder the picker writes. -->
        <ConnectorClockifyDashboard
          v-if="dashKind === 'clockify' && tab === 'dashboard'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
          @overview="select('overview')"
          @changed="readClockifyState"
        />
        <ConnectorDashboard
          v-else-if="tab === 'dashboard' && (dashKind === 'github' || (dashKind === 'lynk' && !gate.locked))"
          :row="installedRow"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
        />
        <GoogleCalendarDashboard
          v-else-if="dashKind === 'calendar' && tab === 'dashboard'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
        />
        <ConnectorStudioDashboard
          v-else-if="dashKind === 'studio' && tab === 'dashboard'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
          @overview="select('overview')"
        />
        <ConnectorHabitifyDashboard
          v-else-if="dashKind === 'habitify' && tab === 'dashboard'"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
          :day="day"
          @select-day="selectDay"
        />

        <!-- Fitbit's tab is one day and one table, and it is read-only: the copy on
             the page is the connector's own, and no control here writes to the
             account. The gate is part of the render, not just of the click: a
             mounted dashboard reads on mount, so a locked tab would spend an
             account's budget it has no grant for and paint a day it does not have.
             Locked, the chain falls through to Overview, which is what
             `dashboardPane` points at. -->
        <ConnectorFitbitDashboard
          v-else-if="dashKind === 'fitbit' && tab === 'dashboard' && !lock"
          id="cxn-pane-dashboard"
          role="tabpanel"
          aria-labelledby="cxn-tab-dashboard"
          :day="fitbitDay"
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

          <!-- The Lynk.id report's one setting. It sits above the accounts card
               because the folder is the thing a person came to change; the grant is
               already done by the time they get here. -->
          <section v-if="isLynk && !notInstalled" class="cxn-card cxn-report">
            <h2>{{ row.label }} report</h2>
            <p class="cxn-about-lead">
              One spreadsheet per product, and this folder's <code class="mono">{{ lynkConfig.sheetSuffix }}</code>
              tab is the one read. Change the folder here and the Dashboard follows it —
              no reload, and no second setting anywhere else.
            </p>
            <div class="cfg">
              <div class="cfg-row">
                <span class="lb">Drive folder</span>
                <button
                  type="button"
                  class="field"
                  data-role="select"
                  :aria-label="lynkConfig.folderName ? `Drive folder: ${lynkConfig.folderName}` : 'Choose a Drive folder'"
                  @click="picker = true"
                >
                  <span class="val">{{ lynkConfig.folderName || (lynkConfig.folderId ? lynkConfig.folderId : 'Pick a folder…') }}</span>
                  <span class="tail">{{ folderTail }}</span>
                  <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              </div>
              <div class="cfg-row">
                <span class="lb">Sheet suffix</span>
                <div class="field-static">
                  <code class="mono">{{ lynkConfig.sheetSuffix }}</code>
                  <span class="tail">tab name</span>
                </div>
              </div>
              <div class="cfg-row">
                <span class="lb">Currency</span>
                <div class="field-static">
                  <span>IDR · Indonesian rupiah</span>
                  <span class="tail">no conversion</span>
                </div>
              </div>
              <div class="cfg-row">
                <span class="lb">Time zone</span>
                <div class="field-static">
                  <span>{{ lynkConfig.timezone }}</span>
                  <span class="tail">for every date</span>
                </div>
              </div>
            </div>
            <div class="cfg-actions">
              <button class="btn btn-primary btn-sm" type="button" :disabled="!lynkConfig.folderId || lynk.testing" @click="runFolderTest">
                {{ lynk.testing ? 'Reading…' : 'Test folder' }}
              </button>
              <button class="btn btn-sm" type="button" :disabled="!lynkConfig.folderId || lynk.reading" @click="reReadNow">
                {{ lynk.reading ? 'Reading…' : 'Re-read now' }}
              </button>
              <button class="btn btn-ghost btn-sm" type="button" :disabled="!lynkConfig.folderId" @click="dropFolder">
                Forget folder
              </button>
            </div>
            <!-- What the last test actually saw. The numbers are the read's own, so
                 "70 spreadsheets" here and "70 sheets" on the tab cannot disagree. -->
            <div v-if="testLine" class="cfg-test">
              <span class="k">read in {{ (Number(lynk.test?.ms || 0) / 1000).toFixed(1) }} s</span>
              <p>{{ testLine }}</p>
            </div>
            <div v-else-if="lynk.testError" class="cfg-test" data-tone="bad">
              <span class="k">not read</span>
              <p>{{ lynk.testError }}</p>
            </div>
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
            <h2>{{ isCli ? 'Sign-in' : isTokenKey ? 'API key' : 'Endpoint and token' }}</h2>
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

          <!-- The one action the dashboard has. The list is `GET /v1/workspaces`,
               which is itself a read the key makes, so without a key the card says
               so instead of offering a list it cannot have. A failure stays in this
               card: this card is the thing that failed. -->
          <section v-if="dashKind === 'clockify'" class="cxn-card">
            <div class="cxn-card-head">
              <h2>Workspace</h2>
              <span class="spacer"></span>
              <span class="n">{{ clockify.workspaceId ? 'chosen' : 'not chosen' }}</span>
            </div>
            <p class="cxn-note">
              Every read happens inside one Clockify workspace — its reports, its people
              and its projects. Choosing one here is what unlocks the dashboard tab.
            </p>
            <p v-if="!storedKey.configured" class="cxn-note">
              Paste a key first: the list of workspaces is one of the reads that key makes.
            </p>
            <template v-else>
              <div
                v-if="spaces.length"
                class="seg ck-seg"
                role="group"
                aria-label="Which Clockify workspace to read"
              >
                <button
                  v-for="space in spaces"
                  :key="space.id"
                  type="button"
                  :title="space.name"
                  :aria-pressed="space.id === clockify.workspaceId"
                  :aria-busy="busy === 'space' ? 'true' : undefined"
                  :disabled="Boolean(busy)"
                  @click="pickSpace(space)"
                ><span class="nm">{{ space.name }}</span></button>
              </div>
              <p v-else-if="!spacesLoaded && !spacesError" class="cxn-note">
                Reading the workspaces this key can see…
              </p>
              <p v-else-if="!spacesError" class="cxn-note">
                This key can read no workspace. Its owner needs to be a member of one.
              </p>
              <p class="cxn-note">
                The reports are read inside the chosen workspace only; the key itself
                never leaves this machine.
              </p>
            </template>
            <div v-if="spacesError" class="cxn-error" role="alert">{{ spacesError }}</div>
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

    <!-- The folder lock's answer: one dialog, one job. It lives outside the tab
         body because the lock is what opens it, and a lock with its own modal is
         the shortest path from "what is it waiting for" to a folder. -->
    <DriveFolderPicker
      v-if="picker"
      :folder-id="lynkConfig.folderId"
      @close="picker = false"
      @pick="onFolderPicked"
    />
  </div>
</template>
