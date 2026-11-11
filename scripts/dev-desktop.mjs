/**
 * Starts the Vite dev server, waits until it is actually listening, then boots
 * Electron pointed at the resolved URL.
 *
 * Using Vite's programmatic API (instead of `concurrently` + `wait-on`) means we
 * never guess the port: Vite may fall back to the next free one, and we read the
 * URL it really bound. Electron's lifetime owns the whole process, so closing
 * the window is enough to shut the dev server down too.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

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

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: url },
})

let shuttingDown = false

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
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
