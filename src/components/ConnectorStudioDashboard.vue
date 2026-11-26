<script setup>
import { computed, onMounted } from 'vue'
import { ago } from '@/stores/hub'
import { heroColorFor } from '@/composables/entityMark'
import {
  pick as pickStudio,
  readDashboard,
  readRoster,
  studio,
  studioChannels,
} from '@/composables/youtubeStudioDashboard'

/**
 * The YouTube Studio connector's Dashboard tab: what one channel did over a
 * window that ends where Analytics ends.
 *
 * The subject is a **channel**, not an account, so the first chip row is channels
 * (`@localpart · title`) and the second is the window. Both are answered from a
 * roster read the page already ran, so a chip costs no request; only Refresh and
 * a changed chip reach Google.
 *
 * **Two different `—`.** A metric the grant cannot read is `null` and prints a
 * dash with the scope that would fill it, because a `0` there would claim the
 * window was empty. A zero that *is* zero prints `0`, and the empty window has its
 * own sentence. `scopes` reports what the grant can do; `calls` reports what Google
 * said. A refused scope is therefore a dash plus a banner, never a "no permission"
 * guess about a grant that has the permission and a failing call.
 *
 * Nothing here signs anything in. The account card owns consent — this tab links
 * to it, because a second consent surface would be a second place a token lives.
 */
const emit = defineEmits(['overview'])

/* The chart and the traffic bars are the only coloured furniture on the page, and
   the colour is the connector's own hero mark rather than a hue picked here. */
const hero = heroColorFor('youtube-studio')

const payload = computed(() => studio.payload)
const totals = computed(() => payload.value?.totals || null)
const previous = computed(() => payload.value?.previous || null)
const windowInfo = computed(() => payload.value?.window || null)
const channel = computed(() => payload.value?.channel || null)
const scopes = computed(() => payload.value?.scopes || null)
const quota = computed(() => payload.value?.quota || null)
/* Google counts again at a fixed wall time in a zone the reader may not live in,
   so the sentence names both clocks. The offset is measured from the two clocks
   at the moment of the read rather than assumed — daylight saving is a fact about
   the machine, not about this page. */
const quotaReset = computed(() => {
  if (!quota.value) return null
  const at = new Date()
  const minutesIn = (zone) => {
    const parts = new Intl.DateTimeFormat('en-gb', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value) || 0
    return pick('hour') * 60 + pick('minute')
  }
  const local = minutesIn(Intl.DateTimeFormat().resolvedOptions().timeZone)
  /* Midnight Pacific is the moment the Pacific clock rolls over, wherever the
     reader is sitting: local midnight minus the distance between the two. */
  const shift = (1440 + local - minutesIn('America/Los_Angeles')) % 1440
  if (shift < 60) return null
  const hh = String(Math.floor(shift / 60)).padStart(2, '0')
  const mm = String(shift % 60).padStart(2, '0')
  return `${hh}:${mm} your time`
})
const failed = computed(() => (payload.value?.calls || []).filter((entry) => !entry.ok))
/* A lost permission is a fact of the grant; a failed call is a fact of the read.
   The banner quotes Google's own sentence when there is one. */
const analyticsRefusal = computed(
  () =>
    failed.value[0]?.why || 'yt-analytics.readonly is not in this grant, so Analytics refuses',
)

const nFmt = new Intl.NumberFormat('en-gb')
/* Two decimals, grouped like every other number on the page: `$1842.60` next to
   `412,806` reads as a second dialect. Only the fraction digits differ from
   `nFmt`, so the grouping rule is the same one, not a second opinion. */
