/**
 * What every run is told, and what it is handed.
 *
 * Two pieces, both of which have to be identical for an entity run and a chat
 * turn — a chat is the same agent with the same file, and it would be a bug if
 * it could change its own instructions but not know that it could.
 *
 *   1. `compose()` — the instruction text, in precedence order:
 *        platform brief  <  workspace context  <  the entity's own body
 *      The workspace's rules are scope-wide and come first so an entity's own
 *      persona can narrow them but not silently replace them by accident.
 *
 *   2. `env()` — `ENTITY_CLI_PATH`, `ENTITY_WORKSPACE`, `ENTITY_ENTITY`, and the
 *      generated shim the first value points at. A harness launched from Finder
 *      inherits LaunchServices' PATH, not the user's; resolving `entity` through
 *      PATH would work in `npm run dev` and fail in the packaged app.
 */
const fs = require('node:fs')
const path = require('node:path')

const SKILL = fs
  .readFileSync(path.join(__dirname, 'platform-skill.md'), 'utf8')
  .trim()

/** instruction text for one run */
function compose({ record, entity, extra = '' } = {}) {
  const parts = [SKILL]
  const context = String(record?.context || '').trim()
  if (context) parts.push(`## Workspace context\n\n${context}`)
  const own = String(entity?.instructions || '').trim()
  if (own) parts.push(own)
  const tail = String(extra || '').trim()
  if (tail) parts.push(tail)
  return parts.join('\n\n')
}

/* ── the shim ─────────────────────────────────────────────────────── */

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function shimPath(record) {
  const file = process.platform === 'win32' ? 'entity.cmd' : 'entity'
  return path.join(record.path, '.bin', file)
}

/**
 * A one-line launcher that runs this build's CLI without needing `node` on PATH.
 *
 * `ELECTRON_RUN_AS_NODE=1` turns the Electron binary into a plain Node, which
 * means the CLI is exactly the code that shipped with the app — no second
 * runtime, no version skew between what the agent calls and what the window
 * shows.
 */
function ensureShim(record) {
  const file = shimPath(record)
  const exec = process.execPath
  const cli = path.join(__dirname, 'cli.cjs')
  const body =
    process.platform === 'win32'
      ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" "${cli}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(exec)} ${shellQuote(cli)} "$@"\n`

  /* Rewrite only when it would differ. The shim carries the absolute path of
     the binary that generated it, so a moved app or an Electron upgrade heals
     here — but the common case must not touch mtime on every run. */
  try {
    if (fs.readFileSync(file, 'utf8') === body) return file
  } catch {
    /* not there yet, or not readable: fall through and write it */
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, { mode: 0o755 })
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, file)
  } catch {
    /* a read-only workspace still runs; the harness just loses the CLI */
  }
  return file
}

/** The environment every harness gets, so the brief's commands resolve. */
function env({ record, entity } = {}) {
  /* ENTITY_HOME is inherited: the app itself was launched with whatever value
     pointed at this profile, and the child gets the same process.env. */
  const out = {
    ENTITY_WORKSPACE: record?.id || '',
    ENTITY_ENTITY: entity?.name || '',
  }
  if (record) out.ENTITY_CLI_PATH = ensureShim(record)
  return out
}

module.exports = { SKILL, compose, env, ensureShim, shimPath, shellQuote }
