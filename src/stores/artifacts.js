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
})

export function resetArtifacts() {
  artifacts.loading = false
  artifacts.loaded = false
  artifacts.error = ''
  artifacts.workspace = ''
  artifacts.path = ''
  artifacts.items = []
}

export async function loadArtifacts(workspace = hub.workspace) {
  if (!workspace) {
    resetArtifacts()
    return []
  }
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
  return call('artifact.read', { workspace: hub.workspace, id })
}

export async function downloadArtifact(id) {
  return call('artifact.download', { workspace: hub.workspace, id })
}

export async function removeArtifact(id) {
  const result = await call('artifact.remove', { workspace: hub.workspace, id })
  await loadArtifacts()
  return result
}

export async function revealArtifact(id) {
  return call('artifact.reveal', { workspace: hub.workspace, id })
}
