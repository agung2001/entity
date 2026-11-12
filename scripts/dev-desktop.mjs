/**
 * Starts the Vite dev server, waits until it is actually listening, then boots
 * Electron pointed at the resolved URL.
 *
 * Using Vite's programmatic API (instead of `concurrently` + `wait-on`) means we
 * never guess the port: Vite may fall back to the next free one, and we read the
 * URL it really bound. Electron's lifetime owns the whole process, so closing
 * the window is enough to shut the dev server down too.
 */
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import electronPath from 'electron'

const require = createRequire(import.meta.url)
/* The dev server is also a parent of Electron, which is a parent of harnesses.
   One registry decides who outlives whom. */
const registry = require('./electron/child-registry.cjs')

const server = await createServer()
await server.listen()
server.printUrls()

const url = server.resolvedUrls?.local?.[0]
if (!url) {
  console.error('[dev:desktop] Vite did not expose a local URL; aborting.')
  await server.close()
  process.exit(1)
}

console.log(`[dev:desktop] launching Electron → ${url}`)

/* Tracked so a launcher that dies takes Electron with it, and so the next boot
   can reap Electron even after a hard kill. */
const child = registry.spawnTracked(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: url },
  kind: 'desktop',
  label: 'electron',
})

let shuttingDown = false

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  /* Electron stops its own children on quit; this covers the case where it does
     not get the chance — a crash, or a signal it never saw. */
  if (child.exitCode === null) child.kill('SIGTERM')
  await registry.stopAll({ graceMs: 1500 }).catch(() => {})
  await server.close().catch(() => {})
  process.exit(code)
}

child.on('error', async (error) => {
  console.error('[dev:desktop] failed to start Electron:', error)
  await shutdown(1)
})

child.on('exit', (code) => shutdown(code ?? 0))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
    shutdown(0)
  })
}

/* A launcher that dies without a handler still leaves the tree to the journal,
   which the next boot reaps. */
process.on('exit', () => {
  try {
    registry.stopAllSync()
  } catch {
    /* nothing left to stop */
  }
})
