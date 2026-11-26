<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ago } from '@/stores/hub'
import { ttlWords } from '@/connectors/parts/readClock'
import report, { num, pct, stamp as trackerStamp } from '@/connectors/youtrack/report'
import { readDashboard, youtrack } from '@/connectors/youtrack/useYoutrack'

/**
 * The YouTrack connector's Dashboard tab: who is stuck, and on what.
 *
 * Two reads, once, and every number on this pane derives from them in
 * `src/connectors/youtrack/report.js`. Nothing here adds up a column by itself — a tile and
 * the table under it come from the same function, so they cannot disagree, and the
 * arithmetic a lead checks by hand is the arithmetic a unit test already checks.
 *
 * **Two absences, two meanings**, carried through from that module: a read that did
 * not return prints `—` in the tiles it feeds, and a read that returned nothing
 * prints `0`. The pane never turns the first into the second.
 *
 * There is no sign-in here and no write. The credential is one header in
 * `mcp.json`, so the card in the rail prints the file and the header path instead of
 * a form that would misdescribe how the token arrives; and the two tools this pane
 * may call are `search_issues` and `get_issue`, both read-only.
 */
const route = useRoute()
const router = useRouter()

/* Three chips, not three filters: they decide which bands render. `both` is the
   absence of the parameter, because the address spells the default out as little
   as possible — the same rule the tab strip follows for `?tab=`. */
const SCOPES = [
  { key: 'both', label: 'Both reports' },
  { key: 'me', label: 'Just me' },
  { key: 'team', label: 'The team' },
]
const scope = computed(() => {
  const asked = String(route.query.scope || '')
  return SCOPES.some((entry) => entry.key === asked) ? asked : 'both'
})
const bandTop = ref(null)

function pickScope(key) {
  const query = { ...route.query }
  if (key === 'both') delete query.scope
  else query.scope = key
  router.replace({ query })
  /* The pane scrolls to its first rendered band: switching from "the team" to "just
     me" leaves the reader at an offset that no longer means anything. */
  bandTop.value?.scrollIntoView({ block: 'start' })
}

/* The clock the derived ages are measured against. Held in a ref and moved on a
   read so `report()` is a pure function of two reactive inputs — a `Date.now()` read
   inside the computed would make every frame a different answer. */
const now = ref(Date.now())

/* The rows the main process returned, handed to the pure derivation unchanged. A
   `null` read stays `null`: that is the difference between "did not answer" and
   "answered with nothing", and it is decided in the composable, not here. */
const data = computed(() =>
  report(
    {
      state: youtrack.state,
      readAt: youtrack.readAt,
      cached: youtrack.cached,
      cacheTtlMs: youtrack.cacheTtlMs,
      calls: youtrack.calls,
      window: youtrack.window,
      me: { login: youtrack.login, name: youtrack.name },
      errors: youtrack.errors,
      truncated: youtrack.truncated,
      unresolved: youtrack.unresolved,
      resolved: youtrack.resolved,
    },
    now.value,
  ),
)

const totals = computed(() => data.value.totals)

/* Three words the main process can answer with that mean "no rows", as opposed to
   "these rows". Kept as one list so the panel, the banner and the skeleton all
   agree on which states are failures. */
const FAULTS = ['refused', 'offline', 'timeout']
const fault = computed(() => {
  if (FAULTS.includes(String(youtrack.state || ''))) return String(youtrack.state)
  /* A thrown call is a broken call table, not a tracker state. It still has to stop
     the skeleton, or the pane waits forever for an answer that already failed. */
  if (youtrack.error && !data.value.readAt) return 'offline'
  return ''
})

/* A failure with nothing behind it: the reason sits where the figures would have
   been. A failure *after* a good read keeps its numbers and gets the banner below,
   because deleting a real table because a refresh timed out helps nobody. */
const failure = computed(() => (fault.value && !data.value.readAt ? fault.value : ''))

/* The skeleton is "first open, nothing cached" — an empty `readAt` is the same
   fact as `loading`, and saying `0` for it would be the confident zero this pane
   exists to avoid. */
const loading = computed(() => !failure.value && (youtrack.loading || !data.value.readAt))

