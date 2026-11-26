/**
 * Connectors: one list, two scopes, three kinds.
 *
 * The page reads one merged list from the main process (`connector.list`) and
 * writes through the verb the store behind each field already owns — an MCP
 * server's binding through `workspace.writeMcp`, a credential through
 * `integrations.saveCredential`, a status line through `integrations.probe`.
 * Nothing here invents a fourth store; the merge is the feature.
 *
 * Verify before save is the rule the old YouTrack path already had
 * (`integrations-store.saveCredential`): the write is attempted, the service is
 * asked, and a refusal puts the file back — so a page that says "nothing was
 * saved" is telling the truth.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'
import { loadIntegrations, probeIntegrations } from '@/stores/integrations'


const PROBED = new Set()

/* Three populations, three panes: what this workspace has, what the app ships and
   this workspace has not installed, and what another app holds on this machine. */
export const connectors = reactive({
  workspace: '',
  loading: false,
  loaded: false,
  error: '',
  rows: [],
  available: [],
  /* the shipped catalog as the sheet's card groups read it — the same table the
     Built-in pane comes from, so the two lists cannot drift */
  catalog: [],
  machine: [],
  counts: { workspace: 0, machine: 0, available: 0 },
  path: '',
  poolPath: '',
  note: 'definitions travel with the workspace; tokens stay on this machine.',
})

export function resetConnectors() {
  connectors.workspace = ''
  connectors.loading = false
  connectors.loaded = false
  connectors.error = ''
  connectors.rows = []
  connectors.available = []
  connectors.catalog = []
  connectors.machine = []
  connectors.counts = { workspace: 0, machine: 0, available: 0 }
  PROBED.clear()
}

function adopt(answer) {
  if (!answer) return
  connectors.rows = answer.rows || []
  connectors.available = answer.available || []
  connectors.machine = answer.machine || []
  connectors.counts = answer.counts || { workspace: 0, machine: 0, available: 0 }
  connectors.path = answer.path || ''
  connectors.poolPath = answer.poolPath || ''
  if (answer.note) connectors.note = answer.note
}

/* ── accounts: the second read, and the one derived field ───────────────
   A connector that carries an account (`rest` + `oauth`) has N accounts on this
   machine, and the roster still draws **one row per connector**. So the count and
   the aggregate word are computed here, where the row is built, and the row gains
   no second status cell (spec §3). Counts read `3 accounts` / `1 account`, never
   `account(s)` (spec §6). */
const countOf = (n) => `${n} ${n === 1 ? 'account' : 'accounts'}`

function deriveAccounts(row, stored) {
  const accounts = Array.isArray(stored) ? stored : []
  const total = accounts.length
  const dead = accounts.filter((entry) => entry.status !== 'connected').length
  const ok = accounts.filter((entry) => entry.status === 'connected')
  const scope = ok[0]?.scopes?.[0] || ''
  /* The four words `toneOf()` already reads: zero accounts keeps today's
     `not probed`, anything dead is `needs sign-in`, everything fine is
     `connected`. */
  const status = total === 0 ? 'not probed' : dead > 0 ? 'needs sign-in' : 'connected'
  const statusDetail =
    total === 0
      ? 'no account connected'
      : dead > 0
        ? `${dead} of ${countOf(total)}`
        : [countOf(total), scope].filter(Boolean).join(' · ')
  return { accounts, accountCount: total, accountsLabel: total ? countOf(total) : '', status, statusDetail }
}

/** Set the derived account fields on every oauth row, from one map read. */
function applyAccounts(rows, map) {
  const book = map && typeof map === 'object' ? map : {}
  return rows.map((row) => (row.oauth ? { ...row, ...deriveAccounts(row, book[row.id]) } : row))
}

/** The merged list. Cheap: one directory walk, one pool read, one harness scan. */
export async function loadConnectors(workspace = hub.workspace) {
  if (!workspace) {
    resetConnectors()
    return []
  }
  connectors.loading = true
  connectors.error = ''
  try {
    const answer = await call('connector.list', { workspace })
    connectors.workspace = workspace
    adopt(answer)
    /* The accounts are a second read on purpose: they live on this machine, and a
       roster must paint from the index even when that file is unreadable. A
       failure leaves the rows exactly as `adopt` drew them — no error banner. */
    try {
      connectors.rows = applyAccounts(connectors.rows, await call('connector.accounts'))
    } catch {
      /* no account list: the roster keeps the index's own answer */
    }
    /* The shipped catalog is a literal in the main process; the sheet's groups
       read it so they cannot list fewer connectors than the app ships. */
    try {
      connectors.catalog = await call('connector.catalog')
    } catch {
      /* no catalog: the sheet's own groups still draw */
    }
    connectors.loaded = true
    return connectors.rows
  } catch (error) {
    connectors.error = error?.message || 'Could not read this workspace\'s connectors.'
    connectors.rows = []
    connectors.available = []
    connectors.machine = []
    connectors.loaded = false
    return []
  } finally {
    connectors.loading = false
  }
}

