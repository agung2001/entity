/**
 * What moved on GitHub in the last 90 days, read from the `gh` already signed in
 * on this machine.
 *
 * Three answers, all read-only except the last:
 *
 *   logins()          every login the CLI holds, and which of them GitHub refuses
 *   dashboard({…})    six counts, the open pull requests, a row per active repo
 *   useActive({…})    `gh auth switch` — the card's "Use as active"
 *
 * **No token is ever read, printed or stored.** `gh` owns the credential; this
 * module only asks it questions, so a broken token is a row with the CLI's own
 * sentence on it, never something to repair here.
 *
 * **Every `gh` argument is a literal in this file.** A login reaches argv only
 * after `gh auth status` has reported it, and only after it matches `LOGIN_RE`;
 * nothing a person types is ever interpolated into a command. The verbs are an
 * allow-list — `auth status`, `api graphql`, `api rate_limit`, `auth switch` —
 * and there is exactly one write among them.
 *
 * **A refused login does not blank the rest.** `auth status` is read once, each
 * readable login is queried on its own, and one login's failure is one row.
 *
 * **One read a day.** The answer is written to `<~/.entity>/github-dashboard.json`
 * and served from there for a day: a dashboard is a slow-moving number and seven
 * requests per visit is a cost nobody asked for. Refresh forces a new read, and
 * the expiry does the rest — the file is read on each call, so nothing is held in
 * this process's memory between visits.
 *
 * **Only the active login's numbers are read.** `repo` scope is held per account
 * and `gh` always sends the active login's key, so a second signed-in login's own
 * private repositories are invisible: its counts would be zeros it did not earn.
 * Those logins keep their row with `counts: null` — the page prints `—` and names
 * the login; `gh auth switch` is the honest way to widen it, and the card offers it.
 */
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const harnesses = require('../../harness-store.cjs')
const { githubBinary } = require('./path.cjs')
const config = require('./config.cjs')

const WINDOW_DAYS = 90
/* One visit, one read: a number that changed twice in a day is not the number a
   person is asking about. Refresh forces, and the file expires after a day. */
const CACHE_MS = 24 * 60 * 60_000
/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'github-dashboard.json')
const CACHE_SCHEMA = 2
const STATUS_TIMEOUT_MS = 8_000
/* The whole document is one request and answered in ~3 s on a real connection;
   the ceiling is for the connection that never answers. */
const READ_TIMEOUT_MS = 20_000
const HOST = 'github.com'
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
/* What a count needs before it can be trusted. `repo` is what makes another
   login's private work visible; without it a number is not zero, it is unknown,
   and the page prints `—` rather than a lie. */
const NEEDS = 'repo'
/* The one ceiling: the repositories the table can mention, and equally the page the
   candidate alias answers, so there is nothing shortened behind a shortened list.
   Four repositories per call, five aliased searches each. The foot names the cap. */
const MAX_REPOS = 30
const REPOS_PER_CALL = 4
/* A repository name reaches a search string, so it is checked like a login is. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/* One document, every number. The seven searches are aliases of the same call,
   so the cost is one request and one round trip, not seven. Nulls are normal
   here: `reviewDecision` and `statusCheckRollup` are absent on most young
   pull requests, and the table says "no checks" rather than crashing. */