/* A read that cost one of the two: the rest still renders, stamped and named. */
const incomplete = computed(() => {
  if (loading.value || !data.value.readAt) return null
  const truncated = data.value.truncated
  const cut = truncated.unresolved || truncated.resolved
  if (fault.value) {
    return {
      reads: [],
      cut,
      text:
        fault.value === 'refused'
          ? `YouTrack refused the token on the refresh — these numbers are the last read, at ${clock(data.value.readAt)}.`
          : `YouTrack stopped answering on the refresh — these numbers are the last read, at ${clock(data.value.readAt)}.`,
    }
  }
  const reads = Array.isArray(youtrack.errors) ? youtrack.errors : []
  if (!reads.length && !cut) return null
  return {
    reads,
    cut,
    text: reads.length
      ? `${reads.length === 1 ? 'One read' : `${reads.length} reads`} did not answer — ${reads
          .map((entry) => (entry.read === 'resolved' ? 'the resolved read' : 'the unresolved read'))
          .join(', ')}.`
      : 'A read stopped at the 1,200-row cap.',
  }
})

const showMe = computed(() => scope.value !== 'team')
const showTeam = computed(() => scope.value !== 'me')
const mine = computed(() => data.value.tiles.mine)
const teamTiles = computed(() => data.value.tiles.team)
const seats = computed(() => data.value.team)

/* How long a stored answer stays good, in words that come from the answer itself:
   a hardcoded "5 minutes" outlives the constant it describes. `ttlWords` is the shared
   rule (`parts/readClock.js`); the stamp below stays local because this page also says
   whether the answer on screen is served or fresh, which is its own sentence. */
const ttlText = computed(() => ttlWords(data.value.cacheTtlMs))
const cacheUntil = computed(() => {
  const read = Date.parse(data.value.readAt)
  const ms = Number(data.value.cacheTtlMs)
  if (!Number.isFinite(read) || !Number.isFinite(ms) || ms <= 0) return ''
  return clock(new Date(read + ms).toISOString())
})
const stamp = computed(() => {
  if (loading.value) return 'reading…'
  if (!data.value.readAt) return 'not read yet'
  const read = `read ${ago(data.value.readAt)}`
  if (!data.value.cached) return ttlText.value ? `${read} · cached for ${ttlText.value}` : read
  return cacheUntil.value ? `${read} · cached until ${cacheUntil.value}` : `${read} · from cache`
})

/* ── the window, printed the way the read asked for it ──────────────── */
const dayText = (iso, year) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
  })
}
const span = computed(() => data.value.window)
const spanText = computed(
  () => `${span.value.days} days · ${dayText(span.value.since, false)} – ${dayText(span.value.until, true)}`,
)
const windowQueries = computed(() => {
  const queries = youtrack.queries || {}
  return {
    unresolved: String(queries.unresolved || '#Unresolved'),
    resolved: String(queries.resolved || '#Resolved resolved date: …'),
  }
})

function clock(iso) {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })
    : '—'
}

/* ── the table ─────────────────────────────────────────────────────── */
const shareWidth = (share) =>
  !Number.isFinite(Number(share)) || Number(share) <= 0
    ? '0%'
    : `${Math.max(2, Math.round(Number(share) * 100))}%`
const ofIssues = (count) => pct(count, totals.value.unresolved)

/* ── the flow ──────────────────────────────────────────────────────── */
const barHeight = (height) =>
  !Number.isFinite(Number(height)) || Number(height) <= 0 ? '0%' : `${Math.max(2, Math.round(Number(height) * 100))}%`

/* One sentence, not a graphic: a screen reader gets the same seven columns a sighted
   reader does, and the peak that scales them. */
const flowLabel = computed(() => {
  const days = data.value.flow.days
  if (data.value.flow.empty) return 'Created and resolved per day, last 7 days: nothing created or resolved.'
  const parts = days.map((day) => `${dayText(day.day, false)}: ${day.created} created, ${day.resolved} resolved`)
  return `Created and resolved per day, last 7 days, on a shared peak of ${data.value.flow.peak}. ${parts.join('; ')}.`
})

/* ── the backlog ───────────────────────────────────────────────────── */
const projectWidth = (width) =>
  !Number.isFinite(Number(width)) || Number(width) <= 0 ? '0%' : `${Math.max(2, Math.round(Number(width) * 100))}%`

/* Where the tracker's own pages are. `host` is the host of the server URL in this
   workspace's `mcp.json`, so an empty one means the file holds no URL to build on —
   the badge says so, and a link built from nothing would point at this app. */
const trackerUrl = computed(() => (youtrack.host ? `https://${youtrack.host}` : ''))

