<script setup>
import { computed, ref } from 'vue'
import { ago } from '@/stores/hub'
import { dayText, money, monthText, num, pct, lynk } from '@/connectors/lynk/useLynk'

/**
 * The Customers tab: who bought, how often, and who has not been back.
 *
 * A second tab rather than four more cards on Overview, because the questions are
 * different shapes. Overview is money per month and per product — a column of
 * numbers a person scans. This is a population: how many buyers bought once, twice,
 * six times; which of them have drifted; what the top ten account for. Mixed onto
 * one page, the second set of numbers competes with the first for the same tiles.
 *
 * Three rules, and they are the ones a reader will test this screen against:
 *
 *   1. **A person is named only if the folder named them.** `leaderboard[].name` is
 *      `null` when the sheet carried no name, and the row then reads `Buyer #12` —
 *      its rank — rather than a blank. No contact field from a sheet is drawn here
 *      at all, because the answer does not carry one.
 *   2. **A rate with no denominator is a dash.** `pct()` answers `—` for a missing
 *      value, so a bucket with no buyers prints `—` rather than a confident `0 %`.
 *   3. **The whole folder, not a chip.** The Overview's chips slice `days`; a
 *      buyer's first and last month are the answer's own, so slicing this tab by a
 *      window would show a repeat buyer as new. Its period is the folder's history,
 *      said once at the top.
 */

/* A row that can be opened: the product list under a top buyer is the one thing
   here that is genuinely long (a buyer of thirty products), so it is collapsed by
   default and its row says how many it is not showing. */
const open = ref('')
const toggle = (key) => (open.value = open.value === key ? '' : key)

const customers = computed(() => lynk.customers || {})
const value = computed(() => customers.value.value || {})
const breadth = computed(() => customers.value.breadth || {})
const buyers = computed(() => lynk.buyers || {})

/* The buckets in the order a person reads them. The header's number is their sum,
   so a bucket that disagrees with it cannot hide — it shows. */
const buckets = computed(() => {
  const orders = customers.value.orders || {}
  const rows = [
    { key: 'one', label: '1 order', n: Number(orders.one) || 0 },
    { key: 'two', label: '2 orders', n: Number(orders.two) || 0 },
    { key: 'threeToFive', label: '3–5 orders', n: Number(orders.threeToFive) || 0 },
    { key: 'sixPlus', label: '6+ orders', n: Number(orders.sixPlus) || 0 },
  ]
  const total = rows.reduce((sum, row) => sum + row.n, 0)
  const biggest = Math.max(0, ...rows.map((row) => row.n))
  return rows.map((row) => ({
    ...row,
    share: total > 0 ? (row.n / total) * 100 : null,
    /* The bar is drawn against the biggest bucket, not the total: with one bucket
       holding 80 % of buyers, scaling to the total leaves three bars invisible. */
    width: biggest > 0 ? Math.max(row.n > 0 ? 3 : 0, Math.round((row.n / biggest) * 100)) : 0,
  }))
})

const bucketTotal = computed(() => buckets.value.reduce((sum, row) => sum + row.n, 0))
const buyerCountLine = computed(() =>
  bucketTotal.value ? `${num(bucketTotal.value)} ${bucketTotal.value === 1 ? 'buyer' : 'buyers'}` : '—',
)

/* Recency: three bands the main process defines by days since the last order —
   ≤ 60 active, ≤ 120 drifting, else lapsed. The thresholds are quoted, not
   re-invented, so a band cannot drift from the one the answer sorted by. */
const bands = computed(() => {
  const recency = customers.value.recency || {}
  return [
    { key: 'active', label: 'Active', note: 'ordered within 60 days', tone: 'ok', ...(recency.active || {}) },
    { key: 'drifting', label: 'Drifting', note: '60 to 120 days idle', tone: 'warn', ...(recency.drifting || {}) },
    { key: 'lapsed', label: 'Lapsed', note: 'over 120 days idle', tone: 'bad', ...(recency.lapsed || {}) },
  ]
})

const bandTotal = computed(() => bands.value.reduce((sum, band) => sum + (Number(band.buyers) || 0), 0))

/* New and returning, month by month. A table of the last twelve rather than a
   stacked chart: the numbers are three or four digits and a chart would hide them.
   `customers.months` arrives newest-first, so the twelve to keep are the leading
   twelve and the reverse makes them read left to right. */