const DOCUMENT = `query Dashboard(
  $login: String!, $merged: String!, $opened: String!, $openNow: String!,
  $reviews: String!, $issues: String!, $repos: String!, $prs: String!
) {
  rateLimit { limit cost remaining resetAt }
  user(login: $login) {
    repositories(ownerAffiliations: OWNER) { totalCount }
    mine: repositories(
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      first: ${MAX_REPOS}, orderBy: { field: PUSHED_AT, direction: DESC }
    ) { nodes { ... on Repository { nameWithOwner isPrivate pushedAt } } }
  }
  merged: search(query: $merged, type: ISSUE, first: 0) { issueCount }
  opened: search(query: $opened, type: ISSUE, first: 0) { issueCount }
  openNow: search(query: $openNow, type: ISSUE, first: 0) { issueCount }
  reviews: search(query: $reviews, type: ISSUE, first: 0) { issueCount }
  issues: search(query: $issues, type: ISSUE, first: 0) { issueCount }
  repos: search(query: $repos, type: REPOSITORY, first: 0) { repositoryCount }
  prs: search(query: $prs, type: ISSUE, first: 12) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url updatedAt isDraft reviewDecision
        author { login }
        repository { nameWithOwner }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 50) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { conclusion }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/* ── the day-long cache, on disk ───────────────────────────────────
   The last answer lives in one JSON file rather than in this process: a restart
   should not spend seven requests to rediscover numbers it already printed, and
   the renderer can live with the file being the only copy. `at` is when the read
   finished, `key` is the logins and the window it was read for, and `value` is the
   payload verbatim — `readAt` inside it is what the page stamps.

   A cache nobody can write is a cache that misses: every failure here is a miss,
   never a read that fails. */
function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA || !Number.isFinite(raw?.at) || !raw?.value) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(key, value) {
  const body = `${JSON.stringify({ schema: CACHE_SCHEMA, key, at: Date.now(), value }, null, 2)}\n`
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CACHE_FILE)
  } catch {
    /* read-only home, a full disk: the next visit reads GitHub again. */
  }
}

/** Signing in, signing out or switching the active login changes whose token
    answers, so the stored answer belongs to nobody. */
function forgetCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true })
  } catch {
    /* already gone */
  }
}

/* ── running the CLI ─────────────────────────────────────────────── */

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: Boolean(error?.killed),
      })
    })
  })
}

/** The sentence a failed CLI printed, in the order it is worth believing.
    `gh` writes its own complaint to stderr (`gh: Bad credentials (HTTP 401)`)
    and dumps the API's JSON body — whose last line is a lone `}` — to stdout, so
    the JSON is only asked for its `message` and never read line-wise. */
function reasonOf(result) {
  const lines = (text) =>
    String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  const spoken = lines(result.stderr)
  if (spoken.length) return spoken[spoken.length - 1].slice(0, 300)
  try {
    const message = JSON.parse(String(result.stdout || '{}'))?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    /* Not JSON: fall through to the raw last line, which is all there is. */
  }
  const printed = lines(result.stdout)
  if (printed.length) return printed[printed.length - 1].slice(0, 300)
  if (result.error?.code === 'ENOENT') return 'not found on PATH'
  if (result.timedOut) return 'the CLI did not answer in time'
  return String(result.error?.message || result.error || 'unknown error').slice(0, 300)
}

/**
 * The `gh` this connector would spawn — the page's own field first, then the
 * environment, then the package managers' and PATH's answers. It is the same
 * resolution `@github:` uses (`path.cjs`), so a binary somebody named on this page
 * is the one the sign-in read and the mention both run.
 */
function binary() {
  const wanted = githubBinary()
  /* A whole path is stat-ed; a bare name is the one case that needs the PATH walk,
     because `spawn` does it at run time and this answer has to travel to a page. */
  const found = path.isAbsolute(wanted)
    ? fs.existsSync(wanted)
      ? wanted
      : ''
    : harnesses.which(wanted)
  return { found: Boolean(found), path: found || '' }
}

/* ── the binary's own two verbs ──────────────────────────────────── */

/** What `gh` this connector would run right now, and how it was found. */
function binaryPath() {
  return require('./path.cjs').resolve()
}

/** Set (or clear, with an empty string) the path, then answer the new resolution. */
function setPath({ binary: wanted } = {}) {
  config.save({ binary: wanted })
  /* The login cache was filled by a different binary: a name that changed hands is
     not a cache to keep. */
  forgetCache()
  return binaryPath()
}

/* ── who is signed in ────────────────────────────────────────────── */

/**
 * Every login `gh` holds, including the ones GitHub refuses.
 *
 * `--json hosts` is the only shape that carries all of them; the human output is
 * one paragraph and cannot be counted. It exits 0 even when a token is refused,
 * so the gate is the contents of `hosts`, never the exit code, and an empty
 * `hosts` is the answer "signed in nowhere" rather than an error.
 */
async function logins() {
  const bin = binary()
  if (!bin.found) {
    return { binary: bin, host: HOST, logins: [], checkedAt: new Date().toISOString() }
  }
  const answer = await run(bin.path, ['auth', 'status', '--json', 'hosts'], STATUS_TIMEOUT_MS)
  let hosts = null
  try {
    hosts = JSON.parse(answer.stdout || '{}')?.hosts || null
  } catch {
    hosts = null
  }
  if (!hosts) {
    /* A CLI too old for `--json`, or one whose output is not JSON at all. The
       reason travels; an empty list would read as "signed in nowhere", which is a
       different fact. */
    return {
      binary: bin,
      host: HOST,
      logins: [],
      checkedAt: new Date().toISOString(),
      problem: answer.error ? reasonOf(answer) : 'gh auth status did not answer with JSON',
    }
  }
  const rows = []
  for (const [host, entries] of Object.entries(hosts)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      rows.push({
        login: String(entry?.login || ''),
        host: String(entry?.host || host),
        scopes: String(entry?.scopes || '')
          .split(/,\s*/)
          .map((scope) => scope.trim())
          .filter(Boolean),
        active: entry?.active === true,
        refused: String(entry?.state || 'success') !== 'success',
        error: String(entry?.error || ''),
        tokenSource: String(entry?.tokenSource || ''),
      })
    }
  }
  /* The active login first: it is the one whose token answers, and the card puts
     it at the top for the same reason. */
  rows.sort((a, b) => Number(b.active) - Number(a.active))
  return { binary: bin, host: HOST, logins: rows, checkedAt: new Date().toISOString() }
}

/* ── the budget, which is free to ask about ──────────────────────── */

/** `rate_limit` costs nothing against itself, so it answers even when the
    dashboard's own request was just refused with 403. That is what makes the
    reset time printable at all. */
async function budgetOf(bin) {
  if (!bin.found) return null
  const answer = await run(bin.path, ['api', 'rate_limit'], STATUS_TIMEOUT_MS)
  let resources = null
  try {
    resources = JSON.parse(answer.stdout || '{}')?.resources || null
  } catch {
    resources = null
  }
  if (!resources) return null
  const pick = (entry) => {
    if (!entry) return null
    const remaining = Number(entry.remaining)
    const limit = Number(entry.limit)
    if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return null
    return { limit, remaining, resetAt: new Date(Number(entry.reset) * 1000).toISOString() }
  }
  return { core: pick(resources.core), graphql: pick(resources.graphql) }
}

/** A 403 or an exhausted budget, in either of the two shapes `gh` reports it. */
function rateLimitedBy(result) {
  const printed = `${result.stderr || ''}\n${result.stdout || ''}`
  return /rate limit|secondary rate limit|API rate limit exceeded|abuse detection/i.test(printed)
}

/* ── one login's numbers ─────────────────────────────────────────── */

function clauses(login, since) {
  return {
    login,
    merged: `is:pr is:merged author:${login} merged:>=${since}`,
    opened: `is:pr author:${login} created:>=${since}`,
    openNow: `is:pr is:open author:${login}`,
    reviews: `is:pr is:open review-requested:${login}`,
    issues: `is:issue is:open assignee:${login}`,
    repos: `user:${login} pushed:>=${since}`,
    prs: `is:pr is:open author:${login} sort:updated-desc`,
  }
}

/* The four columns of a repository row, plus the activity gate. The same text is
   the row's link in `connectors/github/GithubDashboard.vue`, so a count and its link cannot
   disagree: they are one question, asked twice. */
function repoClauses(login, repo, since) {
  const of = `repo:${repo}`
  return {
    merged: `${of} is:pr is:merged author:${login} merged:>=${since}`,
    opened: `${of} is:pr author:${login} created:>=${since}`,
    closedUnmerged: `${of} is:pr is:closed is:unmerged author:${login} closed:>=${since}`,
    issues: `${of} is:issue is:open assignee:${login}`,
    active: `${of} author:${login} updated:>=${since}`,
  }
}

const REPO_COUNT_KEYS = ['merged', 'opened', 'closedUnmerged', 'issues', 'active']

/** One chunk's document: an alias per repository per column. Built as a literal
    here, with the values travelling as variables, so no query text is ever
    assembled from a name. */
function repoQuery(size) {
  const vars = []
  const lines = []
  for (let index = 0; index < size; index += 1) {
    for (const key of REPO_COUNT_KEYS) {
      const alias = `r${index}_${key}`
      vars.push(`$${alias}: String!`)
      lines.push(`  ${alias}: search(query: $${alias}, type: ISSUE, first: 0) { issueCount }`)
    }
  }
  return `query Repos(${vars.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n${lines.join('\n')}\n}`
}

function checksOf(rollup) {
  if (!rollup) return { word: 'none', failing: 0, tone: '' }
  const contexts = Array.isArray(rollup.contexts?.nodes) ? rollup.contexts.nodes : []
  const failing = contexts.filter(
    (context) =>
      context?.conclusion === 'FAILURE' ||
      context?.conclusion === 'TIMED_OUT' ||
      context?.conclusion === 'CANCELLED' ||
      context?.state === 'FAILURE' ||
      context?.state === 'ERROR',
  ).length
  if (failing) return { word: `${failing} failing`, failing, tone: 'bad' }
  if (rollup.state === 'SUCCESS') return { word: 'green', failing: 0, tone: 'ok' }
  if (rollup.state === 'PENDING' || rollup.state === 'EXPECTED') {
    return { word: 'running', failing: 0, tone: 'warn' }
  }
  return { word: 'none', failing: 0, tone: '' }
}

/** The pill's word is the signal; `tone` only colours the dot. Draft and
    "changes asked" are words this table can say, so they are not folded away. */
function stateOf(pull, checks) {
  if (pull?.isDraft) return { word: 'draft', tone: '' }
  if (checks.failing) return { word: 'checks failing', tone: 'warn' }
  if (pull?.reviewDecision === 'CHANGES_REQUESTED') return { word: 'changes asked', tone: 'bad' }
  if (checks.tone === 'ok') return { word: 'ready to merge', tone: 'ok' }
  if (pull?.reviewDecision === 'REVIEW_REQUIRED') return { word: 'review needed', tone: '' }
  return { word: 'no checks', tone: '' }
}

function pullRows(result) {
  const nodes = Array.isArray(result?.prs?.nodes) ? result.prs.nodes : []
  return nodes
    .filter((node) => node && node.number)
    .map((node) => {
      const checks = checksOf(node.commits?.nodes?.[0]?.commit?.statusCheckRollup)
      const state = stateOf(node, checks)
      return {
        repo: String(node.repository?.nameWithOwner || ''),
        number: Number(node.number),
        title: String(node.title || ''),
        url: String(node.url || ''),
        author: String(node.author?.login || ''),
        updatedAt: String(node.updatedAt || ''),
        checks: checks.word,
        failing: checks.failing,
        checksTone: checks.tone,
        state: state.word,
        tone: state.tone,
        draft: node.isDraft === true,
      }
    })
}

/* Repositories worth asking about: everything this login owns, collaborates on or
   reaches through an organization, last pushed inside the window. The alias
   answers in `PUSHED_AT` order, so the cap drops the repos least likely to have
   activity. ponytail: a repo where the login only ever opened an issue and never
   pushed is not a candidate; widening that needs a second search, not a second
   request here. */
function repoCandidates(data, since) {
  const nodes = Array.isArray(data?.user?.mine?.nodes) ? data.user.mine.nodes : []
  const seen = new Set()
  const rows = []
  for (const node of nodes) {
    const name = String(node?.nameWithOwner || '')
    const pushedAt = String(node?.pushedAt || '')
    if (!REPO_RE.test(name) || seen.has(name)) continue
    if (pushedAt.slice(0, 10) < since) continue
    seen.add(name)
    rows.push({ name, private: node.isPrivate === true, pushedAt })
  }
  /* ponytail: the alias answers `MAX_REPOS` repositories, so a login active in more
     is asked about its most recently pushed ones and the foot says so. Widening the
     ceiling means a second page of aliases, not a second query. */
  return rows.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
}

/** The gated rows, four repositories per call. A chunk that fails makes the whole
    table unknown — an under-counted table reads as "nothing else", which is the
    one thing it must never claim. */
async function readRepoRows(bin, login, since, candidates) {
  const rows = []
  let reads = 0
  for (let start = 0; start < candidates.length; start += REPOS_PER_CALL) {
    const chunk = candidates.slice(start, start + REPOS_PER_CALL)
    const args = ['api', 'graphql']
    chunk.forEach((repo, index) => {
      const values = repoClauses(login, repo.name, since)
      for (const key of REPO_COUNT_KEYS) args.push('-f', `r${index}_${key}=${values[key]}`)
    })
    args.push('-f', `query=${repoQuery(chunk.length)}`)
    const answer = await run(bin.path, args, READ_TIMEOUT_MS)
    reads += 1
    let data = null
    try {
      data = JSON.parse(answer.stdout || '{}')?.data || null
    } catch {
      data = null
    }
    if (!data) return { rows: null, capped: false, reads, problem: reasonOf(answer) }
    chunk.forEach((repo, index) => {
      const counted = (key) => {
        const value = Number(data[`r${index}_${key}`]?.issueCount)
        return Number.isFinite(value) ? value : null
      }
      /* The filter each count was taken with travels with the row, so the link
         beside it is the same question and cannot drift from the number. */
      const values = repoClauses(login, repo.name, since)
      rows.push({
        name: repo.name,
        private: repo.private,
        pushedAt: repo.pushedAt,
        queries: {
          merged: values.merged,
          opened: values.opened,
          closedUnmerged: values.closedUnmerged,
          issues: values.issues,
        },
        merged: counted('merged'),
        opened: counted('opened'),
        closedUnmerged: counted('closedUnmerged'),
        issues: counted('issues'),
        active: counted('active'),
      })
    })
  }
  /* The activity gate: a repository this login never merged, opened, closed or
     assigned in, and did not touch in the window, has nothing to say here. */
  return {
    rows: rows.filter((row) => Number(row.active) > 0),
    /* The alias page was filled, so there may be repositories past it: the foot
       says which ones were asked about rather than implying the list is all. */
    capped: candidates.length >= MAX_REPOS,
    reads,
    problem: '',
  }
}

async function readLogin(bin, login, since, scopes, active) {
  const args = ['api', 'graphql']
  const values = clauses(login, since)
  for (const [key, value] of Object.entries(values)) args.push('-f', `${key}=${value}`)
  args.push('-f', `query=${DOCUMENT}`)
  const answer = await run(bin.path, args, READ_TIMEOUT_MS)
  let payload = null
  try {
    payload = JSON.parse(answer.stdout || '{}')
  } catch {
    payload = null
  }
  const data = payload?.data || null
  if (!data) {
    return {
      login,
      error: reasonOf(answer),
      rateLimited: rateLimitedBy(answer),
      budget: null,
    }
  }
  /* A search the token may not run answers `null` with an entry in `errors`; that
     count is unknown, not zero. */
  const count = (name) => {
    const row = data[name]
    if (!row) return null
    const value = name === 'repos' ? row.repositoryCount : row.issueCount
    return Number.isFinite(Number(value)) ? Number(value) : null
  }
  const readable = scopes.includes(NEEDS)
  const candidates = active ? repoCandidates(data, since) : []
  /* `repo` scope is held per account and `gh` only ever sends the active login's
     key, so a second signed-in login's own private repositories are invisible to
     this read. Its zeros would be numbers it never earned, so the row is marked
     unknown (`counts: null`) and the page prints `—` and names it. */
  const counts = readable && active
    ? {
        merged: count('merged'),
        opened: count('opened'),
        openNow: count('openNow'),
        reviews: count('reviews'),
        issues: count('issues'),
        repos: count('repos'),
      }
    : null
  const repos = active ? await readRepoRows(bin, login, since, candidates) : null
  return {
    login,
    error: '',
    rateLimited: false,
    counts,
    /* What the six are measured against: a count over "no repositories" would be
       a misleading zero. */
    owned: counts ? Number(data.user?.repositories?.totalCount ?? NaN) || null : null,
    prs: active ? pullRows(data) : null,
    /* `null` is "not read", which the page prints as nothing-and-a-reason; `[]`
       would be "read, and empty", which is the lie this replaced. */
    repoRows: repos?.rows ?? null,
    /* Whether the candidate page filled: the foot qualifies the list with it. */
    capped: repos?.capped === true,
    /* One line, and only when the row has numbers it cannot back up. */
    why: counts
      ? ''
      : `@${login} is signed in but not active, so its own repositories are visible only to its own token and its counts are not read. Use it as active to read them.`,
    problem: repos?.problem || '',
    reads: repos?.reads || 0,
    budget: data.rateLimit
      ? {
          limit: Number(data.rateLimit.limit) || 0,
          remaining: Number(data.rateLimit.remaining) || 0,
          resetAt: String(data.rateLimit.resetAt || ''),
        }
      : null,
  }
}

/* ── the dashboard ───────────────────────────────────────────────── */

function windowOf() {
  const until = new Date()
  const since = new Date(until.getTime() - WINDOW_DAYS * 86_400_000)
  const day = (date) => date.toISOString().slice(0, 10)
  return { days: WINDOW_DAYS, since: day(since), until: day(until) }
}

/**
 * Six counts, the open pull requests and one row per repository with activity, for
 * every login the CLI holds — plus the one answer that is a failure, per login.
 *
 * Only the *active* login can answer: a second login's counts are `null` with a
 * one-line `why`, because its own private repositories are invisible to the
 * active login's token. `gh auth switch` is the fix, and the card offers it.
 *
 * Cached for a day, in `github-dashboard.json`: `force` is the Refresh button, and
 * the cache key is the set of readable logins plus the window start, so signing in
 * or out (or the day rolling over) invalidates it without anyone remembering to.
 */
async function dashboard({ force = false } = {}) {
  const roster = await logins()
  const since = windowOf()
  const readable = roster.logins.filter(
    (entry) => !entry.refused && entry.login && LOGIN_RE.test(entry.login),
  )
  const refused = roster.logins.filter((entry) => entry.refused || !entry.login)
  const base = {
    binary: roster.binary,
    problem: roster.problem || '',
    host: roster.host,
    window: since,
    readAt: '',
    cached: false,
    /* How long a stored answer stays good, so the page can print the rule
       instead of hardcoding a number that drifts from this constant. */
    cacheTtlMs: CACHE_MS,
    logins: roster.logins,
    accounts: {},
    errors: [],
    budget: null,
    limited: null,
    reads: 0,
  }
  if (!roster.binary.found) return base
  if (!readable.length) {
    base.errors = refused.map((entry) => ({
      login: entry.login,
      message: entry.error || 'the CLI holds this login but GitHub refuses its token',
    }))
    return base
  }

  /* The active login is part of the key: switching it changes which counts are
     readable, so a cached answer from the other one is not the same answer. */
  const key = `${readable
    .map((entry) => `${entry.login}${entry.active ? '!' : ''}`)
    .join(',')}|${since.since}`
  if (!force) {
    const hit = readCache()
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) {
      return { ...hit.value, cached: true, reads: 0 }
    }
  }

  const budget = await budgetOf(roster.binary)
  const answers = await Promise.all(
    readable.map((entry) =>
      readLogin(roster.binary, entry.login, since.since, entry.scopes, entry.active === true),
    ),
  )

  const accounts = {}
  const errors = []
  let limited = null
  let reads = 0
  let graphBudget = budget?.graphql || null
  for (const answer of answers) {
    if (answer.error) {
      errors.push({ login: answer.login, message: answer.error })
      if (answer.rateLimited) {
        const resetAt = budget?.graphql?.resetAt || budget?.core?.resetAt || ''
        limited = { login: answer.login, message: answer.error, resetAt }
      }
      continue
    }
    accounts[answer.login] = {
      counts: answer.counts,
      owned: answer.owned,
      prs: answer.prs,
      repoRows: answer.repoRows,
      capped: answer.capped,
      why: answer.why,
      problem: answer.problem,
    }
    reads += 1 + (Number(answer.reads) || 0)
    if (answer.budget) graphBudget = answer.budget
  }
  /* A login the roster already knew was refused keeps its row here too, so the
     card and the tab cannot disagree about who broke. */
  for (const entry of refused) {
    errors.push({
      login: entry.login,
      message: entry.error || 'the CLI holds this login but GitHub refuses its token',
    })
  }

  const value = {
    ...base,
    readAt: new Date().toISOString(),
    accounts,
    errors,
    budget: budget ? { ...budget, graphql: graphBudget } : graphBudget ? { graphql: graphBudget } : null,
    limited,
    /* What this read actually cost: one document per login, one chunked document
       per four repositories, plus the free budget question. */
    reads: reads + 1,
    refused: refused.map((entry) => entry.login).filter(Boolean),
  }
  /* Stale numbers are better than none, and they are what a rate-limited tab
     shows — but they are never presented as fresh: `readAt` travels with them.
     Nor are they worth storing: a rate-limited read would only re-serve the same
     refusal for a day. */
  if (!limited) writeCache(key, value)
  return value
}

/* ── the one write ───────────────────────────────────────────────── */

/**
 * Make one login the active one.
 *
 * This is the only verb in this module that changes anything, and it changes only
 * which key `gh` sends — the token itself stays where it was. The login is
 * checked against what `gh auth status` just reported before it reaches argv.
 */
async function useActive({ login } = {}) {
  const wanted = String(login || '')
  if (!LOGIN_RE.test(wanted)) throw new Error('That is not a login gh could hold.')
  const roster = await logins()
  if (!roster.binary.found) throw new Error('gh is not on this machine\'s PATH.')
  const entry = roster.logins.find((row) => row.login === wanted)
  if (!entry) throw new Error(`gh holds no login called @${wanted}.`)
  if (entry.refused) {
    throw new Error(
      `@${wanted}'s token is refused, so it cannot be made active. ${entry.error || 'Run gh auth login.'}`,
    )
  }
  if (entry.active) return { login: wanted, active: true, logins: roster.logins }
  const answer = await run(
    roster.binary.path,
    ['auth', 'switch', '--hostname', entry.host, '--user', wanted],
    STATUS_TIMEOUT_MS,
  )
  if (answer.error) throw new Error(reasonOf(answer))
  forgetCache()
  const after = await logins()
  return { login: wanted, active: true, logins: after.logins }
}

module.exports = { CACHE_MS, CACHE_FILE, WINDOW_DAYS, binaryPath, dashboard, logins, setPath, useActive }
