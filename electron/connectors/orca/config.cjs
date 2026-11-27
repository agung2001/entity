/**
 * The Orca binary this machine was told to use — `~/.entity/orca.json`.
 *
 * The app can find Orca on its own (`path.cjs` knows the app bundle, the user's
 * own bin and PATH), and finding it automatically is the normal case. This file is
 * for the machine where it is somewhere else: a nightly build, a checkout, a
 * package manager with its own prefix. Without it the only answer was to edit the
 * environment the app was launched with, which is not a setting a person has.
 *
 * Three rules, the same ones `turn-timeout-store.cjs` keeps for its own file:
 *
 *   1. **Machine-wide, never synced.** A path is a fact about *this* computer.
 *      `connectors.json` travels with the workspace; this must not, or a
 *      teammate's `/Users/…` would arrive as a broken binary.
 *   2. **Empty means automatic.** Clearing the field is a real answer: the
 *      resolver goes back to its own search instead of pinning a stale path.
 *   3. **A path that cannot be run is refused when it is saved**, not stored and
 *      left to fail at the first mention. The save-time check is `existsSync` plus
 *      "is a file": whether it *answers* is what the page's Test connection is for.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tilde } = require('../../frontmatter.cjs')

const SCHEMA = 1
const FILE = 'orca.json'

/* Resolved per call, not at load, for the same reason `path.cjs` reads the file
   per call: a test may point `ENTITY_HOME` somewhere else after this module is
   already in the cache. */
function file() {
  const root = process.env.ENTITY_HOME
    ? path.resolve(process.env.ENTITY_HOME)
    : path.join(os.homedir(), '.entity')
  return path.join(root, FILE)
}

/** What was stored, or `''` for automatic. A bad file reads as automatic. */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return typeof raw?.binary === 'string' ? raw.binary.trim() : ''
  } catch {
    return ''
  }
}

/** `~/…` is what a person types; the file stores what can be spawned. */
function expand(value) {
  const text = String(value || '').trim()
  if (text === '~') return os.homedir()
  return text.startsWith(`~${path.sep}`) || text.startsWith('~/') || text.startsWith('~\\')
    ? path.join(os.homedir(), text.slice(2))
    : text
}

/**
 * Store a path, or clear it.
 *
 * Refused, not clamped: a number that was silently moved is a number the person
 * never chose. Here the same rule means an unreadable path never becomes the
 * connector's binary — the message says what to fix while the field still holds
 * what they typed.
 */
function save({ binary } = {}) {
  const wanted = expand(binary)
  if (!wanted) {
    write('')
    return ''
  }
  /* A command name with no separator is a PATH lookup, which the resolver already
     knows how to do; anything else has to be one whole path, because a relative
     one would resolve against whatever cwd the app happened to start in. */
  const hasSeparator = wanted.includes('/') || wanted.includes('\\')
  if (hasSeparator && !path.isAbsolute(wanted)) {
    throw new Error(
      'That is a relative path. Give the whole path to the binary, or just its name to look it up on PATH.',
    )
  }
  if (path.isAbsolute(wanted)) {
    let stat = null
    try {
      stat = fs.statSync(wanted)
    } catch {
      stat = null
    }
    if (!stat) throw new Error(`${tilde(wanted)} does not exist. Nothing changed.`)
    if (!stat.isFile()) throw new Error(`${tilde(wanted)} is not a file. Nothing changed.`)
  }
  write(wanted)
  return wanted
}

function write(binary) {
  const target = file()
  const tmp = `${target}.${process.pid}.tmp`
  const body = `${JSON.stringify({ schema: SCHEMA, binary }, null, 2)}\n`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, target)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing was staged */
    }
    throw new Error(
      `${tilde(target)} is not writable (${String(error?.message || error)}). Nothing changed.`,
    )
  }
}

module.exports = { FILE, expand, file, read, save }
