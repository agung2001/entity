/**
 * Serve the app against a disposable, invented profile — for a screenshot.
 *
 * `npm run dev` reads the real `~/.ssh/config` and the real workspace records, so
 * a picture of it is a picture of somebody's fleet. This starts the same dev
 * server with a scratch `ENTITY_HOME` **and** a scratch `HOME`, both under
 * `.tmp/`, so:
 *
 * - the ssh reader sees `seed-story.mjs`'s invented hosts and nothing else;
 * - nothing is written to `~/.entity/`;
 * - the profile is rebuilt from scratch on every run, so a stale picture cannot
 *   come from a stale seed.
 *
 * Usage:  node tests/support/story-server.mjs [--port 5183]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { seedStory } from './seed-story.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const argPort = process.argv.indexOf('--port')
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.STORY_PORT || 5183)
const BASE = `http://localhost:${PORT}`

const PROFILE = path.join(ROOT, '.tmp', 'story-profile')
const HOME = path.join(ROOT, '.tmp', 'story-home')
const STATE_DIR = path.join(ROOT, '.tmp', 'story')

const state = await seedStory({ root: ROOT, profile: PROFILE, stateDir: STATE_DIR, home: HOME })
console.log(`[story] invented profile at ${PROFILE}`)
console.log(`[story] scratch HOME at ${HOME} — ${state.workspaceLabel} / ${state.user.username}`)
console.log(`[story] open ${BASE}/${state.workspace}/settings?tab=machines`)

const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(vite)) {
  console.error('[story] vite is not installed. Run npm install first.')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [vite, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      /* both are needed: ENTITY_HOME is the app's profile, HOME is what the ssh
         reader resolves `~` against */
      ENTITY_HOME: PROFILE,
      HOME,
      /* the machine names itself in the hero's Local row and in the rail; a
         screenshot must not publish the machine it was taken on */
      ENTITY_HOSTNAME: 'studio-workstation',
      VITE_DEV_PORT: String(PORT),
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
  console.error(`[story] vite could not start: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  if (code && code !== 0) console.error(`[story] vite exited with ${code}`)
  process.exit(code ?? 0)
})
