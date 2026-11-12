import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
/* The same modules the Electron main process uses. One parser, one runner, one
   call table — the browser dev server and the packaged app cannot drift apart. */
const ELECTRON_DIR = fileURLToPath(new URL('./electron/', import.meta.url))
const RPC_PATH = require.resolve('./electron/rpc.cjs')

/**
 * Local data for `npm run dev` (and `npm run preview`).
 *
 * In Electron the renderer goes through the preload bridge. In a plain browser
 * there is no bridge, so the Vite server mounts the same call table at
 * `POST /__entity/call` and streams run events at `GET /__entity/events`.
 * These routes exist only in the dev/preview server; a static deploy has none of
 * them, and the renderer shows an honest empty state instead of inventing data.
 */
function localDataPlugin() {
  /** live SSE responses — one per open window */
  const clients = new Set()
  let rpc = null

  function getRpc() {
    if (rpc) return rpc
    const { createRpc } = require(RPC_PATH)
    rpc = createRpc({
      emit: (event) => {
        const line = `data: ${JSON.stringify(event)}\n\n`
        for (const res of clients) {
          try {
            res.write(line)
          } catch {
            clients.delete(res)
          }
        }
      },
      reveal: () => {},
    })
    return rpc
  }

  function resetRpc() {
    try {
      rpc?.closeAll()
    } catch {
      /* the dev server is reloading anyway */
    }
    rpc = null
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(ELECTRON_DIR)) delete require.cache[key]
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        /* a prompt is text; 2 MB is far more than any of these calls needs */
        if (size > 2 * 1024 * 1024) {
          reject(new Error('Request body too large.'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function mount(middlewares) {
    middlewares.use(async (req, res, next) => {
      let url
      try {
        url = new URL(req.url || '/', 'http://localhost')
      } catch {
        return next()
      }
      if (!url.pathname.startsWith('/__entity/')) return next()

      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(payload))
      }

      try {
        if (url.pathname === '/__entity/events') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('Connection', 'keep-alive')
          res.write(': connected\n\n')
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }

        if (url.pathname === '/__entity/call' && req.method === 'POST') {
          const raw = await readBody(req)
          let payload = {}
          try {
            payload = raw ? JSON.parse(raw) : {}
          } catch {
            return send(400, { ok: false, error: 'Malformed JSON body.' })
          }
          const result = await getRpc().call(payload?.fn, payload?.args)
          return send(result.ok ? 200 : 400, result)
        }

        /* Compatibility reads: the same data the call table returns. */
        if (url.pathname === '/__entity/ssh-hosts') {
          const result = await getRpc().call('ssh.hosts')
          return send(200, result.data)
        }
        if (url.pathname === '/__entity/ssh-probe') {
          const alias = url.searchParams.get('alias') || ''
          if (!alias) return send(400, { error: 'alias is required' })
          const result = await getRpc().call('ssh.probe', { alias })
          return send(200, result.data)
        }
        if (url.pathname === '/__entity/skills') {
          const result = await getRpc().call('skills.scan')
          return send(200, result.data)
        }
        if (url.pathname === '/__entity/skill') {
          const result = await getRpc().call('skills.read', {
            harness: url.searchParams.get('harness') || '',
            name: url.searchParams.get('name') || '',
          })
          if (!result.data) return send(404, { error: 'skill not found' })
          return send(200, result.data)
        }
        return send(404, { error: 'unknown local endpoint' })
      } catch (error) {
        return send(500, { ok: false, error: String(error?.message || error) })
      }
    })
  }

  return {
    name: 'entity-local-data',
    configureServer(server) {
      mount(server.middlewares)
      /* electron/*.cjs sits outside the module graph; drop it when it changes so
         `/__entity/*` reflects the edit without restarting the server. */
      server.watcher.add(ELECTRON_DIR)
      server.watcher.on('change', (file) => {
        if (file.startsWith(ELECTRON_DIR)) resetRpc()
      })
    },
    configurePreviewServer(server) {
      mount(server.middlewares)
    },
  }
}

// `base: './'` keeps asset paths relative so the built app also loads from
// the `file://` protocol inside Electron.
export default defineConfig({
  base: './',
  plugins: [vue(), localDataPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Deliberately not Vite's default 5173, which other projects tend to hold.
    // strictPort is off: with a port clash Vite moves to the next free one, and
    // `scripts/dev-desktop.mjs` reads the port that was actually bound.
    port: Number(process.env.VITE_DEV_PORT) || 5183,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
