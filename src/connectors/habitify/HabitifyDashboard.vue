<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { ago } from '@/stores/hub'
import { cacheNote as cacheNoteOf, cachedUntil, ttlWords } from '@/connectors/parts/readClock'
import { readStamp } from '@/connectors/parts/readStamp'
import { habitify, account } from '@/connectors/habitify/useHabitify'

/**
 * The Habitify connector's Dashboard tab: one day's schedule, and the week that day
 * sits in, read through the account this machine already signed in.
 *
 * Nothing here signs anything in and nothing here writes. The grant is a refresh
 * token in this machine's own store and the only tool behind it is
 * `list-habits-by-date`, so completing, skipping or logging a habit is not something
 * this tab can do — each row's status is a reading of what the provider already holds,
 * said in the tab's own four words (`done`, `rest day`, `not done`, `not done · ends a
 * streak`) rather than in the provider's field values.
 *
 * The six tiles count what the table below them lists, and each one carries its own
 * denominator: `1 of 2 scheduled` is a fact, `1` alone is a number somebody will read
 * as a rate. A tile whose number is unknown prints `—`, never `0` — a scope the grant
 * does not carry makes the count unknown, and `0` would be a claim.
 */
const props = defineProps({
  /** The civil day on screen, from the address. Empty means "whatever is today". */
  day: { type: String, default: '' },
})
const emit = defineEmits(['select-day'])

const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) => (Number.isFinite(Number(value)) && value !== null ? nFmt.format(Number(value)) : '—')

const entry = computed(() => account())
const tiles = computed(() => habitify.tiles)
const rows = computed(() => (Array.isArray(habitify.rows) ? habitify.rows : []))
const failures = computed(() => (Array.isArray(habitify.errors) ? habitify.errors : []))

/* ── the day strip ─────────────────────────────────────────────────
   Seven buttons for the week the day sits in, ending at today: a day that has not
   happened is not offered, because asking Habitify about tomorrow answers nothing
   and printing that as "0 scheduled" would be a claim about a day nobody has lived. */
const civil = (iso) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  return Number.isFinite(date.getTime()) ? date : null
}
const dayText = (iso) => {
  const date = civil(iso)
  if (!date) return '—'
  return date.toLocaleDateString('en-gb', { weekday: 'short', day: 'numeric', month: 'short' })
}
const shortDay = (iso) => {
  const date = civil(iso)
  if (!date) return '—'
  return date.toLocaleDateString('en-gb', { weekday: 'short' })
}
/* `23 Nov` — the week's own range, where the weekday is already in the column head. */
const shortDate = (iso) => {
  const date = civil(iso)
  if (!date) return '—'
  return date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short' })
}
const civilToday = () =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const today = civilToday()

/* ── when the day on screen ends ───────────────────────────────────
   Local midnight of the day being read, counted down in the same civil terms the
   rest of the sheet uses. A day is over once its midnight has passed, and then there
   is nothing to count: the span is dropped rather than printed as a negative. */
const dayEnds = computed(() => {
  const date = civil(habitify.day)
  if (!date) return ''
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  const left = midnight - Date.now()
  if (!(left > 0)) return ''
  const minutes = Math.floor(left / 60_000)
  if (minutes < 60) return `day ends in ${minutes} min`
  return `day ends in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
})

const weekDays = computed(() => {
  const start = habitify.week?.start
  const read = new Map((tiles.value?.days || []).map((day) => [day.day, day]))
  if (!start) return []
  const out = []
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(Date.parse(`${start}T12:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)
    if (date > today) break
    const answer = read.get(date) || null
    out.push({
      day: date,
      label: shortDay(date),
      scheduled: answer?.scheduled ?? null,
      completed: answer?.completed ?? null,
      state: answer?.state || 'past',
      /* The main process marks the one day that is today inside this week; the rail
         reuses it rather than keeping a second clock that could disagree. */
      open: answer?.open === true,
    })
  }
  return out
})
/* Days the read tried and failed on, as opposed to days after the one on screen
   that nobody asked about. Only the first kind belongs in a `partly read` banner. */
