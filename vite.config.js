import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
/* The same module the Electron main process uses. One parser, one scanner — the
   browser dev server and the packaged app cannot drift apart. */
const localDataPath = require.resolve('./electron/local-data.cjs')
const localData = () => require(localDataPath)

const LOCAL_DATA_FILE = fileURLToPath(new URL('./electron/local-data.cjs', import.meta.url))

/**
 * Local machine data for `npm run dev` (and `npm run preview`).
 *
 * In Electron the renderer goes through the preload bridge. In a plain browser
 * there is no bridge, so these endpoints expose the same three reads to the
 * Vite server that is already running on this machine. They are only mounted
 * by the dev/preview server; a static deploy has no route for them.
 */
function localDataPlugin() {
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
        if (url.pathname === '/__entity/ssh-hosts') {
          return send(200, localData().readSshHosts())
        }
        if (url.pathname === '/__entity/ssh-probe') {
          const alias = url.searchParams.get('alias') || ''
          if (!alias) return send(400, { error: 'alias is required' })
          return send(200, await localData().probeSshHost(alias))
        }
        if (url.pathname === '/__entity/skills') {
          return send(200, localData().scanSkillLibrary())
        }
        if (url.pathname === '/__entity/skill') {
          const harness = url.searchParams.get('harness') || ''
          const name = url.searchParams.get('name') || ''
          const entry = localData().readSkillEntry(harness, name)
          if (!entry) return send(404, { error: 'skill not found' })
          return send(200, entry)
        }
        return send(404, { error: 'unknown local endpoint' })
      } catch (error) {
        return send(500, { error: String(error?.message || error) })
      }
    })
  }

  return {
    name: 'entity-local-data',
    configureServer(server) {
      mount(server.middlewares)
      /* local-data.cjs sits outside the module graph; drop it when it changes
         so `/__entity/*` reflects the edit without restarting the server. */
      server.watcher.add(LOCAL_DATA_FILE)
      server.watcher.on('change', (file) => {
        if (file === LOCAL_DATA_FILE) delete require.cache[localDataPath]
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
