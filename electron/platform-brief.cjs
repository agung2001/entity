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

const REMOTE_SKILL = `## This run is on a remote machine

The workspace was staged into the current directory before this turn. Treat
those files as the workspace: read and write entities and artifacts there.
The Entity CLI is not installed on this host, so do not call \`$ENTITY_CLI_PATH\`.
Skills named by the prompt are already installed in this harness's skill
library when the target supports it.

Do not try to reach the person's local filesystem, local Entity profile or a
local MCP server. If a file or server is missing, say so instead of guessing.`

/** instruction text for one run */
function compose({ record, entity, extra = '', remote = false } = {}) {
  const parts = [remote ? REMOTE_SKILL : SKILL]
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
function env({ record, entity, remote = false } = {}) {
  /* ENTITY_HOME is inherited: the app itself was launched with whatever value
     pointed at this profile, and the child gets the same process.env. */
  const out = {
    ENTITY_WORKSPACE: record?.id || '',
    ENTITY_ENTITY: entity?.name || '',
  }
  if (record && !remote) out.ENTITY_CLI_PATH = ensureShim(record)
  return out
}

module.exports = { SKILL, REMOTE_SKILL, compose, env, ensureShim, shimPath, shellQuote }