const failedDays = computed(() => (tiles.value?.days || []).filter((day) => day.state === 'error').length)
/* Whether that day is *unknown* rather than *empty* — the day on screen's own state,
   not the week's: a failed Tuesday under Thursday's table says nothing about
   Thursday. `tiles` null with an error row is the other unknown: the grant could not
   be used at all, so nobody knows what was scheduled. */
const dayState = computed(
  () => (tiles.value?.days || []).find((day) => day.day === habitify.day)?.state || '',
)
const unread = computed(
  () =>
    dayState.value === 'error' ||
    Boolean(habitify.error) ||
    (!tiles.value && failures.value.length > 0),
)
/* The alert is for a read that produced nothing usable. A week where one day failed
   still has tiles and rows, and the `partly read` strip below counts what it has —
   two banners for one failure would read as two problems. A call that never answered
   (`habitify.error`) is the same shape: nothing to count. */
const refused = computed(() => Boolean(habitify.error) || (!tiles.value && failures.value.length > 0))
const refusal = computed(() => failures.value[0]?.message || habitify.error || 'the store reported no reason')
/* The sentence for the day under the heading specifically — the banner quotes the
   first failure, which after a partly-read week may be a different day. */
const dayFailure = computed(() => failures.value.find((row) => row.day === habitify.day) || null)

/* ── nothing anywhere this week ──────────────────────────────────────
   Every day read, not one of them scheduled anything. That is a real answer — the
   account has no habits yet — but an empty table, six zeros and one day's sentence
   read as a broken read rather than an empty account, which is the report that
   sends someone looking for a bug in this page. `dayState === 'ok'` is what keeps
   this apart from `unread`: a week nobody could read is a failure, not emptiness,
   and the alert above already says so. The account is named because "whose habits
   are these?" is the question an empty report cannot otherwise answer. */
const nothingScheduled = computed(() => {
  const days = tiles.value?.days || []
  if (!days.length || habitify.loading) return false
  if (days.some((day) => day.state === 'error')) return false
  return days.every((day) => Number(day.scheduled) === 0)
})

/* ── the six tiles, in the order a person reads them ───────────────
   Done first (the day's answer), then what is left, then what is about to break,
   then the two that are about the week rather than a day. Every value comes from the
   same read as the table, so a tile and a row can never disagree. */
const kpis = computed(() => {
  const t = tiles.value
  return [
    {
      key: 'done',
      k: 'Done today',
      value: t ? t.done : null,
      q: t ? `of ${num(t.scheduled)} scheduled` : 'not read yet',
    },
    {
      key: 'open',
      k: 'Still open',
      value: t ? t.open : null,
      q: t ? 'scheduled, not logged' : 'not read yet',
    },
    {
      key: 'risk',
      k: 'Streaks at risk',
      value: t ? t.risk : null,
      q: t ? 'open with a streak running' : 'not read yet',
    },
    {
      key: 'best',
      k: 'Best streak',
      value: t ? t.best : null,
      q: t?.bestHabit ? `${num(t.best)} days · ${t.bestHabit}` : 'no streak reported',
    },
    {
      key: 'week',
      k: 'This week',
      value: t ? t.week : null,
      q: t ? `of ${num(t.weekScheduled)} scheduled` : 'not read yet',
    },
    {
      key: 'checkins',
      k: 'Check-ins',
      value: t ? t.checkins : null,
      q: t ? `days all done, of ${num(t.daysRead)} read` : 'not read yet',
    },
  ]
})

/* ── a row's state, in four words ───────────────────────────────────
   The provider's vocabulary is not this table's: `completed`, `skipped` and `failed`
   are its words, and printing them makes the reader learn a schema to find out what
   happened. Four words cover every state a habit can be in, and each one carries the
   state the row draws from — so a row cannot say `done` in one cell and keep the open
   state in its attribute. The provider's own word survives nowhere but here.

   `none` is the provider's `inprogress`: scheduled, nothing logged. It is not a
   failure and not a rest day, so it gets the plain `not done` — and when a streak is
   running, that sentence is the whole point of the tab, so it says the rest. */