/**
 * The status line, second. The rows paint from the definition files; the probe
 * spawns `orca`, spawns `gh` and searches YouTrack, so it lands later and is
 * cached — coming back to this page does not re-sign-in to anything.
 */
export async function probeConnectors({ workspace = hub.workspace, force = false } = {}) {
  if (!workspace) return
  /* The probe is cached in main for minutes and here for the session: coming back
     to the page paints the rows and their status line without asking a CLI again. */
  if (!force && PROBED.has(workspace)) return
  try {
    await loadIntegrations({ workspace })
    const rows = await probeIntegrations({ workspace, force })
    PROBED.add(workspace)
    const byId = new Map((rows || []).map((row) => [row.id, row]))
    connectors.rows = connectors.rows.map((row) => {
      const hit = byId.get(row.id)
      if (!hit) return row
      return {
        ...row,
        status: row.status === 'parked' || row.status === 'in the pool' ? row.status : hit.status,
        statusDetail: hit.detail || row.statusDetail,
        enabled: hit.enabled,
        available: hit.available,
        /* What the probe actually saw. The row keeps it so a detail page can
           answer "is this the account I meant" without spending a second probe
           — `@login` plus what the token may touch, or the projects it listed. */
        samples: Array.isArray(hit.samples) ? hit.samples : [],
        total: Number.isFinite(hit.total) ? hit.total : null,
        samplesLabel: hit.samplesLabel || '',
      }
    })
    /* a probe that answers changes nothing about the counts: they count
       definitions, not statuses */
  } catch {
    /* the rows stay: `not probed` is a state, not an empty page */
  }
}

/* ── the verbs ─────────────────────────────────────────────────────── */

/** `Add connector` writes to the workspace by default: it is the case that syncs. */
export async function addConnector({ id, label, kind, command, url, args, env, binary, verify, oauth }) {
  const answer = await call('connector.add', {
    workspace: hub.workspace,
    id,
    label,
    kind,
    command,
    url,
    args,
    env,
    binary,
    verify,
    oauth,
  })
  adopt(answer)
  return answer
}

export async function installConnector(id) {
  const answer = await call('connector.install', { workspace: hub.workspace, id })
  adopt(answer)
  return answer
}

export async function uninstallConnector(id) {
  const answer = await call('connector.uninstall', { workspace: hub.workspace, id })
  adopt(answer)
  return answer
}

export async function adoptConnector(id) {
  const answer = await call('connector.adopt', { workspace: hub.workspace, id })
  adopt(answer)
  return answer
}

/** `Copy here`: an explicit copy into the workspace. Credentials do not travel. */
export async function copyConnector(id) {
  const answer = await call('connector.copy', { workspace: hub.workspace, id })
  adopt(answer)
  return answer
}

export async function removeConnector(id) {
  const answer = await call('connector.remove', { workspace: hub.workspace, id })
  adopt(answer)
  return answer
}

/* ── the account verbs ───────────────────────────────────────────────
   Each one re-derives the aggregate afterwards, so the roster row and the
   connector's page cannot disagree about how many accounts there are. */

/** Every account stored for one connector, on this machine. */
export async function loadAccounts(connectorId) {
  const map = await call('connector.accounts')
  connectors.rows = applyAccounts(connectors.rows, map)
  return connectors.rows.find((row) => row.id === connectorId)?.accounts || []
}

export async function removeAccount({ connector, account }) {
  await call('connector.account.remove', { connector, account })
  return loadAccounts(connector)
}

export async function testAccounts(connectorId) {
  const answer = await call('connector.account.test', { connector: connectorId })
  await loadAccounts(connectorId)
  return answer
}

export async function connectAccount(connectorId) {
  /* The workspace decides which scope tier the consent asks for, so it has to
     travel with the call: without it the main process falls back to the default
     and a workspace set to `read` would silently be asked for full access. */
  const answer = await call('connector.account.connect', {
    connector: connectorId,
    workspace: hub.workspace,
  })
  if (answer?.ok) await loadAccounts(connectorId)
  return answer
}

/** Is an OAuth client saved for this provider? Reports a hint, never the secret. */
export async function oauthStatus(provider = 'google') {
  return call('connector.oauth.status', { provider })
}

/** Which provider a connector authenticates against (`google` | `x`). */
export async function providerOf(connectorId) {
  return call('connector.oauth.provider', { connector: connectorId })
}

/** The provider's display name ('Google', 'X') for the card's button. */
export async function oauthLabel(provider = 'google') {
  return call('connector.oauth.label', { provider })
}

export async function setOauthClient({ provider = 'google', clientId, clientSecret }) {
  return call('connector.oauth.setClient', { provider, clientId, clientSecret })
}

export async function clearOauthClient(provider = 'google') {
  return call('connector.oauth.clearClient', { provider })
}

/** Read a dropped `credentials.json` for confirmation. Answers the id and a mask. */
export async function readOauthClientFile({ provider = 'google', text }) {
  return call('connector.oauth.clientFile', { provider, text })
}

/** Save from a dropped `credentials.json`. Parsing happens in the main process. */
export async function setOauthClientFile({ provider = 'google', text }) {
  return call('connector.oauth.setClientFile', { provider, text })
}

