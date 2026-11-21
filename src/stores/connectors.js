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

export const connectors = reactive({
  workspace: '',
  loading: false,
  loaded: false,
  error: '',
  rows: [],
  counts: { workspace: 0, machine: 0 },
  path: '',
  poolPath: '',
  note: 'definitions travel with the workspace; tokens stay on this machine.',
})

const PROBED = new Set()

export function resetConnectors() {
  connectors.workspace = ''
  connectors.loading = false
  connectors.loaded = false
  connectors.error = ''
  connectors.rows = []
  connectors.counts = { workspace: 0, machine: 0 }
  PROBED.clear()
}

function adopt(answer) {
  if (!answer) return
  connectors.rows = answer.rows || []
  connectors.counts = answer.counts || { workspace: 0, machine: 0 }
  connectors.path = answer.path || ''
  connectors.poolPath = answer.poolPath || ''
  if (answer.note) connectors.note = answer.note
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
    connectors.loaded = true
    return connectors.rows
  } catch (error) {
    connectors.error = error?.message || 'Could not read this workspace\'s connectors.'
    connectors.rows = []
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
export async function addConnector({ id, label, kind }) {
  const answer = await call('connector.add', { workspace: hub.workspace, id, label, kind })
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

/**
 * Test one connector *before* it is saved.
 *
 * Three kinds, three cheap self-reports: an MCP server is one `tools/list`
 * through the pool, a CLI is its own `auth status`, a REST row is one `GET` at
 * `verify.path` expecting 2xx. A failure is the service's sentence plus the one
 * fact that matters — nothing was written.
 */
export async function testConnector({ kind, id, token, host } = {}) {
  if (kind === 'mcp') {
    const answer = await call('mcp.tools', { workspace: hub.workspace, name: id })
    const count = Array.isArray(answer?.tools) ? answer.tools.length : 0
    return {
      ok: true,
      detail: `${count} ${count === 1 ? 'tool' : 'tools'} answered${answer?.source ? ` · ${answer.source}` : ''}`,
    }
  }
  if (kind === 'cli') {
    const answer = await call('integration.test', { workspace: hub.workspace, id })
    return { ok: true, detail: answer?.detail || 'The CLI answered.' }
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
  }
}