const WORD = {
  completed: { word: 'done', tone: 'ok', state: 'done' },
  skipped: { word: 'rest day', tone: 'mute', state: 'skipped' },
  failed: { word: 'not done', tone: 'bad', state: 'open' },
}
const statusOf = (row) => {
  if (row.status === 'none') {
    return row.streak
      ? { word: 'not done · ends a streak', tone: 'warn', state: 'at-risk' }
      : { word: 'not done', tone: '', state: 'open' }
  }
  return WORD[row.status] || { word: 'not done', tone: '', state: 'open' }
}
const streakOf = (row) =>
  row.streak === null || row.streak === undefined ? '—' : `${num(row.streak)} ${row.streak === 1 ? 'day' : 'days'}`
/* The rows with their state resolved once each: the template draws the table's own
   word, the tone of its dot and the row's own `data-s` from one answer, so a row
   cannot say `done` in one cell and carry the open state in the attribute. */
const table = computed(() => rows.value.map((row) => ({ ...row, ...statusOf(row), streakText: streakOf(row) })))

/* ── what was read, and how long it stands ───────────────────────────
   The shared envelope in `parts/readClock.js`: the words follow `cacheTtlMs`, so a
   constant that changes cannot leave a stale "a day" in the copy. */
const ttlText = computed(() => ttlWords(habitify.cacheTtlMs))
const cacheUntil = computed(() => cachedUntil(habitify.readAt, habitify.cacheTtlMs))
const cacheNote = computed(() => cacheNoteOf({ cached: habitify.cached, ttlMs: habitify.cacheTtlMs }))
const stamp = computed(() =>
  readStamp({ readAt: habitify.readAt, loading: habitify.loading, ttlMs: habitify.cacheTtlMs }),
)
const heading = computed(() => (habitify.day ? dayText(habitify.day) : 'Today'))
/* Whether the day on screen is the one still running. "Before midnight" only tells the
   truth about today; any other day's open habits were left open and stay that way. */
const isToday = computed(() => !habitify.day || habitify.day === today)
/* Where the schedule resumes, when the day on screen is empty and the read could
   look ahead for it. `null` covers both "there is no next day" and "nobody could
   check" — the row then says nothing rather than promising a day it cannot name. */
const next = computed(() => habitify.next || null)
/* The name of the day the schedule resumes on, for the button that goes there:
   `Friday`, not `Fri 27 Nov`, because the sentence above it already spelled the date
   out and a button repeating it reads like a second fact. */
const nextDay = computed(() => {
  const day = civil(next.value?.day)
  return day ? day.toLocaleDateString('en-gb', { weekday: 'long' }) : ''
})

/* ── picking a day outside this week ───────────────────────────────
   The seven chips cover the running week; a native date input covers everything
   else, so no calendar is built and no dependency is added. It opens as a popover
   and closes on a pick, on Escape, or on a click anywhere else. */
const picking = ref(false)
const picker = ref(null)
const pickOpen = () => {
  picking.value = !picking.value
}
const pickClose = () => {
  picking.value = false
}
function pickDate(event) {
  const value = String(event.target.value || '')
  pickClose()
  if (value) pickDay(value)
}
/* Escape goes through the one stack every surface shares, so the popover closes
   before anything it sits inside would. */
useDialogDismiss({ active: () => picking.value, close: () => pickClose() })
function onPickOutside(event) {
  if (picking.value && !picker.value?.contains(event.target)) pickClose()
}
onMounted(() => {
  /* `click`, not `pointerdown`: a pointerdown that lands on the pick button itself
     would close the popover before its own click could open it. */
  document.addEventListener('click', onPickOutside)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onPickOutside)
})

function refresh() {
  emit('select-day', { day: habitify.day || props.day, force: true })
}
function pickDay(day) {
  if (!day || day === habitify.day) return
  emit('select-day', { day, force: false })
}

/* ── walking the weeks ───────────────────────────────────────────
   A read covers Monday..the day it was asked about, so asking about Sunday is asking
   for the whole week. `previous week` is therefore the Sunday before this one, `next
   week` the Sunday after — and the same event the chips fire, so the address stays the
   one thing that says which day is on screen and no route parameter is added. `This
   week` is today, which is the shape a bookmark should have. */
