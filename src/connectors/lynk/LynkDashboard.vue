<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ago } from '@/stores/hub'
import CalendarHeatmap from '@/components/CalendarHeatmap.vue'
import {
  clock,
  dayText,
  money,
  monthText,
  num,
  pct,
  safeUrl,
  shiftDay,
  shiftMonth,
  spanDays,
  lynk,
  readDashboard,
} from '@/connectors/lynk/useLynk'
import LynkCustomers from '@/connectors/lynk/LynkCustomers.vue'

/**
 * The Lynk.id Dashboard tab: what a store sold, read from one Drive folder of
 * spreadsheets.
 *
 * Kept in its own component rather than threaded through the GitHub body, because
 * the two answer different questions with different shapes — a pull-request list
 * and a revenue table share the shell (`.dsh-band`, the chips row, the rail) and
 * nothing else. This is the body `connectors/ConnectorDashboardPane.vue` maps the
 * `lynk` kind to.
 *
 * Five rules, copied from the YouTube Studio connector because they are the ones
 * that keep a report honest:
 *
 *   1. **Never invent a number.** A spreadsheet whose header cannot be read is
 *      counted as unreadable and named, not added as zero revenue.
 *   2. **Every window is anchored on the answer**, not on this machine's clock —
 *      `window.lastDay` is the folder's own last sale, so a stale read does not
 *      silently shorten the window. This is also why a chip is a pair of days here
 *      and not `days: 30` in a request.
 *   3. **A chip costs no request.** The answer is the whole folder; a chip slices
 *      `days` and each product's `series` in this file. Only Refresh reads Drive.
 *   4. **Zero rows stay on screen.** An empty period draws the frame and says why,
 *      because a table of zeroes looks like a broken connector.
 *   5. **A link is checked before it is drawn.** Sheet and landing URLs come from
 *      the main process as ids; `safeUrl()` keeps only `https` on a known host, and
 *      anything else renders as the plain text it is.
 *
 * The two tabs live in the address (`?view=customers`), for the reason the page's own
 * `?tab=dashboard` does: a tab is a place a person can send somebody. The rest of the
 * query rides along untouched — `view`, not `tab`, because `tab` is the page's.
 */
const route = useRoute()
const router = useRouter()

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'customers', label: 'Customers' },
]
/* `?view=`, not `?tab=`: the connector page already owns `tab` for
   `overview` / `dashboard`, and its `normalizeTab()` deletes any value it does not
   define — a `?tab=customers` would be erased on the next tick and this body would
   remount under it. `view` is this tab's own word for its own split. */
const tab = computed(() => (String(route.query.view) === 'customers' ? 'customers' : 'overview'))

function setTab(next) {
  const query = { ...route.query }
  if (next === 'customers') query.view = 'customers'
  else delete query.view
  /* `replace`, not `push`: switching a tab is not a step in a history a person
     wants to walk back through one press at a time. */
  router.replace({ query }).catch(() => null)
}

/* ── the window ─────────────────────────────────────────────────────────────
   A chip is two civil days. `lastDay` is the answer's own last sale, so `Last 90
   days` means ninety days ending there, never ninety days ending today. */
const window = computed(() => lynk.window || {})
const lastDay = computed(() => String(window.value.lastDay || window.value.until || ''))
const firstDay = computed(() => String(window.value.firstDay || window.value.since || ''))

/* Years, newest first, from the older edge of the history — a year can be present
   in `lastDay`'s month and absent from `firstDay`'s, so both ends are read. */
const years = computed(() => {
  const found = new Set()
  for (const entry of lynk.months || []) {
    const year = String(entry.key || '').slice(0, 4)
    if (/^\d{4}$/.test(year)) found.add(year)
  }
  for (const entry of lynk.days || []) {
    const year = String(entry.day || '').slice(0, 4)
    if (/^\d{4}$/.test(year)) found.add(year)
  }
  return [...found].sort().reverse()
})

/**
 * The chips, and every one of them is a real period or it is absent.
 *
 * `All time` is the whole folder. A year is its own twelve months. The two relative
 * chips are anchored on `lastDay` and are only offered when the history is longer
 * than the chip would be — a `Last 6 months` over four months of history is `All
 * time` spelled wrong.
 */
const chips = computed(() => {
  const list = []
  const last = lastDay.value
  for (const year of years.value) list.push({ key: `y${year}`, label: year, kind: 'year', year })
  if (last && firstDay.value) {
    const six = shiftMonth(shiftDay(last, 1), -6)
    const ninety = shiftDay(last, -89)
    if (six && six > firstDay.value) list.push({ key: '6m', label: 'Last 6 months', since: six, until: last })
    if (ninety && ninety > firstDay.value) list.push({ key: '90d', label: 'Last 90 days', since: ninety, until: last })
  }
  list.push({ key: 'all', label: 'All time', since: firstDay.value, until: last, all: true })
  return list
})

/* The newest year is the default, because a store is asking about now. `All time`
   is one press away and is never the landing state: it hides every comparison. */
const picked = ref('')

