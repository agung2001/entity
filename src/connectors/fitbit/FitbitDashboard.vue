<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ago } from '@/stores/hub'
import { cacheNote as cacheNoteOf, ttlWords } from '@/connectors/parts/readClock'
import { ensureDay, fitbit, readDashboard } from '@/connectors/fitbit/useFitbit'

/**
 * The Fitbit connector's Dashboard tab: one day, in six counts and twenty-four
 * hours, read from the account that is signed in on this machine.
 *
 * **Read-only, everywhere.** There is no control here that logs steps, food,
 * water, sleep or weight, and no button that could — Fitbit is a service this app
 * reads, not one it writes to. The only verb on the page is **Re-read**, and it
 * spends at most five of the hour's hundred and fifty calls.
 *
 * The day lives in the address (`?tab=dashboard&day=…`) and this component does
 * not write to it: it asks with `pick`, and the view answers by handing back a new
 * `day`. That keeps one owner for the query and makes the tab a place a person can
 * open again tomorrow.
 *
 * Every number is printed as the main process shaped it. A `null` is `—` and says
 * why in its own `.q` — an unreadable sleep score is not a zero, and a grant
 * without the heart-rate scope is not a resting rate of nothing.
 */
const props = defineProps({
  /* `''` (today), `yesterday`, or `YYYY-MM-DD`. `today` is also accepted so a
     bookmarked address keeps working; the view folds it back to `''`. */
  day: { type: String, default: '' },
})
const emit = defineEmits(['pick'])

const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) =>
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? '—'
    : nFmt.format(Number(value))

/* ── which day ──────────────────────────────────────────────────────
   Three controls and no fourth: today, yesterday, and the app's date field for
   anything older. A "next day" arrow would offer a day that has not happened. */
const asked = computed(() => String(props.day || ''))
const isToday = computed(() => asked.value === '' || asked.value === 'today')
const isYesterday = computed(() => asked.value === 'yesterday')
const literal = computed(() => /^\d{4}-\d{2}-\d{2}$/.test(asked.value))
const pickOpen = ref(false)

function pickToday() {
  pickOpen.value = false
  emit('pick', 'today')
}
function pickYesterday() {
  pickOpen.value = false
  emit('pick', 'yesterday')
}
/* The field's own value is the only thing that travels: `type="date"` already
   guarantees a shape, and a cleared field is not a request for anything. */