const moneyFmt = new Intl.NumberFormat('en-gb', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
/* `null` is "the grant cannot read it" and must never reach `Number()` — that
   returns `0`, which is the one value this page is careful not to invent. */
const N = (value) => {
  if (value === null || value === undefined || value === '') return Number.NaN
  return Number(value)
}
const num = (value) => (Number.isFinite(N(value)) ? nFmt.format(N(value)) : null)
const hours = (minutes) => (Number.isFinite(N(minutes)) ? `${nFmt.format(Math.round(N(minutes) / 60))} h` : null)
/* Revenue carries Google's own number and the `$` the connector already prints
   (`youtube-studio.cjs` hardcodes it too): matching that is honest, while a
   currency this page inferred from the channel would be an invention with a
   decimal point on it. */
const money = (value) => (Number.isFinite(N(value)) ? `$${moneyFmt.format(N(value))}` : null)
const signed = (value) => {
  const n = N(value)
  if (!Number.isFinite(n)) return null
  return `${n < 0 ? '-' : '+'}${nFmt.format(Math.abs(n))}`
}
/* `m:ss`, for an average view duration — never a decimal of a minute. */
const mmss = (value) => {
  const n = N(value)
  if (!Number.isFinite(n)) return null
  const seconds = Math.round(n)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
/* `+12.4%` against the previous window. A percentage against zero is not a
   movement, so two empty windows report nothing rather than `no change` — the
   second empty window is the interesting fact, and `0%` would bury it. */
function change(now, then) {
  const current = N(now)
  const prior = N(then)
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null
  if (!prior) return current ? '+100%' : null
  const ratio = ((current - prior) / prior) * 100
  return `${ratio > 0 ? '+' : ''}${ratio.toFixed(1)}%`
}
const dayText = (iso, year) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
  })
}

/* ── the chips ─────────────────────────────────────────────────────── */
const channels = computed(() => studioChannels())
/* The lead channel is the first one of *its own* account: the chip says which
   channel a grant leads with, so a second account's channel is not decorated with
   the first account's `main`. */
const leadIds = computed(
  () => new Set(studio.accounts.map((account) => account.channels?.[0]?.id).filter(Boolean)),
)
const chosen = computed(() => studio.picked.channel || '')
const days = computed(() => Number(studio.picked.days) || 28)
const WINDOWS = [7, 28, 90]

async function chooseChannel(entry) {
  if (chosen.value === entry.id) return
  pickStudio({ account: entry.account, channel: entry.id })
  await readDashboard()
}
async function chooseDays(span) {
  if (days.value === span) return
  pickStudio({ days: span })
  await readDashboard()
}
function refresh() {
  readDashboard({ force: true })
}

/* ── the six counts ────────────────────────────────────────────────── */
const kpis = computed(() => {
  const t = totals.value
  const p = previous.value
  const span = windowInfo.value?.days || days.value
  const noAnalytics = scopes.value?.analytics === false
  const noRevenue = noAnalytics || scopes.value?.revenue === false
  const views = N(t?.views)
  const answered = payload.value !== null && !noAnalytics
  const per100 =
    answered && Number.isFinite(views) && views > 0 && Number.isFinite(N(t?.likes))
      ? `${((N(t.likes) / views) * 100).toFixed(1)} per 100 views`
      : null
  const avg = N(t?.avgViewSeconds) > 0 ? mmss(t.avgViewSeconds) : null
  const subscribers = num(channel.value?.subscribers)
  const adRevenue = N(t?.adRevenue) > 0 ? money(t.adRevenue) : null
  const viewsDelta = change(t?.views, p?.views)
  const watchDelta = change(t?.minutes, p?.minutes)
  return [
    {
      key: 'views',
      k: 'Views',
      value: num(t?.views) ?? '—',
      delta: viewsDelta,
      note: viewsDelta ? `vs prev ${span} d` : null,
      unread: noAnalytics ? 'no analytics scope' : null,
      title: noAnalytics
        ? 'views — needs yt-analytics.readonly'
        : answered && views === 0
          ? 'views · 0 in this window'
          : 'views · reports.query metrics=views',
    },
    {
      key: 'watch',
      k: 'Watch time',
      value: hours(t?.minutes) ?? '—',
      delta: watchDelta,
      note: avg ? `avg ${avg} per view` : watchDelta ? `vs prev ${span} d` : null,
      unread: noAnalytics ? 'no analytics scope' : null,
      title: noAnalytics
        ? 'estimatedMinutesWatched — needs analytics'
        : `estimatedMinutesWatched · averageViewDuration ${Number.isFinite(N(t?.avgViewSeconds)) ? Math.round(N(t.avgViewSeconds)) : '—'} s${Number.isFinite(N(t?.avgViewPercent)) ? `, ${Math.round(N(t.avgViewPercent))}% of the video` : ''}`,
    },
    {
      key: 'subs',
      k: 'Net subscribers',
      value: signed(t?.net) ?? '—',
      delta: change(t?.net, p?.net),
      note:
        Number.isFinite(N(t?.gained)) && Number.isFinite(N(t?.lost))
          ? `${num(t.gained)} gained · ${num(t.lost)} lost`
          : null,
      unread: noAnalytics ? 'no analytics scope' : null,
      title: noAnalytics
        ? 'subscribersGained − subscribersLost — needs analytics'
        : `subscribersGained − subscribersLost · channel has ${subscribers || '—'}`,
    },
    {
      key: 'likes',
      k: 'Likes',
      value: num(t?.likes) ?? '—',
      delta: change(t?.likes, p?.likes),
      note: per100,
      unread: noAnalytics ? 'no analytics scope' : null,
      title: noAnalytics ? 'likes — needs analytics' : 'likes · reports.query metrics=likes',
    },
    {
      key: 'comments',
      k: 'Comments',
      value: num(t?.comments) ?? '—',
      delta: change(t?.comments, p?.comments),
      note: N(payload.value?.unreplied) > 0 ? `${num(payload.value.unreplied)} with no reply` : null,
      unread: noAnalytics ? 'no analytics scope' : null,
      title: noAnalytics ? 'comments — needs analytics' : 'comments · reports.query metrics=comments',
    },
    {
      key: 'revenue',
      k: 'Estimated revenue',
      value: money(t?.revenue) ?? '—',
      delta: change(t?.revenue, p?.revenue),
      note: adRevenue ? `ads ${adRevenue}` : null,
      unread: noRevenue ? 'no revenue scope' : null,
      title: noRevenue
        ? 'estimatedRevenue — needs monetary scope'
        : N(t?.revenue) === 0
          ? 'estimatedRevenue · no monetised views'
          : 'estimatedRevenue · printed in the connector\'s own dollars, never converted',
    },
  ]
})