const activeChip = computed(() => {
  const wanted = picked.value || (years.value.length ? `y${years.value[0]}` : 'all')
  const found = chips.value.find((chip) => chip.key === wanted)
  /* A stored pick can name a year the answer no longer has (the folder changed
     under it): fall back rather than show an empty frame. */
  return found || chips.value[chips.value.length - 1] || { key: 'all', label: 'All time', all: true, since: '', until: '' }
})

/** Which civil days this chip states. A year is its twelve months, not 365 days. */
const period = computed(() => {
  const chip = activeChip.value
  if (chip.kind === 'year') {
    const since = `${chip.year}-01-01`
    const until = `${chip.year}-12-31`
    /* A year the folder only partly covers shows the covered part: a window whose
       `until` is in the future would divide growth by nothing and label a bar with
       days that have not happened. */
    return {
      since: since < firstDay.value ? firstDay.value : since,
      until: until > lastDay.value ? lastDay.value : until,
      year: chip.year,
    }
  }
  return {
    since: chip.since || firstDay.value,
    until: chip.until || lastDay.value,
    year: '',
  }
})

const span = computed(() => spanDays(period.value.since, period.value.until))

/** The equally long window immediately before this one — the growth denominator. */
const prior = computed(() => {
  if (!span.value) return null
  const until = shiftDay(period.value.since, -1)
  if (!until || until < firstDay.value) return null
  return { since: shiftDay(until, -(span.value - 1)), until }
})

const inWindow = (day) => Boolean(day) && day >= period.value.since && day <= period.value.until
const inPrior = (day) => Boolean(prior.value) && day >= prior.value.since && day <= prior.value.until

/* Units are not in `days[]` — that index carries money and order counts only — so
   the period's units come off each product's own series. */
const periodUnits = computed(() => {
  let units = 0
  for (const product of lynk.products || []) {
    for (const entry of product.series || []) {
      if (inWindow(entry.day)) units += Number(entry.units) || 0
    }
  }
  return units
})

/* ── the period's own arithmetic ───────────────────────────────────────────── */
const days = computed(() => (lynk.days || []).filter((entry) => inWindow(entry.day)))

const totals = computed(() => {
  const bucket = { revenue: 0, orders: 0, days: 0 }
  for (const entry of days.value) {
    bucket.revenue += Number(entry.revenue) || 0
    bucket.orders += Number(entry.orders) || 0
    if (Number(entry.orders) > 0) bucket.days += 1
  }
  return bucket
})

/* Products are sliced per period, from each row's own `series`: the answer's
   `products[]` totals are the whole folder's, and a chip that printed those under a
   90-day label would be the bug this file exists to avoid. */
const products = computed(() =>
  (lynk.products || []).map((product) => {
    let revenue = 0
    let orders = 0
    let units = 0
    let priorOrders = 0
    let soldBefore = false
    for (const entry of product.series || []) {
      const count = Number(entry.orders) || 0
      if (inWindow(entry.day)) {
        revenue += Number(entry.revenue) || 0
        units += Number(entry.units) || 0
        orders += count
      } else if (period.value.since && entry.day < period.value.since) {
        /* Everything before the window, not just the prior window: `new` means never
           sold, so a product that was big two years ago is not new. */
        if (count > 0 || (Number(entry.revenue) || 0) > 0) soldBefore = true
        if (inPrior(entry.day)) priorOrders += count
      }
    }
    /* Three growth answers, and they are different facts:
       `new`      — the product had no order before this window at all;
       a number   — orders in this window less orders in the equally long one before;
       `—`        — there is no prior window to compare with (All time, or the
                    folder's first period), so growth is unknown, not zero. */
    let growth = null
    if (prior.value) growth = !soldBefore && orders > 0 ? 'new' : orders - priorOrders
    return {
      ...product,
      revenue,
      orders,
      units,
      aov: orders ? Math.round(revenue / orders) : 0,
      share: totals.value.revenue > 0 ? Math.round((revenue / totals.value.revenue) * 1000) / 10 : 0,
      growth,
      growthText: growth === 'new' ? 'new' : growth === null ? '\u2014' : growth > 0 ? `+${growth}` : String(growth),
      growthSign: typeof growth === 'number' ? Math.sign(growth) : 0,
      priorOrders,
    }
  }),
)

const sold = computed(() => products.value.filter((product) => product.orders > 0))
const unsold = computed(() => products.value.filter((product) => product.orders === 0))

/* The biggest month in the period is the Revenue tile's hint: it is the one fact
   that turns a total into a shape. */
const peakMonth = computed(() => {
  let best = null
  for (const month of periodMonths.value) {
    if (!best || Number(month.revenue) > Number(best.revenue)) best = month
  }
  return best && Number(best.revenue) > 0 ? best : null
})

/* An empty period is a real answer and says so, in its own words: the folder may
   have sold before this window and nothing inside it. */
const quiet = computed(() => lynk.loaded && !lynk.loading && !lynk.error && !totals.value.orders)

/* ── bars, per month ──────────────────────────────────────────────────────── */
/* The months this window touches and no others: a year chip is that year's twelve,
   a relative chip is the slice it actually spans. `lynk.months` descends, so it is
   reversed once here and every reader gets the same order. */