function commitDay(event) {
  const value = String(event?.target?.value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return
  pickOpen.value = false
  emit('pick', value)
}

/* ── one read, on mount and whenever the day changes ─────────────────
   The tab is only rendered when the gate is open, so its own mount is the read
   trigger. `readDashboard` waits for a read already in flight and runs the last
   request after it, so two fast presses cannot land on screen in the wrong order. */
onMounted(() => {
  ensureDay(asked.value)
})
/* A new day in the address is a new read. The composable serialises them, so a
   press during a read is queued rather than dropped and the last one wins. */
watch(asked, (value) => {
  ensureDay(value)
})

/* The one verb on the page. A read already in flight makes it a no-op rather than
   a `disabled` button: a disabled button leaves the tab order, and the person who
   tabbed to it would hear nothing about why pressing it did nothing. */
function reread() {
  if (fitbit.reading) return
  readDashboard({ day: asked.value, force: true })
}

/* ── the six counts ─────────────────────────────────────────────────
   Each tile names the number, prints it, and puts the denominator under it. The
   value is the main process's arithmetic, not a sum done here. */
const sleepText = computed(() => {
  const minutes = fitbit.counts?.sleep?.minutes
  if (minutes === null || minutes === undefined) return '—'
  const total = Math.max(0, Math.round(Number(minutes)))
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
})
const km = (value) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(2)} km`)
const hourWord = (value) => (Number(value) === 1 ? '1 call' : `${Number(value) || 0} calls`)
const receipt = computed(() => {
  if (!fitbit.readAt) return 'not read yet'
  return `${fitbit.stale ? 'read earlier' : 'read'} ${ago(fitbit.readAt)} · ${hourWord(fitbit.calls)}`
})

const tiles = computed(() => {
  const counts = fitbit.counts || {}
  const goals = fitbit.goals || {}
  const steps = counts.steps
  const stepGoal = goals.steps
  const share = steps !== null && stepGoal ? Math.min(100, Math.round((steps / stepGoal) * 100)) : 0
  const score = counts.sleep?.score
  const range = fitbit.hrRange
  return [
    {
      key: 'steps',
      k: 'Steps',
      v: num(steps),
      q: stepGoal ? `of ${num(stepGoal)} · ${share}% of the goal` : 'no step goal on this account',
      share,
      href: 'https://www.fitbit.com/activities',
    },
    {
      key: 'distance',
      k: 'Distance',
      v: km(counts.distanceKm),
      q: goals.distanceKm ? `of ${km(goals.distanceKm)}` : 'no distance goal on this account',
      href: 'https://www.fitbit.com/activities',
    },
    {
      key: 'active',
      k: 'Active minutes',
      v: num(counts.activeMinutes),
      q: goals.activeMinutes
        ? `of ${num(goals.activeMinutes)} min · fairly and very active`
        : 'fairly and very active',
      href: 'https://www.fitbit.com/activities',
    },
    {
      key: 'sleep',
      k: 'Sleep',
      v: sleepText.value,
      q:
        counts.sleep?.minutes === null || counts.sleep?.minutes === undefined
          ? 'no sleep logged for this day'
          : score === null || score === undefined
            ? 'the main sleep · no score in the log'
            : `the main sleep · score ${num(score)}`,
      href: 'https://www.fitbit.com/sleep',
    },
    {
      key: 'heart',
      k: 'Resting heart rate',
      v: counts.restingHr === null || counts.restingHr === undefined ? '—' : `${num(counts.restingHr)} bpm`,
      q: fitbit.noHeartrate
        ? 'not granted — the heart-rate scope was not asked for'
        : range
          ? `${num(range.low)}–${num(range.high)} bpm over ${range.days} days`
          : 'no earlier reading to compare with',
      href: 'https://www.fitbit.com/',
    },
    {
      key: 'devices',
      k: 'Devices',
      v: num(counts.devices?.count),
      q: receipt.value,
      href: 'https://www.fitbit.com/settings/devices',
    },
  ]
})

/* ── the hours ──────────────────────────────────────────────────────
   An hour that has not happened is not a row: `not yet` is the clock, not a
   measurement, and twenty-four of them would be a table of nothing. The band
   below the strip says how many are still to come. */
const rows = computed(() =>
  (Array.isArray(fitbit.bands) ? fitbit.bands : []).filter((band) => band.status !== 'not yet'),
)
const tonight = computed(() => {
  const left = Number(fitbit.day?.hoursLeft)
  if (!Number.isFinite(left) || left <= 0) return null
  const hours = Math.max(1, Math.round(left))
  return {
    hours: hours === 1 ? '1 hour' : `${hours} hours`,
    rows: rows.value.length,
  }
})
const tone = (status) =>
  status === 'on track' ? 'ok' : status === 'behind' ? 'bad' : status === 'in progress' ? 'warn' : null
/* The hour's own fill: active minutes out of the sixty it holds. The number is in
   the `aria-valuetext` as a sentence, because a bar read aloud is not a bar. */
const barWidth = (band) =>
  band.activeMinutes === null ? '0%' : `${Math.min(100, Math.max(0.6, band.activeMinutes))}%`
const barLabel = (band) =>
  band.activeMinutes === null
    ? `${band.label}: no heart-rate samples in this hour`
    : `${band.label}: ${band.activeMinutes} active ${band.activeMinutes === 1 ? 'minute' : 'minutes'} of 60`
const heart = (band) => (band.avgHr === null || band.avgHr === undefined ? '—' : `${num(band.avgHr)} bpm`)
const activeText = (band) =>
  band.activeMinutes === null ? '—' : `${num(band.activeMinutes)} min`

/* ── the week ───────────────────────────────────────────────────────
   Seven days from the file the main process already holds — reading a week of
   Fitbit would be a second set of calls, so the strip is made of what has been
   read and says so when the answer is thin. */
const week = computed(() => (Array.isArray(fitbit.week) ? fitbit.week : []))
const weekEmpty = computed(() => week.value.every((entry) => entry.steps === null))
const weekday = (date) => {
  const parsed = new Date(`${String(date)}T12:00:00`)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('en-gb', { weekday: 'short' }) : '—'
}
const weekShort = (date) => {
  const parsed = new Date(`${String(date)}T12:00:00`)
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('en-gb', { day: 'numeric', month: 'short' })
    : '—'
}

/* ── the clock ──────────────────────────────────────────────────────
   Fitbit's reset time is quoted, never computed: a number derived from the wrong
   minute would send someone back to a wall that is still there. */
const clock = (iso) => {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })
    : 'a time Fitbit did not say'
}
const limitText = computed(() => (fitbit.limited ? clock(fitbit.limited.resetAt) : ''))
/* How long a stored answer stays good, in the words the page prints. Read from the
   answer the main process sent, never typed into the copy — a finished day and the
   day still running do not cache for the same length of time, and the constant that
   decides is on the main process. */
/* The shared envelope in `parts/readClock.js`. `stale` is Fitbit's own word for
   "this answer is from an earlier read", which is the same fact as `cached`. */
const ttlText = computed(() => ttlWords(fitbit.cacheTtlMs))
const cacheNote = computed(() =>
  cacheNoteOf({ cached: fitbit.stale, ttlMs: fitbit.cacheTtlMs }),
)
const budget = computed(() => fitbit.budget || null)
const budgetText = computed(() => {
  const value = budget.value
  if (!value || !value.limit) return ''
  return `${num(value.used)} of ${num(value.limit)} calls this hour · resets ${clock(value.resetAt)}`
})
/* The day on screen, in the account's own words: the timezone the numbers were
   bucketed in, and the read's age. A person in a different zone needs the first to
   trust the second. */
const stampText = computed(() => {
  if (fitbit.reading) return 'reading…'
  if (!fitbit.readAt) return 'not read yet'
  const zone = fitbit.day?.timezone || 'UTC'
  const where = fitbit.noTimezone ? `${zone} · the account has no timezone, so its days break at UTC` : zone
  return `${where} · ${fitbit.stale ? 'read earlier' : 'read'} ${ago(fitbit.readAt)}`
})
</script>

<template>
  <div class="dsh-band">
    <!-- The read failed outright. The sentence is the main process's own, quoted
         rather than summarised: it knows whether the account is missing, refused
         or unreachable, and this component does not. -->
    <div v-if="fitbit.error" class="dsh-err" role="alert">
      <b>Fitbit could not be read.</b>
      <p><code class="mono">{{ fitbit.error }}</code></p>
      <p v-if="fitbit.readAt">
        The numbers below are the ones read at <b>{{ ago(fitbit.readAt) }}</b> — they
        were true for their own moment and nothing here has re-read them since.
      </p>
      <div class="dsh-err-act">
        <button
          class="btn btn-sm"
          type="button"
          :aria-disabled="fitbit.reading ? 'true' : 'false'"
          @click="reread"
        >
          Try again
        </button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which day to read">
        <!-- The chip already pressed reads back the day on screen, and pressing it
             again costs nothing: `ensureDay` sees the same day in memory and does not
             ask. A `disabled` chip would take the pressed state out of the tab order
             and leave nothing to hear. -->
        <button
          type="button"
          class="dsh-chip"
          :aria-pressed="isToday ? 'true' : 'false'"
          @click="pickToday"
        >Today</button>
        <button
          type="button"
          class="dsh-chip"
          :aria-pressed="isYesterday ? 'true' : 'false'"
          @click="pickYesterday"
        >Yesterday</button>
        <button
          type="button"
          class="dsh-chip"
          :aria-expanded="pickOpen ? 'true' : 'false'"
          :aria-pressed="literal ? 'true' : 'false'"
          :aria-controls="pickOpen ? 'fbk-day' : undefined"
          @click="pickOpen = !pickOpen"
        >{{ literal ? asked : 'Pick a day' }}</button>
      </div>
      <div class="dsh-when">
        <span>{{ stampText }}</span>
        <button
          class="btn btn-sm"
          type="button"
          :aria-disabled="fitbit.reading ? 'true' : 'false'"
          @click="reread"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ fitbit.reading ? 'Reading…' : 'Re-read' }}
        </button>
      </div>
    </div>

    <!-- The app's own date field, revealed by the third chip rather than always
         taking a line: most visits are today or yesterday. -->
    <div v-if="pickOpen" class="dsh-pickfield">
      <label for="fbk-day">Day</label>
      <input
        id="fbk-day"
        type="date"
        :value="literal ? asked : ''"
        @change="commitDay"
      />
      <span>a finished day is served from the file, so it costs no calls</span>
    </div>

    <!-- A spent hour: the numbers under it were read before the limit, and they
         are still the truth about their day. Only the reset can be acted on. -->
    <div v-if="fitbit.limited" class="dsh-wait" data-tone="bad">
      <span class="k">Call limit</span>
      <p>
        Fitbit’s calls for this hour are spent — <b>{{ num(fitbit.limited.calls) }}</b> of
        <b>{{ num(budget?.limit) }}</b> used — and they reset at <b>{{ limitText }}</b>.
        The numbers below are the last read, not new ones.
      </p>
      <span class="spacer"></span>
      <button
        class="btn btn-sm"
        type="button"
        :aria-disabled="fitbit.reading ? 'true' : 'false'"
        @click="reread"
      >Try again</button>
    </div>

    <!-- Before midnight: the hours after now are the clock, so they are a line
         instead of twenty-four empty rows. -->
    <div v-if="tonight" class="dsh-wait" data-tone="calm">
      <span class="k">Before midnight</span>
      <p>
        <b>{{ tonight.hours }}</b> of this day have not happened yet · the table below fills in
        as they do, {{ tonight.rows }} of 24 hours read so far.
      </p>
    </div>

    <div class="dsh-kpis fbk-kpis" role="list" :aria-busy="fitbit.reading ? 'true' : 'false'">
      <a
        v-for="tile in tiles"
        :key="tile.key"
        class="dsh-kpi"
        :class="{ 'fbk-steps': tile.key === 'steps' }"
        role="listitem"
        :href="tile.href"
        target="_blank"
        rel="noreferrer noopener"
        :title="`${tile.k} · opens Fitbit`"
      >
        <span class="k">{{ tile.k }}</span>
        <span v-if="fitbit.reading && !fitbit.readAt" class="dsh-skel" style="width: 46%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ tile.v }}</b>
        <div v-if="tile.key === 'steps' && tile.share" class="dsh-meter" role="img" :aria-label="`${tile.v} of ${num(fitbit.goals?.steps)} steps`"><i :style="{ width: `${tile.share}%` }"></i></div>
        <span class="q">{{ tile.q }}</span>
      </a>
    </div>

    <div class="dsh">
      <div class="dsh-main">
        <section class="dsh-card dsh-tblcard" aria-labelledby="fbk-hour-head">
          <div class="hd">
            <h2 id="fbk-hour-head">Hour by hour</h2>
            <span class="n">{{ fitbit.reading && !fitbit.readAt ? '—' : `${rows.length} of 24` }}</span>
            <span class="spacer"></span>
            <span class="hd-when">{{ fitbit.date || '—' }}</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="fbk-hour-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Hour</th>
                  <th scope="col" class="fbk-num">Heart rate</th>
                  <th scope="col">Active</th>
                  <th scope="col">Band</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="fitbit.reading && !fitbit.readAt">
                  <tr v-for="n in 5" :key="`sk${n}`" class="skrow">
                    <td><span class="dsh-skel" style="width: 84px; height: 10px"></span></td>
                    <td class="fbk-num"><span class="dsh-skel" style="width: 40px; height: 9px"></span></td>
                    <td><span class="dsh-skel" style="width: 90px; height: 6px"></span></td>
                    <td class="stc"><span class="dsh-skel" style="width: 62px; height: 18px"></span></td>
                  </tr>
                </template>
                <!-- No heart-rate scope: the four calls still answered, so the day
                     is real and the column says which grant is missing. -->
                <tr v-else-if="fitbit.noHeartrate" class="emptyrow">
                  <td colspan="4">
                    <b>The heart-rate scope was not granted, so no hour has a trace.</b>
                    <span>
                      Steps, distance, sleep and devices were read; the hourly bands need
                      <code class="mono">heartrate</code>. Grant it on the connector’s page and re-read.
                    </span>
                  </td>
                </tr>
                <!-- A day with no samples: the device has not synced, which is a
                     fact about the watch rather than about this page. -->
                <tr v-else-if="!rows.length" class="emptyrow">
                  <td colspan="4">
                    <b>Nothing synced for this day yet.</b>
                    <span>
                      Fitbit holds no minute-by-minute trace here.
                      <a href="https://www.fitbit.com/settings/devices" target="_blank" rel="noreferrer noopener">Check the device’s sync on Fitbit ↗</a>
                    </span>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="band in rows" :key="band.from">
                    <td class="fbk-hour">{{ band.from }}–{{ band.to }}</td>
                    <td class="fbk-num" data-l="heart rate">{{ heart(band) }}</td>
                    <td data-l="active">
                      <div class="fbk-bar">
                        <div class="dsh-meter" role="progressbar" :aria-valuenow="band.activeMinutes === null ? 0 : band.activeMinutes" aria-valuemin="0" aria-valuemax="60" :aria-valuetext="barLabel(band)"><i :style="{ width: barWidth(band) }"></i></div>
                        <span class="fbk-amt">{{ activeText(band) }}</span>
                      </div>
                    </td>
                    <td class="stc">
                      <span class="st" :data-tone="tone(band.status)"><i aria-hidden="true"></i>{{ band.status }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            Five reads for the day — activity, sleep, the heart-rate summary, the minute trace
            and the device list · {{ cacheNote }}<template v-if="budgetText"> · {{ budgetText }}</template>
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="fbk-week-head">
          <div class="hd">
            <h2 id="fbk-week-head">This week</h2>
            <span class="n">{{ week.filter((entry) => entry.goalMet).length }} goal met</span>
          </div>
          <div v-if="weekEmpty" class="dsh-none">
            No day this week has been read yet — the strip fills in as days are read,
            and reading one costs no second request.
          </div>
          <ul v-else class="fbk-week">
            <li v-for="entry in week" :key="entry.date" :title="`${weekShort(entry.date)} · ${num(entry.steps)} steps${entry.goalMet ? ' · goal met' : ''}`">
              <span class="st" :data-tone="entry.goalMet ? 'ok' : null"><i aria-hidden="true"></i>{{ weekday(entry.date) }}</span>
            </li>
          </ul>
          <dl class="cxn-facts">
            <dt>steps</dt>
            <dd>{{ num(fitbit.counts?.steps) }} of {{ num(fitbit.goals?.steps) }}</dd>
            <dt>distance</dt>
            <dd>{{ km(fitbit.counts?.distanceKm) }} of {{ km(fitbit.goals?.distanceKm) }}</dd>
            <dt>active</dt>
            <dd>{{ num(fitbit.counts?.activeMinutes) }} of {{ num(fitbit.goals?.activeMinutes) }} min</dd>
          </dl>
        </section>

        <section class="dsh-card" aria-labelledby="fbk-heart-head">
          <div class="hd">
            <h2 id="fbk-heart-head">Resting heart rate</h2>
            <span class="n">{{ fitbit.noHeartrate ? 'not granted' : '' }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>this day</dt>
            <dd>{{ num(fitbit.counts?.restingHr) }}{{ fitbit.counts?.restingHr === null ? '' : ' bpm' }}</dd>
            <dt>this week</dt>
            <dd>
              {{ fitbit.hrRange ? `${num(fitbit.hrRange.low)}–${num(fitbit.hrRange.high)} bpm · ${fitbit.hrRange.days} days` : 'not enough readings' }}
            </dd>
            <dt>sleep score</dt>
            <dd>{{ num(fitbit.counts?.sleep?.score) }}</dd>
          </dl>
          <p class="dsh-foot">
            <template v-if="fitbit.noHeartrate">
              The heart-rate scope was not granted for this account, so Fitbit answered
              <code class="mono">403</code> for the two heart reads and every rate here is unknown —
              not zero.
            </template>
            <template v-else>
              The week’s range is the days already read, not a second set of calls.
            </template>
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="fbk-dev-head">
          <div class="hd">
            <h2 id="fbk-dev-head">Devices</h2>
            <span class="n">{{ num(fitbit.counts?.devices?.count) }}</span>
          </div>
          <ul v-if="fitbit.deviceList?.length" class="dsh-repos">
            <li v-for="device in fitbit.deviceList" :key="device.name">
              <span class="nm">{{ device.name }}</span>
              <span class="pv">{{ device.type || 'device' }}</span>
              <span class="when">{{ device.lastSyncTime ? ago(device.lastSyncTime) : 'never synced' }}</span>
            </li>
          </ul>
          <div v-else class="dsh-none">No device has synced to this account.</div>
          <p class="dsh-foot">
            Read at most once an hour and cached, so a new day costs five calls and an
            old one costs none. <a href="https://www.fitbit.com/settings/devices" target="_blank" rel="noreferrer noopener">Device settings on Fitbit ↗</a>
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
