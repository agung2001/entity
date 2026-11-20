/**
 * Workspace artifacts are files under `<ws>/artifacts`. The renderer only sees
 * metadata and, on demand, text or a data URL; it never gets a filesystem path.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

export const artifacts = reactive({
  loading: false,
  loaded: false,
  error: '',
  workspace: '',
  path: '',
  items: [],
  /* The rail's filter, in the store rather than in the panel: the artifact page
     is a route, so pressing a scope would otherwise reset it on navigation. */
  scope: 'personal',
  counts: { personal: 0, shared: 0 },
})

/* Read-once cache. A thread renders its attached screenshots and documents
   every time it is opened; re-reading a data URL over the call table for each
   visit is pure waste. Writes clear the entry they touch. */
const reads = new Map()
const MAX_READS = 24
const readKey = (workspace, id) => `${workspace}:${id}`

function forgetRead(workspace, id) {
  if (id) {
    reads.delete(readKey(workspace, id))
    return
  }
  for (const key of [...reads.keys()]) if (key.startsWith(`${workspace}:`)) reads.delete(key)
}

export function resetArtifacts() {
  artifacts.loading = false
  artifacts.loaded = false
  artifacts.error = ''
  artifacts.workspace = ''
  artifacts.path = ''
  artifacts.items = []
  artifacts.counts = { personal: 0, shared: 0 }
  reads.clear()
}

/**
 * Take back the files nobody shared.
 *
 * The shared tree is what an export and a remote sync carry, and it used to fill
 * two ways: `share()` (a rename plus an index entry) and anything that wrote a
 * path under `artifacts/` directly — an agent told to leave its screenshot on
 * "the workspace artifact shelf", a render script, a hand-run command. Those
 * files were never shared, but they sat in the shared tree and a colleague got
 * them on the next sync. The store moves them to the personal root, where every
 * other unshared file lives; nothing is deleted, and a name the person already
 * has is kept as `<name>-2`.
 *
 * Run once per workspace from the shelf's own read, not on a timer: the moment
 * somebody looks at their artifacts is the moment to fix them.
 */
const adopted = new Set()

export async function adoptUnclaimedArtifacts(workspace = hub.workspace) {
  if (!workspace || adopted.has(workspace)) return null
  adopted.add(workspace)
  try {
    const result = await call('artifact.adopt', { workspace })
    if (result?.adopted?.length) {
      /* A file that changed shelf changes the list and the counts. */
      artifacts.loaded = false
      forgetRead(workspace)
    }
    return result
  } catch {
    /* the read below still answers; a failed adoption is not a failed shelf */
    return null
  }
}

export async function loadArtifacts(workspace = hub.workspace) {
  if (!workspace) {
    resetArtifacts()
    return []
  }
  /* Before the list, so the counts the panel paints are the ones it kept. */
  await adoptUnclaimedArtifacts(workspace)
  if (artifacts.workspace !== workspace) {
    artifacts.items = []
    artifacts.path = ''
  }
  artifacts.loading = true
  artifacts.error = ''
  try {
    const data = await call('artifact.list', { workspace })
    artifacts.workspace = workspace
    artifacts.path = data?.path || ''
    artifacts.items = data?.items || []
    artifacts.counts = data?.counts || { personal: 0, shared: 0 }
    artifacts.loaded = true
    return artifacts.items
  } catch (error) {
    artifacts.error = error?.message || 'Could not read the workspace artifacts.'
    artifacts.workspace = workspace
    artifacts.items = []
    artifacts.loaded = false
    return []
  } finally {
    artifacts.loading = false
  }
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function uploadArtifact(file) {
  const buffer = await file.arrayBuffer()
  const dataUrl = `data:${file.type || 'application/octet-stream'};base64,${bytesToBase64(buffer)}`
  const item = await call('artifact.upload', {
    workspace: hub.workspace,
    name: file.name,
    dataUrl,
  })
  await loadArtifacts()
  forgetRead(hub.workspace, item?.id)
  return item
}

export async function saveTextArtifact(name, text) {
  const item = await call('artifact.saveText', {
    workspace: hub.workspace,
    name,
    text,
  })
  await loadArtifacts()
  return item
}

export async function readArtifact(id) {
  const key = readKey(hub.workspace, id)
  const hit = reads.get(key)
  if (hit) return hit
  const value = await call('artifact.read', { workspace: hub.workspace, id })
  if (reads.size >= MAX_READS) reads.delete(reads.keys().next().value)
  reads.set(key, value)
  return value
}

export async function downloadArtifact(id) {
  return call('artifact.download', { workspace: hub.workspace, id })
}

export async function removeArtifact(id) {
  const result = await call('artifact.remove', { workspace: hub.workspace, id })
  forgetRead(hub.workspace, id)
  await loadArtifacts()
  return result
}

/**
 * Erase part of the shelf, from settings → Artifacts.
 *
 * `scope` is `shared` (`artifacts/` with its archive and its trash), `personal`
 * (this account's `.personal/<account>/artifacts/`) or `all`. The main process
 * removes the files; the window re-reads the shelf it was showing, so the counts,
 * the rail panel and the open preview cannot keep naming a file that is gone.
 */
export async function eraseArtifacts(scope = 'all') {
  const result = await call('artifact.eraseAll', { workspace: hub.workspace, scope })
  forgetRead(hub.workspace)
  hub.artifact.open = ''
  await loadArtifacts()
  return result
}

/** Both scope moves are the same shape: write the index, then re-read the shelf
 *  so the counts and the row's place come from the store, not from here. */
async function moveScope(channel, id) {
  const item = await call(channel, { workspace: hub.workspace, id })
  forgetRead(hub.workspace, id)
  await loadArtifacts()
  return item
}

export async function shareArtifact(id) {
  return moveScope('artifact.share', id)
}

export async function unshareArtifact(id) {
  return moveScope('artifact.unshare', id)
}

/**
 * Whether a row is the signed-in member's own. A personal file always is; a
 * shared one answers with the owner the store stamped, compared to the account
 * this window is signed in as. Used by the shelf's row and the artifact bar so
 * the two cannot disagree about who owns a file.
 */
export function ownsArtifact(item) {
  if (!item || item.scope !== 'shared') return true
  const owner = item.owner || {}
  const email = String(owner.email || '').toLowerCase()
  const mine = String(hub.account?.email || hub.session?.email || '').toLowerCase()
  if (email && mine) return email === mine
  const username = String(hub.account?.username || hub.session?.user || '').toLowerCase()
  return Boolean(username) && String(owner.name || '').toLowerCase() === username
}

/**
 * Save an editor draft back to the artifact it came from. The read cache for
 * that id is dropped, so the next open sees the bytes that are now on disk.
 */
export async function writeArtifactText(id, text) {
  const item = await call('artifact.writeText', {
    workspace: hub.workspace,
    id,
    text,
  })
  forgetRead(hub.workspace, id)
  await loadArtifacts()
  return item
}

export async function revealArtifact(id) {
  return call('artifact.reveal', { workspace: hub.workspace, id })
}

/**
 * Open an artifact with the verb its extension allows (`editor`, `browser`).
 * The server re-checks the verb against the file's own capabilities, so a dead
 * button here is a message, never a shell.
 */
export async function openArtifact(id, how) {
  return call('artifact.open', { workspace: hub.workspace, id, how })
}