const periodMonths = computed(() => {
  const first = String(period.value.since || '').slice(0, 7)
  const last = String(period.value.until || '').slice(0, 7)
  if (!first || !last) return []
  return (lynk.months || [])
    .filter((month) => month.key >= first && month.key <= last)
    .slice()
    .reverse()
})

const monthBars = computed(() => {
  const rows = periodMonths.value
  if (!rows.length) return []
  const biggest = Math.max(0, ...rows.map((row) => Number(row.revenue) || 0))
  return rows.map((row) => ({
    ...row,
    width: biggest > 0 ? Math.max(2, Math.round((Number(row.revenue) / biggest) * 100)) : 0,
  }))
})

const monthTotal = computed(() => monthBars.value.reduce((sum, row) => sum + (Number(row.revenue) || 0), 0))
const monthPeak = computed(() => monthBars.value.find((row) => row.width === 100) || null)

/* ── the leaderboard ──────────────────────────────────────────────────────── */
const COLS = [
  { key: 'name', label: 'Product', kind: 'text' },
  { key: 'orders', label: 'Orders', kind: 'num' },
  { key: 'units', label: 'Units', kind: 'num' },
  { key: 'revenue', label: 'Revenue', kind: 'num' },
  { key: 'aov', label: 'AOV', kind: 'num' },
  { key: 'growth', label: 'Growth', kind: 'num' },
]
/* Sorted by money taken, because that is the question the tab answers; the other
   four columns are one press away. */
const sort = ref({ key: 'revenue', dir: -1 })

function sortBy(key) {
  if (sort.value.key === key) sort.value = { key, dir: -sort.value.dir }
  else sort.value = { key, dir: key === 'name' ? 1 : -1 }
}

const rows = computed(() => {
  const { key, dir } = sort.value
  const read = (product) => {
    if (key === 'name') return String(product.name || '').toLowerCase()
    /* A new product outranks every number high-to-low, and `—` (no prior window)
       sinks: both are answers, not zeroes, so they are placed rather than sorted as 0. */
    if (key === 'growth') {
      if (product.growth === 'new') return dir < 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER
      if (product.growth === null) return dir < 0 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
      return product.growth
    }
    return Number(product[key]) || 0
  }
  /* Sold rows first whatever the sort: a product with no order in this period is
     not a leader by any column, and burying it is what the empty chips are for. */
  return sold.value.slice().sort((left, right) => {
    const a = read(left)
    const b = read(right)
    if (a === b) return String(left.name || '').localeCompare(String(right.name || ''))
    return a < b ? -dir : dir
  })
})

const sortMark = (key) => (sort.value.key === key ? (sort.value.dir < 0 ? '↓' : '↑') : '')

const paretoLabel = (product) =>
  product.pareto === 'A' ? 'A · core revenue' : 'B · long tail'

/* ── the tiles ────────────────────────────────────────────────────────────── */
const kpis = computed(() => {
  const total = totals.value
  const periodPct = lynk.totals.orders > 0 ? Math.round((total.orders / lynk.totals.orders) * 100) : 0
  return [
    {
      key: 'revenue',
      k: 'Revenue',
      v: money(total.revenue),
      q: 'money taken in this period',
      hint: peakMonth.value
        ? `Biggest month: ${monthText(peakMonth.value.key, true)} at ${money(peakMonth.value.revenue)}.`
        : 'No month in this period took money.',
    },
    {
      key: 'orders',
      k: 'Orders',
      v: num(total.orders),
      q: 'paid, vouchered and free',
      hint: `${num(periodUnits.value)} units across them · ${periodPct} % of the folder's orders.`,
    },
    {
      key: 'aov',
      k: 'AOV',
      v: money(total.orders ? Math.round(total.revenue / total.orders) : 0),
      q: 'revenue ÷ orders',
      hint: `Paid-only AOV is ${money(lynk.paid.aov)} — free rows are orders and never revenue.`,
    },
    {
      key: 'catalogue',
      k: 'Products sold',
      v: `${num(sold.value.length)} of ${num(lynk.sheets.total)}`,
      q: 'spreadsheets with an order',
      hint: unsold.value.length
        ? `${num(unsold.value.length)} sold nothing in this period.`
        : 'Every spreadsheet in this folder sold something.',
    },
  ]
})

/* ── the calendar heat map ────────────────────────────────────────────────── */
/* An order is the cell's unit: money is a column, but a day is either one with
   orders on it or it is not — and `turns` is the key `CalendarHeatmap` reads. Only
   this period's days are handed over, so the calendar shades the window rather than
   the folder's whole history. */
const heatDays = computed(() => {
  const map = {}
  for (const entry of days.value) map[entry.day] = { turns: Number(entry.orders) || 0 }
  return map
})
const heatYear = computed(() => Number(String(period.value.until || lastDay.value).slice(0, 4)) || new Date().getFullYear())
const heatPeak = computed(() => {
  let best = null
  for (const entry of days.value) {
    if (!best || Number(entry.revenue) > Number(best.revenue)) best = entry
  }
  return best && Number(best.orders) > 0 ? best : null
})

/* ── the rail cards ───────────────────────────────────────────────────────── */
const source = computed(() => ({
  folder: lynk.folderName || lynk.folderId || 'no folder',
  sheets: lynk.sheets.total,
  withTab: lynk.sheets.withTab,
  suffix: lynk.suffix || lynk.sheetSuffix,
}))

