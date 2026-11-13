/**
 * Remote connections, as the window sees them.
 *
 * The sync itself runs in the main process (or the Vite data server); this store
 * only asks for status, starts a manual pass, and turns streamed
 * `remote-sync` events into a toast and a badge. The token never crosses into
 * the renderer — it lives in `<workspace>/.remote.token` on disk.
 */
import { reactive } from 'vue'
import { call, onRunEvent } from '@/composables/localBridge'
import { toast } from '@/stores/hub'
import { loadWorkspaceList } from '@/stores/workspaces'

export const remote = reactive({
  loaded: false,
  loading: false,
  error: '',
  /** workspace id → the public connection state */
  items: {},
  /** workspace id → the findings that stopped the last sync */
  findings: {},
  /** one action at a time; values are `connect`, `sync:<id>`, `approve:<id>` */
  busy: '',
  /** the workspace whose remote panel is open */
  panel: '',
  /** true on the shared-server build: remote sync is a client feature */
  server: false,
})

let streamed = false
const refreshTimers = new Map()

function refreshOne(id) {
  if (!id) return
  clearTimeout(refreshTimers.get(id))
  const timer = setTimeout(async () => {
    refreshTimers.delete(id)
    try {
      const state = await call('remote.status', { id })
      if (state?.connected) remote.items = { ...remote.items, [id]: state }
      else {
        const next = { ...remote.items }
        delete next[id]
        remote.items = next
      }
    } catch {
      /* the next manual reload is the fallback */
    }
  }, 120)
  refreshTimers.set(id, timer)
}

