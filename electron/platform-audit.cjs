/**
 * `<ws>/audit.jsonl` — one line per agent-initiated mutation.
 *
 * An entity that rewrites its own instructions is not a bug, but it is the kind
 * of event that needs an explanation later. The run log already says what an
 * agent *did*; this says what it *changed*, and a change outlives the run that
 * made it.
 *
 * Append-only and best-effort: an audit write that fails must never fail the
 * mutation it was describing, or a full disk would look like a permissions bug.
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'audit.jsonl'
/** Keep the tail bounded; a busy agent should not grow this without a ceiling. */
const MAX_LINES = 5000

function auditPath(record) {
  return path.join(record.path, FILE)
}

function append(record, entry = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    workspace: record.id,
    actor: 'entity',
    ...entry,
  })
  try {
    fs.appendFileSync(auditPath(record), `${line}\n`, 'utf8')
  } catch {
    /* the mutation already happened; a missing audit line is not worth a throw */
  }
  return line
}

/** Newest first, for a future Activity view and for `entity audit`. */
function read(record, { limit = 50 } = {}) {
  let text = ''
  try {
    text = fs.readFileSync(auditPath(record), 'utf8')
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const tail = lines.slice(-Math.min(MAX_LINES, Math.max(1, limit)))
  return tail
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .reverse()
}

module.exports = { FILE, auditPath, append, read }
