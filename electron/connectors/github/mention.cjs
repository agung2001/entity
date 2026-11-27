/**
 * `@github:<owner/repo>` and `@github:<query>` — one repository by name, or a search
 * across the repositories `gh` can see.
 *
 * Two shapes only (a repository and a search over repositories), because issues and
 * PRs already have their own MCP server surface; widening it means a third dispatch
 * on `gh search issues` / `gh search prs` once someone asks for it.
 *
 * **It only runs while the connector is switched on.** `gh` is a spawn on every
 * `@github:` send and on every keystroke of the composer's `@github:` menu, and a
 * person who never turned GitHub CLI on should not be paying for either: `run()`
 * refuses, and the two surfaces above turn that into a refusal and an empty menu.
 * `githubBinary()` is deliberately not gated — the settings probe and the
 * dashboard's sign-in read both have to answer for a row that is off.
 *
 * The switch is read lazily, once per call, because `integrations-store` requires
 * `mention-ref`, which loads this module through the registry: a load-time require
 * would hand one of the two a half-built module.
 */
const { execFile } = require('node:child_process')
const { githubBinary } = require('./path.cjs')

const MAX_PER_SOURCE = 3
/* One spawn per mention and one per menu page. Ten seconds is what the old
   `mention-ref` ceiling gave `gh`; a search over a large account is the slow end. */
const GH_TIMEOUT_MS = 10_000

/** Is the GitHub CLI connector switched on? Missing file, missing key: off. */
function isActive() {
  try {
    return require('../../integrations-store.cjs').enabled().github === true
  } catch {
    /* A store that cannot be read is not a reason to spawn a CLI: off is the safe
       answer, and the surfaces above turn it into no work at all. */
    return false
  }
}

/** One `gh` call, as text. Rejects with a sentence a card can print. */
function run(args) {
  if (!isActive()) {
    throw new Error(
      '@github: is switched off. Turn the GitHub CLI connector on in Connectors, then try again.',
    )
  }
  return new Promise((resolve, reject) => {
    execFile(
      githubBinary(),
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const message = String(error?.message || error).slice(0, 200)
          reject(
            new Error(
              error?.code === 'ENOENT'
                ? 'gh is not installed, or not on PATH.'
                : `gh ${args[0] || ''} failed: ${message}`,
            ),
          )
          return
        }
        resolve(String(stdout || ''))
      },
    )
  })
}

/** The reader a turn uses: the injected one in a test, `run` in the app. */
const readerOf = (ctx) => ctx?.deps?.execGithub || run

/* ── the mention ──────────────────────────────────────────────────── */

async function resolve(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@github: needs a repository (owner/repo) or a search query.')
  const gh = readerOf(ctx)
  /* `owner/repo` is a whole query with one slash — the shape `gh api` takes */
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query)) {
    const raw = await gh(['api', `repos/${query}`])
    let repo = null
    try {
      repo = JSON.parse(raw)
    } catch {
      throw new Error(`@github:${query} did not resolve to a repository Gh could read.`)
    }
    if (!repo?.full_name) throw new Error(`@github:${query} is not a repository Gh knows.`)
    return [
      {
        id: repo.full_name,
        label: `${repo.full_name} — ${repo.description || 'a repository'}`,
        detail: [repo.language, repo.private ? 'private' : 'public', repo.html_url]
          .filter(Boolean)
          .join(' · '),
        url: repo.html_url || `https://github.com/${repo.full_name}`,
      },
    ]
  }
  const raw = await gh([
    'search',
    'repos',
    '--limit',
    String(limit),
    '--json',
    'fullName,description,url',
    query,
  ])
  let rows = []
  try {
    rows = JSON.parse(raw)
  } catch {
    throw new Error('gh search repos did not return JSON.')
  }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.fullName || '',
    label: `${row.fullName || ''} — ${row.description || 'a repository'}`,
    detail: row.url || '',
    url: row.url || '',
  }))
}

/**
 * What the composer offers while `@github:` is being typed.
 *
 * One page, and it is the resolver's own answer: the repository the person named, or
 * the first matches of `gh search repos`. A menu that resolved differently from a
 * send is how a suggestion comes back empty when the mention would not.
 */
async function preview(fields = [], { limit = MAX_PER_SOURCE } = {}) {
  const query = fields.join(':').trim()
  if (!query) return []
  const rows = await resolve({}, { query }, { limit })
  return rows.map((row) => ({
    mention: `@github:${row.id}`,
    label: row.label,
    detail: row.detail,
  }))
}

module.exports = { MAX_PER_SOURCE, githubBinary, isActive, preview, resolve, run }