const shiftDay = (iso, delta) => {
  const at = Date.parse(`${String(iso)}T12:00:00Z`)
  return Number.isFinite(at) ? new Date(at + delta * 86_400_000).toISOString().slice(0, 10) : ''
}
const weekStart = computed(() => habitify.week?.start || '')
const weekEnd = computed(() => habitify.week?.end || '')
const weekPrev = computed(() => (weekStart.value ? shiftDay(weekStart.value, -1) : ''))
/* The Sunday of the next week, so one click reads the whole of it: a read covers
   Monday..the day it asked about. */
const weekNext = computed(() => (weekEnd.value ? shiftDay(weekEnd.value, 7) : ''))
/* A week that has not started cannot be read: Habitify has not scheduled it, and
   seven zeroes for it would be a claim rather than a reading. The week starts the
   day after this week's Sunday. */
const canNext = computed(() => Boolean(weekEnd.value) && shiftDay(weekEnd.value, 1) <= today)
const weekRange = computed(() =>
  weekStart.value && weekEnd.value ? `${shortDate(weekStart.value)} – ${shortDate(weekEnd.value)}` : '—',
)
/* Seven columns whether or not the read reached them: the grid's cells are the whole
   week, and a head that stopped at today would slide the words one column left. */
const weekColumns = computed(() =>
  weekStart.value
    ? Array.from({ length: 7 }, (_, index) => {
        const date = shiftDay(weekStart.value, index)
        return { day: date, label: shortDay(date), open: date === today }
      })
    : [],
)

/* ── the week figure band ────────────────────────────────────────
   The four numbers the One app leads with, in its own words. Each one is `null`
   rather than `0` when nobody could count it, so the band prints `—` and the reader
   knows the difference between a week nobody scheduled and a week nobody read. */
const weekFigures = computed(() => {
  const t = habitify.totals
  return [
    { key: 'habits', k: 'Habits tracked', value: t ? t.habits : null, q: t ? 'seen this week' : 'not read yet' },
    {
      key: 'rate',
      k: 'Week rate',
      value: t?.rate === null || t?.rate === undefined ? null : Math.round(t.rate * 100),
      suffix: t?.rate === null || t?.rate === undefined ? '' : '%',
      q: t ? `${num(t.completed)} of ${num(t.scheduledSlots)} scheduled` : 'not read yet',
    },
    {
      key: 'streak',
      k: 'Longest streak',
      value: t?.longestStreak ? t.longestStreak.days : null,
      q: t?.longestStreak ? `${num(t.longestStreak.days)} days · ${t.longestStreak.habit}` : 'no streak reported',
    },
    {
      key: 'perfect',
      k: 'Perfect days',
      value: t ? t.perfectDays : null,
      q: t ? 'every habit done that day' : 'not read yet',
    },
  ]
})

/* ── the habit × week grid ──────────────────────────────────────────────
   The provider's four words for a day, in this tab's words for them. A day that was
   not scheduled, or was never read, is a dash: the habit was not due, so there is
   nothing to have missed. A measurable habit that was not finished still says how far
   it got — `2/5 km` is the fact, and `not done` alone would hide it. */
const CELL = {
  completed: { word: 'done', tone: 'ok' },
  skipped: { word: 'rest day', tone: 'mute' },
  failed: { word: 'not done', tone: 'bad' },
  none: { word: 'not done', tone: null },
}
const amount = (progress) => {
  if (!progress) return ''
  const { value, target, unit } = progress
  if (value === null || target === null) return ''
  return `${num(value)}/${num(target)}${unit ? ` ${unit}` : ''}`
}
const cellOf = (habit, cell) => {
  const label = `${habit.name} · ${dayText(cell.date)}`
  /* Two different dashes: a day nobody read, and a day where nothing was due. Neither
     is a miss, and the label tells a screen reader which one it is. */
  if (!cell.read) return { label: `${label} · not read`, word: '—', tone: 'dash' }
  if (!cell.scheduled) return { label: `${label} · not scheduled`, word: '—', tone: 'dash' }
  const said = CELL[cell.status] || { word: 'not done', tone: null }
  const detail = cell.status === 'completed' ? '' : amount(cell.progress)
  const streak =
    cell.status === 'none' && habit.streak ? `ends a ${num(habit.streak)} day streak` : ''
  return {
    label: `${label} · ${said.word}${detail ? ` ${detail}` : ''}${streak ? ` · ${streak}` : ''}`,
    word: said.word,
    detail,
    tone: said.tone,
  }
}
const grid = computed(() =>
  (Array.isArray(habitify.habits) ? habitify.habits : []).map((habit) => ({
    ...habit,
    cells: (habit.cells || []).map((cell) => cellOf(habit, cell)),
    rateText: habit.rate === null || habit.rate === undefined ? '—' : `${Math.round(habit.rate * 100)}%`,
    streakText:
      habit.streak === null || habit.streak === undefined
        ? '—'
        : `${num(habit.streak)} ${habit.streak === 1 ? 'day' : 'days'}`,
  })),
)
</script>

