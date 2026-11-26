<script setup>
import { computed, onMounted, ref } from 'vue'
import { ago } from '@/stores/hub'
import { cacheNote as cacheNoteOf, cachedUntil, ttlWords } from '@/connectors/parts/readClock'
import { readStamp } from '@/connectors/parts/readStamp'
import { googleCalendar, readAccounts, readDashboard } from '@/connectors/google-calendar/useCalendar'

/**
 * The Google Calendar connector's Dashboard tab: six counts and one seven-day
 * agenda, read from the Google grant this machine already holds.
 *
 * Three things it deliberately is not. It is not a week grid — the question is
 * "what is next, and do I have room", and a grid answers a different one. It is not
 * a sign-in surface — the accounts card on Overview owns that, and a token form
 * here would be a second place for a token to live. And it never writes: the
 * `calendar.readonly` scope it asks for cannot create, move or cancel an event, so
 * there is no verb to offer.
 *
 * `0` and `—` are different words here. `0` means a read succeeded and found
 * nothing; `—` means the grant cannot answer, and the tile's query line names the
 * scope that would. The main process hands over `null` for the second case, so the
 * distinction survives the wire rather than being re-guessed in the template.
 */
const picked = ref('')

const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '')
  ? nFmt.format(Number(value))
  : '—'

/* ── the calendars, which are the chips ────────────────────────────
   One chip per calendar across every account that answered, keyed by name: two
   accounts sharing "Product" is one calendar to a person, and two chips with the
   same label would filter to different halves. */
const lanes = computed(() => googleCalendar.lanes || {})
/* A chip's number is what pressing it shows, so it counts the deduped rows that
   carry that calendar — not the calendar's own raw event list, which double-counts
   a meeting that was on two calendars. */
const calendars = computed(() => {
  const rows = Array.isArray(googleCalendar.events) ? googleCalendar.events : []
  const seen = new Map()
  for (const lane of Object.values(lanes.value)) {
    for (const calendar of lane?.calendars || []) {
      if (seen.has(calendar.name)) continue
      seen.set(calendar.name, {
        name: calendar.name,
        readOnly: calendar.readOnly === true,
        events: rows.filter((row) =>
          Array.isArray(row.calendars) ? row.calendars.includes(calendar.name) : row.calendar === calendar.name,
        ).length,
        participant: calendar.participant || '',
        email: lane.email || '',
      })
    }
  }
  return [...seen.values()]
})
/* A chip that no longer exists (a calendar unticked between reads) must not keep
   filtering the table down to nothing. */
const active = computed(() => calendars.value.some((entry) => entry.name === picked.value))

const events = computed(() => {
  const rows = Array.isArray(googleCalendar.events) ? googleCalendar.events : []
  if (!active.value) return rows
  /* A meeting that sat on two calendars is one row that answers to both chips. */
  return rows.filter((row) =>
    Array.isArray(row.calendars) ? row.calendars.includes(picked.value) : row.calendar === picked.value,
  )
})

