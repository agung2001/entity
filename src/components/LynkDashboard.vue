<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ago } from '@/stores/hub'
import { lynk, readDashboard } from '@/composables/lynkDashboard'

/**
 * The Lynk.id Dashboard tab: what a store sold, read from one Drive folder of
 * spreadsheets.
 *
 * Kept in its own component rather than threaded through the GitHub body, because
 * the two answer different questions with different shapes — a pull-request list
 * and a revenue table share the shell (`.dsh-band`, the chips row, the rail) and
 * nothing else. The shell is the same file's markup either way; this is the body
 * the shell switches to, chosen by `ConnectorDashboard` on `row.builtIn`.
 *
 * Four rules, copied from the YouTube Studio connector because they are the ones
 * that keep a report honest:
 *
 *   1. **Never invent a number.** A spreadsheet whose header cannot be read is
 *      counted as unreadable and named, not added as zero revenue.
 *   2. **Every window is anchored on the answer**, not on this machine's clock —
 *      the last order in the folder ends the window, so a stale read does not
 *      silently shorten it.
 *   3. **A chip costs no request.** 30 / 90 / 12m / all re-slice rows the main
 *      process already read; only Refresh and Re-read now spend a Drive call.
 *   4. **Zero rows stay on screen.** An empty folder draws the table's frame and
 *      says why, because six zeroes look like a broken connector.
 */
const route = useRoute()
const router = useRouter()

const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) => (Number.isFinite(Number(value)) ? nFmt.format(Number(value)) : '—')

/* `Rp 9.351.900` — id-ID, a space after the prefix, and `Rp 0` rather than an em
   dash when nothing was sold: zero is a fact, missing is `—`. */
const moneyFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })
const money = (value) => {
  if (value === null || value === undefined || value === '') return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount < 0 ? `−Rp ${moneyFmt.format(Math.abs(amount))}` : `Rp ${moneyFmt.format(amount)}`
}
const pct = (value) => {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  const shown = amount * 100
  return `${Number.isInteger(Number(shown.toFixed(1))) ? Math.round(shown) : shown.toFixed(1)} %`
}
const dayText = (iso, year = true) => {
  if (!iso) return '—'
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
  })
}
const monthText = (key, long = false) => {
  const date = new Date(`${key}-01T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', { month: long ? 'long' : 'short', year: '2-digit' })
}
const clock = (iso) => {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return `${date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })}`
}

/* ── the window: four chips over one answer ────────────────────────── */
const CHIPS = [
  { key: 30, label: '30 days' },
  { key: 90, label: '90 days' },
  { key: 365, label: '12 months' },
  { key: 0, label: 'All' },
]
const days = ref(90)

async function slice(next) {
  if (days.value === next) return
  days.value = next
  /* A cached answer is arithmetic in the main process — the folder is not read
     again, which is the whole reason the chips are cheap. */
  await readDashboard({ days: next })
}

const spanText = computed(() => {
  const span = lynk.window || {}
  if (!span.since || !span.until) return 'no window yet'
  const label = span.days ? `${num(span.days)} days` : 'everything on file'
  return span.since === span.until
    ? `${dayText(span.until)} · ${label}`
    : `${dayText(span.since)} → ${dayText(span.until)} · ${label}`
})

/* The folder changed under a stored answer: an answer older than the cache's own
   time to live is the one case where "read 3 h ago" means "this may be wrong". */
const stale = computed(() => {
  if (!lynk.readAt || !lynk.cacheTtlMs) return false
  const read = new Date(lynk.readAt).getTime()
  if (!Number.isFinite(read)) return false
  return Date.now() - read > lynk.cacheTtlMs
})

/* A folder that was deleted, or moved to an account this grant cannot see, is not
   a refused grant: reauthorizing changes nothing and picking another folder does.
   Two failures, two sentences, because the button differs. */
const notFound = computed(() =>
  /not ?found|404|does not exist|no longer|PERMISSION_DENIED.*drive/i.test(String(lynk.error || '')),
)

/* Nothing was ever read and the read failed: the six tiles would be six zeroes
   nobody earned, so the frame is the error and nothing else. A throttle is drawn
   with its own sentence, above this — but it still never fills the frame with
   zeroes for a folder that was not read. */
const dead = computed(() => Boolean(lynk.error) && !lynk.readAt)

const refreshing = computed(() => lynk.reading && Boolean(lynk.readAt))
const empty = computed(() => lynk.loaded && !lynk.loading && lynk.error === '' && !lynk.products.length)

/* What is happening right now, in one line: the folder being listed, or how many
   of the folder's spreadsheets have been opened. Never a bare spinner. */
const readLine = computed(() => {
  const { phase, total, read } = lynk.progress || {}
  if (phase === 'listing') return 'Listing the folder…'
  if (total && read < total) return `Reading ${num(read)} of ${num(total)} spreadsheets…`
  if (total) return `Add ${total === 1 ? 'up one spreadsheet' : `up ${num(total)} spreadsheets`}…`
  return 'Reading the folder…'
})
/* The tiles are skeletons while the first read is in flight, and the old numbers
   stay put while a refresh runs over them — two different jobs. */
const skel = computed(() => lynk.loading || (!lynk.readAt && lynk.reading))

/* A sheet the read could not use is neither revenue nor a zero: it is named. */
const missing = computed(() => lynk.sheets.unreadable || 0)
const partial = computed(() => lynk.sheets.empty > 0 || missing.value > 0)
const partialLine = computed(() => {
  const total = lynk.sheets.total
  if (!total) return ''
  const parts = []
  if (lynk.sheets.empty) {
    parts.push(
      `${num(lynk.sheets.empty)} of ${num(total)} spreadsheets ${lynk.sheets.empty === 1 ? 'is' : 'are'} empty.`,
    )
  }
  if (missing.value) {
    parts.push(
      `${num(missing.value)} ${missing.value === 1 ? 'tab' : 'tabs'} had no readable header, so ${missing.value === 1 ? 'it is' : 'they are'} not in the table either.`,
    )
  }
  return parts.join(' ')
})

/* ── the tiles ─────────────────────────────────────────────────────── */
const kpis = computed(() => [
  {
    key: 'revenue',
    k: 'Revenue',
    value: money(lynk.totals.revenue),
    raw: lynk.totals.revenue,
    q: 'money taken in this window',
    hint: 'Every row with a price, added up. Free rows contribute nothing here.',
  },
  {
    key: 'orders',
    k: 'Orders',
    value: num(lynk.totals.orders),
    raw: lynk.totals.orders,
    q: 'rows with a buyer',
    hint: 'Orders including free ones — a giveaway is still an order.',
  },
  {
    key: 'aov',
    k: 'Average order',
    value: money(lynk.totals.aov),
    raw: lynk.totals.aov,
    q: 'revenue ÷ paid orders',
    hint: 'Divided by paid orders only, so a thousand free rows cannot drag it to zero.',
  },
  {
    key: 'paid',
    k: 'Paid orders',
    value: num(lynk.totals.paid),
    raw: lynk.totals.paid,
    q: 'orders with money on them',
    hint: 'The rows revenue is divided by.',
  },
  {
    key: 'buyers',
    k: 'Buyers',
    value: num(lynk.buyers.total),
    raw: lynk.buyers.total,
    q: 'distinct addresses',
    hint: 'One buyer is one email, however many products they bought.',
  },
  {
    key: 'repeat',
    k: 'Repeat',
    value: pct(lynk.repeatPct),
    raw: lynk.repeatPct,
    q: `${num(lynk.buyers.twice)} bought twice or more`,
    hint: 'Share of buyers with two or more orders — the only loyalty number here.',
  },
])

const months = computed(() => lynk.months)
/* Whether any row in this window was free: the footnote changes with it, because
   "free rows are counted as orders, never as revenue" is only worth saying when a
   free row exists. */
const rowsFree = computed(() => lynk.products.some((product) => Number(product.freeOrders) > 0))
const freeLine = computed(() => {
  const free = lynk.products.filter((product) => Number(product.freeOrders) > 0)
  if (!free.length) return ''
  const named = free
    .slice(0, 2)
    .map((product) => `${product.name} (${num(product.freeOrders)} free orders)`)
    .join(' and ')
  const lead = free.length === 1 ? 'One of these never took money' : `Some of these never took money`
  return `${lead}: ${named}. Free rows are counted as orders, never as revenue.`
})

/* The twelve-month series, drawn as bars in the rail. */
const total12 = computed(() => lynk.months.reduce((sum, entry) => sum + (Number(entry.revenue) || 0), 0))
const peak12 = computed(() => Math.max(0, ...lynk.months.map((entry) => Number(entry.revenue) || 0)))
/* The share bar is a share, not a revenue bar: it is 0–100 % of this window's
   money, so the widest product is always full and the table stays comparable. */
const shareWidth = (product) => `${Math.max(0, Math.min(100, Math.round((Number(product.share) || 0) * 100)))}%`
const barWidth = (value) => {
  const amount = Number(value) || 0
  if (!peak12.value || amount <= 0) return '0%'
  return `${Math.max(2, Math.round((amount / peak12.value) * 100))}%`
}

/* Products with a zero last order still earn a row; their money column says `Rp 0`
   rather than disappearing, because a product that took no money is a product the
   person needs to see. */
const rows = computed(() => lynk.products)

const source = computed(() => ({
  folder: lynk.folderName || lynk.folderId || 'no folder',
  sheets: lynk.sheets.total,
  withTab: lynk.sheets.withTab,
  suffix: lynk.sheetSuffix,
}))

const overview = computed(() => {
  const query = { ...route.query }
  delete query.tab
  return query
})

async function refresh() {
  await readDashboard({ days: days.value, force: true })
}

/* Reauthorize and "pick another folder" both end on Overview: that page owns the
   Google grant and the folder control, and this tab has neither. */
function goOverview() {
  router.replace({ query: overview.value })
}
/* Reauthorizing is a grant, and this page cannot grant one: it hands the person
   to the account card on Overview, which owns the Google consent and the folder
   control. Re-reading here would only repeat the refusal. */
function reauthorize() {
  goOverview()
}
</script>

<template>
  <div class="dsh-band">
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
        <button class="btn btn-sm" type="button" :disabled="lynk.reading" @click="refresh">
          Try again
        </button>
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
        <button class="btn btn-sm" type="button" @click="reauthorize">Reauthorize</button>
        <button class="btn btn-sm btn-ghost" type="button" :disabled="lynk.reading" @click="refresh">
          Try again
        </button>
      </div>
    </div>

    <!-- Anything else: a real failure with Google's own words on it. The frame is
         still drawn below, but with the numbers that were already read, so an
         outage is never mistaken for a folder with nothing in it. -->
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

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which window to show">
        <button
          v-for="chip in CHIPS"
          :key="chip.key"
          type="button"
          class="dsh-chip"
          :aria-pressed="days === chip.key"
          @click="slice(chip.key)"
        >{{ chip.label }}</button>
      </div>
      <div class="dsh-when">
        <span>{{ spanText }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="dsh-sheets">
          {{ lynk.sheets.total ? `${num(lynk.sheets.total)} sheets` : 'no folder read' }}
        </span>
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
      <p>{{ readLine }}</p>
    </div>

    <!-- Stale: the answer is real and probably no longer true. The sentence names
         the age and the button that re-reads, rather than a banner that only
         apologises. -->
    <div v-if="stale && !lynk.refused" class="dsh-wait">
      <span class="k">Stale</span>
      <p>
        This answer was read <b>{{ ago(lynk.readAt) }}</b> and the folder has changed since.
        <a class="dsh-jump" href="#" @click.prevent="refresh">refresh</a>
      </p>
    </div>

    <!-- Partial: some spreadsheets had nothing to read. Named above the table so the
         table's total is never mistaken for the folder's. -->
    <div v-if="partial && !empty" class="dsh-wait">
      <span class="k">Partly read</span>
      <p>
        {{ partialLine }}
        They are listed in the folder, not in this table — a product with no order is a fact, not a
        zero.
      </p>
    </div>

    <div v-if="!dead" class="dsh-kpis" :aria-busy="skel ? 'true' : 'false'">
      <a
        v-for="kpi in kpis"
        :key="kpi.key"
        class="dsh-kpi"
        href="#dsh-prod-head"
        :title="`${kpi.hint} Jump to the product table`"
      >
        <span class="k">{{ kpi.k }}</span>
        <span v-if="skel" class="dsh-skel" style="width: 52%; height: 20px; margin-top: 6px"></span>
        <b v-else class="v">{{ kpi.value }}</b>
        <span class="q">{{ kpi.q }}</span>
      </a>
    </div>

    <div v-if="!dead" class="dsh">
      <div class="dsh-main">
        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-prod-head">
          <div class="hd">
            <h3 id="dsh-prod-head">Products</h3>
            <span class="n">{{ skel ? '—' : rows.length }}</span>
            <span class="spacer"></span>
            <span class="hd-when">by money taken</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-prod-head">
            <table class="dsh-tbl dsh-prod-tbl">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" class="money">Revenue</th>
                  <th scope="col" class="ckc">Orders</th>
                  <th scope="col" class="shr">Share</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="skel">
                  <tr v-for="n in 7" :key="`sk${n}`" class="skrow">
                    <td>
                      <span class="dsh-skel" style="width: 62%; height: 11px"></span>
                      <span class="dsh-skel" style="width: 38%; height: 9px; margin-top: 7px"></span>
                    </td>
                    <td class="money" data-l="revenue"><span class="dsh-skel" style="width: 84px; height: 11px"></span></td>
                    <td class="ck" data-l="orders"><span class="dsh-skel" style="width: 34px; height: 11px"></span></td>
                    <td class="shr" data-l="share"><span class="dsh-skel" style="width: 52px; height: 9px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!rows.length" class="emptyrow">
                  <td colspan="4">
                    <b>{{ lynk.sheets.total ? 'This folder has no paid order yet' : 'This folder has no spreadsheet' }}</b>
                    <span v-if="lynk.sheets.total">
                      {{ num(lynk.sheets.total) }} spreadsheets were read; each one's
                      <code class="mono">{{ lynk.sheetSuffix }}</code> tab had a header and no rows.
                    </span>
                    <span v-else>Nothing in this folder is a spreadsheet, so there is nothing to add up.</span>
                    <a href="#" @click.prevent="goOverview">Check the folder, or pick another one</a>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="product in rows" :key="product.slug || product.name">
                    <td>
                      <div class="prod">
                        <span class="nm" :title="product.name">{{ product.name }}</span>
                        <span class="sub">
                          last order {{ product.lastOrder ? dayText(product.lastOrder) : '—' }}
                          <template v-if="product.freeOrders">
                            · <b>{{ num(product.freeOrders) }}</b> free
                          </template>
                        </span>
                      </div>
                    </td>
                    <td class="money" data-l="revenue" :data-zero="Number(product.revenue) > 0 ? null : '1'">
                      {{ money(product.revenue) }}
                    </td>
                    <td class="ck" data-l="orders">{{ num(product.orders) }}</td>
                    <td class="shr" data-l="share">
                      <span class="sharebar" aria-hidden="true"><i :style="{ width: shareWidth(product) }"></i></span>
                      {{ pct(product.share) }}
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            Read from <code class="mono">spreadsheets.values</code> ·
            {{ lynk.readAt ? `read ${ago(lynk.readAt)}` : 'not read yet' }} ·
            <template v-if="freeLine">{{ freeLine }}</template>
            <template v-else>Zero rows are kept: a product with no order is a fact, not a missing row.</template>
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="dsh-src-head">
          <div class="hd">
            <h3 id="dsh-src-head">Source</h3>
            <span class="n">{{ source.sheets ? `${source.withTab} of ${source.sheets}` : '—' }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>folder</dt>
            <dd class="ell" :title="source.folder">{{ source.folder }}</dd>
            <dt>tab</dt>
            <dd><code class="mono">{{ source.suffix }}</code></dd>
            <dt>currency</dt>
            <dd>{{ lynk.currency }}</dd>
            <dt>zone</dt>
            <dd>{{ lynk.timezone }}</dd>
            <dt>read</dt>
            <dd>{{ lynk.readAt ? ago(lynk.readAt) : '—' }}</dd>
          </dl>
          <p class="dsh-foot">
            {{ lynk.cached ? 'A stored answer, six hours old at most.' : 'Read from Drive just now.' }}
            <b>{{ lynk.reads || 0 }}</b> {{ lynk.reads === 1 ? 'spreadsheet' : 'spreadsheets' }} touched.
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="dsh-m12-head">
          <div class="hd">
            <h3 id="dsh-m12-head">12 Months</h3>
            <span class="n">{{ months.length }}</span>
          </div>
          <div v-if="skel" class="dsh-months">
            <span v-for="n in 12" :key="`msk${n}`" class="dsh-skel" style="height: 46px"></span>
          </div>
          <ol v-else class="dsh-months" aria-label="Revenue by month, twelve months">
            <li v-for="entry in months" :key="entry.month" :title="`${monthText(entry.month, true)} · ${money(entry.revenue)} · ${num(entry.orders)} orders`">
              <span class="bar" aria-hidden="true"><i :style="{ height: barWidth(entry.revenue) }"></i></span>
              <span class="ml">{{ monthText(entry.month) }}</span>
            </li>
          </ol>
          <p class="dsh-foot">
            {{ months.length ? `${money(total12)} over the twelve months to ${monthText(months[months.length - 1].month, true)}.` : 'No month has an order yet.' }}
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="dsh-buy-head">
          <div class="hd">
            <h3 id="dsh-buy-head">Buyers</h3>
            <span class="n">{{ num(lynk.buyers.total) }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>bought twice or more</dt>
            <dd>
              {{ num(lynk.buyers.twice) }}
              <span class="muted">· {{ pct(lynk.repeatPct) }} of {{ num(lynk.buyers.total) }}</span>
            </dd>
            <dt>active ≤ 30 d</dt>
            <dd>{{ num(lynk.buyers.active) }}</dd>
            <dt>drifting ≤ 90 d</dt>
            <dd>{{ num(lynk.buyers.drifting) }}</dd>
            <dt>lapsed &gt; 90 d</dt>
            <dd>{{ num(lynk.buyers.lapsed) }}</dd>
          </dl>
          <div
            class="dsh-meter"
            role="img"
            :aria-label="`${num(lynk.buyers.twice)} of ${num(lynk.buyers.total)} buyers bought more than once`"
          ><i :style="{ width: `${Math.round(lynk.repeatPct * 100)}%` }"></i></div>
          <p class="dsh-foot">
            Watched from the window's own last day, so a stored answer does not age its buyers twice.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
