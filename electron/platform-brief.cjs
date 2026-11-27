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
 *      PATH would work in `npm run dev` and fail in the packaged app. It also
 *      names Orca (`ENTITY_ORCA_BIN`, plus that directory first on PATH), because
 *      a child otherwise spends its first turns rediscovering a CLI the app
 *      already resolved — see `connectors/orca/path.cjs` and
 *      `connectors/github/path.cjs`.
 */
const fs = require('node:fs')
const path = require('node:path')
const orcaPath = require('./connectors/orca/path.cjs')
const githubPath = require('./connectors/github/path.cjs')

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

/**
 * What a turn that is on a clock is told.
 *
 * A chat turn is stopped at a wall-clock deadline, and the stop lands mid-thought:
 * two threads here ran 90 minutes each, wrote a plan fifteen times and edited
 * nothing. A deadline the harness cannot see is only a way to lose the work, so
 * the turn is handed the one thing that changes its shape — how long it has — and
 * the order that fits inside that. Only a bounded turn gets this; a run has no
 * such deadline and must not be told it does.
 */
function turnBudget(minutes) {
  /* no deadline, no budget: a run is queued and has none, and a caller that
     guessed at a number must not be able to invent one */
  const span = Math.round(Number(minutes))
  if (!Number.isFinite(span) || span < 1) return ''
  return `## This turn is on a clock

It is stopped at **${span} minutes** from the moment it started, and the stop lands wherever
the work is — an unwritten plan produces nothing. So:

- **The first plan you write is the plan.** Do not re-derive it after a read. If a
  step you already wrote is still true, do it; a second \`let me plan\` costs a
  read and buys nothing.
- **Read to answer a question, not to see the file.** \`grep -n\` the line and take
  one offset read around it. Sweeping \`sed -n\` slices across a large file is the
  most expensive way to learn one fact.
- **A first edit beats a fourth read.** A file you have changed is somewhere to
  refine from; a file you have only read is still a guess.
- **Land the whole deliverable, then refine it.** On a bounded turn the first
  complete version outranks an excellent fraction of one.
- When it is finished and verified, reply and stop. Do not keep improving a thing
  the person already has.`
}

/** instruction text for one run */
function compose({ record, entity, extra = '', remote = false, budget = '' } = {}) {
  const parts = [remote ? REMOTE_SKILL : SKILL]
  /* a turn's deadline is a platform constraint, so it precedes the workspace's own
     rules: an entity may narrow it, but it may not hide it */
  const clock = String(budget || '').trim()
  if (clock) parts.push(clock)
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
  if (record && !remote) {
    out.ENTITY_CLI_PATH = ensureShim(record)
    /* Local only: a remote run has its own binaries, and a path on this machine
       must not be claimed as one available there. Both local CLIs are named, and
       their directories go first on PATH, because a harness that shells out to
       `orca` or `gh` (or to a script whose shebang needs a sibling `node`) has no
       other way to find one that is not on the inherited PATH.
       The key is the platform's own: Windows stores `Path`, and adding `PATH`
       beside it would hand the child two entries differing only by case —
       `shell-path.cjs` makes the same choice for the app's own PATH. */
    out.ENTITY_ORCA_BIN = orcaPath.orcaBinary()
    out.ENTITY_GH_BIN = githubPath.githubBinary()
    const dirs = [orcaPath.orcaDir(out.ENTITY_ORCA_BIN), githubPath.githubDir(out.ENTITY_GH_BIN)]
      .filter(Boolean)
      /* the two binaries can share a directory — once is enough */
      .filter((dir, index, all) => all.indexOf(dir) === index)
    const key = process.platform === 'win32' ? 'Path' : 'PATH'
    const inherited = process.env[key] || process.env.PATH || ''
    if (dirs.length) out[key] = [...dirs, inherited].filter(Boolean).join(path.delimiter)
  }
  return out
}

module.exports = {
  SKILL,
  REMOTE_SKILL,
  compose,
  turnBudget,
  env,
  ensureShim,
  shimPath,
  shellQuote,
}
