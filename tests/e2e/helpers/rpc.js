import { readProfile } from './profile.js'

/**
 * The dev server exposes the same call table as the Electron main process at
 * POST /__entity/call. Tests use it only to arrange state that the UI does not
 * expose (pinning a harness, for example), never to assert a UI outcome.
 */
export async function callRpc(p, fn, args = {}) {
  const response = await fetch(`${p.baseURL}/__entity/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fn, args }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `${fn} failed (${response.status})`)
  }
  return payload.data
}

export async function pinHarness(id, file) {
  const p = readProfile()
  return callRpc(p, 'harness.setPath', { id, path: file })
}

export async function harnessList(p = readProfile()) {
  return callRpc(p, 'harness.list', {})
}

export async function readEntity(p, name) {
  return callRpc(p, 'entity.read', { workspace: p.workspace, name })
}