/* The band's note is the page's most important sentence: the window is not
   today's, and a reader who thinks it is will read the last two days as a
   collapse rather than as a settlement lag. */
const windowNote = computed(() => {
  const w = windowInfo.value
  if (!w?.end) return null
  return {
    end: dayText(w.end, true),
    span: `${w.days} days · ${dayText(w.start)} – ${dayText(w.end)}`,
    before: `${dayText(w.prevStart)} – ${dayText(w.prevEnd)}`,
  }
})
const waiting = computed(() => {
  const unreplied = N(payload.value?.unreplied)
  const rows = payload.value?.videos || []
  const unlisted = rows.filter((video) => video.privacy === 'unlisted').length
  if (!(unreplied > 0) && !unlisted) return null
  const oldest = (payload.value?.comments || []).reduce(
    (most, entry) => Math.max(most, Number(entry.waitingDays) || 0),
    0,
  )
  return {
    unreplied: Number.isFinite(unreplied) ? unreplied : null,
    unlisted,
    oldest,
    oldestText: oldest ? `${oldest} ${oldest === 1 ? 'day' : 'days'}` : null,
  }
})

/* ── the chart ─────────────────────────────────────────────────────── */
const W = 640
const BASE = 116
const TOP = 8
const chart = computed(() => {
  const rows = payload.value?.series
  if (!Array.isArray(rows) || !rows.length) return null
  const views = rows.map((row) => N(row.views) || 0)
  const peak = Math.max(...views)
  const step = views.length > 1 ? W / (views.length - 1) : W
  const at = views.map((value, index) => {
    const x = Number((index * step).toFixed(1))
    const y = peak > 0 ? Number((BASE - (value / peak) * (BASE - TOP)).toFixed(1)) : BASE
    return [x, y]
  })
  const line = at.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
  /* The area closes down to the strip below the baseline, so a flat line still
     fills its band instead of drawing a hairline nobody can see. */
  const area = `M0,120 ${line.replace(/^M/, 'L')} L${W},120 Z`
  const index = views.indexOf(peak)
  return {
    line,
    area,
    peak,
    peakDay: rows[index]?.day || '',
    dot: peak > 0 ? { x: at[index][0], y: at[index][1] } : null,
    empty: peak === 0,
  }
})
const chartLabel = computed(() => {
  const w = windowInfo.value
  if (!w?.start) return 'Views per day.'
  const span = `${dayText(w.start)} to ${dayText(w.end, true)}`
  if (!chart.value) return `Views per day, ${span}. This grant cannot read Analytics.`
  if (chart.value.empty) return `Views per day, ${span}. No views recorded in this window.`
  return `Views per day, ${span}. Highest day ${num(chart.value.peak)} views on ${dayText(chart.value.peakDay)}.`
})
/* No series is not an empty series: one is a scope to grant, the other is a quiet
   month, and the two sentences are not interchangeable. */
