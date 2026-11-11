/**
 * The local-data bridge.
 *
 * Inside Electron the preload bridge is the only way out, so everything goes
 * through `window.desktop`. In a plain browser (`npm run dev`) the Vite server
 * mounts the same three reads at `/__entity/*` (see vite.config.js) and this
 * module falls back to them. Anywhere else — a static deploy, `file://` without
 * preload — the call rejects so views can show an honest empty state instead of
 * inventing machines or skills.
 */

const LOCAL = '/__entity'

function bridge() {
  return globalThis.desktop
}

export const hasDesktopBridge = () =>
  Boolean(bridge()?.isElectron && typeof bridge()?.readSshHosts === 'function')

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
  if (!response.ok) throw new Error(payload?.error || `Local request failed (${response.status}).`)
  return payload
}

export async function readSshHosts() {
  if (hasDesktopBridge()) return bridge().readSshHosts()
  return request('/ssh-hosts')
}

export async function probeSshHost(alias) {
  if (hasDesktopBridge()) return bridge().probeSshHost(alias)
  return request(`/ssh-probe?alias=${encodeURIComponent(alias)}`)
}

export async function scanSkillLibraries() {
  if (hasDesktopBridge()) return bridge().scanSkills()
  return request('/skills')
}

export async function readSkillEntry(harness, name) {
  if (hasDesktopBridge()) return bridge().readSkill(harness, name)
  return request(`/skill?harness=${encodeURIComponent(harness)}&name=${encodeURIComponent(name)}`)
}