/* A project row is an aggregate, so its link is the tracker's own search for that
   project's unresolved issues: the number on the row and the list it opens are one
   query, read off the same `#Unresolved` the pane already asked for. The name is
   encoded because it may hold a space; the space and the `#` that follow it are
   written out, since a raw one would end the query at the fragment. */
const projectHref = (project) =>
  trackerUrl.value
    ? `${trackerUrl.value}/issues?q=project:{${encodeURIComponent(project)}}%20%23Unresolved`
    : ''

/* ── the oldest rows the backlog is counted from ───────────────────── */
/* Eight, not the whole read: this is the nudge under the counts, and the tab's one
   list of individual issues does not need to become a second table. */
const OLDEST_ROWS = 8
const oldest = computed(() => {
  const rows = Array.isArray(youtrack.unresolved) ? [...youtrack.unresolved] : []
  /* `trackerStamp` is the one reader that turns the tracker's `YYYY-MM-DD hh:mm:ss`
     into a number — aliased, because `stamp` below is the read's own clock. A row
     with no date sorts last rather than to the top of a list called oldest, so an
     undated issue cannot hide the one that has waited longest. */
  return rows
    .sort((a, b) => (trackerStamp(a.createdAt) ?? Infinity) - (trackerStamp(b.createdAt) ?? Infinity))
    .slice(0, OLDEST_ROWS)
})

/* The row's own `url` is the tracker's answer and always wins; the built one is the
   fallback for a row that arrived without it. */
const issueHref = (row) =>
  String(row?.url || '') ||
  (trackerUrl.value ? `${trackerUrl.value}/issue/${encodeURIComponent(String(row?.id || ''))}` : '')

/* The count beside the head keeps the pane's two absences apart: a read that did not
   answer is `—`, a read that answered with nothing is `none`. */
const oldestCount = computed(() => {
  if (!Array.isArray(youtrack.unresolved)) return '—'
  return oldest.value.length ? `${oldest.value.length} of ${num(totals.value.unresolved)}` : 'none'
})

/* ── what to do about it ───────────────────────────────────────────── */
const credentialFile = computed(() => String(youtrack.file || 'mcp.json'))
const headerPath = computed(() => String(youtrack.headerPath || 'servers.youtrack.headers.Authorization'))
const toolsOnServer = computed(() => Number(youtrack.tools) || 0)

function refresh() {
  now.value = Date.now()
  readDashboard({ force: true }).then(() => {
    now.value = Date.now()
  })
}

/* One read, and this is the only place that makes it on open. The page probes the
   credential to decide whether the tab may be opened at all; it never reads the
   numbers, because two mounts fetching the same two queries would be four calls
   for one tab and a cache that saves nothing. `force` is the button above and
   nothing else.

   A cached answer still arrives through here: the main process holds the rows for
   five minutes, so re-opening the tab is one call table round trip and zero
   tracker requests. */
onMounted(async () => {
  now.value = Date.now()
  if (!youtrack.readAt) await readDashboard()
  now.value = Date.now()
})
</script>

