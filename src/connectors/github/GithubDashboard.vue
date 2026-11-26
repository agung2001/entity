<script setup>
import { computed, ref } from 'vue'
import { ago } from '@/stores/hub'
import { cacheNote as cacheNoteOf, cachedUntil, ttlWords } from '@/connectors/parts/readClock'
import { readStamp } from '@/connectors/parts/readStamp'
import { copyText } from '@/lib/clipboard'
import { github, makeActive, readDashboard } from '@/connectors/github/useGithub'

/* One body, one root — the pane's `id`/`role`/`aria-labelledby` arrive as attributes
   and land where they are meant to. Lynk.id used to be a second root here (a shell
   drawing another connector's component), which is exactly the "two connectors in one
   file" shape the pane component exists to end. */

/**
 * The GitHub connector's Dashboard tab: what moved in the last 90 days, read from
 * the `gh` this machine already has signed in — for **every** login it holds.
 *
 * Nothing here signs anything in. The credential lives in the CLI's own store, so
 * this tab reads what that store answers and, when a token is refused, prints the
 * CLI's own sentence with a copyable `gh auth login` beside it. A sign-in form
 * here would be a second place for a token to live, and a wrong one.
 *
 * The six tiles are links to the search they count, because a number nobody can
 * check is a number nobody believes. The table is a real `<table>` in a bounded
 * scroll box, so the sticky head is the browser's work and not a positioned
 * imitation of it.
 *
 * Every chip filters a slice that was already read: switching accounts costs no
 * request, which is why the main process answers per login instead of per page.
 */
const copied = ref('')

const nFmt = new Intl.NumberFormat('en-gb')
/* `Number(null)` is `0`, so a missing number must be rejected before the cast: a
   count this read could not back up prints `—`, never a zero it did not earn. */
const num = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : nFmt.format(Number(value))

/* Every login with a name, refused or not: a refused chip stays on screen, because
   removing it would hide which account is broken. */
const named = computed(() => github.logins.filter((entry) => entry.login))
const readable = computed(() => named.value.filter((entry) => !entry.refused))

/* **One unknown makes the total unknown.** A login whose counts were not read makes
   every summed tile `—` rather than a number that silently left a person out. That
   rule is right, and as a *default* it opened the tab on six dashes whenever a second
   login was signed in without being active — so the page opens on the login the CLI
   actually reads, and `All accounts` is one press away. Once every readable login was
   read, the default is the total again. */
const selected = ref('') // '' → the default; 'all' → everything readable; else a login
const allRead = computed(() =>
  readable.value.length > 0 && readable.value.every((entry) => github.accounts?.[entry.login]?.counts != null),
)
const activeLogin = computed(() => readable.value.find((entry) => entry.active)?.login || '')
const effective = computed(() => selected.value || (allRead.value ? 'all' : activeLogin.value || 'all'))
/* The chips and the tiles read this: `all` is the slice, not an empty filter. */
const scope = computed(() => {
  const all = readable.value.map((entry) => entry.login)
  if (effective.value === 'all') return all
  return all.includes(effective.value) ? [effective.value] : all
})

/* ── the window, printed the way the spec asks for it ─────────────── */
const FALLBACK_DAYS = 90
const fallback = (() => {
  const until = new Date()
  const since = new Date(until.getTime() - FALLBACK_DAYS * 86_400_000)
  const day = (date) => date.toISOString().slice(0, 10)
  return { days: FALLBACK_DAYS, since: day(since), until: day(until) }
})()
const span = computed(() => (github.window?.since ? github.window : fallback))
const dayText = (iso, year) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
  })
}
const spanText = computed(
  () => `${span.value.days} days · ${dayText(span.value.since, false)} – ${dayText(span.value.until, true)}`,
)
/* One titles the repo table with its window, so the words say how far back the
   rows reach instead of leaving the reader to guess. Plural-correct, derived from
   the window the main process sent, never typed in. */
