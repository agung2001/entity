/**
 * How long a turn may run before the app stops it — one machine-wide number.
 *
 * Until now this was `ENTITY_TURN_TIMEOUT_MS` or a constant, which meant the
 * only way to change it was to edit the environment the app started with. That
 * is not a setting a person has, and the complaint that produced this file was
 * exactly that: "there is no option to control the maximum chat timeout limit".
 *
 * It belongs to the machine, not to a workspace: the deadline is armed by the
 * process that owns the turn, and every workspace on this machine runs in that
 * process. So it is one small file in `~/.entity/`, beside `harnesses.json`.
 *
 * Three rules:
 *
 *   1. **The file is a preference, not a schedule.** `turnTimeoutMs` is read when
 *      a turn starts, so a change lands on the next message rather than killing
 *      whatever is running.
 *   2. **The environment still wins.** `ENTITY_TURN_TIMEOUT_MS` is how the E2E
 *      suite and a CI job pin the number; a person's file must not be able to
 *      quietly outrank the harness that spawned the process. When both are set the
 *      environment is used and the page says so.
 *   3. **A turn is always bounded.** Zero, or a value outside `RANGE_MS`, is not
 *      "no limit": it falls back to the default. An unbounded turn is a leaked
 *      promise and a card that lies about still thinking.
 *
 * The environment is not clamped (`fromEnv`) — a test pins it to 1500 ms on
 * purpose — while the field is (`set`, which refuses rather than clamps).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `ENTITY_HOME` first, exactly like every other store: a test must never write
   the developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CONFIG = path.join(ROOT, 'turn.json')
const FILE = 'turn.json'

const DEFAULT_MS = 90 * 60_000
/* Ten minutes is the shortest deadline that can still land a review; six hours is
   a working day, which is the point at which the clock stops protecting anything
   and simply holds a process open. */
const RANGE_MS = { min: 10 * 60_000, max: 6 * 60 * 60_000 }
/* The picker's steps, in **minutes** (the unit the field and the page speak).
   A free-text field would accept 43 minutes and then be impossible to compare
   with anything. The store and the timer are in milliseconds; this list is the
   one place the two units meet, and the view converts. */
const CHOICES = [10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360]

const clamp = (ms) => {
  const n = Math.round(Number(ms))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MS
  return Math.min(RANGE_MS.max, Math.max(RANGE_MS.min, n))
}

/**
 * The environment's own clock, if the process was started with one.
 *
 * Used **as given**, not clamped: this is how a test pins the number to 1500 ms,
 * and a store that rounded it up to the ten-minute floor would turn a one-second
 * test into a ten-minute one. The range is a rule for the person's field, not for
 * the process's own environment.
 */
function fromEnv() {
  const n = Number(process.env.ENTITY_TURN_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return clamp(raw?.turnTimeoutMs)
  } catch {
    return DEFAULT_MS
  }
}

function writeConfig(ms) {
  const tmp = `${CONFIG}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 1, turnTimeoutMs: ms }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, CONFIG)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing was staged */
    }
    throw new Error(
      `${FILE} could not be written (${String(error?.message || error)}). Nothing changed.`,
    )
  }
  return ms
}

/**
 * The number a turn is actually armed with, and where it came from.
 *
 * `source` is what the page prints: `environment` means the process was started
 * with `ENTITY_TURN_TIMEOUT_MS` and the file cannot win, `file` means the person
 * chose it, `default` means nobody has.
 */
function status() {
  const configured = read()
  const env = fromEnv()
  if (env) {
    return {
      turnTimeoutMs: env,
      source: 'environment',
      defaultMs: DEFAULT_MS,
      choices: CHOICES,
      range: RANGE_MS,
      editable: false,
      file: FILE,
    }
  }
  return {
    turnTimeoutMs: configured,
    source: configured === DEFAULT_MS ? 'default' : 'file',
    defaultMs: DEFAULT_MS,
    choices: CHOICES,
    range: RANGE_MS,
    editable: true,
    file: FILE,
  }
}

/** What the turn path reads. One call, so the deadline and the brief agree. */
function turnTimeoutMs() {
  return fromEnv() || read()
}

/** Validate here, not in the view: the renderer only ever sends a number. */
function set({ turnTimeoutMs: ms } = {}) {
  const env = fromEnv()
  if (env) {
    throw new Error(
      'This app was started with ENTITY_TURN_TIMEOUT_MS, so the turn limit is the environment’s. Restart it without that variable to change it here.',
    )
  }
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) throw new Error('The turn limit must be a positive number of milliseconds.')
  /* Refused, not clamped: a value silently moved to the nearest legal step is a
     number the person never chose, saved as if they had. */
  if (n < RANGE_MS.min || n > RANGE_MS.max) {
    throw new Error(
      `The turn limit must be between ${RANGE_MS.min / 60_000} and ${RANGE_MS.max / 60_000} minutes.`,
    )
  }
  writeConfig(Math.round(n))
  return status()
}

module.exports = {
  CONFIG,
  DEFAULT_MS,
  RANGE_MS,
  CHOICES,
  read,
  status,
  turnTimeoutMs,
  set,
}
