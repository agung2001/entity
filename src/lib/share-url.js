// The packaged app loads its bundle from app.asar over file://, so a href resolved
// against the page URL exists only here; share only for the web build or a synced remote.
import { remoteFor } from '@/stores/remote'

export function shareBase(workspaceId) {
  try {
    const protocol = typeof window !== 'undefined' ? window.location.protocol : ''
    if (protocol === 'http:' || protocol === 'https:') return window.location.href
    const serverUrl = remoteFor(workspaceId)?.serverUrl
    if (!serverUrl) return ''
    const parsed = new URL(String(serverUrl))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`
  } catch {
    return ''
  }
}

export function shareHref(href, workspaceId) {
  try {
    const base = shareBase(workspaceId)
    if (!base) return ''
    return new URL(href, base).href
  } catch {
    return ''
  }
}