/* Name mismatches are the one check a person cannot eyeball: a sheet renamed in
   Drive and a title in the store that no longer agree. */
const mismatches = computed(() => lynk.names.sheets || [])

/* Why a row has no landing link — and it is one of three answers, never a shrug:
   no marketplace is configured (nothing was asked for), one is configured but this
   name did not match it, or the fetch failed and the previous snapshot's links are
   on screen. The setting is on Overview, so the sentence points there. */
const landingWhy = computed(() => {
  if (!lynk.links.marketplace) return 'no marketplace configured — add one on Overview to link a row to its store page'
  if (lynk.links.resolved === false) return 'the marketplace could not be read, so the last links this grant resolved are shown'
  return 'this name did not match a marketplace title'
})

/* Re-check every href before it is drawn. `safeUrl()` answers `null` for anything
   that is not `https` on a host this app trusts, and the template then prints text. */
const folderHref = computed(() => safeUrl(lynk.links.url))

/* The host is what a person recognises; the whole URL is in the row's title. */
const marketplaceLabel = computed(() => {
  try {
    return new URL(lynk.marketplaceUrl).hostname
  } catch {
    return lynk.marketplaceUrl
  }
})
const sheetHref = (url) => safeUrl(url)
const landingHref = (url) => safeUrl(url)

/* A folder that was deleted, or moved to an account this grant cannot see, is not
   a refused grant: reauthorizing changes nothing and picking another folder does. */
const notFound = computed(() =>
  /not ?found|404|does not exist|no longer|PERMISSION_DENIED.*drive/i.test(String(lynk.error || '')),
)
const skel = computed(() => lynk.loading || (!lynk.readAt && lynk.reading))
const refreshing = computed(() => lynk.reading && Boolean(lynk.readAt))

/* A sheet the read could not use is neither revenue nor a zero: it is named. */
const partial = computed(() => lynk.sheets.empty > 0 || lynk.sheets.unreadable > 0 || lynk.sheets.failed > 0)
const partialLine = computed(() => {
  const total = lynk.sheets.total
  if (!total) return ''
  const parts = []
  if (lynk.sheets.empty) {
    parts.push(`${num(lynk.sheets.empty)} of ${num(total)} spreadsheets ${lynk.sheets.empty === 1 ? 'is' : 'are'} empty.`)
  }
  if (lynk.sheets.failed) {
    parts.push(
      `${num(lynk.sheets.failed)} of ${num(total)} could not be downloaded, so ${lynk.sheets.failed === 1 ? 'it is' : 'they are'} missing from this read. Refresh takes them again.`,
    )
  }
  if (lynk.sheets.unreadable) {
    parts.push(
      `${num(lynk.sheets.unreadable)} ${lynk.sheets.unreadable === 1 ? 'tab' : 'tabs'} had no readable header, so ${lynk.sheets.unreadable === 1 ? 'it is' : 'they are'} not in the totals either.`,
    )
  }
  return parts.join(' ')
})

async function refresh() {
  await readDashboard({ force: true })
}

/* Reauthorize and "pick another folder" both end on Overview: that page owns the
   Google grant and the folder control, and this tab has neither. */
function goOverview() {
  /* The folder control and the Google grant live on the connector page's Overview
     tab, so this is that address with this tab's own words removed. */
  const query = { ...route.query }
  delete query.tab
  delete query.view
  router.replace({ query }).catch(() => null)
}
</script>