function summaryLine(result) {
  const summary = result?.summary || {}
  const parts = []
  if (summary.pulled) parts.push(`${summary.pulled} pulled`)
  if (summary.pushed) parts.push(`${summary.pushed} pushed`)
  if (summary.deletedRemote) parts.push(`${summary.deletedRemote} removed remotely`)
  if (summary.deletedLocal) parts.push(`${summary.deletedLocal} removed locally`)
  if (summary.conflicts?.length) parts.push(`${summary.conflicts.length} conflict${summary.conflicts.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function onRemoteEvent(event) {
  if (!event || event.kind !== 'remote-sync' || !event.workspace) return
  const id = event.workspace
  refreshOne(id)

  if (event.status === 'blocked') {
    const count = Array.isArray(event.findings) ? event.findings.length : 0
    remote.findings = { ...remote.findings, [id]: event.findings || [] }
    toast(
      `Sync stopped: ${count || 'a'} suspicious file${count === 1 ? '' : 's'} in the remote workspace. Nothing was written.`,
    )
    return
  }
  if (event.status === 'unauthorized') {
    toast('Remote sync stopped: the server rejected this session. Reconnect to continue.')
    return
  }
  if (event.status === 'error') {
    toast(`Remote sync failed: ${event.error || 'the server did not answer.'}`)
    return
  }
  if (event.status === 'idle') {
    const line = summaryLine(event)
    remote.findings = { ...remote.findings, [id]: [] }
    if (line && event.reason !== 'poll') toast(`Remote synced · ${line}`)
    if (event.quarantined?.length) {
      toast(
        `${event.quarantined.length} MCP server${event.quarantined.length === 1 ? '' : 's'} from the server parked for review.`,
      )
    }
    if (event.mcpDiverged?.length) {
      toast(
        `MCP definitions changed on the server; the local copy of ${event.mcpDiverged.join(', ')} was kept.`,
      )
    }
  }
}

/** One stream per window; safe to call from every mount. */
export function ensureRemoteStream() {
  if (streamed) return
  streamed = true
  onRunEvent(onRemoteEvent)
}

export function remoteFor(id) {
  return remote.items[String(id || '')] || null
}

export function isRemote(id) {
  return Boolean(remoteFor(id))
}

export async function loadRemote() {
  remote.loading = true
  remote.error = ''
  try {
    const mode = await call('server.mode').catch(() => ({ server: false }))
    remote.server = Boolean(mode?.server)
    if (remote.server) {
      remote.items = {}
      remote.loaded = true
      return {}
    }
    const list = await call('remote.list')
    remote.items = Object.fromEntries(
      (Array.isArray(list) ? list : []).map((entry) => [entry.workspace, entry]),
    )
    remote.loaded = true
    return remote.items
  } catch (error) {
    remote.error = error?.message || 'Remote connections could not be read.'
    remote.items = {}
    remote.loaded = true
    return {}
  } finally {
    remote.loading = false
  }
}

export async function discoverRemote({ serverUrl, email, password }) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = 'discover'
  try {
    return await call('remote.discover', { serverUrl, email, password })
  } finally {
    remote.busy = ''
  }
}

/**
 * Clone a remote workspace locally and run the first pull. The new workspace is
 * *not* opened automatically: the person is still on the workspace picker and
 * the card appearing there is the confirmation that the pull succeeded.
 */
export async function connectRemote({ serverUrl, email, password, remoteWorkspace, label, guard }) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = 'connect'
  try {
    const result = await call('remote.connect', {
      serverUrl,
      email,
      password,
      remoteWorkspace,
      label,
      ...(guard ? { guard } : {}),
    })
    await loadWorkspaceList().catch(() => {})
    await loadRemote()
    if (result?.result?.blocked) {
      remote.findings = {
        ...remote.findings,
        [result.record.id]: result.result.findings || [],
      }
    }
    return result
  } finally {
    remote.busy = ''
  }
}

export async function syncRemote(id) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = `sync:${id}`
  try {
    const result = await call('remote.sync', { id, reason: 'manual' })
    const state = await call('remote.status', { id }).catch(() => null)
    if (state?.connected) remote.items = { ...remote.items, [id]: state }
    if (result?.blocked) remote.findings = { ...remote.findings, [id]: result.findings || [] }
    else if (result?.ok) {
      remote.findings = { ...remote.findings, [id]: [] }
      const line = summaryLine(result)
      toast(line ? `Remote synced · ${line}` : 'Remote is already up to date')
    }
    return result
  } finally {
    remote.busy = ''
  }
}

/**
 * Approve the exact bytes the user just reviewed. The server hashes are carried
 * through, so editing the file again re-arms the guard.
 */
/** Change the second-opinion evaluator for a connected workspace. */
export async function setRemoteGuard(id, guard) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = `guard:${id}`
  try {
    const state = await call('remote.setGuard', { id, guard })
    if (state?.connected) remote.items = { ...remote.items, [id]: state }
    toast(
      state?.guard?.enabled
        ? `Sync evaluator: ${state.guard.harness}${state.guard.model ? ` · ${state.guard.model}` : ''}`
        : 'Sync evaluator off',
    )
    return state
  } finally {
    remote.busy = ''
  }
}

/** Refresh the session token after the server rejected the old one. */
export async function reconnectRemote(id, password) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = `reconnect:${id}`
  try {
    const result = await call('remote.reconnect', { id, password })
    const state = await call('remote.status', { id }).catch(() => null)
    if (state?.connected) remote.items = { ...remote.items, [id]: state }
    if (result?.ok) {
      remote.findings = { ...remote.findings, [id]: [] }
      toast('Remote session refreshed')
    }
    return result
  } finally {
    remote.busy = ''
  }
}

export async function approveRemote(id, findings) {
  if (remote.busy) throw new Error('A remote action is already running.')
  const items = (Array.isArray(findings) ? findings : [])
    .filter((finding) => finding?.path && finding?.sha256)
    .map((finding) => ({ path: finding.path, sha256: finding.sha256 }))
  if (!items.length) throw new Error('There is nothing to approve.')
  remote.busy = `approve:${id}`
  try {
    const result = await call('remote.approve', { id, items })
    const state = await call('remote.status', { id }).catch(() => null)
    if (state?.connected) remote.items = { ...remote.items, [id]: state }
    if (result?.ok) {
      remote.findings = { ...remote.findings, [id]: [] }
      toast('Approved content synced')
    }
    return result
  } finally {
    remote.busy = ''
  }
}

export async function disconnectRemote(id, { forget = true } = {}) {
  if (remote.busy) throw new Error('A remote action is already running.')
  remote.busy = `disconnect:${id}`
  try {
    const result = await call('remote.disconnect', { id, forget })
    await loadWorkspaceList().catch(() => {})
    const next = { ...remote.items }
    delete next[id]
    remote.items = next
    const findings = { ...remote.findings }
    delete findings[id]
    remote.findings = findings
    toast(forget ? 'Remote disconnected · local files kept' : 'Remote sync paused')
    return result
  } finally {
    remote.busy = ''
  }
}

export function openRemotePanel(id = '') {
  remote.panel = String(id || '')
}

export function closeRemotePanel() {
  remote.panel = ''
}
