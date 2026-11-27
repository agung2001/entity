<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ago } from '@/stores/hub'
import { ttlWords } from '@/connectors/parts/readClock'
import report, { num, pct } from '@/connectors/youtrack/report'
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
 *
 * **Two reports, two views.** *Just me* answers what is on your plate; *the team*
 * answers where the unowned, the undecided and the stopped work sits. They are
 * peers, not bands in one scroll: one is rendered at a time, each with its own rail,
 * and `?scope=team` is the only thing the address spells out — `me` is the default
 * and therefore the bare URL, the rule the tab strip above already follows for
 * `?tab=`.
 */
const route = useRoute()
const router = useRouter()

/* Two views, not two filters and not two bands in one scroll: `me` and `team` are
   peer reports, and only one of them is on screen at a time. `me` is the default and
   therefore the absence of the parameter, because the address spells the default out
   as little as possible — the same rule the tab strip follows for `?tab=`. */
const SCOPES = [
  { key: 'me', label: 'Just me' },
  { key: 'team', label: 'The team' },
]
const scope = computed(() => {
  const asked = String(route.query.scope || '')
  return SCOPES.some((entry) => entry.key === asked) ? asked : 'me'
})
const bandTop = ref(null)

function pickScope(key) {
  if (!SCOPES.some((entry) => entry.key === key)) return
  const query = { ...route.query }
  if (key === 'me') delete query.scope
  else query.scope = key
  router.replace({ query })
  /* Each view is its own scroll: switching leaves the reader at an offset that
     belonged to the report they were no longer reading. */
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
      /* The three facts the report links and the sprint card are built on: the origin
         the rows came from, and the board read that rode beside them. Passed straight
         through — `report.js` owns every href and every percentage. */
      base: youtrack.base,
      sprint: youtrack.sprint,
      sprintState: youtrack.sprintState,
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

const mine = computed(() => data.value.tiles.mine)
const teamTiles = computed(() => data.value.tiles.team)
const seats = computed(() => data.value.team)

/* The count beside "Your open work", keeping the pane's two absences apart: a read
   that did not answer, or a token that cannot name its own seat, prints `—` — never a
   `0` the tracker did not say. It says `12` when the list is all of them and `12 of 20`
   when it is not, so the head never reads `12 of 12`. */
const myHead = computed(() => {
  const list = data.value.myOpen
  if (loading.value || list.total === null) return '—'
  return list.rows.length === list.total
    ? num(list.total)
    : `${num(list.rows.length)} of ${num(list.total)}`
})

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

/* Where the tracker's own pages are, as the read reported them. `report.base` is the
   origin of the server URL in this workspace's `mcp.json`; every href in this pane is
   derived in `report.js` from it, so nothing here rebuilds a link or hardcodes a host. */

/* ── the oldest rows the backlog is counted from ───────────────────── */
/* Derived in `report.js` beside the counts they come from: eight, oldest first, each
   one already carrying the id, the date and the href the card prints. */
const oldest = computed(() => data.value.oldest)

/* The count beside the head keeps the pane's two absences apart: a read that did not
   answer is `—`, a read that answered with nothing is `none`. */
const oldestCount = computed(() => {
  if (!Array.isArray(youtrack.unresolved)) return '—'
  return oldest.value.length ? `${oldest.value.length} of ${num(totals.value.unresolved)}` : 'none'
})

/* `share` arrives as a 0..1 fraction, so neither the sprint bar nor the breakdown bar
   divides in the template: `shareWidth` above paints it, with the same floor a real
   but tiny share needs to stay visible. */

/* The state pills the backlog table prints: reused from this pack's own `.st` pill,
   so a state is a dot and a word in the same grammar as the seats table. A state the
   map does not know keeps the neutral dot rather than inventing a colour. */
const stateTone = (state) => {
  const word = String(state || '').toLowerCase()
  if (word.includes('progress')) return 'warn'
  if (word === 'fixed') return 'bad'
  return ''
}

/* ── the four facts One's report prints above its tiles ─────────────── */
const metaRows = computed(() => {
  const meta = data.value.meta
  return [
    { k: 'Period', v: meta.period },
    { k: 'Source', v: meta.source },
    { k: 'Generated', v: meta.generated },
    { k: 'Scope', v: meta.scope },
  ]
})

/* One sentence for the chart, so a screen reader gets the seven bars and the peak
   they are drawn against instead of a `role="img"` with no words in it. */
const cadenceLabel = computed(() => {
  const bars = data.value.cadence
  if (!bars.length) return 'Delivery cadence: no day to draw'
  const parts = bars.map((bar) => `${bar.label} ${bar.value} resolved`)
  return `Delivery cadence over ${bars.length} days, on a peak of ${data.value.cadencePeak} resolved in one day. ${parts.join('; ')}.`
})

/* Three slices of one open queue, all against the same denominator, so the three
   cards cannot describe the backlog in three different totals. */
const breakdown = computed(() => [
  { key: 'state', title: 'By state', rows: data.value.queue },
  { key: 'type', title: 'By type', rows: data.value.queueTypes },
  { key: 'priority', title: 'By priority', rows: data.value.queuePriorities },
])

const sprintLabel = computed(() => {
  const sprint = data.value.sprint
  if (!sprint) return 'Sprint progress: no current sprint'
  if (!sprint.segments.length) return `${sprint.name}: no work items yet`
  const parts = sprint.segments.map((segment) => `${segment.count} ${segment.label.toLowerCase()}`)
  return `${sprint.progress}% of ${sprint.total} work items resolved: ${parts.join(', ')}.`
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

    <!-- One bar, one choice: which of the two reports is open. A segmented control,
         not a second tab strip — the page already has a tab strip above this one
         (Overview | Dashboard), and two of them stacked read as two navigations.
         The read stamp and Refresh sit on the same line, right-aligned, the way the
         Clockify band states its workspace and its read. -->
    <div class="dsh-bar">
      <span class="dsh-lead">Report</span>
      <div class="seg" role="group" aria-label="Which report to show">
        <button
          v-for="entry in SCOPES"
          :key="entry.key"
          type="button"
          :aria-pressed="scope === entry.key ? 'true' : 'false'"
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

    <!-- ── the "Just me" view: what is on your plate that is big and going cold.
            One report on screen at a time — the team report is its own view below,
            not a band under this one, and each view keeps only the cards its own
            numbers feed. ────────────────────────────────────────────────────── -->
    <template v-if="scope === 'me'">
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
          <span class="q">{{ tile.hint }}</span>
        </div>
      </div>

      <div class="dsh">
        <div class="dsh-main">
          <!-- The rows the `Open` tile counts, listed: the tile says how many, this
               says which ones. Touched last first — the plate a person works from is
               the one they moved most recently. -->
          <section class="dsh-card" aria-labelledby="dsh-mine-head">
            <div class="hd">
              <h3 id="dsh-mine-head">Your open work</h3>
              <span class="n">{{ myHead }}</span>
              <span class="spacer"></span>
              <span class="hd-when">touched last first</span>
            </div>
            <ul class="dsh-repos dsh-issues">
              <template v-if="loading">
                <li v-for="n in 5" :key="`my${n}`">
                  <span class="id"><span class="dsh-skel" style="width: 42px; height: 8px"></span></span>
                  <span class="dsh-skel" style="width: 68%; height: 9px"></span>
                </li>
              </template>
              <template v-else>
                <!-- Three absences, three sentences: a token that cannot name its
                     own seat, a read that did not answer, and a tracker that really
                     has nothing on this plate. -->
                <li v-if="!data.me.login" class="dsh-none">
                  The token cannot name the account behind it, so there is no list to show.
                </li>
                <li v-else-if="data.myOpen.total === null" class="dsh-none">
                  The unresolved read did not answer, so there is no list to show.
                </li>
                <li v-else-if="!data.myOpen.rows.length" class="dsh-none">
                  Nothing unresolved is assigned to you.
                </li>
                <template v-else>
                  <li v-for="row in data.myOpen.rows" :key="row.id">
                    <a
                      v-if="row.url"
                      class="id"
                      :href="row.url"
                      :title="`Open ${row.id} in YouTrack`"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ row.id }}</a>
                    <span v-else class="id">{{ row.id }}</span>
                    <a
                      v-if="row.url"
                      class="ell"
                      :href="row.url"
                      :title="`Open ${row.id} in YouTrack`"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ row.summary }}</a>
                    <span v-else class="ell muted" :title="row.summary">{{ row.summary }}</span>
                    <a
                      v-if="row.projectUrl"
                      class="pj"
                      :href="row.projectUrl"
                      :title="`Open ${row.project} in YouTrack`"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ row.project }}</a>
                    <span v-else class="pj">{{ row.project }}</span>
                  </li>
                </template>
              </template>
            </ul>
            <p v-if="!loading && data.myOpen.more" class="dsh-foot">
              <b>{{ num(data.myOpen.more) }}</b> more open assigned to you — the team
              report lists the backlog they sit in.
            </p>
          </section>
        </div>

        <!-- The one card here that is about the pane rather than the person: which
             file the token lives in is exactly what a reader needs when their own
             seat cannot be counted. -->
        <div class="dsh-rail">
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
                {{ num(data.calls) }} tool calls, one read
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
    </template>

    <!-- ── the team report: every seat the tracker names, then everything One's page
            prints — the window, the four figures, the cadence, the sprint, the
            queue's shape and the two tables. ────────────────────────────────── -->
    <template v-else>
      <!-- ── the team band: where the unowned and the undecided work sits. Its own
              heading, at the band's own offset, so swapping the two reports does not
              move it. ──────────────────────────────────────────────────────── -->
      <div class="dsh-sect">
        <h2>Who is stuck</h2>
        <p class="why">
          Every seat the tracker names on an open issue — the unowned, the undecided
          and the ones that stopped moving.
        </p>
      </div>

      <div class="dsh">
        <div class="dsh-main">
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
              <span class="q">{{ tile.hint }}</span>
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

          <!-- ── the rows the counts above are made of ────────────────────────
               One issue list, oldest first, because a count of 41 says nothing about
               which 41 to start on — and each row leaves for the tracker, which is
               where the issue can actually be worked. It sits under the seats rather
               than in the rail: this column is shorter than the rail, and a list a
               page wide is easier to scan than the same list in 306 px. ──────── -->
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
                  <a
                    v-if="row.url"
                    class="id"
                    :href="row.url"
                    :title="`Open ${row.id} in YouTrack`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ row.id }}</a>
                  <span v-else class="id">{{ row.id }}</span>
                  <a
                    v-if="row.url"
                    class="ell"
                    :href="row.url"
                    :title="`Open ${row.id} in YouTrack`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ row.summary }}</a>
                  <span v-else class="ell muted" :title="row.summary">{{ row.summary }}</span>
                  <a
                    v-if="row.projectUrl"
                    class="pj"
                    :href="row.projectUrl"
                    :title="`Open ${row.project} in YouTrack`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ row.project }}</a>
                  <span v-else class="pj">{{ row.project }}</span>
                </li>
                <li v-if="!failure && !oldest.length" class="dsh-none">
                  No unresolved issue was read.
                </li>
              </template>
            </ul>
          </section>
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
                    v-if="row.url"
                    class="nm"
                    :href="row.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="`Open ${row.project} in YouTrack`"
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
              {{ num(data.backlog.others) }} projects.
            </p>
          </section>
        </div>
      </div>

      <!-- ── One's report, in One's order: what the window was, the four figures,
              the cadence, the sprint, the queue's shape, then the two tables. Every
              value here comes out of `report.js`; this pane adds no number of its own. -->
      <dl class="dsh-meta">
        <div v-for="row in metaRows" :key="row.k">
          <dt>{{ row.k }}</dt>
          <dd>{{ loading ? '—' : row.v }}</dd>
        </div>
      </dl>
      <div class="dsh-kpis dsh-shape" role="list" :aria-busy="loading ? 'true' : 'false'">
        <div
          v-for="tile in data.kpis"
          :key="tile.label"
          class="dsh-kpi"
          role="listitem"
          :data-unread="tile.value === null ? '1' : null"
          :title="tile.hint"
        >
          <span class="k">{{ tile.label }}</span>
          <span v-if="loading" class="dsh-skel" style="width: 46%; height: 22px; margin: 6px 0 4px"></span>
          <b v-else class="v">{{ num(tile.value) }}</b>
          <span class="q">{{ tile.hint }}</span>
        </div>
      </div>

      <!-- ── delivery cadence: seven days on one shared peak ───────────── -->
      <section class="dsh-card" aria-labelledby="dsh-cadence-head">
        <div class="hd">
          <h2 id="dsh-cadence-head">Delivery cadence</h2>
          <span class="n">resolved · {{ data.meta.period }}</span>
        </div>
        <div v-if="loading" class="dsh-flow" aria-hidden="true">
          <div v-for="n in 7" :key="`csk${n}`" class="dsh-flow-col">
            <div class="bars"><span class="dsh-skel" style="width: 12px; height: 44px"></span></div>
            <span class="dsh-skel" style="width: 16px; height: 7px"></span>
          </div>
        </div>
        <div v-else class="dsh-flow" role="img" :aria-label="cadenceLabel">
          <div
            v-for="bar in data.cadence"
            :key="bar.day"
            class="dsh-flow-col"
            :title="`${bar.day}: ${bar.value} resolved`"
          >
            <div class="bars"><i data-k="resolved" :style="{ height: barHeight(bar.height) }"></i></div>
            <span class="lb">{{ bar.label }}</span>
          </div>
        </div>
        <p v-if="!loading" class="dsh-foot">{{ data.summary }}</p>
        <!-- The batch worth a sentence, when there is one: an ordinary week gets the
             summary above and nothing here. -->
        <div v-if="!loading && data.highlight" class="dsh-wait" role="note">
          <span class="k">{{ data.highlight.title }}</span>
          <p>{{ data.highlight.body }}</p>
        </div>
      </section>

      <!-- ── the current sprint, or the reason there is none ────────────── -->
      <section class="dsh-card" aria-labelledby="dsh-sprint-head">
        <div class="hd">
          <h2 id="dsh-sprint-head">Current sprint</h2>
          <span v-if="data.sprint" class="n">{{ data.sprint.dates }}</span>
          <span class="spacer"></span>
          <a
            v-if="data.sprint && data.board"
            class="dsh-jump"
            :href="data.board"
            target="_blank"
            rel="noopener noreferrer"
            :title="`Open board ${data.sprintState.board} in YouTrack`"
          >Board ↗</a>
        </div>
        <template v-if="loading">
          <span class="dsh-skel" style="width: 58%; height: 10px"></span>
          <span class="dsh-skel" style="width: 34%; height: 26px; margin-top: 10px"></span>
          <span class="dsh-skel" style="width: 100%; height: 6px; margin-top: 12px"></span>
        </template>
        <template v-else-if="data.sprint">
          <p class="dsh-sprint-name">{{ data.sprint.name }}</p>
          <div class="dsh-sprint-figs">
            <b class="dsh-sprint-pct">{{ data.sprint.progress }}%</b>
            <span class="of">{{ num(data.sprint.done) }} of {{ num(data.sprint.total) }} resolved</span>
          </div>
          <!-- A three-part bar and the three counts beside it: one derivation, so the
               bar cannot say a different split from the legend under it. -->
          <div v-if="data.sprint.segments.length" class="dsh-seg" role="img" :aria-label="sprintLabel">
            <i v-for="segment in data.sprint.segments" :key="segment.key" :data-k="segment.key" :style="{ width: shareWidth(segment.share) }"></i>
          </div>
          <p v-if="data.sprint.segments.length" class="dsh-legend">
            <span v-for="segment in data.sprint.segments" :key="segment.key">
              <i :data-k="segment.key" aria-hidden="true"></i>{{ segment.label }}
              <b>{{ num(segment.count) }}</b>
            </span>
          </p>
          <ul v-if="data.sprint.shown.length" class="dsh-repos dsh-issues dsh-sprint-items">
            <li v-for="item in data.sprint.shown" :key="item.id">
              <a
                v-if="item.url"
                class="id"
                :href="item.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="`Open ${item.id} in YouTrack`"
              >{{ item.id }}</a>
              <span v-else class="id">{{ item.id }}</span>
              <a
                v-if="item.url"
                class="ell"
                :href="item.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="`Open ${item.id} in YouTrack`"
              >{{ item.summary }}</a>
              <span v-else class="ell" :title="item.summary">{{ item.summary }}</span>
              <span class="pj">{{ item.state || '—' }}</span>
            </li>
          </ul>
          <p v-else-if="data.sprint.total" class="dsh-none">Every work item in this sprint is resolved.</p>
          <p v-else class="dsh-none">This sprint has no work items yet.</p>
          <p v-if="data.sprint.hidden" class="dsh-foot">
            <a v-if="data.board" :href="data.board" target="_blank" rel="noopener noreferrer">
              {{ num(data.sprint.hidden) }} more open {{ data.sprint.hidden === 1 ? 'item' : 'items' }} ↗
            </a>
            <template v-else>{{ num(data.sprint.hidden) }} more open items on the board.</template>
          </p>
        </template>
        <template v-else>
          <p class="dsh-sprint-name">{{ data.sprintState.reason?.title || 'No current sprint' }}</p>
          <p class="dsh-foot">{{ data.sprintState.reason?.detail || 'The sprint board could not be read.' }}</p>
          <p v-if="data.sprintState.boardUrl" class="dsh-foot">
            <a :href="data.sprintState.boardUrl" target="_blank" rel="noopener noreferrer">
              Open board {{ data.sprintState.board }} ↗
            </a>
          </p>
        </template>
      </section>

      <!-- ── the shape of the open queue: state, type, priority ─────────── -->
      <div class="dsh-break">
        <section
          v-for="card in breakdown"
          :key="card.key"
          class="dsh-card"
          :aria-labelledby="`dsh-brk-${card.key}`"
        >
          <div class="hd">
            <h3 :id="`dsh-brk-${card.key}`">{{ card.title }}</h3>
            <span class="spacer"></span>
            <span class="n">{{ num(totals.backlog) }}</span>
          </div>
          <ul v-if="card.rows.length && !loading" class="yt-bars">
            <li v-for="row in card.rows" :key="row.label">
              <span class="nm" :title="row.label">{{ row.label }}</span>
              <span class="pc">{{ num(row.count) }} · {{ row.pct }}%</span>
              <span class="bar" aria-hidden="true"><i :style="{ width: shareWidth(row.share) }"></i></span>
            </li>
          </ul>
          <p v-else-if="loading" class="dsh-none">Reading the queue…</p>
          <p v-else class="dsh-none">No unresolved issue to split.</p>
        </section>
      </div>

      <!-- ── shipped this week: what closed, newest first ───────────────── -->
      <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-shipped-head">
        <div class="hd">
          <h2 id="dsh-shipped-head">Shipped this week</h2>
          <span class="n">
            {{ loading ? '—' : `${num(data.shipped.length)} resolved · ${data.meta.period}` }}
          </span>
        </div>
        <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-shipped-head">
          <table class="dsh-tbl">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Summary</th>
                <th scope="col">Project</th>
                <th scope="col" class="upd">Resolved</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading" class="skrow">
                <td v-for="cell in 4" :key="`ssk${cell}`"><span class="dsh-skel" style="width: 76%; height: 9px"></span></td>
              </tr>
              <tr v-else-if="!failure && !data.shipped.length" class="emptyrow">
                <td colspan="4">
                  <b>Nothing resolved in this window.</b>
                  <span>The tracker answered and returned no closed issue for these seven days.</span>
                </td>
              </tr>
              <template v-else>
                <tr v-for="row in data.shipped" :key="row.id">
                  <td class="iid">
                    <a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer" :title="`Open ${row.id} in YouTrack`">{{ row.id }}</a>
                    <span v-else>{{ row.id }}</span>
                  </td>
                  <td class="sum">
                    <a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer" :title="`Open ${row.id} in YouTrack`">{{ row.summary }}</a>
                    <span v-else :title="row.summary">{{ row.summary }}</span>
                  </td>
                  <td class="prj">
                    <a v-if="row.projectUrl" :href="row.projectUrl" target="_blank" rel="noopener noreferrer" :title="`Open ${row.project} in YouTrack`">{{ row.project }}</a>
                    <span v-else>{{ row.project }}</span>
                  </td>
                  <td class="upd">{{ row.date }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ── the open backlog, newest first, then the ones going cold ───── -->
      <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-open-head">
        <div class="hd">
          <h2 id="dsh-open-head">Open backlog</h2>
          <span class="n">
            {{ loading ? '—' : `${num(data.open.length)} unresolved · ${data.meta.scope}` }}
          </span>
        </div>
        <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-open-head">
          <table class="dsh-tbl">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Summary</th>
                <th scope="col">Project</th>
                <th scope="col">State</th>
                <th scope="col">Priority</th>
                <th scope="col" class="upd">Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading" class="skrow">
                <td v-for="cell in 6" :key="`osk${cell}`"><span class="dsh-skel" style="width: 76%; height: 9px"></span></td>
              </tr>
              <tr v-else-if="!failure && !data.open.length" class="emptyrow">
                <td colspan="6">
                  <b>No unresolved issue in this scope.</b>
                  <span>The tracker answered and returned nothing open.</span>
                </td>
              </tr>
              <template v-else>
                <tr v-for="row in data.open" :key="row.id">
                  <td class="iid">
                    <a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer" :title="`Open ${row.id} in YouTrack`">{{ row.id }}</a>
                    <span v-else>{{ row.id }}</span>
                  </td>
                  <td class="sum">
                    <a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer" :title="`Open ${row.id} in YouTrack`">{{ row.summary }}</a>
                    <span v-else :title="row.summary">{{ row.summary }}</span>
                  </td>
                  <td class="prj">
                    <a v-if="row.projectUrl" :href="row.projectUrl" target="_blank" rel="noopener noreferrer" :title="`Open ${row.project} in YouTrack`">{{ row.project }}</a>
                    <span v-else>{{ row.project }}</span>
                  </td>
                  <td>
                    <span class="st" :data-tone="stateTone(row.state) || null">
                      <i aria-hidden="true"></i>{{ row.state || '—' }}
                    </span>
                  </td>
                  <td class="prj">{{ row.priority || '—' }}</td>
                  <td class="upd">{{ row.date }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="!loading && data.staleText" class="dsh-foot">
          <b>Stale items worth a decision.</b> Open or fixed but unresolved:
          {{ data.staleText }}.
        </p>
      </section>
    </template>
  </div>
</template>
