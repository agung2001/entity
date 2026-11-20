/**
 * How long a turn may run — the machine's one deadline.
 *
 * The value lives in `~/.entity/turn.json` and is read by the main process when a
 * turn starts, so it is not a workspace setting and not a per-thread one: every
 * conversation on this machine shares the clock.
 *
 * `source` is the whole reason this store exists rather than a plain number:
 * `environment` means the app was started with `ENTITY_TURN_TIMEOUT_MS` (the E2E
 * suite does), and then the field is read-only instead of silently ignoring
 * every edit.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

export const turn = reactive({
  loading: false,
  loaded: false,
  saving: false,
  error: '',
  writeError: '',
  turnTimeoutMs: 0,
  defaultMs: 0,
  source: 'default',
  choices: [],
  range: { min: 10 * 60_000, max: 6 * 60 * 60_000 },
  editable: true,
  file: 'turn.json',
  at: 0,
})

export const turnMinutes = () => Math.round((turn.turnTimeoutMs || 0) / 60_000)
export const defaultMinutes = () => Math.round((turn.defaultMs || 0) / 60_000)
export const minMinutes = () => Math.round((turn.range?.min || 0) / 60_000)
export const maxMinutes = () => Math.round((turn.range?.max || 0) / 60_000)

function adopt(data) {
  if (!data) return
  for (const key of [
    'turnTimeoutMs',
    'defaultMs',
    'source',
    'choices',
    'range',
    'editable',
    'file',
  ]) {
    if (data[key] !== undefined) turn[key] = data[key]
  }
  turn.loaded = true
  turn.at = Date.now()
}

export async function loadTurn({ force = false } = {}) {
  if (!force && turn.loaded) return turn
  turn.loading = true
  turn.error = ''
  try {
    adopt(await call('turn.status'))
    return turn
  } catch (problem) {
    turn.error = problem?.message || 'Could not read the turn limit.'
    turn.loaded = false
    return turn
  } finally {
    turn.loading = false
  }
}

/** Minutes go on the wire and milliseconds on disk; the store owns the one
    conversion so the view never multiplies by 60_000. */
export async function setTurnMinutes(minutes) {
  turn.saving = true
  turn.writeError = ''
  try {
    adopt(await call('turn.set', { turnTimeoutMs: Math.round(Number(minutes) * 60_000) }))
    return turn
  } catch (problem) {
    turn.writeError = problem?.message || 'The turn limit could not be saved.'
    throw problem
  } finally {
    turn.saving = false
  }
}

/** Back to whatever this build ships with — the one action that answers "I
    changed something and cannot remember the number it started at". */
export async function resetTurn() {
  return setTurnMinutes(defaultMinutes())
}

/** The label the card prints: a clock, in the unit people think in. */
export function turnLabel(ms = turn.turnTimeoutMs) {
  const minutes = Math.round((Number(ms) || 0) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  if (Number.isInteger(hours)) return `${hours} h`
  return `${Math.floor(hours)} h ${minutes % 60} min`
}
