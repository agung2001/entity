/**
 * GOAL.js — the only path a number takes to the screen (§8).
 *
 * A goal stores one script. `Refresh` runs it here, in the main process, and the
 * object it returns is the whole read the page may print. Nothing else writes a
 * figure: a tick writes a `done` boolean, and the bar keeps the numbers its last
 * read answered with.
 *
 * The sandbox has **no capability it was not given**. A fresh `vm` context holds
 * `goal`, `sources`, `connectors`, `cache`, `log` and `signal` and nothing else:
 * no `require`, no `fetch`, no `fs`, no `process`, no environment. `goal` is JSON
 * and the four helpers are built *inside* the context on purpose — a host
 * function passed in would hand the script `fn.constructor`, which is the host
 * `Function`, and that is an escape to `process` in one line.
 *
 * A throw, a timeout, a non-function export and a malformed answer all end as
 * `read: null`. `null` prints an em dash; `0` would be a claim.
 */
const vm = require('node:vm')

const TIMEOUT_MS = 3_000
const MAX_SCRIPT = 64 * 1024

const INT = (value) => (Number.isInteger(value) ? value : null)
const SOURCE_STATES = new Set(['ok', 'off', 'error'])

/**
 * The read, field by field, as §8 declares it. Anything that does not match is
 * `null` rather than a coerced number: `Number("n/a")` is `NaN`, and `NaN` in a
 * percentage is how a bar comes to print something it was never told.
 */
function readOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const next = raw.next && typeof raw.next === 'object' ? raw.next : null
  return {
    done: INT(raw.done) ?? 0,
    /* `null` is the failed read, and it is preserved — this is the one field the
       page tests before it prints anything. */
    total: INT(raw.total),
    late: INT(raw.late),
    next: next ? { title: String(next.title || ''), due: String(next.due || '') } : null,
    deadlineDays: INT(raw.deadlineDays),
    slip: INT(raw.slip),
    sources: Array.isArray(raw.sources)
      ? raw.sources
          .filter((source) => source && typeof source === 'object')
          .map((source) => ({
            kind: String(source.kind || ''),
            label: String(source.label || ''),
            state: SOURCE_STATES.has(String(source.state)) ? String(source.state) : 'error',
            readAt: String(source.readAt || ''),
          }))
      : [],
  }
}

/* U+2028 and U+2029 end a line in JS but are legal inside a JSON string, so a
   goal title carrying one would close the literal it was pasted into. */
const literal = (value) =>
  JSON.stringify(value ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** A fresh context whose globals are data, or functions built from data. */
function contextFor(goal) {
  const context = vm.createContext({})
  vm.runInContext(
    `globalThis.goal = ${literal(goal)};
     globalThis.sources = [];
     globalThis.connectors = {};
     globalThis.cache = {};
     globalThis.signal = { aborted: false };
     globalThis.__log = [];
     globalThis.log = (...parts) => {
       globalThis.__log.push(parts.map((part) => {
         try { return typeof part === 'string' ? part : JSON.stringify(part); }
         catch { return String(part); }
       }).join(' '));
     };`,
    context,
    { timeout: TIMEOUT_MS },
  )
  return context
}

function logsOf(context) {
  try {
    return JSON.parse(vm.runInContext('JSON.stringify(globalThis.__log)', context, { timeout: 500 }))
  } catch {
    return []
  }
}

/**
 * Run one goal's script. Never throws: the caller writes `read` (or `null`) and
 * the reason, because a Refresh that failed is a sentence on the page, not a
 * rejected call.
 */
async function run(script, { goal } = {}) {
  const code = String(script || '').trim()
  if (!code) return { read: null, logs: [], error: '' }
  if (code.length > MAX_SCRIPT) {
    return { read: null, logs: [], error: `GOAL.js is larger than ${MAX_SCRIPT / 1024} kB.` }
  }

  const context = contextFor(goal)
  let timer
  try {
    /* §8 documents the script as `export default (async ({ goal, sources }) => …)`.
       A stored string is an expression, so the module keyword is dropped — both
       shapes run. */
    const expression = code.replace(/^\s*export\s+default\s+/, '')
    const fn = new vm.Script(`(${expression})`, { filename: 'GOAL.js' }).runInContext(context, {
      timeout: TIMEOUT_MS,
    })
    if (typeof fn !== 'function') {
      return { read: null, logs: logsOf(context), error: 'GOAL.js did not export a function.' }
    }
    /* The argument is built *inside* the context for the same reason the helpers
       are: a host-made object would carry the host `Object` on its prototype. */
    const arg = vm.runInContext('({ goal: globalThis.goal, sources: globalThis.sources })', context)
    const answer = await Promise.race([
      Promise.resolve(fn(arg)),
      new Promise((_, reject) => {
        /* The sync timeout above cannot stop an await; this one stops waiting for
           it. The sandbox has no timers or I/O, so a lost promise cannot act. */
        timer = setTimeout(
          () => reject(new Error(`GOAL.js did not answer within ${TIMEOUT_MS / 1000}s.`)),
          TIMEOUT_MS,
        )
      }),
    ])
    return { read: readOf(answer), logs: logsOf(context), error: '' }
  } catch (error) {
    return { read: null, logs: logsOf(context), error: String(error?.message || error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The script a new goal starts with: it counts the tasks the person accepted and
 * nothing else. It is a real script on the record — editable, and replaced by
 * whatever an agent later writes — not a hidden fallback in the store.
 */
const DEFAULT_SCRIPT = `
export default (async ({ goal }) => {
  const day = (value) => {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || ''))) return null
    const [year, month, date] = String(value).split('-').map(Number)
    return Date.UTC(year, month - 1, date)
  }
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const deadline = day(goal.deadline)
  const dated = (goal.tasks || []).filter((task) => day(task.date) !== null)
  const done = dated.filter((task) => task.done && day(task.date) <= deadline).length
  const late = dated.filter((task) => !task.done && day(task.date) < today).length
  const shouldBeDone = dated.filter((task) => day(task.date) <= today).length
  const open = dated.filter((task) => !task.done).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  return {
    done,
    total: dated.length,
    late,
    next: open.length ? { title: open[0].title, due: open[0].date } : null,
    deadlineDays: deadline === null ? null : Math.round((deadline - today) / 86400000),
    slip: done - shouldBeDone,
    sources: [],
  }
})
`.trim()

module.exports = { DEFAULT_SCRIPT, MAX_SCRIPT, TIMEOUT_MS, readOf, run }