const months = computed(() => {
  const rows = (customers.value.months || []).slice(0, 12).reverse()
  const biggest = Math.max(
    0,
    ...rows.map((row) => (Number(row.newBuyers) || 0) + (Number(row.returningBuyers) || 0)),
  )
  return rows.map((row) => {
    const fresh = Number(row.newBuyers) || 0
    const back = Number(row.returningBuyers) || 0
    const total = fresh + back
    return {
      ...row,
      fresh,
      back,
      total,
      freshShare: total > 0 ? (fresh / total) * 100 : 0,
      width: biggest > 0 ? Math.max(total > 0 ? 3 : 0, Math.round((total / biggest) * 100)) : 0,
    }
  })
})

const monthPeak = computed(() => months.value.slice().sort((left, right) => right.total - left.total)[0] || null)

const ranks = computed(() => customers.value.leaderboard || [])

/* `band` arrives from the answer as a word; this is the one place it becomes a tone. */
const tone = (band) => (band === 'active' ? 'ok' : band === 'drifting' ? 'warn' : 'bad')

const gapText = computed(() => {
  const days = Number(value.value.gapDays)
  if (!Number.isFinite(days) || days <= 0) return '—'
  return `${num(days)} ${days === 1 ? 'day' : 'days'}`
})
</script>