const windowMonths = computed(() => {
  const months = Math.max(1, Math.round(Number(span.value.days) / 30))
  return `${months} ${months === 1 ? 'month' : 'months'}`
})
/* The read envelope — how long this answer stands, in words that come from the
   payload rather than from the copy. `parts/readClock.js` is the one implementation;
   eight dashboards used to carry their own. */
const ttlText = computed(() => ttlWords(github.cacheTtlMs))
const cacheUntil = computed(() => cachedUntil(github.readAt, github.cacheTtlMs))
const cacheNote = computed(() => cacheNoteOf({ cached: github.cached, ttlMs: github.cacheTtlMs }))
const stamp = computed(() =>
  readStamp({ readAt: github.readAt, loading: github.loading, ttlMs: github.cacheTtlMs }),
)

/* ── the six counts ────────────────────────────────────────────────
   A count is `null` when the login that owns it lacks the scope to see all of
   it. Summing the half that is visible would print a smaller true-looking number,
   so one unknown makes the total unknown — `—`, never `0`. */
function countOf(key) {
  const values = scope.value.map((login) => github.accounts?.[login]?.counts?.[key])
  /* `Number(null)` is `0`, so a missing count has to be rejected before the sum
     rather than by it: an unknown count that adds nothing looks like a real zero. */
  if (!values.length || values.some((value) => value === null || value === undefined || !Number.isFinite(Number(value)))) {
    return null
  }
  return values.reduce((sum, value) => sum + Number(value), 0)
}

const authorClause = (prefix) =>
  scope.value.map((login) => `${prefix}${login}`).join(' ')
const searchUrl = (query, type) =>
  `https://${github.host}/search?q=${encodeURIComponent(query)}&type=${type}`

const kpis = computed(() => {
  const since = span.value.since
  const authors = authorClause('author:')
  const reviewers = authorClause('review-requested:')
  const owners = authorClause('user:')
  const entries = [
    {
      key: 'merged',
      k: 'Merged PRs',
      query: `is:pr is:merged ${authors} merged:>=${since}`.replace(/\s+/g, ' ').trim(),
      type: 'pullrequests',
    },
    {
      key: 'opened',
      k: 'Opened PRs',
      query: `is:pr ${authors} created:>=${since}`.replace(/\s+/g, ' ').trim(),
      type: 'pullrequests',
    },
    {
      key: 'openNow',
      k: 'Open now',
      query: `is:pr is:open ${authors}`.replace(/\s+/g, ' ').trim(),
      type: 'pullrequests',
    },
    {
      key: 'reviews',
      k: 'Reviews asked',
      query: `is:pr is:open ${reviewers}`.replace(/\s+/g, ' ').trim(),
      type: 'pullrequests',
    },
    {
      key: 'issues',
      k: 'Open issues',
      query: `is:issue is:open ${authorClause('assignee:')}`.replace(/\s+/g, ' ').trim(),
      type: 'issues',
    },
    {
      key: 'repos',
      k: 'Repos pushed',
      query: `${owners} pushed:>=${since}`.replace(/\s+/g, ' ').trim(),
      type: 'repositories',
    },
  ]
  return entries.map((entry) => ({
    ...entry,
    value: countOf(entry.key),
    href: searchUrl(entry.query, entry.type),
  }))
})

/* ── the table ───────────────────────────────────────────────────── */
const pulls = computed(() => {
  const rows = []
  for (const login of scope.value) {
    for (const pull of github.accounts?.[login]?.prs || []) rows.push(pull)
  }
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
})
const pullsUrl = computed(() =>
  searchUrl(`is:pr is:open ${authorClause('author:')}`.replace(/\s+/g, ' ').trim(), 'pullrequests'),
)
const shortDate = (iso) => {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short' })
    : '—'
}

/* ── the repository table ─────────────────────────────────
   One row per repository this login actually did something in, and every count a
   link to the very search it was counted with (`row.queries`, sent by the main
   process, so a number and its link cannot drift). It replaces the "Pushed
   recently" rail: a repository pushed in the window is a row here whenever
   anything happened in it, and the rail's six-item cap was a shorter answer to
   the same question. */
