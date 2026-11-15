/**
 * Structured-clone boundary for the desktop bridge.
 *
 * `ipcRenderer.invoke` clones its arguments. Vue's reactive objects are Proxies,
 * and a Proxy cannot be cloned — the user sees "An object could not be cloned"
 * from a perfectly ordinary save. The browser path already JSON-encodes every
 * call, so the desktop path normalises the same way: DTOs only, no proxies.
 */
export function toPlain(value) {
  if (value === undefined) return {}
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error('That request could not be sent to the desktop app.')
  }
}
