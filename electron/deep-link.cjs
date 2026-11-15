/**
 * `entity://` carries a route in the hash, mirroring the renderer's hash
 * router. Everything here returns a plain path for vue-router, or '' when
 * there is nothing safe to navigate to.
 */
function routeFromUrl(raw) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return ''
  }
  if (url.protocol !== 'entity:') return ''

  /* `new URL` normalises `..` away; reject it from the raw text instead. */
  const rawText = String(raw || '')
  const rawPath = rawText.replace(/^entity:\/\/[^/?#]*/i, '').split(/[?#]/)[0]
  if (rawPath.split('/').some((segment) => segment === '..')) return ''
  const rawHash = rawText.includes('#') ? rawText.slice(rawText.indexOf('#') + 1).split('?')[0] : ''
  if (rawHash.split('/').some((segment) => segment === '..')) return ''

  let route = ''
  if (url.hash) {
    if (!url.hash.startsWith('#/')) return ''
    route = url.hash.slice(1)
  } else {
    /* `entity://open/` is the legacy focus-only link. */
    const pathname = (url.pathname || '').replace(/\/+$/, '')
    route = `${pathname}${url.search || ''}`
  }

  if (!route.startsWith('/')) return ''
  const pathOnly = route.split('?')[0].split('#')[0]
  if (pathOnly.split('/').some((segment) => segment === '..')) return ''
  return route
}

module.exports = { routeFromUrl }