const repoRows = computed(() => {
  const rows = []
  for (const login of scope.value) {
    for (const row of github.accounts?.[login]?.repoRows || []) rows.push(row)
  }
  const seen = new Set()
  return rows
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
    .filter((row) => (seen.has(row.name) ? false : seen.add(row.name)))
})
/* How many repositories had activity — `null` when any login in scope was not
   read, because a count over rows that do not exist is a zero nobody earned. */
const repoCount = computed(() => {
  const answers = scope.value.map((login) => github.accounts?.[login]?.repoRows)
  return answers.length && answers.every((rows) => Array.isArray(rows)) ? repoRows.value.length : null
})
/* What the card header counts: the scope's total when everyone answered, else
   the rows that were actually read — never a zero for rows nobody fetched. */
const repoShown = computed(() =>
  repoCount.value !== null ? repoCount.value : readLogins.value.length ? repoRows.value.length : null,
)
/* The candidate page filled, so the rows are "the most recently pushed ones" and
   not "all of them". Said in the foot rather than left to be assumed. */
const repoCapped = computed(() =>
  scope.value.some((login) => github.accounts?.[login]?.capped === true),
)
const ownedTotal = computed(() => {
  const values = scope.value.map((login) => github.accounts?.[login]?.owned)
  /* The same trap `num` closes, one level up: an unread login's `owned` is null,
     and summing it would turn "not read" into a real-looking `0`. */
  if (!values.length || values.some((value) => value === null || value === undefined || !Number.isFinite(Number(value)))) {
    return null
  }
  return values.reduce((sum, value) => sum + Number(value), 0)
})
/* The four counts, in the order the row prints them. `type` is what the search
   link opens; `key` is both the field and the one the main process counted with. */
const repoCols = [
  { key: 'merged', k: 'Merged', type: 'pullrequests' },
  { key: 'opened', k: 'Opened', type: 'pullrequests' },
  { key: 'closedUnmerged', k: 'Closed', type: 'pullrequests' },
  { key: 'issues', k: 'Issues', type: 'issues' },
]
const repoUrl = (name) => `https://${github.host}/${name}`
const profileUrl = (login) => `https://${github.host}/${login}`

/* ── the budget, and what this read cost ─────────────────────────── */
const core = computed(() => github.budget?.core || null)
const graph = computed(() => github.budget?.graphql || null)
const clock = (iso) => {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })
    : '—'
}
const budgetWord = computed(() => {
  const core2 = core.value
  if (!core2 || !core2.limit) return 'unknown'
  const share = core2.remaining / core2.limit
  if (share <= 0) return 'spent'
  if (share < 0.15) return 'low'
  return 'ok'
})
const coreUsed = computed(() => {
  const core2 = core.value
  if (!core2 || !core2.limit) return null
  return Math.max(0, core2.limit - core2.remaining)
})
const meterWidth = computed(() => {
  if (!core.value?.limit || coreUsed.value === null) return '0%'
  return `${Math.min(100, Math.max(0.4, (coreUsed.value / core.value.limit) * 100))}%`
})
const meterLabel = computed(() =>
  coreUsed.value === null
    ? 'Core API budget: not reported'
    : `Core API budget: ${num(coreUsed.value)} of ${num(core.value.limit)} used`,
)

/* ── waiting on you ─────────────────────────────────────────────────
   Only when there is something to wait for: a zero-for-zero banner is noise, and
   the tiles above already print the three zeros. The counts come from the same
   answers the tiles did, so the strip and the tile cannot disagree. */
const scopeText = computed(() =>
  scope.value.length === 1 ? `@${scope.value[0]}` : `these ${scope.value.length || 0} accounts`,
)
/* One line per login whose numbers this read could not back up, worded by the main
   process so the dashboard and the Accounts card tell the same story. */
const unread = computed(() =>
  scope.value.map((login) => github.accounts?.[login]?.why).filter(Boolean),
)
/* A repository chunk that failed leaves the table unread — it is not an empty
   table, so it says what broke instead of counting to zero. */