<template>
  <div class="dsh-band">
    <!-- One account that cannot be read, with the store's own sentence quoted. Never
         a form and never a button that pretends to fix it: the grant is minted on the
         connector's page, and Entity holds no credential it could edit here. -->
    <div v-if="refused" class="dsh-err" role="alert">
      <b>Habitify could not be read for {{ entry ? `@${entry.localpart}` : 'this account' }}.</b>
      <p>
        <code class="mono">{{ refusal }}</code>
        Entity reads the grant this machine holds; it cannot widen a scope or replace a
        refresh token from here.
      </p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="habitify.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          Try again
        </button>
      </div>
    </div>

    <div class="dsh-bar">
      <div class="dsh-day" role="group" aria-label="Which day to read">
        <div class="dsh-chips">
          <button
            v-for="day in weekDays"
            :key="day.day"
            type="button"
            class="dsh-chip"
            :aria-pressed="day.day === habitify.day"
            :title="day.state === 'error' ? 'This day could not be read' : `${day.scheduled ?? '—'} scheduled · ${day.completed ?? '—'} done`"
            @click="pickDay(day.day)"
          >{{ day.label }}<span v-if="day.state === 'error'" class="n">unread</span></button>
          <button
            v-if="!weekDays.some((day) => day.day === habitify.day)"
            type="button"
            class="dsh-chip"
            aria-pressed="true"
          >{{ heading }}</button>
        </div>
        <!-- The chips stop at today and start on Monday, so a day outside this week
             needs its own door. A native date input is the whole calendar: no
             dependency, no grid to keep, and the keyboard and locale come free. -->
        <div ref="picker" class="dsh-picker">
          <button
            type="button"
            class="dsh-pick"
            aria-haspopup="dialog"
            :aria-expanded="picking ? 'true' : 'false'"
            @click="pickOpen"
          >
            {{ dayText(habitify.day) }}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
          </button>
          <div v-if="picking" class="dsh-pop" role="dialog" aria-label="Pick a day">
            <label class="lbl" for="dsh-day-input">Read a day</label>
            <input
              id="dsh-day-input"
              type="date"
              :value="habitify.day"
              :max="today"
              @change="pickDate"
            />
            <button class="btn btn-sm" type="button" @click="pickClose">Close</button>
          </div>
        </div>
      </div>
      <div class="dsh-when">
        <span>{{ heading }}<template v-if="habitify.timezone"> · {{ habitify.timezone }}</template></span>
        <template v-if="dayEnds">
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ dayEnds }}</span>
        </template>
        <span class="sep" aria-hidden="true">·</span>
        <!-- One polite region for the one thing that changes on its own: the stamp.
             Announcing the whole row would read out the timezone and the countdown
             every minute, so the live region is this span and nothing else. -->
        <span role="status" aria-live="polite">{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="habitify.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ habitify.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- A day inside a week that only partly answered: the tiles below count the days
         that did, and this says how many did not rather than letting the total pass
         for the whole week. -->
    <div v-if="habitify.readAt && tiles && failedDays" class="dsh-wait" data-tone="warn">
      <span class="k">Partly read</span>
      <p>
        <b>{{ num(failedDays) }}</b>
        {{ failedDays === 1 ? 'day' : 'days' }} of this week could not be read, so the
        week's totals count the <b>{{ num(tiles.daysRead) }}</b> that did.
      </p>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" :disabled="habitify.reading" @click="refresh">Try again</button>
    </div>

    <!-- Every day of this week was read and none of them scheduled a habit, so the
         six counts below are a real zero and not an unknown. Said once, here, above
         the numbers: an empty table under six zeros is the shape of a broken read,
         and this is the one place that tells them apart. -->
    <div v-if="nothingScheduled" class="dsh-wait">
      <span class="k">No habits yet</span>
      <p>
        <b>Habitify returned no habits for this week.</b>
        <template v-if="entry">Connected as <code class="mono">@{{ entry.localpart }}</code>.</template>
        Nothing is broken here — habits are created in
        <a href="https://habitify.me" target="_blank" rel="noopener noreferrer">Habitify</a>,
        not on this page. The counts below stay at zero until one is scheduled.
      </p>
    </div>

    <!-- Six counts. The skeleton keeps the final grid, so nothing jumps when the
         numbers land, and an unknown count prints `—` rather than `0`: a grant that
         cannot read a day makes every number unknown, and `0` would be a claim. -->
    <div class="dsh-kpis" role="list" :aria-busy="habitify.loading ? 'true' : 'false'">
      <div v-for="kpi in kpis" :key="kpi.key" class="dsh-kpi" role="listitem">
        <span class="k">{{ kpi.k }}</span>
        <span v-if="habitify.loading" class="dsh-skel" style="width: 40%; height: 22px; margin-top: 6px"></span>
        <b v-else class="v">{{ num(kpi.value) }}</b>
        <span class="q">{{ kpi.q }}</span>
      </div>
    </div>

    <!-- The day as it stands: what is still open, and how much of it ends a streak.
         Only over a day that was read and has something genuinely open — an empty band
         over a finished day is noise, and a band about a count nobody could read would
         be a claim. The anchor jumps to the list in the same page, because the answer
         is below rather than somewhere else. -->
    <div v-if="tiles && tiles.open > 0" class="dsh-wait" :data-tone="tiles.risk > 0 ? 'warn' : null">
      <span class="k">{{ isToday ? 'Before midnight' : 'Left open' }}</span>
      <p>
        <b>{{ num(tiles.open) }}</b> habits are still open today<template v-if="tiles.risk > 0"> ·
        <b>{{ num(tiles.risk) }}</b> of them carry a streak that ends if the day closes unchecked</template>
      </p>
      <span class="spacer"></span>
      <a class="dsh-jump" href="#dsh-hab-head">Jump to the list ↓</a>
    </div>

    <div class="dsh">
      <div class="dsh-main">
        <!-- The week as a whole, above the day's own six tiles: four numbers an
             answer about one day cannot give — how many habits there are, what share
             of the week was done, the longest run and how many days were perfect. -->
        <div class="dsh-kpis dsh-wkfigs" role="list" aria-label="This week at a glance" :aria-busy="habitify.loading ? 'true' : 'false'">
          <div v-for="figure in weekFigures" :key="figure.key" class="dsh-kpi" role="listitem">
            <span class="k">{{ figure.k }}</span>
            <span v-if="habitify.loading" class="dsh-skel" style="width: 40%; height: 22px; margin-top: 6px"></span>
            <b v-else class="v">{{ num(figure.value) }}{{ figure.suffix || '' }}</b>
            <span class="q">{{ figure.q }}</span>
          </div>
        </div>

        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-grid-head">
          <div class="hd">
            <h3 id="dsh-grid-head">The habits</h3>
            <span class="n">{{ habitify.loading ? '—' : grid.length }}</span>
            <span class="spacer"></span>
            <span class="hd-when">Monday to Sunday, as read</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-grid-head">
            <table class="dsh-tbl dsh-grid">
              <thead>
                <tr>
                  <th scope="col">Habit</th>
                  <th v-for="day in weekColumns" :key="day.day" scope="col" class="dy">
                    {{ day.label }}<span class="dt">{{ shortDate(day.day) }}</span>
                    <span class="sr-only">{{ dayText(day.day) }}<template v-if="day.open"> · today</template></span>
                  </th>
                  <th scope="col" class="upd">Done</th>
                  <th scope="col" class="upd">Rate</th>
                  <th scope="col" class="upd">Streak</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="habitify.loading">
                  <tr v-for="n in 5" :key="`gsk${n}`" class="skrow">
                    <td><span class="dsh-skel" style="width: 62%; height: 12px"></span></td>
                    <td v-for="day in 7" :key="`gskc${n}-${day}`" class="dy">
                      <span class="dsh-skel" style="width: 18px; height: 18px"></span>
                    </td>
                    <td class="upd"><span class="dsh-skel" style="width: 30px; height: 9px"></span></td>
                    <td class="upd"><span class="dsh-skel" style="width: 24px; height: 9px"></span></td>
                    <td class="upd"><span class="dsh-skel" style="width: 32px; height: 9px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!grid.length" class="emptyrow">
                  <td colspan="11">
                    <b>No habit was scheduled in this week.</b>
                    <span>{{ habitify.day ? 'The days that answered had nothing due.' : 'Nothing has been read yet.' }}</span>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="habit in grid" :key="habit.id">
                    <td>
                      <div class="dsh-hab">
                        <span class="nm" :title="habit.name">{{ habit.name }}</span>
                      </div>
                    </td>
                    <td v-for="(cell, index) in habit.cells" :key="`${habit.id}-${index}`" class="dy" :data-tone="cell.tone" :aria-label="cell.label" :title="cell.label">
                      <span aria-hidden="true">{{ cell.word }}</span>
                      <span v-if="cell.detail" class="amt" aria-hidden="true">{{ cell.detail }}</span>
                    </td>
                    <td class="upd">{{ num(habit.completedDays) }} / {{ num(habit.scheduledDays) }}</td>
                    <td class="upd">{{ habit.rateText }}</td>
                    <td class="upd">{{ habit.streakText }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            A dash is a day the habit was not scheduled, or a day this read did not
            cover — never a miss. Not done shows how far a measurable habit got.
          </p>
        </section>

        <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-hab-head">
          <div class="hd">
            <h3 id="dsh-hab-head">{{ heading }}</h3>
            <span class="n">{{ habitify.loading ? '—' : table.length }}</span>
            <span class="spacer"></span>
            <span class="hd-when">as Habitify scheduled it</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-hab-head">
            <table class="dsh-tbl">
              <thead>
                <tr>
                  <th scope="col">Habit</th>
                  <th scope="col">When</th>
                  <th scope="col" class="upd">Streak</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                <template v-if="habitify.loading">
                  <tr v-for="n in 9" :key="`sk${n}`" class="skrow">
                    <td>
                      <span class="dsh-skel" style="width: 62%; height: 12px"></span>
                      <span class="dsh-skel" style="width: 40%; height: 9px; margin-top: 7px"></span>
                    </td>
                    <td data-l="when"><span class="dsh-skel" style="width: 52px; height: 9px"></span></td>
                    <td class="upd" data-l="streak"><span class="dsh-skel" style="width: 34px; height: 9px"></span></td>
                    <td><span class="dsh-skel" style="width: 84px; height: 18px"></span></td>
                  </tr>
                </template>
                <tr v-else-if="!table.length" class="emptyrow">
                  <td colspan="4">
                    <b v-if="unread">This day could not be read.</b>
                    <b v-else>Nothing is scheduled on {{ heading }}.</b>
                    <span v-if="unread">{{ dayFailure?.message || refusal }}</span>
                    <!-- An empty day is an answer, not a dead end: when the schedule
                         resumes within the days the read probed, the row says where
                         and offers to go there instead of leaving a blank. -->
                    <span v-else-if="next" class="nx">
                      The next scheduled day is {{ dayText(next.day) }} —
                      {{ num(next.scheduled) }} {{ next.scheduled === 1 ? 'habit' : 'habits' }}.
                    </span>
                    <span v-else-if="nothingScheduled" class="nx">
                      No habit is scheduled this week — Habitify has none to list yet.
                    </span>
                    <span v-else>An empty day is a real answer — nothing was due, so nothing is missing.</span>
                    <button
                      v-if="!unread && next"
                      class="btn btn-sm nx-go"
                      type="button"
                      @click="pickDay(next.day)"
                    >Go to {{ nextDay }}</button>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="row in table" :key="row.id" :data-s="row.state">
                    <td>
                      <div class="dsh-hab">
                        <span class="nm" :title="row.name">{{ row.name }}</span>
                      </div>
                    </td>
                    <td data-l="when">{{ dayText(row.day) }}</td>
                    <td class="upd" data-l="streak">{{ row.streakText }}</td>
                    <td>
                      <span class="st" :data-tone="row.tone || null"><i aria-hidden="true"></i>{{ row.word }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <p class="dsh-foot">
            Read with <code class="mono">list-habits-by-date</code> · {{ cacheNote }} ·
            nothing here completes, skips or logs a habit.
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card" aria-labelledby="dsh-week-head">
          <div class="hd">
            <h3 id="dsh-week-head">The week</h3>
            <span class="n">{{ weekRange }}</span>
            <span class="spacer"></span>
            <!-- One way out to where a habit is actually changed. The tab is
                 read-only by design, so the button is a link and it leaves the app. -->
            <a
              class="btn btn-sm dsh-out"
              href="https://app.habitify.me"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Habitify
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>
            </a>
          </div>
          <!-- Three doors onto a week: the one before, this one, the one after. A read
               covers Monday..the day it was asked about, so each door asks about the
               Sunday of that week — the whole week, in one call count. -->
          <div class="dsh-nav" role="group" aria-label="Which week to read">
            <button class="btn btn-sm" type="button" :disabled="!weekPrev || habitify.reading" @click="pickDay(weekPrev)">
              Previous week
            </button>
            <button class="btn btn-sm" type="button" :disabled="habitify.reading || isToday" @click="pickDay(today)">
              This week
            </button>
            <button class="btn btn-sm" type="button" :disabled="!canNext || habitify.reading" @click="pickDay(weekNext)">
              Next week
            </button>
          </div>
          <ul class="dsh-repos">
            <template v-if="habitify.loading">
              <li v-for="n in 9" :key="`wsk${n}`">
                <span class="dsh-skel" style="width: 64%; height: 9px"></span>
              </li>
            </template>
            <template v-else>
              <li v-for="day in weekDays" :key="day.day" :title="dayText(day.day)" :data-open="day.open ? '1' : null">
                <span class="nm"><em>{{ day.label }}</em> {{ dayText(day.day).replace(/^\w+ /, '') }}<template v-if="day.open"> · today</template></span>
                <span v-if="day.state === 'error'" class="pv">unread</span>
                <span class="when">{{ day.scheduled === null ? '—' : `${num(day.completed)} / ${num(day.scheduled)}` }}</span>
              </li>
              <li v-if="!weekDays.length" class="dsh-none">The week has not been read yet.</li>
            </template>
          </ul>
          <p class="dsh-foot">
            A check-in is a day whose every scheduled habit was completed. A day with
            nothing scheduled is not one.
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="dsh-read-head">
          <div class="hd">
            <h3 id="dsh-read-head">The read</h3>
            <span class="n">{{ habitify.reads || 0 }} {{ habitify.reads === 1 ? 'call' : 'calls' }}</span>
          </div>
          <dl class="cxn-facts">
            <dt>account</dt>
            <dd>{{ entry ? `@${entry.localpart}` : '—' }}</dd>
            <dt>day</dt>
            <dd>{{ habitify.day || '—' }}</dd>
            <dt>zone</dt>
            <dd>{{ habitify.timezone || '—' }}</dd>
            <dt>read</dt>
            <dd>{{ habitify.readAt ? ago(habitify.readAt) : '—' }}</dd>
            <dt>grant</dt>
            <dd>{{ entry?.missing?.length ? `missing ${entry.missing.join(', ')}` : 'read only' }}</dd>
          </dl>
          <p class="dsh-foot">
            One call per day of the week that has happened, inside one MCP session ·
            {{ cacheNote }}. <b>Refresh</b> is the only thing that reads Habitify
            sooner than the expiry.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
