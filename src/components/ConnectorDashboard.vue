<script setup>
import { computed, ref } from 'vue'
import { ago } from '@/stores/hub'
import { copyText } from '@/lib/clipboard'
import { github, makeActive, readDashboard } from '@/composables/githubDashboard'

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
const selected = ref('')
const copied = ref('')

const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) => (Number.isFinite(Number(value)) ? nFmt.format(Number(value)) : '—')

/* Every login with a name, refused or not: a refused chip stays on screen, because
   removing it would hide which account is broken. */
const named = computed(() => github.logins.filter((entry) => entry.login))
const readable = computed(() => named.value.filter((entry) => !entry.refused))
/* The chips read this: an empty slice is not a filter, it is "everything". */
const scope = computed(() => {
  if (selected.value && readable.value.some((entry) => entry.login === selected.value)) {
    return [selected.value]
  }
  return readable.value.map((entry) => entry.login)
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
/* How long a stored answer stays good, in the words the page prints. Read from the
   answer the main process sent, never typed into the copy: a hardcoded "15 min"
   that outlived the constant was how the cache came to look shorter than it is. */
const ttlText = computed(() => {
  const ms = Number(github.cacheTtlMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const days = ms / 86_400_000
  if (days >= 1 && Number.isInteger(days)) return days === 1 ? '1 day' : `${days} days`
  const hours = Math.max(1, Math.round(ms / 3_600_000))
  return hours === 1 ? '1 hour' : `${hours} hours`
})
/* When the stored answer stops being good: the read plus its clock, to the minute.
   A person who wants a fresh number needs to know when one arrives on its own. */
const cacheUntil = computed(() => {
  const ms = Number(github.cacheTtlMs)
  const read = new Date(github.readAt).getTime()
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(read)) return ''
  return new Date(read + ms).toLocaleString('en-gb', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
})
/* The same rule in the foot of a card: what was done, and how long it stands. */
const cacheNote = computed(() => {
  if (github.cached) return ttlText.value ? `served from the ${ttlText.value} cache` : 'served from the stored cache'
  return ttlText.value ? `cached for ${ttlText.value}` : 'cached'
})
const stamp = computed(() => {
  if (github.loading) return 'reading…'
  if (!github.readAt) return 'not read yet'
  const read = `read ${ago(github.readAt)}`
  return cacheUntil.value ? `${read} · cached until ${cacheUntil.value}` : read
})

/* ── the six counts ────────────────────────────────────────────────
   A count is `null` when the login that owns it lacks the scope to see all of
   it. Summing the half that is visible would print a smaller true-looking number,
   so one unknown makes the total unknown — `—`, never `0`. */
function countOf(key) {
  const values = scope.value.map((login) => github.accounts?.[login]?.counts?.[key])
  if (!values.length || values.some((value) => !Number.isFinite(Number(value)))) return null
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

/* ── the rail ────────────────────────────────────────────────────── */
const repos = computed(() => {
  const rows = []
  for (const login of scope.value) {
    for (const repo of github.accounts?.[login]?.repos || []) rows.push(repo)
  }
  const seen = new Set()
  return rows
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
    .filter((repo) => (seen.has(repo.name) ? false : seen.add(repo.name)))
    .slice(0, 6)
})
const pushedTotal = computed(() => {
  const values = scope.value.map((login) => github.accounts?.[login]?.reposReadable)
  if (!values.length || values.some((value) => !Number.isFinite(Number(value)))) return null
  return values.reduce((sum, value) => sum + Number(value), 0)
})
const ownedTotal = computed(() => {
  const values = scope.value.map((login) => github.accounts?.[login]?.owned)
  if (!values.length || values.some((value) => !Number.isFinite(Number(value)))) return null
  return values.reduce((sum, value) => sum + Number(value), 0)
})
const repoName = (name) => {
  const [owner, base] = String(name).split('/')
  return { owner: owner ? `${owner}/` : '', base: base || String(name) }
}

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
  selected.value = selected.value === entry.login ? '' : entry.login
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
          :aria-pressed="selected === ''"
          @click="selected = ''"
        >All accounts <span class="n">{{ readable.length }}</span></button>
        <button
          v-for="entry in named"
          :key="entry.login"
          type="button"
          class="dsh-chip"
          :aria-pressed="selected === entry.login"
          :aria-disabled="entry.refused ? 'true' : undefined"
          :title="entry.refused ? 'This login cannot be read until its token is replaced' : undefined"
          @click="pick(entry)"
        ><i class="dot" :data-on="entry.refused ? '2' : entry.active ? '1' : '0'" aria-hidden="true"></i>@{{ entry.login }}
          <span v-if="entry.refused" class="n">refused</span>
          <span v-else-if="entry.active" class="n">active</span>
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
                    <b>Nothing opened, merged or waiting in these 90 days.</b>
                    <span v-if="scope.length">
                      {{ scope.map((login) => `@${login}`).join(' and ') }}
                      {{ scope.length > 1 ? 'have' : 'has' }} 0 pull requests in the window.
                    </span>
                    <a :href="`https://${github.host}/pulls`" target="_blank" rel="noreferrer noopener">Open github.com/pulls ↗</a>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="pull in pulls" :key="`${pull.repo}#${pull.number}`">
                    <td>
                      <div class="dsh-pr">
                        <span class="repo" :title="`${pull.repo}#${pull.number}`">{{ pull.repo }}<b>#{{ pull.number }}</b> ·
                          <span class="who">@{{ pull.author || 'unknown' }}</span></span>
                        <a :href="pull.url" :title="pull.title">{{ pull.title }}</a>
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
            <a :href="pullsUrl" target="_blank" rel="noreferrer noopener">open all {{ pulls.length }} on GitHub ↗</a>
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="dsh-repos-head">
          <div class="hd">
            <h3 id="dsh-repos-head">Pushed recently</h3>
            <span class="n">{{ pushedTotal === null ? '—' : `${repos.length} of ${num(pushedTotal)}` }}</span>
          </div>
          <ul class="dsh-repos">
            <template v-if="github.loading">
              <li v-for="n in 4" :key="`rsk${n}`">
                <span class="dsh-skel" style="width: 64%; height: 9px"></span>
              </li>
            </template>
            <template v-else>
              <li v-for="repo in repos" :key="repo.name" :title="repo.name">
                <span class="nm"><em>{{ repoName(repo.name).owner }}</em>{{ repoName(repo.name).base }}</span>
                <span v-if="repo.private" class="pv">private</span>
                <span class="when">{{ ago(repo.pushedAt) }}</span>
              </li>
              <li v-if="!repos.length" class="dsh-none">Nothing pushed in this window.</li>
            </template>
          </ul>
          <p class="dsh-foot">
            {{ ownedTotal === null ? '—' : num(ownedTotal) }} repositories readable by
            {{ scope.length === 1 ? '@' + scope[0] : `these ${scope.length || 0} accounts` }}.
          </p>
        </section>

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
