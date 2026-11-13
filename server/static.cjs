/**
 * Static renderer files for the server build.
 *
 * The router uses history mode when the page is served over HTTP, so every
 * unknown *document* path (`/workspaces`, `/team/overview`) must return
 * index.html. An unknown path with an extension is a missing asset and gets a
 * real 404 — returning HTML for a missing `.js` is how a deploy turns into a
 * blank screen with a confusing MIME error.
 */
const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

function resolvedInside(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const clean = decoded.replace(/^\/+/, '')
  const file = path.resolve(root, ...clean.split('/').filter(Boolean))
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null
  return file
}

function statFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

function sendFile(req, res, file, stat) {
  const ext = path.extname(file).toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', MIME[ext] || 'application/octet-stream')
  res.setHeader('content-length', String(stat.size))
  /* Vite fingerprints everything under /assets; the shell must never be cached
     or a deploy leaves a client on the previous bundle forever. */
  if (file.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('cache-control', 'no-cache')
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

function createStatic({ distDir }) {
  const root = path.resolve(distDir)
  const indexFile = path.join(root, 'index.html')

  function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    let file = resolvedInside(root, pathname)
    if (!file) return false

    let stat = statFile(file)
    if (stat) {
      sendFile(req, res, file, stat)
      return true
    }

    /* Directory → index.html inside it. */
    if (!path.extname(pathname)) {
      file = resolvedInside(root, path.join(pathname, 'index.html'))
      if (file) {
        stat = statFile(file)
        if (stat) {
          sendFile(req, res, file, stat)
          return true
        }
      }
    }

    /* History-mode fallback: a document route, not a missing asset. */
    const accept = String(req.headers.accept || '')
    if (!path.extname(pathname) && (accept.includes('text/html') || accept === '*/*')) {
      const shell = statFile(indexFile)
      if (shell) {
        sendFile(req, res, indexFile, shell)
        return true
      }
    }
    return false
  }

  return { serve, root, indexFile, hasBuild: () => Boolean(statFile(indexFile)) }
}

module.exports = { createStatic, MIME }
