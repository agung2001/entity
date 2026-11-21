/**
 * `<ws>/pending-write.json` — one instruction rewrite waiting for a person.
 *
 * A run may rewrite its own workspace's instructions, but the person reading the
 * thread should see the lines that change before they land: the file is the
 * entity's standing prompt, and a silent rewrite is why a run behaved differently
 * last Tuesday. So the write is parked here, the card shows the diff, and only
 * Apply runs the verb again.
 *
 * ponytail: one request per workspace. Two simultaneous rewrites would overwrite
 * each other; the upgrade path is a keyed list when that becomes real.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'pending-write.json'

function fileOf(record) {
  return path.join(record.path, FILE)
}

function idFor(request) {
  return crypto
    .createHash('sha256')
    .update([request.workspace, request.name, request.sha256].join('\0'))
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
    if (!doc || typeof doc !== 'object' || !doc.id || !doc.name || !doc.workspace) return null
    if (typeof doc.body !== 'string' || typeof doc.sha256 !== 'string' || !doc.sha256) return null
    if (!doc.stamp || typeof doc.stamp !== 'object') return null
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