const repoError = computed(() =>
  scope.value.map((login) => github.accounts?.[login]?.problem).filter(Boolean)[0] || '',
)
const unreadText = computed(() =>
  scope.value
    .filter((login) => github.accounts?.[login]?.why)
    .map((login) => `@${login}`)
    .join(' and '),
)
/* The logins that answered, so an empty state can name what it is empty *for*. */
const readLogins = computed(() => scope.value.filter((login) => !github.accounts?.[login]?.why))
const readText = computed(() => readLogins.value.map((login) => `@${login}`).join(' and '))
const waiting = computed(() => {
  if (github.loading || !github.readAt) return null
  const failing = pulls.value.reduce((sum, pull) => sum + (Number(pull.failing) || 0), 0)
  const reviews = countOf('reviews')
  const issues = countOf('issues')
  if (!failing && !reviews && !issues) return null
  return { failing, reviews, issues }
})

/* ── what needs the person ───────────────────────────────────────── */
const failures = computed(() => (Array.isArray(github.errors) ? github.errors : []))
/* A rate-limited login lands in `errors` too, and it is not a refused token: the
   "Rate limited" strip below already explains it. The alert is for the other kind,
   so the limited login is subtracted here rather than by the banner that draws it. */
const refusedFailures = computed(() => {
  const limitedLogin = String(github.limited?.login || '')
  return failures.value.filter((entry) => !(limitedLogin && entry.login === limitedLogin))
})
/* One refused login is enough to show the alert: the accounts that answered print
   their numbers underneath it, so a partial read is never silent and never needs a
   second banner saying so. */
const refused = computed(() => refusedFailures.value.length > 0)
const refusedLogin = computed(() => refusedFailures.value[0]?.login || '')
const namedFailure = computed(() =>
  refusedLogin.value ? `@${refusedLogin.value}` : `the login on ${github.host}`,
)
const loginCommand = computed(() => `gh auth login --hostname ${github.host}`)
const fallbackActive = computed(() => {
  const other = readable.value.find((entry) => !github.errors?.some((row) => row.login === entry.login))
  return other?.login || ''
})

async function copy(text, what = 'command') {
  const route = await copyText(text)
  copied.value = route ? what : ''
  if (route) setTimeout(() => (copied.value = ''), 1600)
}

function refresh() {
  readDashboard({ force: true })
}

function pick(entry) {
  if (entry.refused) return
  /* Pressing the login already in view widens back to everything: a chip that acts
     as its own off switch is the one pattern a filter row already teaches. */
  selected.value = effective.value === entry.login ? 'all' : entry.login
}

async function useActive(login) {
  if (!login) return
  try {
    await makeActive(login)
  } catch (problem) {
    /* The CLI's own refusal is the message worth showing; the composable has
       already refreshed nothing, so the numbers stay the last good ones. */
    github.error = String(problem?.message || problem)
  }
}
</script>

