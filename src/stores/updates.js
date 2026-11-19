/**
 * The auto-update state, read once and then pushed.
 *
 * One store for both surfaces: the rail tile and the page are two subscribers,
 * not two requests. The main process owns the updater and the timer, so this is
 * only the request lifecycle — a read on mount, a write per action, and the
 * `update.state` event the call table already broadcasts. There is no polling:
 * a check is a timer in the main process or a button here.
 */
import { reactive } from 'vue'
import { call, onRunEvent } from '@/composables/localBridge'

export const updates = reactive({
  loaded: false,
  loading: false,
  busy: '',
  status: '',
  manual: false,
  current: '',
  latest: '',
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  notes: [],
  notesUrl: '',
  publishedAt: '',
  checkedAt: '',
  platform: '',
  arch: '',
  error: null,
  settings: { auto: true, installOnQuit: true },
  /* the sentence a failed action wants to show next to the updater's own code */
  actionError: '',
})

/**
 * `AccountBackupView`'s format, kept here so the rail popover and the page print
 * the same `102 MB` from the same function.
 */
export function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** A `setSettings` answer is the whole picture again; so is every event. */
function apply(next) {
  if (!next || typeof next !== 'object') return
  for (const key of [
    'status',
    'manual',
    'current',
    'latest',
    'percent',
    'bytesPerSecond',
    'transferred',
    'total',
    'notesUrl',
    'publishedAt',
    'checkedAt',
    'platform',
    'arch',
  ]) {
    if (next[key] !== undefined) updates[key] = next[key]
  }
  if (Array.isArray(next.notes)) updates.notes = next.notes
  if (next.settings) updates.settings = { ...updates.settings, ...next.settings }
  updates.error = next.error ? { ...next.error } : null
}

function messageOf(error) {
  return String(error?.message || error).replace(/^Error:\s*/, '')
}

export async function loadUpdates() {
  if (updates.loading) return updates
  updates.loading = true
  try {
    apply(await call('update.state'))
    updates.loaded = true
  } catch {
    /* A read that cannot reach the call table is a build with no updater, not a
       failure to report: the page shows `dev build` and offers nothing. */
    updates.status = updates.status || 'dev'
  } finally {
    updates.loading = false
  }
  return updates
}

/**
 * Run one action. The answer is the new state, so the page never has to guess
 * what a click did; the event that follows paints the same thing again.
 */
async function act(kind, fn, args = {}) {
  if (updates.busy) return updates
  updates.busy = kind
  updates.actionError = ''
  try {
    apply(await call(fn, args))
  } catch (error) {
    updates.actionError = messageOf(error)
  } finally {
    updates.busy = ''
  }
  return updates
}

export const checkUpdates = () => act('check', 'update.check', { byPerson: true })
export const downloadUpdate = () => act('download', 'update.download')
export const installUpdate = () => act('install', 'update.install')
export const saveUpdateSettings = (patch) => act('settings', 'update.setSettings', patch)

/* One subscription, started the first time a surface asks for the state. */
let off = null

export function ensureUpdateStream() {
  if (off) return
  off = onRunEvent((event) => {
    if (event?.kind === 'update.state') apply(event)
  })
}
