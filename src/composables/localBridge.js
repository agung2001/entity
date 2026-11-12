/**
 * The local-data bridge.
 *
 * Inside Electron the preload bridge is the only way out, so everything goes
 * through `window.desktop`. In a plain browser (`npm run dev`) the Vite server
 * mounts the same call table at `POST /__entity/call` (see vite.config.js) and
 * streams run events at `/__entity/events`. Anywhere else — a static deploy,
 * `file://` without preload — the call rejects so views show an honest empty
 * state instead of inventing machines, skills or entities.
 */

const LOCAL = '/__entity'

function bridge() {
  return globalThis.desktop
}

export const hasDesktopBridge = () =>
  Boolean(bridge()?.isElectron && typeof bridge()?.call === 'function')

async function request(path, init) {
  const response = await fetch(`${LOCAL}${path}`, {
    headers: { accept: 'application/json' },
    ...init,
  })
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) {
    throw new Error('The local data endpoint is not available in this build.')
  }
  const payload = await response.json()
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Local request failed (${response.status}).`)
  }
  return payload
}

/**
 * One call shape for every read and write. The main process decides what the
 * name costs; the renderer never passes a path, a command or a shell string.
 */
export async function call(fn, args = {}) {
  if (hasDesktopBridge()) {
    const result = await bridge().call(fn, args)
    if (!result?.ok) throw new Error(result?.error || `${fn} failed.`)
    return result.data
  }
  const payload = await request('/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fn, args }),
  })
  return payload?.data
}

/** Subscribe to streamed run events. Returns an unsubscribe function. */
export function onRunEvent(cb) {
  if (hasDesktopBridge() && typeof bridge().onRunEvent === 'function') {
    return bridge().onRunEvent(cb)
  }
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource(`${LOCAL}/events`)
  source.onmessage = (event) => {
    try {
      cb(JSON.parse(event.data))
    } catch {
      /* a malformed frame is not worth killing the stream over */
    }
  }
  return () => source.close()
}

export async function readSshHosts() {
  return call('ssh.hosts')
}

export async function probeSshHost(alias, workspace = '') {
  return call('ssh.probe', { alias, workspace })
}

export async function scanSkillLibraries() {
  return call('skills.scan')
}

export async function readSkillEntry(harness, name) {
  return call('skills.read', { harness, name })
}
