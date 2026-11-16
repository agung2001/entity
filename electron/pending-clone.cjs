/**
 * `<ws>/pending-clone.json` — one cross-workspace copy waiting for a person.
 *
 * A pinned run may read another workspace but may not write to it. Copying an
 * entity is a write of a *prompt* into a room nobody in this run is looking at,
 * so it waits here until the window shows the request and the person allows it.
 * The file lives in the run's own workspace, which the run is already allowed
 * to write.
 *
 * ponytail: one request per workspace. Two simultaneous copies would overwrite
 * each other; the upgrade path is a keyed list when that becomes real.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'pending-clone.json'

function fileOf(record) {
  return path.join(record.path, FILE)
}

function idFor(request) {
  return crypto
    .createHash('sha256')
    .update([request.from, request.to, request.name, request.sha256].join('\0'))
    .digest('hex')
    .slice(0, 16)
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
    if (!doc || typeof doc !== 'object' || !doc.id || !doc.from || !doc.to || !doc.name) return null
    if (typeof doc.sha256 !== 'string' || !doc.sha256) return null
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

module.exports = { FILE, idFor, write, read, clear }