/** The access tiers a connector offers, with the chosen one marked. */
export async function loadTiers(connectorId) {
  return call('connector.account.tiers', { connector: connectorId, workspace: hub.workspace })
}

/* ── the Lynk.id report's settings ───────────────────────────────────

   Lynk.id has no syntax to configure, so everything it needs is a field on the
   connector row: which Drive folder, which tab suffix, and the two facts the
   numbers are printed in (rupiah, Jakarta time). They live in `connectors.json`
   beside the binding — not in a file of their own, and not as a constant — so two
   workspaces may point at two folders and neither report leaks into the other.

   `folderId` is the one that matters: it is the dashboard's cache key, which is
   why changing it anywhere goes through here. */
export const lynkConfig = reactive({
  folderId: '',
  folderName: '',
  sheetSuffix: ' - Transactions',
  currency: 'IDR',
  timezone: 'Asia/Jakarta',
  loaded: false,
  loading: false,
  error: '',
})

function adoptLynk(fields) {
  lynkConfig.folderId = String(fields?.folderId || '')
  lynkConfig.folderName = String(fields?.folderName || '')
  lynkConfig.sheetSuffix = String(fields?.sheetSuffix || ' - Transactions')
  lynkConfig.currency = String(fields?.currency || 'IDR')
  lynkConfig.timezone = String(fields?.timezone || 'Asia/Jakarta')
  return lynkConfig
}

/** The folder this workspace reads, as stored. Cheap enough to run on the page. */
export async function loadLynkConfig({ id = 'lynk' } = {}) {
  lynkConfig.loading = true
  try {
    adoptLynk(await call('connector.fields', { workspace: hub.workspace, id }))
    lynkConfig.error = ''
  } catch (problem) {
    lynkConfig.error = String(problem?.message || problem)
  } finally {
    lynkConfig.loading = false
    lynkConfig.loaded = true
  }
  return lynkConfig
}

/**
 * Write the settings. Answers the row as stored, so the page never prints what it
 * hoped was saved: `connector.setFields` refuses a malformed folder id and a
 * non-IANA timezone, and the refusal is the caller's message to show.
 */
export async function saveLynkConfig(fields = {}, { id = 'lynk' } = {}) {
  const answer = await call('connector.setFields', {
    workspace: hub.workspace,
    id,
    fields,
  })
  adoptLynk(answer)
  lynkConfig.error = ''
  /* The folder just changed the answer's identity, and the stored report belongs
     to the folder that was read. `Forget` is the same call with an empty id. */
  await call('connector.lynkForget').catch(() => null)
  return answer
}

/** Point the dashboard at nothing — the tab locks, and the card offers a picker. */
export async function forgetLynkFolder({ id = 'lynk' } = {}) {
  return saveLynkConfig({ folderId: '', folderName: '' }, { id })
}

/** Choose how much this connector's accounts may do. The next consent asks for it. */
export async function setTier({ connector, tier }) {
  const answer = await call('connector.account.setTier', {
    workspace: hub.workspace,
    id: connector,
    tier,
  })
  adopt(answer)
  return answer
}

/**
 * Test one connector *before* it is saved.
 *
 * Three kinds, three cheap self-reports: an MCP server is one `tools/list`
 * through the pool, a CLI is its own `auth status`, a REST row is one `GET` at
 * `verify.path` expecting 2xx. A failure is the service's sentence plus the one
 * fact that matters — nothing was written.
 */
export async function testConnector({ kind, id, token, host, verify, binary } = {}) {
  if (kind === 'mcp') {
    const answer = await call('mcp.tools', { workspace: hub.workspace, name: id })
    const count = Array.isArray(answer?.tools) ? answer.tools.length : 0
    return {
      ok: true,
      detail: `${count} ${count === 1 ? 'tool' : 'tools'} answered${answer?.source ? ` · ${answer.source}` : ''}`,
    }
  }
  if (kind === 'cli') {
    /* `integrations.test`, not `integration.test`: the call table registers the
       plural, the same noun as the store that answers it. */
    /* A shipped row is tested by the app's own code; a custom one carries the
       self-report its person declared, so the call needs both. */
    const answer = await call('integrations.test', { workspace: hub.workspace, id, verify, binary })
    /* Carry the probe's own facts through: a project list or an identity is the
       difference between "it answered" and "it is the one I meant". */
    return {
      ok: true,
      detail: answer?.detail || 'The CLI answered.',
      samples: Array.isArray(answer?.samples) ? answer.samples : [],
      total: answer?.total ?? null,
      samplesLabel: answer?.samplesLabel || '',
    }
  }
  /* rest: the credential write is itself the verify (it is rolled back on
     failure), so the test is the same call the save makes */
  const answer = await call('integrations.saveCredential', {
    workspace: hub.workspace,
    id,
    token,
    host,
  })
  return {
    ok: true,
    detail: answer?.host ? `${answer.host} · token verified` : 'The endpoint answered.',
    samples: answer?.host ? [answer.host] : [],
  }
}