<template>
  <div class="lyk-cust">
    <!-- The period this tab answers for, said once. Overview has chips; this tab
         would lie with them, because a buyer's history is not the window's. -->
    <p class="dsh-note">
      <template v-if="buyers.total">
        <b>{{ num(buyers.total) }}</b> buyers across the folder's whole history,
        {{ dayText(lynk.window.firstDay) }} → {{ dayText(lynk.window.lastDay) }}. A buyer is one
        paying row's name and that name's order history, so this tab is not sliced by Overview's
        period chips — a repeat buyer counted inside a ninety-day window would read as new.
      </template>
      <template v-else-if="lynk.loaded">
        No buyer can be identified yet: either the folder has no paying row, or no paying row carries
        the name a buyer is grouped by.
      </template>
      <template v-else>Reading the folder, so there is nothing to count yet.</template>
    </p>

    <div class="dsh-kpis lyk-kpis">
      <div class="dsh-kpi">
        <span class="k">Buyers</span>
        <b class="v">{{ num(buyers.total) }}</b>
        <span class="q">paying, one row each</span>
        <span class="d">
          <template v-if="buyers.total">
            {{ num(buyers.thisMonthNew) }} first bought in the folder's last month,
            {{ num(buyers.thisMonthReturning) }} came back.
          </template>
          <template v-else>—</template>
        </span>
      </div>
      <div class="dsh-kpi">
        <span class="k">Repeat</span>
        <b class="v">{{ pct(buyers.repeatRate) }}</b>
        <span class="q">bought more than once</span>
        <span class="d">
          <template v-if="buyers.total">
            {{ num(buyers.repeat) }} of {{ num(buyers.total) }} · {{ num(buyers.twice) }} bought exactly twice.
          </template>
          <template v-else>—</template>
        </span>
      </div>
      <div class="dsh-kpi">
        <span class="k">Per buyer</span>
        <b class="v">{{ value.payingBuyers ? money(value.perBuyer) : '—' }}</b>
        <span class="q">spend, averaged</span>
        <span class="d">
          <template v-if="value.payingBuyers">Across {{ num(value.payingBuyers) }} buyers who paid something.</template>
          <template v-else>—</template>
        </span>
      </div>
      <div class="dsh-kpi">
        <span class="k">Top 10</span>
        <b class="v">{{ pct(value.top10) }}</b>
        <span class="q">of all revenue</span>
        <span class="d">
          <template v-if="ranks.length">
            The top twenty-five account for {{ pct(value.top25) }} — the share that says whether the
            store depends on a handful of people.
          </template>
          <template v-else>—</template>
        </span>
      </div>
    </div>

    <div class="lyk-two">
      <!-- How often people come back: four buckets, and the header's number is
           their sum so a bucket can be checked against it on sight. -->
      <section class="dsh-card" aria-labelledby="lyk-buckets-head">
        <div class="hd">
          <h3 id="lyk-buckets-head">Orders per buyer</h3>
          <span class="n">{{ num(bucketTotal) }}</span>
          <span class="spacer"></span>
          <span class="hd-when">{{ buyerCountLine }}</span>
        </div>
        <ul class="lyk-rows" aria-label="Buyers by how many orders they placed">
          <li v-for="bucket in buckets" :key="bucket.key">
            <span class="ml">{{ bucket.label }}</span>
            <span class="bar" aria-hidden="true"><i :style="{ width: `${bucket.width}%` }"></i></span>
            <span class="vl">{{ num(bucket.n) }}</span>
            <span class="sh">{{ pct(bucket.share) }}</span>
          </li>
        </ul>
        <p class="dsh-foot">
          A bucket with no buyers prints <b>—</b>, not <b>0 %</b>: that rate has no denominator.
          The buckets are orders per buyer over the folder's whole history, so they add up to the
          count in the head — and a buyer is in exactly one of them.
        </p>
      </section>

      <!-- Who has stopped: the three bands the read itself sorted buyers into. -->
      <section class="dsh-card" aria-labelledby="lyk-band-head">
        <div class="hd">
          <h3 id="lyk-band-head">Last order</h3>
          <span class="n">{{ num(bandTotal) }}</span>
          <span class="spacer"></span>
          <span class="hd-when">days idle</span>
        </div>
        <ul class="lyk-bands">
          <li v-for="band in bands" :key="band.key" :data-tone="band.tone">
            <span class="dot" aria-hidden="true"></span>
            <span class="bl">{{ band.label }}</span>
            <span class="bn">{{ num(band.buyers) }}</span>
            <span class="bq">{{ band.note }}</span>
            <span class="bm">{{ money(band.revenue) }} · {{ num(band.orders) }} orders</span>
          </li>
        </ul>
        <p class="dsh-foot">
          The bands are the answer's own: a buyer is active while their last order is within
          <b>60 days</b> of the folder's last sale, drifting up to <b>120</b>, and lapsed after that.
          These count buyers, so they need not match the buckets on the left — a buyer can be lapsed
          and still hold six orders.
        </p>
      </section>
    </div>

    <div class="lyk-two">
      <!-- New against returning, month by month. -->
      <section class="dsh-card" aria-labelledby="lyk-new-head">
        <div class="hd">
          <h3 id="lyk-new-head">New and returning</h3>
          <span class="n">{{ months.length }}</span>
          <span class="spacer"></span>
          <span class="hd-when">{{ monthPeak ? `peak ${monthText(monthPeak.key, true)}` : '—' }}</span>
        </div>
        <div v-if="!months.length" class="dsh-none">
          No month has a buyer in it yet, so there is nothing to split.
        </div>
        <ul v-else class="lyk-rows" aria-label="New and returning buyers by month">
          <li v-for="month in months" :key="month.key">
            <span class="ml">{{ monthText(month.key) }}</span>
            <span class="bar split" aria-hidden="true">
              <i class="fresh" :style="{ width: `${month.freshShare}%` }"></i>
              <i class="back" :style="{ width: `${100 - month.freshShare}%` }"></i>
            </span>
            <span class="vl">{{ num(month.total) }}</span>
            <span class="sh">{{ num(month.fresh) }} new · {{ num(month.back) }} back</span>
          </li>
        </ul>
        <p class="dsh-foot">
          The left part of a bar is first-time buyers, the right part is people who had bought before.
          A month can show zero new buyers and still take money — that is the point of the split.
        </p>
      </section>

      <!-- A buyer's relationship to the catalogue, and the two facts asked next:
           how much per buyer, and how far apart their orders are. -->
      <section class="dsh-card" aria-labelledby="lyk-value-head">
        <div class="hd">
          <h3 id="lyk-value-head">Value</h3>
          <span class="n">{{ num(value.payingBuyers) }}</span>
        </div>
        <dl class="cxn-facts">
          <dt>per buyer</dt>
          <dd>{{ value.payingBuyers ? money(value.perBuyer) : '—' }}</dd>
          <dt>top 10</dt>
          <dd>{{ pct(value.top10) }} <span class="muted">of revenue</span></dd>
          <dt>top 25</dt>
          <dd>{{ pct(value.top25) }} <span class="muted">of revenue</span></dd>
          <dt>gap</dt>
          <dd>{{ gapText }} <span class="muted">between one buyer's orders</span></dd>
          <dt>breadth</dt>
          <dd>
            <template v-if="breadth.of">
              {{ num(breadth.multiProduct) }} of {{ num(breadth.of) }} bought more than one product
              · {{ pct((breadth.multiProduct / breadth.of) * 100) }}
            </template>
            <template v-else>—</template>
          </dd>
        </dl>
        <p class="dsh-foot">
          The gap is the mean number of days between one buyer's orders — a mean, not a median, and
          <b>—</b> when nobody has ordered twice. Breadth counts buyers holding two or more distinct
          products, which is a different question from repeat orders on the same one.
        </p>
      </section>
    </div>

    <!-- The leaderboard: twenty rows, paying buyers only, sorted by spend. A name is
         drawn when the sheet carried one and `Buyer #n` when it did not — never an
         email, a phone number or anything else the answer does not hold. -->
    <section class="dsh-card dsh-tblcard" aria-labelledby="lyk-top-head">
      <div class="hd">
        <h3 id="lyk-top-head">Top buyers</h3>
        <span class="n">{{ ranks.length }}</span>
        <span class="spacer"></span>
        <span class="hd-when">by spend</span>
      </div>
      <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="lyk-top-head">
        <table class="dsh-tbl lyk-top">
          <thead>
            <tr>
              <th scope="col" class="rk">#</th>
              <th scope="col">Buyer</th>
              <th scope="col" class="num">Orders</th>
              <th scope="col" class="num">Products</th>
              <th scope="col" class="money">Spend</th>
              <th scope="col" class="upd">First</th>
              <th scope="col" class="upd">Last</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!ranks.length" class="emptyrow">
              <td colspan="8">
                <b>{{ lynk.loaded ? 'Nobody has paid yet' : 'Not read yet' }}</b>
                <span v-if="lynk.loaded">
                  The folder holds free rows only, or none of its paying rows carries a buyer name to
                  group by — either way there is no leader to name.
                </span>
                <span v-else>The folder has not been read, so there is nobody to rank.</span>
              </td>
            </tr>
            <template v-else>
              <tr v-for="person in ranks" :key="person.rank" :data-open="open === person.rank ? '1' : null">
                <td class="rk">{{ person.rank }}</td>
                <td>
                  <div class="prod">
                    <button
                      v-if="person.productList && person.productList.length"
                      type="button"
                      class="lyk-name"
                      :aria-expanded="open === person.rank ? 'true' : 'false'"
                      @click="toggle(person.rank)"
                    >
                      <span class="nm">{{ person.name || `Buyer #${person.rank}` }}</span>
                      <span class="chev" aria-hidden="true">{{ open === person.rank ? '−' : '+' }}</span>
                    </button>
                    <span v-else class="nm">{{ person.name || `Buyer #${person.rank}` }}</span>
                    <span class="sub">
                      {{ num(person.orders) }} {{ person.orders === 1 ? 'order' : 'orders' }}
                      <template v-if="person.productsOmitted">
                        · {{ num(person.productsOmitted) }} more products held back
                      </template>
                    </span>
                  </div>
                  <ul v-if="open === person.rank && person.productList" class="lyk-held">
                    <li v-for="held in person.productList" :key="held.title">
                      <span class="ht">{{ held.title }}</span>
                      <span class="hv">
                        {{ num(held.units) }} {{ held.units === 1 ? 'unit' : 'units' }}
                        · {{ money(held.paid) }}
                        · last {{ held.last ? dayText(held.last) : '—' }}
                      </span>
                    </li>
                  </ul>
                </td>
                <td class="num">{{ num(person.orders) }}</td>
                <td class="num">{{ num(person.products) }}</td>
                <td class="money">{{ money(person.spend) }}</td>
                <td class="upd">{{ person.firstMonth ? monthText(person.firstMonth, true) : '—' }}</td>
                <td class="upd">{{ person.lastMonth ? monthText(person.lastMonth, true) : '—' }}</td>
                <td>
                  <span class="lyk-band" :data-tone="tone(person.band)">{{ person.band || '—' }}</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p class="dsh-foot">
        Twenty buyers by money spent, and only buyers who spent something — a free claim does not make
        somebody a top buyer. A name is printed only when the spreadsheet carried one; otherwise the
        row is its rank, because an unnamed payer is still a payer.
        <template v-if="lynk.readAt"> Read {{ ago(lynk.readAt) }}.</template>
      </p>
    </section>
  </div>
</template>