/* ── the window and the stamp ──────────────────────────────────── */
const FALLBACK_DAYS = 7
const fallback = (() => {
  const since = new Date()
  const until = new Date(since.getTime() + FALLBACK_DAYS * 86_400_000)
  return { days: FALLBACK_DAYS, since: since.toISOString(), until: until.toISOString() }
})()
const span = computed(() => (googleCalendar.window?.since ? googleCalendar.window : fallback))
const dayText = (iso, year) => {
  const date = new Date(iso)
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
/* The read envelope in `parts/readClock.js`: the cache window comes from the main
   process rather than the copy, because a "10 min" typed into the template is the
   same class of lie as a hardcoded rate limit. This page prints the cache note with
   its own grammar (`cached 1 hour`), which `style: 'bare'` keeps. */
const ttlText = computed(() => ttlWords(googleCalendar.cacheTtlMs))
const cacheNote = computed(() =>
  cacheNoteOf({ cached: googleCalendar.cached, ttlMs: googleCalendar.cacheTtlMs, style: 'bare' }),
)
const stamp = computed(() => readStamp({ readAt: googleCalendar.readAt, loading: googleCalendar.loading }))

/* ── the six numbers ──────────────────────────────────────────────
   A tile whose read could not answer prints `—` with the scope that would fix it,
   never a zero dressed up as an answer. */
const blind = computed(() => googleCalendar.scopeMissing || googleCalendar.apiOff)
const dayLink = (kind) => {
  const at = new Date(span.value.since)
  const stamp2 = Number.isFinite(at.getTime())
    ? `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`
    : ''
  return `https://calendar.google.com/calendar/r/${kind}/${stamp2}`
}

const kpis = computed(() => {
  const tiles = googleCalendar.tiles || {}
  const next = tiles.nextIn && typeof tiles.nextIn === 'object' ? tiles.nextIn : null
  const count = calendars.value.length
  const q = (text) => (blind.value ? 'needs calendar.readonly' : text)
  const items = [
    {
      key: 'today',
      k: 'Today',
      value: tiles.today,
      q: q(`timeMin 00:00 · ${count || 0} ${count === 1 ? 'calendar' : 'calendars'}`),
      href: dayLink('day'),
      title: 'The events that have not ended today · opens day view',
    },
    {
      key: 'week',
      k: 'This week',
      value: tiles.week,
      q: q(`timeMax +${span.value.days}d`),
      href: dayLink('week'),
      title: 'Every event in the next seven days · opens week view',
    },
    {
      key: 'hours',
      k: 'Meeting hours',
      value: tiles.hours,
      q: q('sum(end − start) · accepted'),
      href: dayLink('week'),
      title: 'Accepted events only; tentative is not booked time · opens week view',
    },
    {
      key: 'nextIn',
      k: 'Next in',
      value: next ? next.minutes : null,
      q: blind.value ? 'needs calendar.readonly' : next ? `min · ${next.title}` : 'nothing scheduled',
      href: next ? eventUrl() : dayLink('day'),
      title: 'Minutes until the next event starts · opens the next event',
    },
    {
      key: 'needsReply',
      k: 'Needs reply',
      value: tiles.needsReply,
      q: q('responseStatus=needsAction'),
      href: dayLink('week'),
      title: 'Invitations this account has not answered · opens the week',
    },
    {
      key: 'overlaps',
      k: 'Overlaps',
      value: tiles.overlaps,
      q: q('freebusy · same hour'),
      href: dayLink('week'),
      /* The tile's title names the collision when there is one, because `2` alone
         does not say which two rows wear the marker. */
      title: googleCalendar.wait?.overlapDay
        ? `Two events share an hour on ${dayLabel(googleCalendar.wait.overlapDay)} · opens the week`
        : 'Events that share an hour with another · opens the week',
    },
  ]
  return items
})

/* The next event's own page when the read carried a link, the day view otherwise.
   The tile must be a link either way (spec §9). */
function eventUrl() {
  const rows = Array.isArray(googleCalendar.events) ? googleCalendar.events : []
  const next = rows.find((row) => row.url && new Date(row.start).getTime() >= Date.now())
  return next?.url || dayLink('day')
}

/* ── the agenda, grouped by day ──────────────────────────────────
   The day group is a `tr.dayrow` rather than a second table: the head stays one
   sticky row, and a screen reader reads "Today · Tue 25 Nov 3" before the events. */
const dayLabel = (key) => {
  const date = new Date(`${key}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return key
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const named = date.toDateString() === today.toDateString()
    ? 'Today'
    : date.toDateString() === tomorrow.toDateString()
      ? 'Tomorrow'
      : ''
  const stamp2 = date.toLocaleDateString('en-gb', { weekday: 'short', day: 'numeric', month: 'short' })
  return named ? `${named} · ${stamp2}` : stamp2
}
const groups = computed(() => {
  const byDay = new Map()
  for (const event of events.value) {
    const key = String(event.day || '')
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(event)
  }
  return [...byDay.entries()].map(([key, rows]) => ({ key, label: dayLabel(key), rows }))
})
const clockOf = (iso) => {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })
    : '—'
}
const whenText = (event) =>
  (event.allDay ? 'All day' : `${clockOf(event.start)}–${clockOf(event.end)}`)

/* The primary calendar is named after its own address, so `avery@example.test ·
   @avery` says one thing twice. The participant is only worth printing when it
   names somebody other than the calendar. */
const calWho = (event) =>
  event.participant && event.calendar !== event.participant && event.calendar !== event.account
    ? event.participant
    : ''
const calLine = (event) => {
  const who = calWho(event)
  return `${event.calendar}${who ? ` · @${who}` : ''}${event.account ? ` · ${event.account}` : ''}`
}

const calendarUrl = computed(() => dayLink('week'))

/* ── free this week ───────────────────────────────────────────────
   Gaps of 30 minutes or more between 08:00 and 19:00, over the union of every busy
   block — so a calendar shared with the person still fills the day. */
const lengthSpan = (from, to) => {
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} h ${rest}` : `${hours} h`
}
/* The rail is 306 px wide and shares its line with a duration, so it takes the short
   date the sheet prints there — `Today`, `Thu 27` — while the agenda's day row keeps
   the month (`Today · Tue 25 Nov`). Two labels, two widths. */
const railDay = (key) => {
  const date = new Date(`${key}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return key
  const named = dayLabel(key).split(' · ')[0]
  if (named === 'Today' || named === 'Tomorrow') return named
  return date.toLocaleDateString('en-gb', { weekday: 'short', day: 'numeric' })
}

const gapRows = computed(() =>
  (Array.isArray(googleCalendar.gaps) ? googleCalendar.gaps : []).map((gap) => ({
    day: railDay(gap.day),
    time: `${clockOf(gap.from)}–${clockOf(gap.to)}`,
    length: lengthSpan(gap.from, gap.to),
  })),
)
/* A capped list says so. `6 gaps` over a week that holds 23 is a claim the rail
   cannot support; `6 of 23` is the same number with its ceiling named. */
const gaps = computed(() => gapRows.value.slice(0, 6))
const gapsHead = computed(() => {
  const total = gapRows.value.length
  const word = total === 1 ? 'gap' : 'gaps'
  return total > gaps.value.length ? `${gaps.value.length} of ${total}` : `${total} ${word}`
})

/* ── the calendars rail ───────────────────────────────────────────
   The foot counts the whole window, not what a chip is filtering: `2 events in the
   window` must not drop to `1` because one calendar is selected — the chip changes
   the table, never the week. */
const calendarHint = computed(() => {
  const rows = [...new Set(Object.values(lanes.value).map((lane) => lane?.email).filter(Boolean))]
  const total = calendars.value.length
  const week = googleCalendar.tiles?.week
  const count = Number.isFinite(Number(week)) ? nFmt.format(Number(week)) : String(events.value.length)
  /* Two addresses joined by a comma read as a list the sentence below then calls a
     subject: `A, B share 0 events` is wrong, `A and B share` is not. */
  const who = rows.length > 2
    ? `${rows.slice(0, -1).join(', ')} and ${rows[rows.length - 1]}`
    : rows.join(' and ')
  return {
    who: who || '—',
    text: `${total} ${total === 1 ? 'calendar' : 'calendars'} readable, ${count} ${
      count === '1' ? 'event' : 'events'
    } in the window.`,
  }
})

/* ── what needs the person ───────────────────────────────────────
   One strip, and it is always there once a read has settled: the sheet's empty
   state prints it too, as the page's first sentence rather than a zero-for-zero
   banner. `warn` when there is something to act on, `quiet` when the answer is
   "nothing" — and never `quiet` while the grant cannot answer, because "nothing
   overlaps" would be a claim the data does not support (§5). */
const wait = computed(() => {
  if (googleCalendar.loading || !googleCalendar.readAt) return null
  if (blind.value) return null
  const row = googleCalendar.wait
  const needsReply = Number(row?.needsReply || 0)
  const overlaps = Number(row?.overlaps || 0)
  /* The next event's minutes come from the tile, not from the strip's copy: the
     strip is `null` whenever nothing needs an answer, and a week with three events
     and no invitation is not "nothing is scheduled". */
  const next = googleCalendar.tiles?.nextIn
  const nextMinutes = Number.isFinite(Number(next?.minutes)) ? Number(next.minutes) : null
  return {
    tone: needsReply || overlaps ? 'warn' : 'quiet',
    needsReply,
    overlaps,
    overlapDay: row?.overlapDay ? dayLabel(row.overlapDay) : '',
    nextMinutes,
  }
})

/* ── what went wrong ──────────────────────────────────────────────
   A refused token is quoted, never paraphrased: Google's own sentence is the one a
   person can search for. The rate limit has its own banner below, because it is not
   a refusal — the numbers on screen are real, they are just old. */
const failures = computed(() =>
  (Array.isArray(googleCalendar.errors) ? googleCalendar.errors : []).filter(Boolean),
)
const refusedAccounts = computed(() => {
  const limited = String(googleCalendar.limited?.account || '')
  return (Array.isArray(googleCalendar.refused) ? googleCalendar.refused : [])
    .filter((account) => account && account !== limited)
    .map((account) => {
      const lane = lanes.value[account] || {}
      const row = failures.value.find((entry) => entry.account === account)
      return {
        account,
        email: lane.email || `@${account}`,
        calendars: Array.isArray(lane.calendars) ? lane.calendars.length : 0,
        message: row?.message || '',
      }
    })
})
/* The refused account keeps a chip, dashed and labelled `unreadable`: the calendars'
   names are exactly what the refused read did not return, so the chip names the
   account instead of inventing one. It is not counted in `All calendars` — a chip
   nobody can press must not be added to a number that gates a click. */
const unreadable = computed(() =>
  refusedAccounts.value.map((entry) => ({ account: entry.account })),
)
const apiOff = computed(() => googleCalendar.apiOff === true)

/* The agenda's count: `18`, or `7 of 18` once a calendar chip filters the table, so
   the number in the head always says what it is counting. */
const shown = computed(() => {
  if (googleCalendar.loading) return '—'
  const week = googleCalendar.tiles?.week
  if (active.value && Number.isFinite(Number(week))) return `${events.value.length} of ${num(week)}`
  return String(events.value.length)
})

/* The head word is the sheet's own vocabulary: `ok`, `spent`, and `—` for the state
   in between. Google publishes no Calendar quota figure, so `ok` here would be a
   claim about a number nobody asked for — the foot says why it is `—`. */
const quotaWord = computed(() => {
  const quota = googleCalendar.quota
  if (!quota || quota.state === 'unknown') return '—'
  return quota.state === 'limited' ? 'spent' : 'ok'
})
/* What one page read costs, in the same parts Google bills it in: one calendar
   list and one free/busy pass per account, then a page per calendar. Counted from
   the answer rather than written into the copy — the number moves with the
   accounts and the calendars ticked, and a foot that kept saying "6" over a
   four-calendar read would be the kind of sentence that drifts. */
const cost = computed(() => {
  const rows = Object.values(lanes.value)
  if (!rows.length) return null
  const lists = rows.length
  const pages = rows.reduce((n, lane) => n + (lane?.calendars?.length || 0), 0)
  return { lists, pages, total: lists + lists + pages }
})

/* ── the week's shape ────────────────────────────────────────────
   One source per number: `totals` is computed in the main process off the same event
   list the table draws, so a column's minutes and `This week` cannot disagree. When
   the grant cannot answer, `totals` is `null` and every figure here prints `—` — a
   week shape of zeroes would be a claim nobody read. */
const totals = computed(() => googleCalendar.totals || null)
const duration = (minutes) => {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return '0 min'
  const hours = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  if (!hours) return `${rest} min`
  return rest ? `${hours} h ${rest}` : `${hours} h`
}

/* The four figures One's page opens with, in Entity's own tile grammar: a value, and
   the hint that says what it was counted from. */
const shapeKpis = computed(() => {
  const row = totals.value
  const q = (text) => (blind.value || !row ? 'needs calendar.readonly' : text)
  const value = (read) => (row ? read(row) : null)
  return [
    {
      key: 'busy',
      k: 'Busy hours',
      value: value((t) => duration(t.busyMinutes)),
      q: row ? `${num(row.events)} events · ${num(row.emptyDays)} empty days` : q(''),
    },
    {
      key: 'share',
      k: 'Meeting share',
      value: value((t) => `${Math.round(t.meetingShare * 100)}%`),
      q: row ? `${duration(row.meetingMinutes)} of meeting time` : q(''),
    },
    {
      key: 'focus',
      k: 'Longest focus block',
      value: value((t) => (t.longestFocusMinutes ? duration(t.longestFocusMinutes) : 'none')),
      q: row
        ? `${num(row.backToBack)} back-to-back · ${num(row.overlapPairs)} overlaps`
        : q(''),
    },
    {
      key: 'bounds',
      k: 'Outside the window',
      value: value((t) => t.outOfHoursEvents),
      q: row
        ? `${row.outOfHoursEvents === 1 ? 'event' : 'events'} · ${num(row.weekendMinutes)} weekend min`
        : q(''),
    },
  ]
})

/* The kind budget: only the kinds with minutes in them, because a row that says `0`
   is a row about nothing. */
const budget = computed(() =>
  (Array.isArray(googleCalendar.kinds) ? googleCalendar.kinds : []).filter((kind) => kind.minutes > 0),
)
/* Every row One's readings card carries, rendered here verbatim: the sentence and its
   tone are written once, in the main process, from the same totals the tiles print. */
const readings = computed(() =>
  (Array.isArray(googleCalendar.readings) ? googleCalendar.readings : []).filter((row) => row?.label),
)
const TONES = { good: 'ok', watch: 'warn', risk: 'bad' }

/* ── the week grid ─────────────────────────────────────────────
   One column per day of the window, all-day events in their own strip above the
   timed rows, and a day with nothing says so rather than leaving an empty box. The
   column's `busyMinutes` is a union of intervals, so two overlapping meetings count
   once — the same arithmetic the Busy hours tile uses.

   The rows are every calendar, not the chip's: the chip filters the list below, and
   a grid whose header counted the whole week over a filtered set of rows would be
   two claims in one box. `days` and the events here come from the same read. */
const dayColumns = computed(() =>
  (Array.isArray(googleCalendar.days) ? googleCalendar.days : []).map((day) => {
    const rows = (Array.isArray(googleCalendar.events) ? googleCalendar.events : []).filter(
      (event) => event.day === day.date,
    )
    return {
      ...day,
      label: dayLabel(day.date).split(' · ').slice(-1)[0] || day.date,
      allDay: rows.filter((event) => event.allDay),
      timed: rows.filter((event) => !event.allDay),
    }
  }),
)
/* The calendar's own colour per row is not part of this read, so the kind is the
   signal — a word in the title and a tinted edge, never colour alone (§8). */
const kindLabel = (kind) => ({ meeting: 'meeting', focus: 'focus', personal: 'personal' })[kind] || 'other'

onMounted(() => {
  /* The tab is drawn only after the gate said yes, but the composable is shared:
     a deep link straight here resolves the roster first, and this makes the read
     idempotent when it does. */
  if (!googleCalendar.loaded) readAccounts().catch(() => {})
  if (!googleCalendar.readAt) readDashboard().catch(() => {})
})
</script>

<template>
  <div class="dsh-band">
    <!-- The account that was refused, named, with Google's own words in mono. Never
         a sign-in form: the card on Overview is where a grant is replaced, and the
         numbers above stay — a refused lane is counted as missing, not as zero. -->
    <div v-if="refusedAccounts.length" class="dsh-err" role="alert">
      <b>
        Google refused the read for {{ refusedAccounts.map((entry) => entry.email).join(' and ') }}.
      </b>
      <p v-for="entry in refusedAccounts" :key="`er${entry.account}`">
        <template v-if="entry.calendars">
          That account's {{ entry.calendars }} {{ entry.calendars === 1 ? 'calendar is' : 'calendars are' }} missing from every number above — counted as missing, not guessed.
        </template>
        <template v-else>That account's calendars are missing from every number above.</template>
        <code v-if="entry.message" class="mono">{{ entry.message }}</code>
      </p>
      <p>Entity quotes Google's own message; it cannot refresh a token Google has revoked. Replacing the grant is the accounts card's job, on Overview.</p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="googleCalendar.reading" @click="readDashboard({ force: true })">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          Try again
        </button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-chips" role="group" aria-label="Which calendars to read">
        <button
          type="button"
          class="dsh-chip"
          :aria-pressed="!active"
          @click="picked = ''"
        >All calendars <span class="n">{{ googleCalendar.loading ? '—' : calendars.length }}</span></button>
        <button
          v-for="calendar in calendars"
          :key="calendar.name"
          type="button"
          class="dsh-chip"
          :aria-pressed="active && picked === calendar.name"
          :title="calendar.readOnly ? `${calendar.name} — read-only, cannot be filtered by attendee` : calendar.name"
          @click="picked = picked === calendar.name ? '' : calendar.name"
        ><i class="dot" :data-on="calendar.readOnly ? '0' : '1'" aria-hidden="true"></i>{{ calendar.name }}</button>
        <button
          v-for="entry in unreadable"
          :key="`un${entry.account}`"
          type="button"
          class="dsh-chip"
          aria-disabled="true"
          aria-pressed="false"
          title="Google refused this account's read, so its calendars cannot be listed"
        ><i class="dot" aria-hidden="true"></i>@{{ entry.account }} <span class="n">unreadable</span></button>
      </div>
      <div class="dsh-when">
        <span>{{ spanText }}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="googleCalendar.reading" @click="readDashboard({ force: true })">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ googleCalendar.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Rate limited: the last good numbers stay on screen with their stamp, because
         a spinner over a week that was already read is a worse answer than an old
         one labelled old. -->
    <div v-if="googleCalendar.limited" class="dsh-wait" data-tone="bad" role="alert">
      <span class="k">Quota</span>
      <p>
        Google stopped answering · {{ googleCalendar.limited.message || 'the rate limit is spent' }} ·
        these numbers were read at <b>{{ clockOf(googleCalendar.readAt) }}</b> and have not moved since.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="googleCalendar.reading" @click="readDashboard({ force: true })">
        Try again
      </button>
    </div>

    <!-- Six tiles, each a link to the Calendar view it counts: a number nobody can
         check is a number nobody believes. -->
    <div class="dsh-kpis" role="list" :aria-busy="googleCalendar.loading ? 'true' : 'false'">
      <a
        v-for="kpi in kpis"
        :key="kpi.key"
        class="dsh-kpi"
        role="listitem"
        :href="kpi.href"
        target="_blank"
        rel="noreferrer noopener"
        :title="kpi.title"
      >
        <span class="k">{{ kpi.k }}</span>
        <span v-if="googleCalendar.loading" class="dsh-skel" style="width: 40%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ num(kpi.value) }}</b>
        <span class="q">{{ kpi.q }}</span>
      </a>
    </div>

    <!-- The week's shape, in One's four figures: busy time, how much of it was
         meetings, the longest solo block, and how much fell outside the work window.
         Same tile grammar as the six above, so the band reads as one row of facts. -->
    <div class="dsh-kpis dsh-shape" role="list" :aria-busy="googleCalendar.loading ? 'true' : 'false'">
      <div v-for="kpi in shapeKpis" :key="kpi.key" class="dsh-kpi" role="listitem">
        <span class="k">{{ kpi.k }}</span>
        <span v-if="googleCalendar.loading" class="dsh-skel" style="width: 40%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ kpi.value === null ? '—' : kpi.value }}</b>
        <span class="q" :title="kpi.q">{{ kpi.q }}</span>
      </div>
    </div>

    <p v-if="active" class="dsh-scope">
      The four figures above, the minutes by kind, the grid and the readings in the rail
      cover every calendar this grant reads. Only the list under the grid follows the
      calendar chip.
    </p>

    <!-- The kind budget, One's chips: what the street of events above was made of.
         Only the kinds with minutes in them, because a chip that says `0 min` is a
         chip about nothing. -->
    <div v-if="budget.length" class="dsh-kinds" role="list" aria-label="Minutes by kind of event">
      <span v-for="kind in budget" :key="kind.id" class="dsh-kind" role="listitem" :data-kind="kind.id">
        {{ kind.label }} · {{ duration(kind.minutes) }} · {{ Math.round(kind.share * 100) }}%
      </span>
    </div>

    <div v-if="apiOff" class="dsh-wait" data-tone="bad" role="alert">
      <span class="k">API off</span>
      <p>
        The Calendar API is not enabled on Entity's OAuth client, so nothing can be read.
        Enable it in the Google Cloud project, then press Refresh.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="googleCalendar.reading" @click="readDashboard({ force: true })">
        Try again
      </button>
    </div>

    <!-- What needs the person, in the order they can act on it. The anchor jumps to
         the list in this page rather than to Google, because the answer is a reply. -->
    <div v-if="wait" class="dsh-wait" :data-tone="wait.tone">
      <span class="k">Waiting on you</span>
      <p>
        <template v-if="wait.tone === 'quiet'">
          No invitations are waiting and nothing overlaps in these {{ span.days }} days{{ wait.nextMinutes !== null ? '' : ', and nothing is scheduled' }}.
        </template>
        <template v-else>
          <b>{{ num(wait.needsReply) }}</b> {{ wait.needsReply === 1 ? 'invitation needs' : 'invitations need' }} a reply
          <template v-if="wait.overlaps">
            · <b>{{ num(wait.overlaps) }}</b> {{ wait.overlaps === 1 ? 'event overlaps' : 'events overlap' }}
            <template v-if="wait.overlapDay">on {{ wait.overlapDay }}</template>
          </template>
          <template v-if="wait.nextMinutes !== null">
            · the next event starts in <b>{{ num(wait.nextMinutes) }} {{ wait.nextMinutes === 1 ? 'minute' : 'minutes' }}</b>
          </template>
        </template>
      </p>
      <span class="spacer"></span>
      <a class="dsh-jump" href="#agenda-head">Jump to the list ↓</a>
    </div>

    <!-- The week grid, One's `Monday to Sunday` card: one column per day of the
         window, all-day events in their own strip above the timed rows, and a
         day with nothing saying so. Every title is the event's own `htmlLink`;
         the organiser and the attendee count are on the row, never hover-only. -->
    <section class="dsh-card dsh-weekcard" aria-labelledby="week-head">
      <div class="hd">
        <h3 id="week-head">Day by day</h3>
        <span class="n">{{ googleCalendar.loading ? '—' : `${dayColumns.length} days` }}</span>
        <span class="spacer"></span>
        <span class="hd-when">busy time · union of intervals</span>
      </div>
      <div v-if="googleCalendar.loading" class="dsh-week">
        <div v-for="n in 7" :key="`wsk${n}`" class="dsh-daycol">
          <span class="dsh-skel" style="width: 60%; height: 9px"></span>
          <span class="dsh-skel" style="width: 100%; height: 34px; margin-top: 8px"></span>
        </div>
      </div>
      <div v-else-if="!dayColumns.length" class="dsh-week-empty">
        <b>{{ blind ? 'This grant cannot read events, so the week has no shape.' : 'Nothing read yet.' }}</b>
        <span>{{ blind ? 'Busy blocks are visible; what fills them is not.' : 'A read draws one column per day of the window.' }}</span>
      </div>
      <div v-else class="dsh-week" :style="{ '--dcols': dayColumns.length }">
        <div
          v-for="column in dayColumns"
          :key="column.date"
          class="dsh-daycol"
          :data-open="column.open ? '1' : null"
          :data-date="column.date"
        >
          <p class="dh">
            <b>{{ column.label }}</b>
            <span>{{ num(column.events) }} · {{ duration(column.busyMinutes) }}</span>
          </p>
          <p v-if="column.open" class="open">today, so far</p>
          <p v-else-if="column.partial" class="open">window closes mid-day</p>
          <ul v-if="column.allDay.length" class="allday">
            <li v-for="event in column.allDay" :key="`ad${event.id}-${event.start}`">
              <a v-if="event.url" :href="event.url" target="_blank" rel="noreferrer noopener" :title="event.title">{{ event.title }}</a>
              <span v-else class="none">{{ event.title }}</span>
            </li>
          </ul>
          <ul class="timed">
            <li v-for="event in column.timed" :key="`${event.id}-${event.start}`" :data-kind="event.kind">
              <span class="tm">
                {{ clockOf(event.start) }}–{{ clockOf(event.end) }}
                <em v-if="event.outOfHours">out</em>
                <em v-if="event.overlap" class="ov">overlaps</em>
              </span>
              <a v-if="event.url" :href="event.url" target="_blank" rel="noreferrer noopener" :title="event.title">{{ event.title }}</a>
              <span v-else class="none" :title="event.title">{{ event.title }}</span>
              <span class="meta">
                {{ kindLabel(event.kind) }}<template v-if="event.people > 0"> · {{ event.people }} {{ event.people === 1 ? 'attendee' : 'attendees' }}</template>
                <!-- The organiser only when it is somebody other than the reader:
                     `you` is the default, and a column of `you organised` is a
                     column of nothing. Never hover-only — it is on the row. -->
                <template v-if="event.organiser && event.organiser !== event.account"> · by {{ event.organiser }}</template>
              </span>
            </li>
            <li v-if="!column.timed.length && !column.allDay.length" class="dsh-none">Nothing scheduled</li>
          </ul>
        </div>
      </div>
      <p class="dsh-foot">
        Busy time is the union of intervals, so two meetings that overlap count once.
        Today's column is still filling, and the last one stops where the window does.
      </p>
    </section>

    <div class="dsh">
      <div class="dsh-main">
        <section class="dsh-card dsh-tblcard" aria-labelledby="agenda-head">
          <div class="hd">
            <h3 id="agenda-head">Next seven days</h3>
            <span class="n">{{ shown }}</span>
            <span class="spacer"></span>
            <span class="hd-when">sorted by start</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="agenda-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">When</th>
                  <th scope="col">Where</th>
                  <th scope="col">Response</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="googleCalendar.loading">
                  <tr v-for="n in 4" :key="`sk${n}`" class="skrow">
                    <td>
                      <div class="dsh-ev">
                        <span class="dsh-skel" style="width: 62px; height: 7px"></span>
                        <span class="dsh-skel" style="width: 210px; height: 9px; margin-top: 3px"></span>
                      </div>
                    </td>
                    <td class="when" data-l="when"><span class="dsh-skel" style="width: 66px; height: 9px"></span></td>
                    <td class="where" data-l="where"><span class="dsh-skel" style="width: 54px; height: 9px"></span></td>
                    <td class="stc"><span class="dsh-skel" style="width: 58px; height: 11px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!events.length" class="emptyrow">
                  <td colspan="4">
                    <template v-if="blind">
                      <b>{{ apiOff ? 'The Calendar API is not enabled.' : 'This grant returns busy blocks, not events.' }}</b>
                      <span>
                        {{ apiOff
                          ? 'Entity cannot see anything in the window until the API is switched on for this OAuth client.'
                          : 'Entity can see that 11:00 is taken; it cannot see what takes it.' }}
                      </span>
                      <a href="https://calendar.google.com" target="_blank" rel="noreferrer noopener">Ask for calendar.readonly ↗</a>
                    </template>
                    <template v-else>
                      <b>Nothing in the next seven days.</b>
                      <span>
                        {{ calendarHint.who }} share 0 events between
                        {{ dayText(span.since, false) }} and {{ dayText(span.until, true) }}.
                      </span>
                      <a :href="calendarUrl" target="_blank" rel="noreferrer noopener">Open Google Calendar ↗</a>
                    </template>
                  </td>
                </tr>
                <template v-else>
                  <template v-for="group in groups" :key="group.key">
                    <tr class="dayrow">
                      <td colspan="4"><b>{{ group.label }}</b> <span class="n">{{ group.rows.length }}</span></td>
                    </tr>
                    <tr v-for="event in group.rows" :key="`${event.id}-${event.start}`">
                      <td>
                        <div class="dsh-ev">
                          <span class="cal" :title="calLine(event)"><b>{{ event.calendar }}</b><template v-if="calWho(event)"> · @{{ calWho(event) }}</template></span>
                          <a v-if="event.url" :href="event.url" target="_blank" rel="noreferrer noopener" :title="event.title">{{ event.title }}</a>
                          <span v-else class="none" :title="event.title">{{ event.title }}</span>
                          <!-- Who called it and how many answered: a meeting with no
                               organiser or attendee named on the row was hover-only
                               information, which is not information. -->
                          <span v-if="event.organiser || event.people" class="who" :title="event.attendees?.map((who) => `${who.name} · ${who.status || 'no reply asked'}`).join(' · ') || ''">
                            <template v-if="event.organiser">{{ event.organiser === event.account ? 'you' : event.organiser }}</template>
                            <template v-if="event.people"> · {{ event.people }} {{ event.people === 1 ? 'attendee' : 'attendees' }}</template>
                          </span>
                        </div>
                      </td>
                      <td class="when" data-l="when">
                        {{ whenText(event) }}<em v-if="event.length">{{ event.length }}</em><em v-if="event.overlap" class="ov">overlaps</em>
                      </td>
                      <td class="where" data-l="where">
                        <a v-if="event.whereUrl" :href="event.whereUrl" target="_blank" rel="noreferrer noopener">{{ event.where }}</a>
                        <template v-else-if="event.where">{{ event.where }}</template>
                        <span v-else class="none">—</span>
                      </td>
                      <td class="stc">
                        <span class="st" :data-tone="event.tone || null"><i aria-hidden="true"></i>{{ event.response }}</span>
                      </td>
                    </tr>
                  </template>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            Read with <code class="mono">GET /calendar/v3/calendars/{{ '{id}' }}/events</code> · {{ cacheNote }} ·
            <a :href="calendarUrl" target="_blank" rel="noreferrer noopener">open the week in Google Calendar ↗</a>
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <!-- One's deterministic readings, verbatim: each is a label, a value and the
             sentence that ties it to a number above. Written in the main process off
             the same totals the tiles print, so the two cannot disagree. -->
        <section v-if="readings.length" class="dsh-card" aria-labelledby="readings-head">
          <div class="hd">
            <h3 id="readings-head">How this week looks</h3>
            <span class="n">{{ readings.length }}</span>
          </div>
          <ul class="dsh-readings">
            <li v-for="reading in readings" :key="reading.id" :data-tone="TONES[reading.tone] || null">
              <span class="rl">{{ reading.label }}<b>{{ reading.value }}</b></span>
              <p>{{ reading.hint }}</p>
            </li>
          </ul>
          <p class="dsh-foot">
            Written here from the same totals the tiles print — no model, no placeholder.{{ active ? ' These cover every calendar, not the chip above.' : '' }}
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="free-head">
          <div class="hd">
            <h3 id="free-head">Free this week</h3>
            <span class="n">{{ googleCalendar.loading ? '—' : gapsHead }}</span>
          </div>
          <ul class="dsh-repos">
            <template v-if="googleCalendar.loading">
              <li v-for="n in 4" :key="`fsk${n}`">
                <span class="dsh-skel" style="width: 62%; height: 9px"></span>
              </li>
            </template>
            <template v-else>
              <li v-for="gap in gaps" :key="`${gap.day}-${gap.time}`">
                <span class="nm">{{ gap.day }} <em>· {{ gap.time }}</em></span>
                <span class="when">{{ gap.length }}</span>
              </li>
              <li v-if="!gaps.length" class="quiet">
                <span class="nm">Nothing booked — every hour between 08:00 and 19:00 is free.</span>
              </li>
            </template>
          </ul>
          <p class="dsh-foot">Gaps of 30 minutes or more, 08:00–19:00, across the calendars selected.</p>
        </section>

        <section class="dsh-card" aria-labelledby="calendars-head">
          <div class="hd">
            <h3 id="calendars-head">Calendars</h3>
            <span class="n">{{ googleCalendar.loading ? '—' : calendars.length }}</span>
          </div>
          <ul class="dsh-repos">
            <template v-if="googleCalendar.loading">
              <li v-for="n in 3" :key="`csk${n}`">
                <span class="dsh-skel" style="width: 58%; height: 9px"></span>
              </li>
            </template>
            <template v-else>
              <li v-for="(calendar, index) in calendars" :key="calendar.name" :title="calendar.participant ? `${calendar.name} · @${calendar.participant}` : calendar.name">
                <span class="dot-c" :style="{ background: index === 0 ? 'var(--accent)' : index === 1 ? 'var(--ink-2)' : 'var(--border-strong)' }"></span>
                <!-- The primary calendar is named after its own address, so printing
                     the owner beside it is the same string twice. -->
                <span class="nm">{{ calendar.name }}<em v-if="calendar.participant && calendar.name !== calendar.email && calendar.name !== calendar.participant"> · @{{ calendar.participant }}</em></span>
                <span v-if="calendar.readOnly" class="ro">read-only</span>
                <span class="when">{{ calendar.events }}</span>
              </li>
              <li v-if="!calendars.length" class="dsh-none">No calendar is ticked in Google Calendar.</li>
            </template>
          </ul>
          <p class="dsh-foot"><b>{{ calendarHint.who }}</b> · {{ calendarHint.text }}</p>
        </section>

        <section class="dsh-card" aria-labelledby="quota-head">
          <div class="hd">
            <h3 id="quota-head">API quota</h3>
            <span class="n">{{ quotaWord }}</span>
          </div>
          <dl class="cxn-facts tight">
            <dt>today</dt>
            <dd>—</dd>
            <dt>per minute</dt>
            <dd>—</dd>
            <dt>read</dt>
            <dd>{{ googleCalendar.readAt ? ago(googleCalendar.readAt) : '—' }}</dd>
          </dl>
          <div
            class="dsh-meter"
            :data-tone="googleCalendar.limited ? 'bad' : null"
            role="img"
            :aria-label="googleCalendar.limited ? 'Daily quota: spent' : 'Daily quota: not reported by Google'"
          ><i :style="{ width: googleCalendar.limited ? '100%' : '0%' }"></i></div>
          <p class="dsh-foot">
            <template v-if="cost">One page read costs <b>{{ cost.total }}</b> requests:
              {{ cost.lists }} {{ cost.lists === 1 ? 'free/busy pass' : 'free/busy passes' }},
              {{ cost.lists }} calendar {{ cost.lists === 1 ? 'list' : 'lists' }},
              {{ cost.pages }} event {{ cost.pages === 1 ? 'page' : 'pages' }}.</template>
            <template v-else>Google reports no quota figure until a 403 spends it.</template>
            <!-- a cached open spends nothing, which is why this read is often `0` -->
            This read cost
            <b>{{ googleCalendar.reads || 0 }}</b>
            {{ googleCalendar.reads === 1 ? 'request' : 'requests' }} · {{ cacheNote }}.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
