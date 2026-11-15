// The packaged app loads its bundle from app.asar over file://, so a href resolved
// against the page URL exists only here; share a web/remote origin, or the entity: deep link.
import { remoteFor } from '@/stores/remote'

export function shareBase(workspaceId) {
  try {
    const protocol = typeof window !== 'undefined' ? window.location.protocol : ''
    if (protocol === 'http:' || protocol === 'https:') return window.location.href
    const serverUrl = remoteFor(workspaceId)?.serverUrl
    if (serverUrl) {
      try {
        const parsed = new URL(String(serverUrl))
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`
        }
      } catch {
        /* not a usable remote server */
      }
    }
    if (protocol === 'file:' && globalThis.desktop?.isElectron) return 'entity://open/'
    return ''
  } catch {
    return ''
  }
}

export function shareHref(href, workspaceId) {
  try {
    const base = shareBase(workspaceId)
    if (!base) return ''
    /* A hash-router href already starts with `#/`; joining it against the
       protocol origin would duplicate the path. */
    if (base === 'entity://open/') return href ? `${base}${href}` : ''
    return new URL(href, base).href
  } catch {
    return ''
  }
}

export function referenceBlock({ text, entity, workspace, when, url } = {}) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((entry) => entry.trim()) || ''
  const flat = line.replace(/\s+/g, ' ').trim()
  const quote = flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
  const date = when ? new Date(when) : null
  const stamp = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'just now'
  const lines = [
    `> ${quote}`,
    `— ${entity || 'entity'} · ${workspace || 'workspace'}/chat · ${stamp}`,
  ]
  if (url) lines.push(String(url))
  return lines.join('\n')
}
