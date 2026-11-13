/**
 * The fleet as it exists on this machine: every Host block in ~/.ssh/config.
 *
 * `hub.machines` stays the local execution target for agents and skills; this
 * store is the user's ssh fleet. A scan never runs on its own — the user clicks
 * a host, ssh connects with BatchMode, and the workspace keeps the capability
 * snapshot only when that connection and the read-only scan succeed.
 */
import { computed, reactive } from 'vue'
import { readSshHosts } from '@/composables/localBridge'
import { hub } from '@/stores/hub'
import { scanMachine } from '@/stores/workspaces'

export const fleet = reactive({
  loading: false,
  loaded: false,
  error: '',
  hostname: '',
  platform: '',
  configPath: '',
  displayPath: '~/.ssh/config',
  exists: false,
  hosts: [],
  /** alias → { state: 'idle' | 'testing' | 'ok' | 'fail', ms, message, reason } */
  probes: {},
})

let pending = null

export async function loadFleet() {
  if (pending) return pending
  fleet.loading = true
  pending = (async () => {
    try {
      const data = await readSshHosts()
      fleet.hostname = data.hostname || ''
      fleet.platform = data.platform || ''
      fleet.configPath = data.configPath || ''
      fleet.displayPath = data.displayPath || '~/.ssh/config'
      fleet.exists = Boolean(data.exists)
      fleet.hosts = Array.isArray(data.hosts) ? data.hosts : []
      fleet.error = ''
      fleet.loaded = true
    } catch (error) {
      fleet.error = error?.message || 'Could not read ~/.ssh/config.'
      fleet.hosts = []
      fleet.loaded = false
    } finally {
      fleet.loading = false
      pending = null
    }
  })()
  return pending
}

export const probeState = (alias) =>
  fleet.probes[alias] || { state: 'idle', ms: 0, message: '', reason: '' }

export async function probeHost(host) {
  const alias = host?.alias || host?.id || 'local'
  if (!alias) return
  const current = fleet.probes[alias]
  if (current?.state === 'testing') return

  fleet.probes[alias] = { state: 'testing', ms: 0, message: 'testing…', reason: '' }
  try {
    if (!hub.workspace) throw new Error('Open a workspace before scanning a host.')
    const facts = await scanMachine(alias)
    fleet.probes[alias] = {
      state: 'ok',
      ms: facts.durationMs || 0,
      message: `${facts.harnesses.length} harness${facts.harnesses.length === 1 ? '' : 'es'} found`,
      reason: '',
    }
  } catch (error) {
    fleet.probes[alias] = {
      state: 'fail',
      ms: 0,
      message: error?.message || 'The scan could not run.',
      reason: 'scan',
    }
  }
}

export const reachableCount = computed(
  () => Object.values(fleet.probes).filter((probe) => probe.state === 'ok').length,
)