<template>
  <div ref="bandTop" class="dsh-band">
    <!-- A dead token, named with the file and the header it lives in. Never a
         sign-in form: Entity does not hold this credential and could not repair a
         form it never sees. -->
    <div v-if="failure" class="dsh-err" role="alert">
      <b v-if="failure === 'refused'">
        YouTrack refused the token — HTTP {{ youtrack.readStatus || 401 }}.
      </b>
      <b v-else-if="failure === 'timeout'">YouTrack did not answer in 8 s.</b>
      <b v-else>The dashboard could not reach YouTrack.</b>
      <p>
        <span v-if="failure === 'refused'">
          The token in <code class="mono">{{ credentialFile }}</code> is present and dead.
          Dashboard reads <code class="mono">{{ headerPath }}</code> and nothing else.
        </span>
        <span v-else>
          <code class="mono">{{ youtrack.message || 'The tracker did not answer.' }}</code>
          The credential is one header in <code class="mono">{{ credentialFile }}</code>;
          nothing on this page can sign in for you.
        </span>
      </p>
      <div class="dsh-err-act">
        <a
          class="btn btn-sm"
          href="https://www.jetbrains.com/help/youtrack/devportal/Manage-Permanent-Token.html"
          target="_blank"
          rel="noreferrer noopener"
        >How to make a permanent token ↗</a>
        <button class="btn btn-sm btn-ghost" type="button" :disabled="youtrack.reading" @click="refresh">
          {{ youtrack.reading ? 'Trying…' : 'Try again' }}
        </button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which report to show">
        <button
          v-for="entry in SCOPES"
          :key="entry.key"
          type="button"
          class="dsh-chip"
          :aria-pressed="scope === entry.key"
          @click="pickScope(entry.key)"
        >{{ entry.label }}</button>
      </div>
      <div class="dsh-when">
        <span>{{ spanText }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="youtrack.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ youtrack.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Numbers on screen are real and one read short. Stamped, named and
         retryable, because a silently short table is worse than no table. -->
    <div v-if="incomplete" class="dsh-wait" data-tone="warn" role="status">
      <span class="k">Partly read</span>
      <p>
        <b>{{ stamp }}</b> · {{ incomplete.text }}
        The tiles that read depends on print <b>—</b>, not a zero.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="youtrack.reading" @click="refresh">Refresh</button>
    </div>

    <!-- ── the "you" band. Asks what is on your plate that is big and going cold;
            the team band asks where the unowned work sits. Two questions, two tile
            sets, never one merged grid. ─────────────────────────────────────── -->
    <template v-if="showMe">
      <div class="dsh-sect">
        <h2>You</h2>
        <p class="why">
          <template v-if="!data.me.login">
            The token cannot name the account behind it, so there is no seat to count here.
          </template>
          <template v-else>
            What is on your plate that is big and going cold — assigned to
            <b>@{{ data.me.login }}</b>.
          </template>
        </p>
        <a v-if="scope === 'both'" class="dsh-jump" href="#dsh-team">Jump to the team report ↓</a>
      </div>

      <div class="dsh-kpis" role="list" :aria-busy="loading ? 'true' : 'false'">
        <div
          v-for="tile in mine"
          :key="tile.key"
          class="dsh-kpi"
          role="listitem"
          :title="tile.query"
        >
          <span class="k">{{ tile.label }}</span>
          <span v-if="loading" class="dsh-skel" style="width: 46%; height: 22px; margin: 6px 0 4px"></span>
          <b v-else class="v">{{ num(tile.value) }}</b>
          <span class="q">{{ tile.query }}</span>
        </div>
      </div>
    </template>

    <div class="dsh">
      <div class="dsh-main">
        <!-- ── the team band: where the unowned and the undecided work sits ── -->
        <template v-if="showTeam">
          <div id="dsh-team" class="dsh-sect">
            <h2>The team</h2>
            <p class="why">
              Every seat the tracker names on an open issue — the unowned, the undecided
              and the ones that stopped moving.
            </p>
          </div>

          <div class="dsh-kpis" role="list" :aria-busy="loading ? 'true' : 'false'">
            <div
              v-for="tile in teamTiles"
              :key="tile.key"
              class="dsh-kpi"
              role="listitem"
              :title="tile.query"
            >
              <span class="k">{{ tile.label }}</span>
              <span v-if="loading" class="dsh-skel" style="width: 46%; height: 22px; margin: 6px 0 4px"></span>
              <b v-else class="v">{{ num(tile.value) }}</b>
              <span class="q">{{ tile.query }}</span>
            </div>
          </div>

          <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-seats-head">
            <div class="hd">
              <h3 id="dsh-seats-head">Seats</h3>
              <span class="n">{{ loading ? '—' : num(seats.seats) }}</span>
              <span class="spacer"></span>
              <span class="hd-when">sorted by open, then stalled</span>
            </div>
            <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-seats-head">
              <table class="dsh-tbl dsh-tbl-team">
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col" class="num">Open</th>
                    <th scope="col" class="num">In prog.</th>
                    <th scope="col" class="num">Discussed</th>
                    <th scope="col" class="num">Stalled</th>
                    <th scope="col" class="num">Oldest</th>
                    <th scope="col" class="num">Done 7 d</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-if="loading">
                    <tr v-for="n in 5" :key="`sk${n}`" class="skrow">
                      <td>
                        <span class="dsh-skel" style="width: 62%; height: 11px"></span>
                        <span class="dsh-skel" style="width: 88%; height: 2px; margin-top: 7px"></span>
                      </td>
                      <td v-for="cell in 6" :key="`sk${n}-${cell}`" class="num">
                        <span class="dsh-skel" style="width: 28px; height: 9px"></span>
                      </td>
                    </tr>
                  </template>
                  <!-- A read that failed is not a tracker that answered with nothing:
                       the panel above says which it was, and an empty table under it
                       would contradict the alert. -->
                  <tr v-else-if="!failure && !seats.rows.length" class="emptyrow">
                    <td colspan="7">
                      <b>No assignee has an unresolved issue.</b>
                      <span>
                        The tracker answered and returned nothing — a brand-new project
                        looks exactly like this.
                      </span>
                    </td>
                  </tr>
                  <template v-else>
                    <tr v-for="row in seats.rows" :key="row.login">
                      <td class="who">
                        <div class="dsh-nm">
                          <span class="dsh-mm" aria-hidden="true">{{ row.monogram }}</span>
                          <span class="t">
                            <b v-if="row.name" :title="row.name">{{ row.name }}</b>
                            <span class="lg" :title="row.login">{{ row.login }}</span>
                          </span>
                        </div>
                        <span class="dsh-share" aria-hidden="true"><i :style="{ width: shareWidth(row.share) }"></i></span>
                      </td>
                      <td class="num" data-l="open">
                        {{ num(row.open) }}
                        <span class="dsh-pc">{{ ofIssues(row.open) }}</span>
                      </td>
                      <td class="num" data-l="in progress">{{ num(row.inProgress) }}</td>
                      <td class="num" data-l="discussed">{{ num(row.discussed) }}</td>
                      <td class="num stalled" data-l="stalled">{{ num(row.stalled) }}</td>
                      <td class="num oldest" data-l="oldest">{{ num(row.oldestDays) }} d</td>
                      <td class="num done" data-l="done 7 d">{{ num(row.done7) }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <!-- Seats, not people: an issue with two assignees is in both rows, so
                 this sum is larger than the issue count by design. Said in the foot,
                 because a lead will try to reconcile it. -->
            <p class="dsh-foot">
              <b>{{ num(seats.seatTotal) }}</b> open across <b>{{ num(seats.seats) }}</b>
              {{ seats.seats === 1 ? 'seat' : 'seats' }} — an issue with two assignees is counted twice,
              so this is not the tracker's <b>{{ num(totals.unresolved) }}</b> issues.
              <template v-if="seats.unassigned !== null">
                <b>{{ num(seats.unassigned) }}</b> of them have no assignee at all.
              </template>
            </p>
          </section>
        </template>
      </div>

      <div class="dsh-rail">
        <!-- ── created and resolved, one shared peak ───────────────────────── -->
        <section class="dsh-card" aria-labelledby="dsh-flow-head">
          <div class="hd">
            <h3 id="dsh-flow-head">Flow, last 7 days</h3>
            <span class="n">created / resolved</span>
          </div>
          <div v-if="loading" class="dsh-flow" aria-hidden="true">
            <div v-for="n in 7" :key="`fsk${n}`" class="dsh-flow-col">
              <div class="bars">
                <span class="dsh-skel" style="width: 9px; height: 46px"></span>
                <span class="dsh-skel" style="width: 9px; height: 28px"></span>
              </div>
              <span class="dsh-skel" style="width: 16px; height: 7px"></span>
            </div>
          </div>
          <p v-else-if="!failure && data.flow.empty" class="dsh-none">Nothing created or resolved in the last 7 days.</p>
          <div v-else class="dsh-flow" role="img" :aria-label="flowLabel">
            <div
              v-for="day in data.flow.days"
              :key="day.day"
              class="dsh-flow-col"
              :title="`${day.day}: ${day.created} created, ${day.resolved} resolved`"
            >
              <div class="bars">
                <i data-k="created" :style="{ height: barHeight(day.createdH) }"></i>
                <i data-k="resolved" :style="{ height: barHeight(day.resolvedH) }"></i>
              </div>
              <span class="lb">{{ day.label }}</span>
            </div>
          </div>
          <p class="dsh-legend">
            <span><i data-k="created" aria-hidden="true"></i>created</span>
            <span><i data-k="resolved" aria-hidden="true"></i>resolved</span>
          </p>
          <p class="dsh-foot">
            {{ num(data.flow.created) }} created · {{ num(data.flow.resolved) }} resolved ·
            peak <b>{{ num(data.flow.peak) }}</b> in one day. Counted from the same two reads.
          </p>
        </section>

        <!-- ── where the backlog sits ─────────────────────────────────────── -->
        <section class="dsh-card" aria-labelledby="dsh-backlog-head">
          <div class="hd">
            <h3 id="dsh-backlog-head">Where the backlog sits</h3>
            <span class="n">
              {{ loading ? '—' : `${data.backlog.rows.length} of ${num(data.backlog.total)}` }}
            </span>
          </div>
          <ul class="dsh-repos dsh-projs">
            <template v-if="loading">
              <li v-for="n in 7" :key="`bsk${n}`">
                <span class="nm"><span class="dsh-skel" style="width: 42%; height: 9px"></span></span>
                <span class="dsh-pbar"><i style="width: 40%"></i></span>
                <span class="when"><span class="dsh-skel" style="width: 18px; height: 7px"></span></span>
              </li>
            </template>
            <template v-else>
              <li v-for="(row, index) in data.backlog.rows" :key="row.project" :title="row.project">
                <!-- A project name is a link when the tracker's host is known; with
                     no host it stays the plain text it has always been. -->
                <a
                  v-if="projectHref(row.project)"
                  class="nm"
                  :href="projectHref(row.project)"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ row.project }}</a>
                <span v-else class="nm">{{ row.project }}</span>
                <span class="dsh-pbar" aria-hidden="true" :data-first="index === 0 ? '1' : null">
                  <i :style="{ width: projectWidth(row.width) }"></i>
                </span>
                <span class="when">{{ num(row.count) }}</span>
              </li>
              <li v-if="!failure && !data.backlog.rows.length" class="dsh-none">
                No project holds an unresolved issue.
              </li>
            </template>
          </ul>
          <p v-if="!loading && data.backlog.rest" class="dsh-foot">
            {{ num(data.backlog.rest) }} more across the other
            {{ num(data.backlog.total - data.backlog.rows.length) }} projects.
          </p>
        </section>

        <!-- ── the rows the backlog above is counted from ───────────────────
             One issue list, oldest first, because a count of 41 says nothing about
             which 41 to start on — and each row leaves for the tracker, which is
             where the issue can actually be worked. ──────────────────────── -->
        <section class="dsh-card" aria-labelledby="dsh-oldest-head">
          <div class="hd">
            <h3 id="dsh-oldest-head">Oldest unresolved</h3>
            <span class="n">{{ loading ? '—' : oldestCount }}</span>
          </div>
          <ul class="dsh-repos dsh-issues">
            <template v-if="loading">
              <li v-for="n in 5" :key="`osk${n}`">
                <span class="id"><span class="dsh-skel" style="width: 42px; height: 8px"></span></span>
                <span class="dsh-skel" style="width: 68%; height: 9px"></span>
              </li>
            </template>
            <template v-else>
              <li v-for="row in oldest" :key="row.id">
                <span class="id">{{ row.id }}</span>
                <a
                  v-if="issueHref(row)"
                  class="ell"
                  :href="issueHref(row)"
                  :title="row.summary"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ row.summary }}</a>
                <span v-else class="ell muted" :title="row.summary">{{ row.summary }}</span>
                <span class="pj">{{ row.project }}</span>
              </li>
              <li v-if="!failure && !oldest.length" class="dsh-none">
                No unresolved issue was read.
              </li>
            </template>
          </ul>
        </section>

        <!-- ── what this reads: two tools, no write, and the one file the
               credential lives in ─────────────────────────────────────────── -->
        <section class="dsh-card reads" aria-labelledby="dsh-reads-head">
          <div class="hd">
            <h3 id="dsh-reads-head">What this reads</h3>
            <span class="n">{{ toolsOnServer ? `${toolsOnServer} tools on the server` : 'tool count unknown' }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>reads</dt>
            <dd><code class="mono">search_issues</code>, <code class="mono">get_issue</code></dd>
            <dt>open</dt>
            <dd><code class="mono">{{ windowQueries.unresolved }}</code></dd>
            <dt>closed</dt>
            <dd><code class="mono">{{ windowQueries.resolved }}</code></dd>
            <dt>cost</dt>
            <dd>
              {{ num(data.calls) }} tool calls, read once
              <template v-if="ttlText">· cached for {{ ttlText }}</template>
            </dd>
          </dl>
          <p class="reads-note">
            This pane holds no write tool. It reads issues and cannot change one, close
            one or comment on it.
          </p>
          <div class="tokcard">
            <span class="k">credential</span>
            <code :title="credentialFile">{{ credentialFile }}</code>
            <code :title="headerPath">{{ headerPath }}</code>
            <span class="n">one header, in this workspace's file — there is nothing to sign in to here.</span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
