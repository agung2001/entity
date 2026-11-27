/**
 * A local CLI connector's binary: where it is, and the one field that overrides the
 * search.
 *
 * Two connectors ship as a command on the person's machine — Orca and `gh` — and
 * both need the same four answers: a name to spawn, a preference file for the
 * machine that keeps it somewhere else, a cross-platform search, and a store the
 * connector's own page writes to. Written twice, the two would disagree about `~`
 * expansion, a broken symlink, or Windows' `Path` before a year was out.
 *
 * What stays with the connector is what only it knows: its candidate list, its
 * environment variable, its file name, and the words its page prints.
 *
 * The store is a *preference*, not a schedule — it is read per call, so a change
 * lands on the next mention rather than on the next restart.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tilde } = require('../frontmatter.cjs')

const SCHEMA = 1

/* Resolved per call, not at load: a test may point `ENTITY_HOME` somewhere else
   after these modules are already in the cache. */
function root() {
  return process.env.ENTITY_HOME
    ? path.resolve(process.env.ENTITY_HOME)
    : path.join(os.homedir(), '.entity')
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
 * The override file for one connector — `~/.entity/<file>`.
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
function storeFor(file) {
  const target = () => path.join(root(), file)

  /** What was stored, or `''` for automatic. A bad file reads as automatic. */
  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(target(), 'utf8'))
      return typeof raw?.binary === 'string' ? raw.binary.trim() : ''
    } catch {
      return ''
    }
  }

  function write(binary) {
    const at = target()
    const tmp = `${at}.${process.pid}.tmp`
    const body = `${JSON.stringify({ schema: SCHEMA, binary }, null, 2)}\n`
    try {
      fs.mkdirSync(path.dirname(at), { recursive: true })
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, at)
    } catch (error) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* nothing was staged */
      }
      throw new Error(
        `${tilde(at)} is not writable (${String(error?.message || error)}). Nothing changed.`,
      )
    }
  }

  /** Store a path, or clear it. Refused, not clamped: what is typed is what is meant. */
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

  return { file: target, read, save }
}

/**
 * One connector's resolution, over ordered candidate groups.
 *
 * The order is the connector's own (see its `path.cjs`), and this only walks it:
 *
 *   1. the path set on the connector's page — the most deliberate answer;
 *   2. `<environment>` — how a process is *launched* with a binary, which the E2E
 *      suite and a developer's shell use;
 *   3. the groups, first `existsSync` wins (`existsSync` is false for a broken
 *      symlink on every platform, which is the check a stale `/usr/local/bin` entry
 *      needs);
 *   4. the bare name, which is a PATH lookup and the last resort, never an error.
 *
 * `source` is the connector page's word for *why*: a group's own name, `stored`,
 * `environment`, or `path`.
 */
function resolverFor({ store, environment, groups, bare }) {
  const candidates = () => groups.flatMap((group) => group.paths)
  const sourceOf = (candidate) =>
    (groups.find((group) => group.paths.includes(candidate)) || {}).source || 'path'

  function resolve() {
    const stored = store.read()
    if (stored) return { binary: stored, source: 'stored', searched: [] }
    const fromEnv = String(process.env[environment] || '').trim()
    if (fromEnv) return { binary: fromEnv, source: 'environment', searched: [] }
    const searched = candidates()
    for (const candidate of searched) {
      if (fs.existsSync(candidate)) return { binary: candidate, source: sourceOf(candidate), searched }
    }
    /* Bare, not empty: a PATH the harness already has is a real place to find it. */
    return { binary: bare, source: 'path', searched }
  }

  const binary = () => resolve().binary

  /** The directory to put first on `PATH`, or `''` when the binary is bare. */
  function dir(value = binary()) {
    const text = String(value || '')
    const absolute = text.includes(path.sep) || (process.platform === 'win32' && text.includes('/'))
    return absolute ? path.dirname(text) : ''
  }

  return { binary, candidates, dir, resolve }
}

module.exports = { expand, resolverFor, root, storeFor }