<template>
  <div class="dsh-band">
    <!-- The account that broke, named, with the CLI's sentence quoted verbatim and
         the command that fixes it. Never a sign-in form: Entity does not hold the
         token and could not repair it if it did. -->
    <div v-if="refused" class="dsh-err" role="alert">
      <b>The GitHub CLI refused the token for {{ namedFailure }}.</b>
      <p>
        <code class="mono">{{ refusedFailures[0].message || 'the CLI reported no reason' }}</code>
        Entity reads the CLI's own message; it cannot fix a token it never holds.
      </p>
      <div class="cmdrow">
        <code>{{ loginCommand }}</code>
        <button class="btn btn-sm" type="button" @click="copy(loginCommand)">
          {{ copied === 'command' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="github.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          Try again
        </button>
        <button
          v-if="fallbackActive"
          class="btn btn-sm btn-ghost"
          type="button"
          @click="useActive(fallbackActive)"
        >Switch to @{{ fallbackActive }}</button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which accounts to read">
        <button
          type="button"
          class="dsh-chip"
          :aria-pressed="effective === 'all'"
          @click="selected = 'all'"
        >All accounts <span class="n">{{ readable.length }}</span></button>
        <button
          v-for="entry in named"
          :key="entry.login"
          type="button"
          class="dsh-chip"
          :aria-pressed="effective === entry.login"
          :aria-disabled="entry.refused ? 'true' : undefined"
          :title="entry.refused ? 'This login cannot be read until its token is replaced' : entry.active ? undefined : 'Signed in, but only the active login is read — its numbers print —'"
          @click="pick(entry)"
        ><i class="dot" :data-on="entry.refused ? '2' : entry.active ? '1' : '0'" aria-hidden="true"></i>@{{ entry.login }}
          <span v-if="entry.refused" class="n">refused</span>
          <span v-else-if="entry.active" class="n">active</span>
          <!-- The same word the Accounts card uses: signed in, but this token
               cannot read it, so its numbers are `—` and not a zero. -->
          <span v-else class="n">not read</span>
        </button>
      </div>
      <div class="dsh-when">
        <span>{{ spanText }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="github.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ github.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Rate limited: the numbers on screen are real and stale, and the banner
         says so rather than replacing them with a spinner. GitHub's own reset time
         is the only useful thing a person can act on. -->
    <div v-if="github.limited" class="dsh-wait" data-tone="bad">
      <span class="k">Rate limited</span>
      <p>
        GitHub stopped answering · these numbers were read at
        <b>{{ clock(github.readAt) }}</b> and reset at <b>{{ clock(github.limited.resetAt) }}</b>.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="github.reading" @click="refresh">Try again</button>
    </div>

    <!-- Six tiles, each a link to the search it counts. The skeleton keeps the
         final grid, so nothing jumps when the numbers land. -->
    <div class="dsh-kpis" role="list" :aria-busy="github.loading ? 'true' : 'false'">
      <a
        v-for="kpi in kpis"
        :key="kpi.key"
        class="dsh-kpi"
        role="listitem"
        :href="kpi.href"
        target="_blank"
        rel="noreferrer noopener"
        :title="`${kpi.query} · opens GitHub search`"
      >
        <span class="k">{{ kpi.k }}</span>
        <span v-if="github.loading" class="dsh-skel" style="width: 40%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ num(kpi.value) }}</b>
        <span class="q">{{ kpi.query }}</span>
      </a>
    </div>

    <!-- What needs the person, in the order they can act on it: a red check, a
         review asked of them, an assigned issue. The anchor jumps to the list in
         the same page rather than to GitHub, because the fix starts here. -->
    <div v-if="waiting" class="dsh-wait" data-tone="warn">
      <span class="k">Waiting on you</span>
      <p>
        <b>{{ num(waiting.failing) }}</b> {{ waiting.failing === 1 ? 'open pull request has' : 'open pull requests have' }} failing checks ·
        <b>{{ num(waiting.reviews) }}</b> reviews requested ·
        <b>{{ num(waiting.issues) }}</b> {{ waiting.issues === 1 ? 'issue' : 'issues' }} assigned to {{ scopeText }}
      </p>
      <span class="spacer"></span>
      <a class="dsh-jump" href="#dsh-pr-head">Jump to the list ↓</a>
    </div>

    <div class="dsh">
      <div class="dsh-main">
        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-pr-head">
          <div class="hd">
            <h3 id="dsh-pr-head">Open pull requests</h3>
            <span class="n">{{ github.loading ? '—' : pulls.length }}</span>
            <span class="spacer"></span>
            <span class="hd-when">sorted by updated</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-pr-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">State</th>
                  <th scope="col" class="ckc">Checks</th>
                  <th scope="col" class="upd">Updated</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="github.loading">
                  <tr v-for="n in 4" :key="`sk${n}`" class="skrow">
                    <td>
                      <span class="dsh-skel" style="width: 78%; height: 9px"></span>
                      <span class="dsh-skel" style="width: 96%; height: 12px; margin-top: 7px"></span>
                    </td>
                    <td class="stc"><span class="dsh-skel" style="width: 84px; height: 18px"></span></td>
                    <td class="ck" data-l="checks"><span class="dsh-skel" style="width: 52px; height: 9px"></span></td>
                    <td class="upd" data-l="updated"><span class="dsh-skel" style="width: 34px; height: 9px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!pulls.length" class="emptyrow">
                  <td colspan="4">
                    <!-- An unread login is not a login with zero pull requests, so the
                         empty state names what was read and what was not — never one
                         sentence covering both with a `0`. -->
                    <b v-if="readText">Nothing open here.</b>
                    <span v-if="readText">{{ readText }} {{ readLogins.length > 1 ? 'have' : 'has' }} 0 open pull requests.</span>
                    <b v-if="unread.length">{{ readText ? 'And not read.' : 'Not read.' }}</b>
                    <span v-if="unread.length">
                      {{ unreadText }} {{ unread.length > 1 ? 'were' : 'was' }} not read, so
                      {{ unread.length > 1 ? 'their count is' : 'its count is' }} unknown — see the note
                      below the tables.
                    </span>
                    <a :href="`https://${github.host}/pulls`" target="_blank" rel="noreferrer noopener">Open {{ github.host }}/pulls ↗</a>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="pull in pulls" :key="`${pull.repo}#${pull.number}`">
                    <td>
                      <div class="dsh-pr">
                        <span class="repo">
                          <a :href="pull.url" :title="`${pull.repo}#${pull.number}`">{{ pull.repo }}<b>#{{ pull.number }}</b></a> ·
                          <a
                            v-if="pull.author"
                            class="who"
                            :href="profileUrl(pull.author)"
                            target="_blank"
                            rel="noreferrer noopener"
                            :title="`@${pull.author} on ${github.host}`"
                          >@{{ pull.author }}</a>
                          <span v-else class="who">@unknown</span>
                        </span>
                        <a class="ttl" :href="pull.url" :title="pull.title">{{ pull.title }}</a>
                      </div>
                    </td>
                    <td class="stc">
                      <span class="st" :data-tone="pull.tone || null"><i aria-hidden="true"></i>{{ pull.state }}</span>
                    </td>
                    <td class="ck" data-l="checks" :data-bad="pull.failing ? '1' : null">{{ pull.checks }}</td>
                    <td class="upd" data-l="updated">{{ shortDate(pull.updatedAt) }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            Read with <code class="mono">gh api graphql</code> · {{ cacheNote }} ·
            <!-- A login that was not read has no count to say "all N" about, so
                 the link drops the number rather than printing a zero. -->
            <a :href="pullsUrl" target="_blank" rel="noreferrer noopener">open {{ unread.length ? 'the list' : `all ${pulls.length}` }} on GitHub ↗</a>
          </p>
        </section>

        <!-- Repositories with activity in the window, one row each. Every count is
             the search it was counted with, so a number nobody can check is not on
             the page. The host comes from the answer, never a literal. -->
        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-repos-head">
          <div class="hd">
            <h3 id="dsh-repos-head">Repositories with your activity in the last {{ windowMonths }}</h3>
            <span class="n">{{ num(repoShown) }}</span>
            <span class="spacer"></span>
            <span class="hd-when">last pushed first</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-repos-head">
            <table class="dsh-tbl dsh-tbl-repos">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th v-for="col in repoCols" :key="`h-${col.key}`" scope="col" class="num">{{ col.k }}</th>
                  <th scope="col" class="upd">Pushed</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="github.loading">
                  <tr v-for="n in 4" :key="`rrsk${n}`" class="skrow">
                    <td><span class="dsh-skel" style="width: 62%; height: 10px"></span></td>
                    <td v-for="col in repoCols" :key="`rc${n}-${col.key}`" class="num">
                      <span class="dsh-skel" style="width: 22px; height: 9px"></span>
                    </td>
                    <td class="upd"><span class="dsh-skel" style="width: 34px; height: 9px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="repoError" class="emptyrow">
                  <td colspan="6">
                    <b>Not read.</b>
                    <span>{{ repoError }}</span>
                  </td>
                </tr>
                <tr v-else-if="!repoRows.length" class="emptyrow">
                  <td colspan="6">
                    <b v-if="readText">No repository activity here.</b>
                    <b v-if="unread.length">{{ readText ? 'And not read.' : 'Not read.' }}</b>
                    <span v-if="readText">
                      A repository is listed once a pull request was merged, opened or closed,
                      or an issue assigned, in it inside these {{ span.days }} days.
                    </span>
                    <span v-if="unread.length">
                      Which repositories {{ unreadText }} worked in is visible only to
                      {{ unread.length > 1 ? 'their own tokens' : 'its own token' }}.
                    </span>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="row in repoRows" :key="row.name">
                    <td>
                      <div class="dsh-repo">
                        <a :href="repoUrl(row.name)" :title="row.name" target="_blank" rel="noreferrer noopener">{{ row.name }}</a>
                        <span v-if="row.private" class="pv">private</span>
                      </div>
                    </td>
                    <td v-for="col in repoCols" :key="col.key" class="num" :data-l="col.k">
                      <a
                        v-if="row.queries[col.key]"
                        :href="searchUrl(row.queries[col.key], col.type)"
                        target="_blank"
                        rel="noreferrer noopener"
                        :title="`${row.queries[col.key]} · opens GitHub search`"
                      >{{ num(row[col.key]) }}</a>
                      <span v-else>{{ num(row[col.key]) }}</span>
                    </td>
                    <td class="upd" data-l="pushed">{{ shortDate(row.pushedAt) }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            <!-- Two numbers that are not a ratio: how many repositories had activity,
                 and how many are owned. A count of one over the other would read as
                 "a fraction of your repositories", which it is not — the rows include
                 repositories this login only collaborates on. -->
            <!-- A total over the scope when every login answered; otherwise the rows
                 are only the readable logins', so say whose they are instead of
                 calling a partial count a total. -->
            <template v-if="repoCount !== null"><b>{{ num(repoCount) }}</b> with activity in these {{ span.days }} days</template>
            <template v-else-if="readText"><b>{{ num(repoRows.length) }}</b> from {{ readText }}</template>
            <template v-else>repositories not read for {{ scopeText }}</template>
            · <template v-if="ownedTotal === null">the owned total for {{ scopeText }} is not read</template>
            <template v-else>{{ num(ownedTotal) }} owned by {{ scopeText }}</template><template v-if="repoCapped"> · only the most recently pushed repositories were asked about</template>.
          </p>
        </section>

        <!-- A login whose numbers this token cannot read: `—` in the tiles, and this
             one line saying why and what to press. Never a zero it did not earn. -->
        <p v-for="line in unread" :key="line" class="dsh-unread">{{ line }}</p>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="dsh-budget-head">
          <div class="hd">
            <h3 id="dsh-budget-head">API budget</h3>
            <span class="n">{{ budgetWord }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>core</dt>
            <dd>
              {{ core ? `${num(core.remaining)} / ${num(core.limit)} · resets ${clock(core.resetAt)}` : '—' }}
            </dd>
            <dt>graphql</dt>
            <dd>{{ graph ? `${num(graph.remaining)} / ${num(graph.limit)}` : '—' }}</dd>
            <dt>read</dt>
            <dd>{{ github.readAt ? ago(github.readAt) : '—' }}</dd>
          </dl>
          <div class="dsh-meter" role="img" :aria-label="meterLabel"><i :style="{ width: meterWidth }"></i></div>
          <p class="dsh-foot">
            This read cost <b>{{ github.reads || 0 }}</b> {{ github.reads === 1 ? 'request' : 'requests' }}
            · <!-- a second open inside the window spends nothing, which is why the
                     number above is `0` on a cached read rather than a lie -->{{ cacheNote }}.
            <b>Refresh</b> is the only thing that reads GitHub sooner than the expiry.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
