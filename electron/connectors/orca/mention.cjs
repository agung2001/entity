/**
 * `@orca:<project>[:<file>]` — the projects Orca manages on this machine, as real
 * paths, and the worktree a delegated run worked in.
 *
 * Two things Orca is asked for, and both are the same rule: a path in a prompt
 * must be one Orca itself named. A project comes from `orca repo list`, a
 * worktree from `orca worktree list`, and nothing here guesses one from the
 * message — a plausible-looking path that does not exist costs a run more than
 * the mention saves, and a chip that guesses is the lie it exists to prevent.
 *
 * **It only runs while the connector is switched on.** Orca is a CLI that spawns
 * on a composer mount (`mention.sources`), on every `@orca:` send and on every
 * card with a ticket key, so a person who never turned Orca on should not be
 * paying for any of it. Two rules cover every surface:
 *
 *   1. `repos()` refuses while off — it is what the mention, the composer's
 *      sources and the `@` menu all read, so one gate covers all three.
 *   2. A caller that wants a worktree checks `isActive()` first and answers
 *      `none`: that is `mention.worktree` in the call table and the salvage read
 *      a timed-out run does.
 *
 * `worktreeState()` itself is the reader, not a surface: it answers what Orca
 * says when someone asks it, and `worktrees()` stays a plain read for the same
 * reason. `binary()` is deliberately not gated either — the settings probe has to
 * answer "can this run" for a row that is off, and a probe that refused would be
 * a row nobody could fix.
 *
 * The switch is read lazily, once per call, because `integrations-store` requires
 * `mention-ref`, which loads this module through the registry: a load-time require
 * would hand one of the two a half-built module.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { orcaBinary } = require('./path.cjs')

const ORCA_TIMEOUT_MS = 10_000
const ORCA_CACHE_MS = 60_000
/* A child workspace path as Orca writes it in a run's report. */
const ORCA_WORKSPACE_PATH = /[^\s"'`()<>]*[\\/]orca[\\/]workspaces[\\/][^\s"'`()<>]+/gi

/** One `orca` call, as text. Rejects with a sentence a card can print. */
function execFileText(args) {
  return new Promise((resolve, reject) => {
    execFile(orcaBinary(), args, { timeout: ORCA_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(
          new Error(
            error?.code === 'ENOENT'
              ? 'orca is not installed, or not on PATH.'
              : String(error?.message || error).slice(0, 200),
          ),
        )
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/* ── the switch ────────────────────────────────────────────────────── */

/** Is the Orca connector switched on? Missing file, missing key: off. */
function isActive() {
  try {
    return require('../../integrations-store.cjs').enabled().orca === true
  } catch {
    /* A store that cannot be read is not a reason to spawn a CLI: off is the
       safe answer, and the surfaces above turn it into no work at all. */
    return false
  }
}

/* ── the two lists ─────────────────────────────────────────────────── */

let repoCache = { at: 0, repos: [] }

/**
 * The repos Orca knows, cached for a minute: one CLI spawn per burst of mentions.
 *
 * Refused, not empty, when the switch is off: "no projects" is a different fact,
 * and a person who typed `@orca:` deserves to know which of the two they hit.
 */
async function repos({ force = false } = {}) {
  if (!isActive()) {
    throw new Error(
      '@orca: is switched off. Turn the Orca connector on in Connectors, then try again.',
    )
  }
  if (!force && Date.now() - repoCache.at < ORCA_CACHE_MS) return repoCache.repos
  const raw = await execFileText(['repo', 'list', '--json'])
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('orca repo list did not return JSON.')
  }
  const list = parsed?.result?.repos || parsed?.repos || []
  repoCache = { at: Date.now(), repos: list }
  return list
}

let worktreeCache = { at: 0, list: [] }

/** Child and main worktrees Orca knows, cached like the repo list. */
async function worktrees({ force = false } = {}) {
  if (!force && Date.now() - worktreeCache.at < ORCA_CACHE_MS) return worktreeCache.list
  const raw = await execFileText(['worktree', 'list', '--json'])
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('orca worktree list did not return JSON.')
  }
  const list = parsed?.result?.worktrees || parsed?.worktrees || []
  worktreeCache = { at: Date.now(), list }
  return list
}

/* ── a worktree, as it is now ──────────────────────────────────────── */

/**
 * clean | dirty | gone | none — the worktree a delegated row works in, as it is
 * *now*. A field stored at run time would freeze at "clean, exists" and lie in
 * exactly the case this exists for: the row was merged and the worktree removed.
 *
 * The run's own record comes first: a fan-out shares a cwd and a ticket key, so
 * the key alone paints one word on N cards. A delegated run that worked in a
 * child workspace names that path in its report, and a path is per-run. The
 * renderer sends the record, the ticket key and the run's cwd; every path this
 * reads or stats came out of `orca worktree list`, never out of the message.
 *
 * The switch is the caller's business, not this reader's: the surfaces that ask
 * (`mention.worktree`, the salvage read) check `isActive()` and answer `none`
 * without spawning anything, and this function answers whatever Orca says when
 * someone does ask.
 */
async function worktreeState({ cwd = '', ticket = '', record = '' } = {}) {
  const key = String(ticket || '').trim().toLowerCase()
  const named = recordPaths(record)
  /* Nothing said about a worktree, and no key to guess from. */
  if (!key && !named.length) return { state: 'none' }
  const dir = cwd ? path.resolve(String(cwd)) : ''
  const inside = (root, at) => {
    if (!at) return false
    const base = path.resolve(String(root || '.'))
    return at === base || at.startsWith(base + path.sep)
  }
  const list = await worktrees()
  /* The record's own evidence, kept only where Orca itself lists that path. */
  const listed = new Map(list.map((worktree) => [path.resolve(String(worktree.path || '.')), worktree]))
  /* A run on another machine names *that* machine's path, which this machine's
     list will never contain — a remote report is not evidence of a removal.
     Keep a named path only where its worktree base (`…/orca/workspaces/<repo>`)
     is a base this Orca lists, and drop the rest before anything is called gone. */
  const bases = new Set([...listed.keys()].map((at) => path.dirname(at)))
  const local = named.filter((at) => bases.has(path.dirname(at)))
  const mine = local.map((at) => listed.get(at)).filter(Boolean)
  let hit = mine.find((worktree) => matchesKey(worktree, key)) || mine[0]
  /* A record that names a workspace this Orca no longer lists is `gone` — that is
     the difference between "merged and removed" and "never created". */
  if (!hit && local.length) return { state: 'gone', name: path.basename(local[0]) }
  if (!hit) {
    /* The cwd *narrows* the search when it names a repo, and only when it does:
       an entity whose `dir` is `~` runs outside every checkout, and returning
       `none` there would hide the chip for exactly the rows that have a worktree.
       Narrowing is a nicety (one repo's keys), not the boundary — the boundary is
       that `hit.path` below is Orca's word, and `git` is run against nothing else. */
    const known = await repos()
    let scope = known.find((entry) => inside(entry.path, dir))
    if (!scope) {
      /* a run pointed *at* a child worktree names its repo the same way */
      const at = list.find((worktree) => inside(worktree.path, dir))
      if (at) scope = known.find((entry) => entry.id === at.repoId)
    }
    /* The same match the `orca-worktree` skill uses to reuse a child workspace:
       the ticket key in its branch or display name. */
    hit = list
      .filter((worktree) => !worktree.isMainWorktree && (!scope || worktree.repoId === scope.id))
      .sort((a, b) => Number(b.lastActivityAt || 0) - Number(a.lastActivityAt || 0))
      .find((worktree) => matchesKey(worktree, key))
  }
  /* A run that names no workspace and matches no key shows no chip: absence is
     not evidence, and a guess here is the lie the chip exists to prevent. */
  if (!hit) return { state: 'none' }
  if (!fs.existsSync(String(hit.path))) return { state: 'gone', name: worktreeName(hit) }
  const status = await gitStatus(String(hit.path))
  /* `unknown` rather than a guess: a git that cannot answer is not a clean tree. */
  if (status === null) return { state: 'unknown' }
  return {
    state: status ? 'dirty' : 'clean',
    files: status,
    name: worktreeName(hit),
    path: String(hit.path),
    branch: String(hit.branch || '').replace(/^refs\/heads\//, ''),
  }
}

/** How many uncommitted paths a worktree has, or `null` when git could not say. */
function gitStatus(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain'], { timeout: ORCA_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(String(stdout || '').split('\n').filter(Boolean).length)
    })
  })
}

/** `ENTITY-53` in a worktree's branch or display name, the skill's own match. */
function matchesKey(worktree, key) {
  if (!key) return false
  return `${worktree.branch || ''} ${worktree.displayName || ''}`.toLowerCase().includes(key)
}

/** The workspace's own name: what the chip paints, so N runs read as N names. */
function worktreeName(worktree) {
  if (!worktree) return ''
  const raw = String(worktree.branch || '').replace(/^refs\/heads\//, '') || String(worktree.displayName || '') || String(worktree.path || '')
  return raw ? path.basename(raw) : ''
}

/** Every `…/orca/workspaces/<repo>/<name>` path a run's record names. */
function recordPaths(record) {
  const text = typeof record === 'string' ? record : JSON.stringify(record || '')
  const out = []
  for (const [raw] of String(text || '').matchAll(ORCA_WORKSPACE_PATH)) {
    /* a report writes its paths in prose: "…/card, then merged" */
    const at = path.resolve(raw.replace(/[.,;:!?]+$/, ''))
    if (!out.includes(at)) out.push(at)
  }
  return out
}

/* ── the mention ──────────────────────────────────────────────────── */

async function resolve(ctx, segment) {
  const list = await ctx.deps.orcaRepos()
  const wanted = String(segment.project || '').toLowerCase()
  const repo =
    list.find((entry) => String(entry.displayName || '').toLowerCase() === wanted) ||
    list.find((entry) => path.basename(String(entry.path || '')).toLowerCase() === wanted)
  if (!repo) {
    throw new Error(`@orca:${segment.project} is not a project Orca knows.`)
  }
  const root = path.resolve(String(repo.path))
  if (!segment.file) {
    return [{ label: root, detail: repo.displayName || path.basename(root) }]
  }
  const target = path.resolve(root, segment.file)
  /* a mention must not walk out of the repo it named */
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`@orca:${segment.project}:${segment.file} points outside that project.`)
  }
  return [{ label: target, detail: fs.existsSync(target) ? '' : 'does not exist yet' }]
}

module.exports = { binary: orcaBinary, isActive, repos, worktrees, worktreeState, recordPaths, resolve }
