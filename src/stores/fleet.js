/**
 * The fleet as it exists on this machine: every Host block in ~/.ssh/config.
 *
 * `hub.machines` stays the sample workspace for agents and skills; this store is
 * the real list the Machines view and the rail count from. A probe never runs on
 * its own — the user clicks a host, ssh connects with BatchMode, and the card
 * turns green only when that connection succeeds.
 */
import { computed, reactive } from 'vue'
import { probeSshHost, readSshHosts } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

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
  const alias = host?.alias
  if (!alias) return
  const current = fleet.probes[alias]
  if (current?.state === 'testing') return

  fleet.probes[alias] = { state: 'testing', ms: 0, message: 'testing…', reason: '' }
  const started = performance.now()
  try {
    /* the workspace's own machines/CONFIG is what gets tested once a workspace
       exists; a host that is only in ~/.ssh/config still works before setup */
    const result = await probeSshHost(alias, hub.workspace || '')
    fleet.probes[alias] = {
      state: result.ok ? 'ok' : 'fail',
      ms: result.ms ?? Math.round(performance.now() - started),
      message: result.message || (result.ok ? 'reachable' : 'unreachable'),
      reason: result.reason || '',
    }
  } catch (error) {
    fleet.probes[alias] = {
      state: 'fail',
      ms: Math.round(performance.now() - started),
      message: error?.message || 'The probe could not run.',
      reason: 'local',
    }
  }
}

export const reachableCount = computed(
  () => Object.values(fleet.probes).filter((probe) => probe.state === 'ok').length,
)