const chartNote = computed(() => {
  if (payload.value && scopes.value?.analytics === false) {
    return 'This grant has no analytics scope, so there is no daily series to draw.'
  }
  if (chart.value?.empty) {
    return 'No views recorded in this window. Analytics settles two days late, so the last two days are always empty.'
  }
  return ''
})

/* ── the tables ────────────────────────────────────────────────────── */
const videos = computed(() => payload.value?.videos || [])
const lifetime = computed(() => payload.value?.lifetime === true)
const videoCount = computed(() => num(payload.value?.videoCount))
const commentsReadable = computed(() => payload.value !== null && scopes.value?.comments !== false)
const comments = computed(() => payload.value?.comments || [])
const oldestWait = computed(() =>
  comments.value.reduce((most, entry) => Math.max(most, Number(entry.waitingDays) || 0), 0),
)
const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(String(id))}`
const studioUrl = computed(() => channel.value?.url || 'https://studio.youtube.com')

/* ── the rail ──────────────────────────────────────────────────────── */
const traffic = computed(() => payload.value?.traffic || null)
const calls = computed(() => payload.value?.calls || [])
const totalMs = computed(() => calls.value.reduce((sum, entry) => sum + (Number(entry.ms) || 0), 0))
/* `reports.query ×5` rather than five identical rows: the count is the fact, the
   name is the call. */
const callSummary = computed(() => {
  const counts = new Map()
  for (const entry of calls.value) {
    const name = String(entry.call || '').split(' · ')[0]
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
})
const quotaUnits = computed(() => Number(payload.value?.quotaUnits) || 0)
const quotaWidth = computed(() => `${Math.min(100, Math.max(0.4, (quotaUnits.value / 10_000) * 100))}%`)
/* How long a stored answer stays good, in the words the panel prints. Read from
   the answer itself: a hardcoded "15 min" that outlived the constant was how a
   cache came to look shorter than it is. */
const ttlText = computed(() => {
  const ms = Number(studio.cacheTtlMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const spans = ms / 3_600_000
  if (spans >= 24 && Number.isInteger(spans / 24)) {
    return spans / 24 === 1 ? '1 day' : `${spans / 24} days`
  }
  const whole = Math.max(1, Math.round(spans))
  return whole === 1 ? '1 hour' : `${whole} hours`
})
const cacheNote = computed(() => {
  if (studio.cached) return ttlText.value ? `served from the ${ttlText.value} cache` : 'served from the stored cache'
  return ttlText.value ? `cached for ${ttlText.value}` : 'cached'
})
const stamp = computed(() => {
  if (studio.loading) return 'reading…'
  if (!studio.readAt) return 'not read yet'
  const read = `read ${ago(studio.readAt)}`
  return quota.value ? `${read} · held until the quota resets` : `${read} · ${cacheNote.value}`
})
const spanText = computed(() => {
  const w = windowInfo.value
  if (!w?.start) return `${days.value} days`
  return `${w.days} days · ${dayText(w.start)} – ${dayText(w.end, true)}`
})

/* The roster knows which account broke; the numbers belong to the one that
   answers. Naming the broken one is the whole point of the banner. */
const broken = computed(() => studio.accounts.filter((entry) => entry.error))
const pickedAccount = computed(
  () => studio.accounts.find((entry) => entry.localpart === studio.picked.account) || null,
)

onMounted(async () => {
  /* Cheap and idempotent: the page has usually read both already, and a read in
     flight is not restarted. */
  if (!studio.loaded) await readRoster()
  if (!studio.readAt && !studio.error) await readDashboard()
})
</script>

<template>
  <div class="dsh-band" :style="{ '--hero': hero }">
    <!-- A spent quota is a clock, not a failure: the numbers on screen are real
         and stale, and the sentence that says so is the only useful thing on the
         page. They are never replaced with a spinner. -->
    <div v-if="quota" class="dsh-wait" data-tone="bad">
      <span class="k">Quota</span>
      <p>
        The Analytics quota for <b>{{ channel?.handle || channel?.title || 'this channel' }}</b> is
        exhausted. These numbers were read <b>{{ ago(quota.readAt || studio.readAt) }}</b> and will
        not move until <b>00:00 Pacific</b>{{ quotaReset ? ` (${quotaReset})` : '' }}, when Google
        counts again.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="studio.reading" @click="refresh">
        Try again
      </button>
    </div>

    <!-- One account's token was rejected while another still answers: the tab
         keeps its numbers and this banner names which row broke. It never becomes
         a sign-in form — the account card is where a consent lives. -->
    <div v-if="broken.length" class="dsh-err" role="alert">
      <b>The grant for {{ broken[0].email || broken[0].localpart }} is not answering.</b>
      <p>
        <code class="mono">{{ broken[0].error }}</code>
        {{ studio.accounts.length > broken.length ? 'Another account still answers, so this tab keeps the numbers it has.' : 'Nothing on this machine can read the channel until it is signed in again.' }}
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm btn-primary" type="button" @click="emit('overview')">
          Sign in again
        </button>
        <a
          class="btn btn-sm"
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer noopener"
        >Review the grant</a>
      </div>
    </div>

    <!-- The tab is not locked here: the Data API lists videos, so the page shows
         the half the grant can read and a dash where a number would be. Locking it
         would hide the videos somebody came for. Two red banners would be a wall,
         so the broken grant speaks first: it is the one that explains the other. -->
    <div v-if="payload && !broken.length && scopes?.analytics === false" class="dsh-err" role="alert">
      <b>This grant can list videos, not measure them.</b>
      <p>
        <code class="mono">{{ analyticsRefusal }}</code>
        Entity prints the videos it can read and a dash where a number would be —
        never <code class="mono">0</code>, which would claim the window was empty.
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm btn-primary" type="button" @click="emit('overview')">
          Re-consent with analytics
        </button>
        <a
          class="btn btn-sm"
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer noopener"
        >Open the account</a>
      </div>
    </div>

    <!-- Read failed and there is nothing to show: Google's sentence, verbatim, and
         the one control that tries again. -->
    <div v-if="studio.error && !payload" class="dsh-err" role="alert">
      <b>The channel could not be read.</b>
      <p><code class="mono">{{ studio.error }}</code> Entity reads the consent this machine holds; it cannot repair a token it never sees.</p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="studio.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          Try again
        </button>
        <button class="btn btn-sm btn-ghost" type="button" @click="emit('overview')">
          Open the account
        </button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which channel and window to read">
        <button
          v-for="entry in channels"
          :key="entry.id"
          type="button"
          class="dsh-chip"
          :aria-pressed="chosen === entry.id"
          :title="`${entry.email} · ${entry.title}`"
          @click="chooseChannel(entry)"
        ><i class="dot" :data-on="chosen === entry.id ? '1' : '0'" aria-hidden="true"></i>@{{ entry.account }} · {{ entry.title }}
          <span v-if="leadIds.has(entry.id)" class="n">main</span>
        </button>
        <span class="dsh-sep" aria-hidden="true"></span>
        <button
          v-for="span in WINDOWS"
          :key="`w${span}`"
          type="button"
          class="dsh-chip"
          :aria-pressed="days === span"
          @click="chooseDays(span)"
        >{{ span }} d</button>
      </div>
      <div class="dsh-when">
        <span>{{ spanText }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="studio.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ studio.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- The skeleton keeps the settled grid's boxes, so nothing jumps when the
         numbers land. -->
    <div class="dsh-kpis" role="list" :aria-busy="studio.loading ? 'true' : 'false'">
      <a
        v-for="kpi in kpis"
        :key="kpi.key"
        class="dsh-kpi"
        role="listitem"
        :href="`${studioUrl}/analytics`"
        target="_blank"
        rel="noreferrer noopener"
        :data-unread="kpi.unread ? '1' : null"
        :title="kpi.title"
      >
        <span class="k">{{ kpi.k }}</span>
        <span v-if="studio.loading" class="dsh-skel" style="width: 46%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ kpi.value }}</b>
        <span v-if="!studio.loading" class="d">
          <template v-if="kpi.unread"><b>{{ kpi.unread }}</b></template>
          <template v-else-if="kpi.delta"><b>{{ kpi.delta }}</b><template v-if="kpi.note"> <em>{{ kpi.note }}</em></template></template>
          <template v-else-if="kpi.note"><em>{{ kpi.note }}</em></template>
          <template v-else><em>&nbsp;</em></template>
        </span>
      </a>
    </div>

    <p v-if="windowNote && !chart?.empty" class="dsh-note">
      The window ends <b>{{ windowNote.end }}</b>, not today: the Analytics API settles two
      days late and a partial day reads as a collapse.
      <code class="mono">{{ windowNote.span }}</code>, change measured against
      <span class="mono">{{ windowNote.before }}</span>.
    </p>

    <div v-if="waiting" class="dsh-wait" data-tone="warn">
      <span class="k">Waiting on you</span>
      <p>
        <template v-if="waiting.unreplied">
          <b>{{ num(waiting.unreplied) }}</b>
          {{ waiting.unreplied === 1 ? 'comment has' : 'comments have' }} no reply
          <template v-if="waiting.oldestText">· oldest <b>{{ waiting.oldestText }}</b></template>
        </template>
        <template v-if="waiting.unreplied && waiting.unlisted"> · </template>
        <!-- Bounded to the rows this page actually read: a count taken from the
             top ten is a count of the top ten, and calling it the channel's
             would be the same invention as a `0` for a metric nobody read. -->
        <template v-if="waiting.unlisted">
          <b>{{ waiting.unlisted }}</b> of the videos below
          {{ waiting.unlisted === 1 ? 'is' : 'are' }} unlisted and still earning views
        </template>
      </p>
      <span class="spacer"></span>
      <a class="dsh-jump" :href="`${studioUrl}/comments`" target="_blank" rel="noreferrer noopener">Reply in Studio ↗</a>
    </div>

    <!-- A failed read with nothing behind it: the grid would spend the whole page
         saying "nothing was published" about a window nobody managed to read. The
         banner above already carries Google's sentence, so one line says the rest. -->
    <p v-if="studio.error && !payload" class="dsh-none">No numbers to show.</p>
    <div v-else class="dsh">
      <div class="dsh-main">
        <section class="dsh-card" aria-labelledby="dsh-chart-head">
          <div class="hd">
            <h3 id="dsh-chart-head">Views, day by day</h3>
            <span class="n">{{ days }} days</span>
            <span class="spacer"></span>
            <span class="hd-when">reports.query · dimension date</span>
          </div>
          <p v-if="chartNote" class="dsh-note dsh-note-in">{{ chartNote }}</p>
          <!-- One `<svg>` rather than a chart library: the series is one line and
               the axis is three labels, and a canvas would need a resize observer
               to say what these four elements already say at any width. -->
          <svg
            v-if="chart"
            class="yt-chart"
            viewBox="0 0 640 120"
            role="img"
            :aria-label="chartLabel"
          >
            <line class="grid" x1="0" y1="116" x2="640" y2="116" />
            <path class="area" :d="chart.area" />
            <path class="line" :d="chart.line" />
            <circle v-if="chart.dot" class="dot" :cx="chart.dot.x" :cy="chart.dot.y" r="2.6" />
          </svg>
          <div v-else-if="studio.loading" class="dsh-skel" style="width: 100%; height: 120px"></div>
          <!-- Nothing read and nothing being read: the banner above already says
               why, so the card states the absence instead of drawing an empty
               chart that would read as a flat month. -->
          <p v-else-if="!chartNote" class="dsh-none">
            {{ payload ? 'No daily series came back for this window.' : 'Nothing has been read yet.' }}
          </p>
          <div v-if="windowInfo?.start" class="yt-axis">
            <span>{{ dayText(windowInfo.start) }}</span>
            <span class="pk">
              {{ chart?.empty ? 'nothing recorded' : chart ? `peak ${num(chart.peak)} · ${dayText(chart.peakDay)}` : 'not readable' }}
            </span>
            <span>{{ dayText(windowInfo.end, true) }}</span>
          </div>
        </section>

        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-vid-head">
          <div class="hd">
            <h3 id="dsh-vid-head">Videos in this window</h3>
            <span class="n">
              {{ studio.loading ? '—' : lifetime ? num(videos.length) : `${videos.length} of ${num(payload?.channelVideos) ?? '—'}` }}
            </span>
            <span class="spacer"></span>
            <span class="hd-when">{{ lifetime ? 'lifetime counts' : 'sorted by views' }}</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="group" aria-labelledby="dsh-vid-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Video</th>
                  <th scope="col" class="num">Views</th>
                  <th scope="col" class="num">Watch</th>
                  <th scope="col" class="num">Comments</th>
                  <th scope="col" class="upd">Published</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="studio.loading">
                  <tr v-for="n in 4" :key="`vsk${n}`" class="skrow">
                    <td>
                      <span class="dsh-skel" style="width: 76%; height: 9px"></span>
                      <span class="dsh-skel" style="width: 96%; height: 12px; margin-top: 7px"></span>
                    </td>
                    <td class="num"><span class="dsh-skel" style="width: 42px; height: 9px"></span></td>
                    <td class="num"><span class="dsh-skel" style="width: 38px; height: 9px"></span></td>
                    <td class="num"><span class="dsh-skel" style="width: 24px; height: 9px"></span></td>
                    <td class="upd"><span class="dsh-skel" style="width: 34px; height: 9px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!videos.length" class="emptyrow">
                  <td colspan="5">
                    <template v-if="lifetime">
                      <b>Nothing to list.</b>
                      <span>This grant has no analytics scope and the uploads playlist answered empty, so there is no video to name.</span>
                    </template>
                    <template v-else>
                      <b>Nothing was published in these {{ days }} days.</b>
                      <span>The channel has {{ num(payload?.channelVideos) ?? 'an unknown number of' }} videos; none published or earning views between
                        {{ dayText(windowInfo?.start) }} and {{ dayText(windowInfo?.end, true) }}.</span>
                    </template>
                    <a :href="studioUrl" target="_blank" rel="noreferrer noopener">Open Studio ↗</a>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="video in videos" :key="video.id">
                    <td>
                      <div class="dsh-pr">
                        <span class="repo">{{ video.id }} · <span class="who">{{ video.privacy || 'unknown' }}</span></span>
                        <a :href="watchUrl(video.id)" :title="video.title">{{ video.title }}</a>
                      </div>
                    </td>
                    <td class="num" data-l="views">{{ num(video.views) ?? '—' }}</td>
                    <td class="num" data-l="watch">{{ hours(video.minutes) ?? '—' }}</td>
                    <td class="num" data-l="comments">{{ num(video.comments) ?? '—' }}</td>
                    <td class="upd" data-l="published">{{ dayText(video.published) }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            <template v-if="lifetime">
              No analytics scope, so these are lifetime counts from
              <code class="mono">playlistItems.list</code> and <code class="mono">videos.list</code> —
              not the window · <a :href="studioUrl" target="_blank" rel="noreferrer noopener">open in Studio ↗</a>
            </template>
            <template v-else>
              One <code class="mono">reports.query</code> per window, dimension <code class="mono">video</code>,
              top 10 · <b>{{ videoCount ?? '—' }}</b> videos published in the window ·
              <a :href="studioUrl" target="_blank" rel="noreferrer noopener">open in Studio ↗</a>
            </template>
          </p>
        </section>

        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-cmt-head">
          <div class="hd">
            <h3 id="dsh-cmt-head">Comments with no reply</h3>
            <span class="n">
              {{ studio.loading || !commentsReadable ? '' : `${num(payload?.unreplied) ?? '—'} waiting` }}
            </span>
            <span class="spacer"></span>
            <span class="hd-when">{{ commentsReadable && oldestWait ? `oldest ${oldestWait} d` : '' }}</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="group" aria-labelledby="dsh-cmt-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Comment</th>
                  <th scope="col">Video</th>
                  <th scope="col" class="upd">Waiting</th>
                </tr>
              </thead>
              <tbody>
                <!-- Loading wins over "cannot read": a first paint has no payload
                     yet, and painting the refusal while the request is in flight
                     would accuse a grant that is about to answer. -->
                <tr v-if="studio.loading">
                  <td><span class="dsh-skel" style="width: 88%; height: 12px"></span></td>
                  <td class="vd"><span class="dsh-skel" style="width: 70%; height: 9px"></span></td>
                  <td class="upd"><span class="dsh-skel" style="width: 22px; height: 9px"></span></td>
                </tr>
                <tr v-else-if="!commentsReadable" class="emptyrow">
                  <td colspan="3">
                    <b>This grant cannot read comments either.</b>
                    <span><code class="mono">commentThreads.list</code> needs <code class="mono">youtube.force-ssl</code>,
                      which the account never granted. 0 waiting here would be a claim it cannot make.</span>
                    <button class="dsh-linkbtn" type="button" @click="emit('overview')">Re-consent with comments ↗</button>
                  </td>
                </tr>
                <tr v-else-if="!comments.length" class="emptyrow">
                  <td colspan="3">
                    <b>Nothing is waiting for a reply.</b>
                    <span>Every comment on this channel already has an answer from the owner.</span>
                    <a :href="`${studioUrl}/comments`" target="_blank" rel="noreferrer noopener">Read the comment inbox ↗</a>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="entry in comments" :key="entry.id">
                    <td>
                      <div class="dsh-cmt">
                        <span class="who">@{{ entry.author || 'unknown' }}</span>
                        <a :href="`${studioUrl}/comments`" :title="entry.text">{{ entry.text }}</a>
                      </div>
                    </td>
                    <td class="vd" data-l="video">
                      <a :href="watchUrl(entry.videoId)" :title="entry.videoTitle">{{ entry.videoTitle }}</a>
                    </td>
                    <td class="upd" data-l="waiting">{{ entry.waitingDays === null ? '—' : `${entry.waitingDays} d` }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            <template v-if="commentsReadable">
              <code class="mono">commentThreads.list</code> · <code class="mono">allThreadsRelatedToChannelId</code>
              · newest 100 threads, kept those with <b>0 replies</b> ·
              <b>{{ num(payload?.unreplied) ?? '—' }} kept</b>,
              {{ num(comments.length) }} shown ·
              <a :href="`${studioUrl}/comments`" target="_blank" rel="noreferrer noopener">reply in Studio ↗</a>
            </template>
            <template v-else>
              <code class="mono">commentThreads.list</code> not called:
              <code class="mono">youtube.force-ssl</code> is not in this grant ·
              <button class="dsh-linkbtn" type="button" @click="emit('overview')">Re-consent with comments ↗</button>
            </template>
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="dsh-traffic-head">
          <div class="hd">
            <h3 id="dsh-traffic-head">Where the views came from</h3>
            <span class="n">{{ days }} days</span>
          </div>
          <ul v-if="traffic?.length" class="yt-bars">
            <li v-for="(row, index) in traffic" :key="row.name">
              <span class="nm" :title="row.name">{{ row.name }}</span>
              <span class="pc">{{ row.share }}%</span>
              <span class="bar"><i :data-dim="index === traffic.length - 1 ? '1' : '0'" :style="{ width: `${Math.max(2, row.share)}%` }"></i></span>
            </li>
          </ul>
          <p v-else-if="studio.loading" class="dsh-none">reading…</p>
          <!-- A share of zero views is not zero percent of nothing: there is no
               denominator, so the rail says so instead of printing `0%`. -->
          <p v-else class="dsh-none">
            {{ !payload ? 'Nothing has been read yet.' : scopes?.analytics === false ? 'No analytics scope, so traffic sources were not read.' : 'No views recorded in this window, so there is no share to report.' }}
          </p>
          <p class="dsh-foot">Dimension <code class="mono">insightTrafficSourceType</code>, share of views.</p>
        </section>

        <section class="dsh-card" aria-labelledby="dsh-read-head">
          <div class="hd">
            <h3 id="dsh-read-head">What this page read</h3>
            <span class="n">{{ calls.length ? `${calls.length} calls` : '—' }}</span>
          </div>
          <dl class="cxn-facts tight">
            <dt>calls</dt>
            <dd>{{ calls.length }} · {{ (totalMs / 1000).toFixed(1) }} s</dd>
            <dt>cache</dt>
            <dd>{{ ttlText ? `${ttlText}, Refresh forces` : 'Refresh forces' }}</dd>
            <dt>quota</dt>
            <dd>{{ num(quotaUnits) }} of 10,000 units</dd>
          </dl>
          <div
            class="dsh-meter"
            role="img"
            :aria-label="`Data API quota: ${quotaUnits} of 10,000 units used`"
          ><i :style="{ width: quotaWidth }"></i></div>
          <p class="dsh-foot">
            <span v-for="(name, index) in callSummary" :key="name">
              <code class="mono">{{ name }}</code>{{ index === callSummary.length - 1 ? '' : ' · ' }}
            </span>
            <template v-if="!callSummary.length">nothing read yet</template>.
            Analytics counts requests against its own daily budget; the Data API is
            the one metered at 10,000 units a day.
          </p>
          <!-- A call that failed is the one thing here a person can act on, so it
               is quoted rather than folded into a lower count. -->
          <p v-if="failed.length" class="dsh-foot">
            Refused: <code class="mono">{{ failed[0].call }}</code> —
            {{ failed[0].why || 'Google gave no reason' }}
          </p>
          <p v-if="pickedAccount" class="dsh-foot">
            Read as {{ pickedAccount.email }}.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