<template>
  <div class="dsh-band lyk-band">
    <!-- Not reachable: the folder moved or was shared away. The grant is fine, so
         the action is the folder control on Overview, never Reauthorize. -->
    <div v-if="notFound && !lynk.refused" class="dsh-err" role="alert">
      <b>This folder is not reachable with this account</b>
      <p>
        It was deleted, moved, or shared with someone else. The grant is still fine —
        pick the folder again and nothing else changes.
        <code v-if="lynk.error" class="mono">{{ lynk.error }}</code>
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" @click="goOverview">Change folder</button>
      </div>
    </div>

    <div v-else-if="lynk.throttled" class="dsh-err" role="alert">
      <b>Google is rate-limiting the read.</b>
      <p>
        Nothing is wrong with the grant or the folder: too many Sheets requests went out in a
        minute and Google counted them. The read is paced, so waiting a minute and asking again
        usually lands.
        <code v-if="lynk.error" class="mono">{{ lynk.error }}</code>
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="lynk.reading" @click="refresh">Try again</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="goOverview">Check the folder</button>
      </div>
    </div>

    <!-- Refused: Google's own sentence, the date the numbers were read, and the one
         action that changes anything. Never a spinner over good numbers. -->
    <div v-else-if="lynk.refused" class="dsh-err" role="alert">
      <b>Google refused the grant.</b>
      <p>
        <template v-if="lynk.readAt">
          Every number below is from <b>{{ clock(lynk.readAt) }}</b> and will not change until you
          reauthorize.
        </template>
        <template v-else>
          The folder could not be read, so this tab has nothing to show rather than a folder of
          zeroes.
        </template>
        <code v-if="lynk.error" class="mono">{{ lynk.error }}</code>
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" @click="goOverview">Reauthorize</button>
        <button class="btn btn-sm btn-ghost" type="button" :disabled="lynk.reading" @click="refresh">Try again</button>
      </div>
    </div>

    <!-- Anything else: a real failure with Google's own words on it. -->
    <div v-else-if="lynk.error" class="dsh-err" role="alert">
      <b>The read did not finish.</b>
      <p>
        <template v-if="lynk.readAt">
          The numbers below are the ones read at <b>{{ clock(lynk.readAt) }}</b>, not this attempt's.
        </template>
        <template v-else>The folder could not be read, so there is nothing here rather than a folder of zeroes.</template>
        <code class="mono">{{ lynk.error }}</code>
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="lynk.reading" @click="refresh">Try again</button>
        <button class="btn btn-sm btn-ghost" type="button" @click="goOverview">Check the folder</button>
      </div>
    </div>

    <div class="dsh-bar lyk-bar">
      <nav class="lyk-tabs" role="tablist" aria-label="Which way to read the store">
        <button
          v-for="entry in TABS"
          :key="entry.key"
          type="button"
          role="tab"
          :aria-selected="tab === entry.key"
          :tabindex="tab === entry.key ? 0 : -1"
          @click="setTab(entry.key)"
        >{{ entry.label }}</button>
      </nav>
      <span class="spacer"></span>
      <div class="dsh-when">
        <span>{{ lynk.readAt ? ago(lynk.readAt) : 'not read yet' }}</span>
        <button class="btn btn-sm" type="button" :disabled="lynk.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          <template v-if="refreshing">refreshing…</template>
          <template v-else-if="lynk.reading">Reading…</template>
          <template v-else>Refresh</template>
        </button>
      </div>
    </div>

    <!-- In flight, with nothing on screen yet: the one state where a spinner is
         the honest answer. The line names the work, because a folder of seventy
         spreadsheets is a minute and a minute of a silent page reads as a hang. -->
    <div v-if="lynk.reading" class="dsh-wait" role="status" aria-live="polite">
      <span class="k">Reading</span>
      <p>{{ lynk.progress.phase === 'listing' ? 'Listing the folder…' : lynk.progress.total ? `Reading ${num(lynk.progress.read)} of ${num(lynk.progress.total)} spreadsheets…` : 'Reading the folder…' }}</p>
    </div>

    <!-- Partly read: named above the table so its total is never mistaken for the
         folder's. -->
    <div v-if="partial && !quiet" class="dsh-wait">
      <span class="k">Partly read</span>
      <p>{{ partialLine }} They are listed in the folder, not in this table — a product with no order is a fact, not a zero.</p>
    </div>

    <template v-if="tab === 'customers'">
      <LynkCustomers />
    </template>

    <template v-else>
      <div class="dsh-chips" role="group" aria-label="Which period to show">
        <button
          v-for="chip in chips"
          :key="chip.key"
          type="button"
          class="dsh-chip"
          :aria-pressed="activeChip.key === chip.key"
          @click="picked = chip.key"
        >
          {{ chip.label }}
          <span v-if="chip.all" class="n">all</span>
        </button>
      </div>
      <p class="dsh-lykrange">
        <template v-if="period.since">
          {{ dayText(period.since) }} → {{ dayText(period.until) }}
          <span class="sep" aria-hidden="true">·</span>
          {{ num(span) }} {{ span === 1 ? 'day' : 'days' }}
          <span class="sep" aria-hidden="true">·</span>
          the window ends on this folder's own last sale, {{ dayText(lastDay) }}
        </template>
        <template v-else>The folder has no dated order yet.</template>
      </p>

      <div class="dsh-kpis lyk-kpis" :aria-busy="skel ? 'true' : 'false'">
        <div v-for="kpi in kpis" :key="kpi.key" class="dsh-kpi">
          <span class="k">{{ kpi.k }}</span>
          <span v-if="skel" class="dsh-skel dsh-skel-v"></span>
          <b v-else class="v">{{ kpi.v }}</b>
          <span class="q">{{ kpi.q }}</span>
          <span v-if="!skel" class="d">{{ kpi.hint }}</span>
        </div>
      </div>

      <!-- An empty period is its own answer: the frame stays, and the sentence says
           which of the two empties this is — no rows at all, or rows with nothing in
           this window. -->
      <div v-if="quiet" class="dsh-wait">
        <span class="k">Empty period</span>
        <p>
          No order landed between <b>{{ dayText(period.since) }}</b> and
          <b>{{ dayText(period.until) }}</b>.
          <template v-if="firstDay && lastDay">The folder's own history runs {{ dayText(firstDay) }} → {{ dayText(lastDay) }}; pick a wider period above.</template>
          <template v-else>This folder has no dated order yet — a spreadsheet without a date column is counted as unreadable, not as zero.</template>
        </p>
      </div>

      <!-- Revenue per month: the months this window touches, or a year's twelve. -->
      <section class="dsh-card" aria-labelledby="dsh-lykmonths-head">
        <div class="hd">
          <h3 id="dsh-lykmonths-head">Revenue per month</h3>
          <span class="n">{{ monthBars.length }}</span>
          <span class="spacer"></span>
          <span class="hd-when">{{ activeChip.label }}</span>
        </div>
        <div v-if="skel" class="dsh-skel dsh-skel-block"></div>
        <div v-else-if="!monthBars.length" class="dsh-none">No month in this period has an order.</div>
        <ul v-else class="dsh-lykbars" aria-label="Revenue by month">
          <li v-for="month in monthBars" :key="month.key" :title="`${monthText(month.key, true)} · ${money(month.revenue)} · ${num(month.orders)} orders`">
            <span class="ml">{{ monthText(month.key) }}</span>
            <span class="bar" aria-hidden="true"><i :style="{ width: `${month.width}%` }"></i></span>
            <span class="vl">{{ money(month.revenue) }}</span>
          </li>
        </ul>
        <p class="dsh-foot">
          <template v-if="monthBars.length">
            {{ money(monthTotal) }} across {{ monthBars.length }} {{ monthBars.length === 1 ? 'month' : 'months' }}<template v-if="monthPeak">, and <b>{{ monthText(monthPeak.key, true) }}</b> was the biggest at {{ money(monthPeak.revenue) }}</template>.
          </template>
          <template v-else>A month is drawn only when it has an order, so an empty frame is an empty period.</template>
        </p>
      </section>

      <!-- The leaderboard: one row per product that sold in this period, sortable by
           every column, with the two links resolved by id. -->
      <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-lykprod-head">
        <div class="hd">
          <h3 id="dsh-lykprod-head">Products</h3>
          <span class="n">{{ sold.length }}</span>
          <span class="spacer"></span>
          <span class="hd-when">by {{ COLS.find((col) => col.key === sort.key)?.label.toLowerCase() }}</span>
        </div>
        <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-lykprod-head">
          <table class="dsh-tbl dsh-prod-tbl">
            <thead>
              <tr>
                <th scope="col" class="lyk-sort" :aria-sort="sort.key === 'name' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('name')">
                    Product <span class="mk" aria-hidden="true">{{ sortMark('name') }}</span>
                  </button>
                </th>
                <th scope="col" class="num lyk-sort" :aria-sort="sort.key === 'orders' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('orders')">
                    Orders <span class="mk" aria-hidden="true">{{ sortMark('orders') }}</span>
                  </button>
                </th>
                <th scope="col" class="num lyk-sort" :aria-sort="sort.key === 'units' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('units')">
                    Units <span class="mk" aria-hidden="true">{{ sortMark('units') }}</span>
                  </button>
                </th>
                <th scope="col" class="money lyk-sort" :aria-sort="sort.key === 'revenue' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('revenue')">
                    Revenue <span class="mk" aria-hidden="true">{{ sortMark('revenue') }}</span>
                  </button>
                </th>
                <th scope="col" class="num lyk-sort" :aria-sort="sort.key === 'aov' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('aov')">
                    AOV <span class="mk" aria-hidden="true">{{ sortMark('aov') }}</span>
                  </button>
                </th>
                <th scope="col" class="num lyk-sort" :aria-sort="sort.key === 'growth' ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'">
                  <button type="button" class="sortbtn" @click="sortBy('growth')">
                    Growth <span class="mk" aria-hidden="true">{{ sortMark('growth') }}</span>
                  </button>
                </th>
                <th scope="col" class="shr">Share</th>
              </tr>
            </thead>
            <tbody>
              <template v-if="skel">
                <tr v-for="n in 6" :key="`sk${n}`" class="skrow">
                  <td><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="num" data-l="orders"><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="num" data-l="units"><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="money" data-l="revenue"><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="num" data-l="aov"><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="num" data-l="growth"><span class="dsh-skel dsh-skel-line"></span></td>
                  <td class="shr" data-l="share"><span class="dsh-skel dsh-skel-line"></span></td>
                </tr>
              </template>
              <tr v-else-if="!rows.length" class="emptyrow">
                <td colspan="7">
                  <b>{{ lynk.sheets.total ? 'No product sold in this period' : 'This folder has no spreadsheet' }}</b>
                  <span v-if="lynk.sheets.total">
                    {{ num(lynk.sheets.total) }} spreadsheets were read; none of them has an order between
                    {{ dayText(period.since) }} and {{ dayText(period.until) }}.
                  </span>
                  <span v-else>Nothing in this folder is a spreadsheet, so there is nothing to add up.</span>
                  <a href="#" @click.prevent="goOverview">Check the folder, or pick another one</a>
                </td>
              </tr>
              <template v-else>
                <tr v-for="product in rows" :key="product.key">
                  <td>
                    <div class="prod">
                      <span class="nm" :title="product.name">{{ product.name }}</span>
                      <span class="sub">
                        <span class="lyk-pareto" :data-tier="product.pareto" :title="paretoLabel(product)">
                          {{ product.pareto }}
                        </span>
                        last order {{ product.lastSale ? dayText(product.lastSale) : '—' }}
                        <template v-if="product.freeOrders">
                          · <b>{{ num(product.freeOrders) }}</b> free
                        </template>
                        <template v-if="product.mixed"> · mixed</template>
                      </span>
                      <span class="lyk-links">
                        <a
                          v-if="sheetHref(product.sheetUrl)"
                          :href="sheetHref(product.sheetUrl)"
                          target="_blank"
                          rel="noopener noreferrer"
                          :aria-label="`Open ${product.name} in Google Sheets`"
                        >Sheet</a>
                        <span
                          v-else
                          class="lyk-plain"
                          :title="product.sheetUrl || 'no sheet id'"
                        >Sheet</span>
                        <a
                          v-if="landingHref(product.landingUrl)"
                          :href="landingHref(product.landingUrl)"
                          target="_blank"
                          rel="noopener noreferrer"
                          :aria-label="`Open the landing page for ${product.name}`"
                        >Landing page</a>
                        <span v-else class="lyk-plain" :title="landingWhy">no landing page</span>
                      </span>
                    </div>
                  </td>
                  <td class="num" data-l="orders">{{ num(product.orders) }}</td>
                  <td class="num" data-l="units">{{ num(product.units) }}</td>
                  <td class="money" data-l="revenue" :data-zero="product.revenue > 0 ? null : '1'">{{ money(product.revenue) }}</td>
                  <td class="num" data-l="aov">{{ money(product.aov) }}</td>
                  <td class="num" data-l="growth" :data-sign="product.growthSign">{{ product.growthText }}</td>
                  <td class="shr" data-l="share">
                    <span class="sharebar" aria-hidden="true"><i :style="{ width: `${Math.max(0, Math.min(100, product.share))}%` }"></i></span>
                    {{ pct(product.share) }}
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p class="dsh-foot">
          <template v-if="rows.length">
            Read from each spreadsheet's <code class="mono">{{ source.suffix }}</code> tab ·
            landing pages come from the marketplace document on Overview ·
            growth is orders in this period against the equally long window before it<template v-if="!prior">, and there is no such window here, so it reads —</template>.
          </template>
          <template v-else>A product with no order in this period is a row in the chips below, not a zero in this table.</template>
        </p>
      </section>

      <!-- Revenue per day: the folder's own year as a calendar, orders per cell. -->
      <section class="dsh-card" aria-labelledby="dsh-lykday-head">
        <div class="hd">
          <h3 id="dsh-lykday-head">Revenue per day</h3>
          <span class="n">{{ heatYear }}</span>
          <span class="spacer"></span>
          <span v-if="heatPeak" class="hd-when">
            peak {{ dayText(heatPeak.day) }} · {{ money(heatPeak.revenue) }}
          </span>
        </div>
        <!-- An honest empty line instead of an empty chart: a year with no order is
             not a chart with nothing drawn on it. -->
        <div v-if="skel" class="dsh-skel dsh-skel-block"></div>
        <div v-else-if="!heatPeak" class="dsh-none">
          No orders in this period, so the calendar has nothing to shade. The last order in this folder was
          {{ lastDay ? dayText(lastDay) : 'never' }}.
        </div>
        <CalendarHeatmap
          v-else
          :days="heatDays"
          :year="heatYear"
          :height="172"
          label="Orders per day"
          unit="orders"
        />
        <p class="dsh-foot">
          One cell is one civil day; the shading is how many orders landed on it, and the tooltip carries the
          count. Days with no order stay grey rather than taking the palest step of the ramp.
        </p>
      </section>

      <div class="dsh">
        <div class="dsh-main">
          <section class="dsh-card" aria-labelledby="dsh-lykname-head">
            <div class="hd">
              <h3 id="dsh-lykname-head">Sheet names</h3>
              <span class="n">{{ lynk.names.checked ? `${mismatches.length} of ${lynk.names.checked}` : '—' }}</span>
            </div>
            <p v-if="!lynk.names.checked" class="dsh-none">
              No sheet name could be compared yet — a name is checked against the store's own titles once the
              marketplace answers.
            </p>
            <p v-else-if="!mismatches.length" class="dsh-none">
              All {{ num(lynk.names.checked) }} sheet names match a product title in the store.
            </p>
            <ul v-else class="lyk-names">
              <li v-for="entry in mismatches" :key="entry.key">
                <a
                  v-if="sheetHref(entry.sheetUrl)"
                  :href="sheetHref(entry.sheetUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="sf"
                >{{ entry.sheet }}</a>
                <span v-else class="sf">{{ entry.sheet }}</span>
                <span class="tt">
                  reads as <b>{{ entry.title || '—' }}</b>
                  <template v-if="entry.titles && entry.titles.length"> · also {{ entry.titles.slice(0, 2).join(', ') }}</template>
                  · {{ num(entry.rows) }} {{ entry.rows === 1 ? 'row' : 'rows' }}
                </span>
              </li>
            </ul>
            <p class="dsh-foot">
              A mismatch is a renamed file or a retitled product. The numbers are unaffected; the landing link is,
              because it is resolved by title.
            </p>
          </section>

          <section class="dsh-card" aria-labelledby="dsh-lykempty-head">
            <div class="hd">
              <h3 id="dsh-lykempty-head">No orders</h3>
              <span class="n">{{ unsold.length }}</span>
            </div>
            <div v-if="!unsold.length" class="dsh-none">
              Every spreadsheet in this folder has an order in this period.
            </div>
            <ul v-else class="lyk-empty">
              <li v-for="product in unsold" :key="product.key">
                <a
                  v-if="landingHref(product.landingUrl)"
                  :href="landingHref(product.landingUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="`Open the landing page for ${product.name}`"
                >{{ product.name }}</a>
                <span v-else>{{ product.name }}</span>
              </li>
            </ul>
            <p v-if="lynk.emptyProducts.length" class="dsh-foot">
              Separately, {{ lynk.emptyProducts.length }}
              {{ lynk.emptyProducts.length === 1 ? 'spreadsheet has' : 'spreadsheets have' }} a header and no rows
              at all — listed, never counted as a zero:
              <template v-for="(entry, index) in lynk.emptyProducts.slice(0, 4)" :key="entry.key || entry.name">
                <a
                  v-if="sheetHref(entry.sheetUrl)"
                  :href="sheetHref(entry.sheetUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                >{{ entry.name }}</a>
                <span v-else>{{ entry.name }}</span><template v-if="index < Math.min(lynk.emptyProducts.length, 4) - 1">, </template>
              </template>
              <template v-if="lynk.emptyProducts.length > 4"> and {{ lynk.emptyProducts.length - 4 }} more</template>.
            </p>
          </section>
        </div>

        <div class="dsh-rail">
          <section class="dsh-card" aria-labelledby="dsh-lyk-src-head">
            <div class="hd">
              <h3 id="dsh-lyk-src-head">Source</h3>
              <span class="n">{{ source.sheets ? `${source.withTab} of ${source.sheets}` : '—' }}</span>
            </div>
            <dl class="cxn-facts">
              <dt>folder</dt>
              <dd class="ell" :title="source.folder">{{ source.folder }}</dd>
              <dt>marketplace</dt>
              <dd class="ell" :title="lynk.marketplaceUrl || 'not configured'">
                <template v-if="lynk.marketplaceUrl">{{ marketplaceLabel }}</template>
                <template v-else>not configured</template>
              </dd>
              <dt>tab</dt>
              <dd><code class="mono">{{ source.suffix }}</code></dd>
              <dt>currency</dt>
              <dd>{{ lynk.currency }}</dd>
              <dt>zone</dt>
              <dd>{{ lynk.timezone }}</dd>
              <dt>read</dt>
              <dd>{{ lynk.readAt ? ago(lynk.readAt) : '—' }}</dd>
            </dl>
          </section>

          <section class="dsh-card" aria-labelledby="dsh-lyk-pay-head">
            <div class="hd">
              <h3 id="dsh-lyk-pay-head">Paid only</h3>
              <span class="n">{{ num(lynk.paid.orders) }}</span>
            </div>
            <dl class="cxn-facts">
              <dt>revenue</dt>
              <dd>{{ money(lynk.paid.revenue) }}</dd>
              <dt>buyers</dt>
              <dd>
                {{ num(lynk.paid.buyers) }}
                <span class="muted">· {{ num(lynk.paid.repeat) }} repeat, {{ pct(lynk.paid.repeatRate) }}</span>
              </dd>
              <dt>free orders</dt>
              <dd>{{ num(lynk.paid.freeOrders) }}</dd>
              <dt>vouchered</dt>
              <dd>{{ num(lynk.paid.voucheredOrders) }}</dd>
            </dl>
            <p class="dsh-foot">
              Counted from rows that carried money. A free row is an order and never revenue, which is why the
              AOV tile divides by {{ num(totals.orders) }} here and the paid-only figure is beside it.
            </p>
          </section>

          <section class="dsh-card" aria-labelledby="dsh-lyk-fees-head">
            <div class="hd">
              <h3 id="dsh-lyk-fees-head">Fees</h3>
              <span class="n">{{ money(lynk.totals.fees.affiliate + lynk.totals.fees.notif + lynk.totals.fees.convenience) }}</span>
            </div>
            <dl class="cxn-facts">
              <dt>affiliate</dt>
              <dd>{{ money(lynk.totals.fees.affiliate) }}</dd>
              <dt>notification</dt>
              <dd>{{ money(lynk.totals.fees.notif) }}</dd>
              <dt>convenience</dt>
              <dd>{{ money(lynk.totals.fees.convenience) }}</dd>
              <dt>vouchers</dt>
              <dd>{{ money(lynk.totals.vouchers) }}</dd>
            </dl>
            <p class="dsh-foot">
              The folder's own fee columns, added up — never subtracted from revenue, because a gross figure that
              silently went net is two different numbers under one label.
            </p>
          </section>
        </div>
      </div>
    </template>

    <p class="dsh-foot dsh-lykfoot">
      <template v-if="lynk.readAt">
        Revenue is every row that carried money, in the folder's own currency ·
        read {{ clock(lynk.readAt) }} {{ ago(lynk.readAt) }}, kept for {{ Math.round(lynk.cacheTtlMs / 3_600_000) }} h ·
      </template>
      <template v-else>The folder has not been read yet · </template>
      <a
        v-if="folderHref"
        :href="folderHref"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open the Drive folder this report is read from"
      >Drive folder</a>
      <span v-else>{{ lynk.folderId || 'no folder' }}</span>
      <template v-if="lynk.links.resolved === false && lynk.readAt"> · landing links are the last ones this grant resolved</template>
    </p>
  </div>
</template>
