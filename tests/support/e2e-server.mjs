/**
 * The Playwright webServer for the E2E suite.
 *
 * 1. Resets `.tmp/` (profile, fixtures, prompt logs) unless E2E_REUSE_PROFILE=1.
 * 2. Seeds the profile through the app's own stores (no UI, no credentials).
 * 3. Starts Vite with that ENTITY_HOME and waits to be polled by Playwright.
 *
 * Nothing in the profile comes from the developer's real account, workspaces,
 * SSH config or MCP secrets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { seedProfile } from './seed-profile.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.E2E_PORT || 5199)
const BASE = `http://127.0.0.1:${PORT}`

const PROFILE = path.join(ROOT, '.tmp', 'e2e-profile')
const STATE_DIR = path.join(ROOT, '.tmp', 'e2e')
const EXTERNAL = path.join(ROOT, '.tmp', 'e2e-external')
const STUB_LOG = path.join(ROOT, '.tmp', 'e2e-harness-log')
const STATE_FILE = path.join(STATE_DIR, 'profile.json')

process.env.ENTITY_HOME = PROFILE
process.env.E2E_STUB_LOG = STUB_LOG

let state = null
if (process.env.E2E_REUSE_PROFILE === '1' && fs.existsSync(STATE_FILE)) {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  console.log(`[e2e] reusing profile ${PROFILE}`)
} else {
  const seeded = seedProfile({
    root: ROOT,
    profile: PROFILE,
    stateDir: STATE_DIR,
    external: EXTERNAL,
    stubLog: STUB_LOG,
  })
  state = seeded.state
  console.log(`[e2e] seeded profile ${PROFILE}`)
}

state.baseURL = BASE
fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(STATE_FILE, 0o600)

const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(vite)) {
  console.error('[e2e] vite is not installed. Run npm install first.')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [vite, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      ENTITY_HOME: PROFILE,
      VITE_DEV_PORT: String(PORT),
      E2E_STUB_LOG: STUB_LOG,
    },
    stdio: 'inherit',
  },
)

const stop = (signal) => {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('exit', () => stop('SIGTERM'))

child.on('error', (error) => {
  console.error(`[e2e] vite could not start: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  if (code && code !== 0) console.error(`[e2e] vite exited with ${code}`)
  process.exit(code ?? 0)
})
