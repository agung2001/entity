/**
 * One pending request per workspace, on disk.
 *
 * An agent may not create or rewrite the files that define another agent behind
 * the person's back: the request is parked here, the card on the composer shows
 * it, and only `Apply` in the window writes. The file lives in the run's own
 * workspace, which the run is already allowed to write.
 *
 * The shape is the whole mechanism, so it is written down:
 *
 *   { id, at, workspace, kind, name, ...payload, requestedBy }
 *
 * `kind` says which card owns it — `write` carries `body`/`previousBody`/`stamp`,
 * `create` carries the fields the new file will have. The window refuses a
 * request whose `kind` it does not render rather than guessing.
 *
 * ponytail: one request per workspace, whichever kind it is. Two simultaneous
 * proposals would overwrite each other; the upgrade path is a keyed list when
 * that becomes real.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'pending-write.json'
const KINDS = new Set(['write', 'create'])

function fileOf(record) {
  return path.join(record.path, FILE)
}

/**
 * The id names *what would be written*, so a re-proposal with different content
 * is a different request and an approval of the old one fails the id check.
 * Strings only: a payload key (`harness`, `body`) has a meaning per kind.
 */
function idFor(request) {
  const parts = [request.workspace, request.kind, request.name]
  for (const key of Object.keys(request).sort()) {
    if (key === 'id' || key === 'at') continue
    const value = request[key]
    if (typeof value === 'string') parts.push(`${key}=${value}`)
  }
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

/** Atomic, best-effort: a half-written request must never look approvable. */
function write(record, request) {
  const doc = { ...request, id: idFor(request) }
  const file = fileOf(record)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return doc
}

/** Missing, empty or corrupt reads as `null` — never a throw on a read path. */
function read(record) {
  try {
    const doc = JSON.parse(fs.readFileSync(fileOf(record), 'utf8'))
    if (!doc || typeof doc !== 'object' || !doc.id || !doc.name || !doc.workspace) return null
    if (!KINDS.has(doc.kind) || typeof doc.sha256 !== 'string' || !doc.sha256) return null
    /* A rewrite without its two bodies has no diff to show, and a create without
       its description has nothing to read: both are unapprovable. */
    if (doc.kind === 'write' && (typeof doc.body !== 'string' || typeof doc.previousBody !== 'string')) {
      return null
    }
    if (doc.kind === 'create' && typeof doc.description !== 'string') return null
    if (doc.kind === 'write' && (!doc.stamp || typeof doc.stamp !== 'object')) return null
    return doc
  } catch {
    return null
  }
}

/** Clear only the request the caller is looking at; a newer one stays. */
function clear(record, id = '') {
  const current = read(record)
  if (!current) return false
  if (id && current.id !== id) return false
  fs.rmSync(fileOf(record), { force: true })
  return true
}

module.exports = { FILE, KINDS, idFor, write, read, clear }
