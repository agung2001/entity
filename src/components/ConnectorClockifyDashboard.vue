<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { call } from '@/composables/localBridge'
import { ago, hub, initials } from '@/stores/hub'

/**
 * The Clockify connector's Dashboard tab: one week of tracked hours, read from the
 * Reports API by the main process.
 *
 * Nothing here calls Clockify. The key never reaches this file — `connector.dashboard`
 * reads it in the main process, which is why a page that is screenshotted or opened
 * from disk cannot leak one. The payload's `calls` list is printed in the rail so the
 * four requests are on screen rather than in a comment.
 *
 * A failure arrives as an `Error` whose `code` is `clockify-401` and so on. The copy
 * and the one control are chosen from that code, never from the sentence: English
 * gets reworded, codes do not.
 *
 * The stepper's arithmetic is in the payload (`previousKey`, `nextKey`, `isCurrent`)
 * because "which Monday" depends on the workspace's timezone, and a second answer
 * computed here would disagree with the first across a DST change.
 */
/* `changed` tells the page the stored workspace id moved, so its Overview card and
   its locked-tab reason do not keep describing the previous choice. */
const emit = defineEmits(['overview', 'changed'])

const state = ref(null)
const failure = ref(null)
const reading = ref(false)
const spaces = ref([])
const spacesError = ref('')
/* `''` means this week. Every other value is a Monday the payload handed back, so
   the renderer never computes one. */
const week = ref('')
const picked = ref('')
const switching = ref('')
const pausedUntil = ref(0)
const clock = ref(Date.now())
let ticker = 0

/* `h:mm` with a space, and a zero is `0h 00m` — never `0`, which beside `143h 00m`
   reads as a missing number rather than a week nobody tracked. */
const hours = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
}

/* Minus is U+2212: a hyphen beside a `+` column reads as a separator, and tabular
   figures are what make the two signs line up. */
function deltaOf(current, previous) {
  if (!Number.isFinite(Number(previous))) return { text: '—', tone: 'flat' }
  const diff = Math.round(Number(current) || 0) - Math.round(Number(previous) || 0)
  if (!diff) return { text: '—', tone: 'flat' }
  return { text: `${diff > 0 ? '+' : '−'}${hours(Math.abs(diff))}`, tone: diff > 0 ? 'up' : 'dn' }
}

/* A share is a bar. A zero share draws the empty track and no fill at all — a 1 %
   stub reads as "a little", which is the one thing it is not. */
function share(seconds, total) {
  if (!Number(seconds) || !Number(total)) return 0
  return Math.min(100, Math.max(2, (Number(seconds) / Number(total)) * 100))
}

const people = computed(() => state.value?.people || [])
const projects = computed(() => state.value?.projects || [])
const daily = computed(() => state.value?.daily || [])
const mapped = computed(() => Object.keys(state.value?.members || {}).length)
const tracked = computed(() => people.value.filter((row) => row.seconds > 0))
const totalSeconds = computed(() => Number(state.value?.seconds) || 0)
const entries = computed(() => Number(state.value?.entries) || 0)
const quiet = computed(() => people.value.filter((row) => !row.seconds))
/* The first press on a name has to land on the card that is already showing, so the
   card's subject is a fallback to the first person rather than a second state. */
const person = computed(
  () => people.value.find((row) => row.login === picked.value) || people.value[0] || null,
)
const personProjects = computed(() => {
  const row = person.value
  if (!row) return []
  return projects.value
    .map((project) => ({
      label: project.label,
      seconds: project.members.find((member) => member.login === row.login)?.seconds || 0,
    }))
    .filter((entry) => entry.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
})
/* One delta object per row, built once: the cell prints the same value twice
   (text and tone) and calling the formatter twice would be two roundings. */
const deltas = computed(() => {
  const map = {}
  for (const row of people.value) map[row.login] = deltaOf(row.seconds, row.previousSeconds)
  return map
})
const personDelta = computed(() =>
  state.value?.delta && person.value
    ? deltaOf(person.value.seconds, person.value.previousSeconds)
    : null,
)
const weekDelta = computed(() =>
  state.value?.delta ? deltaOf(totalSeconds.value, state.value.previous?.seconds ?? 0) : null,
)

const dayText = (iso) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-gb', { weekday: 'short', day: 'numeric', month: 'short' })
    : String(iso)
}
const windowText = computed(() => {
  if (daily.value.length !== 7) return ''
  return `${dayText(daily.value[0].id)} 00:00 – ${dayText(daily.value[6].id)} 23:59`
})
const bestDay = computed(() =>
  daily.value.reduce((best, day) => (day.seconds > (best?.seconds || 0) ? day : best), null),
)
const shortId = computed(() => {
  const id = String(state.value?.workspaceId || '')
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
})
const cacheText = computed(() => {
  const ms = Number(state.value?.cacheTtlMs)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
})

/* ── the six tiles ─────────────────────────────────────────────────────
   Labels first, so the skeleton occupies the settled tile's box and the band
   never jumps when the numbers land. */
const TILES = ['Tracked this week', 'Entries', 'People', 'Projects', 'Days logged', 'Avg / person']

const kpis = computed(() => {
  const total = totalSeconds.value
  const logged = daily.value.filter((day) => day.seconds > 0).length
  const empty = daily.value.filter((day) => !day.seconds).map((day) => day.label)
  const trackedCount = tracked.value.length
  const names = quiet.value.map((row) => row.name)
  /* A subtitle may never contradict its figure: at zero every sentence below is
     about the zero, not about a change against a week that had hours. */
  const entriesNote = entries.value
    ? `${hours(entries.value ? total / entries.value : 0)} per entry`
    : 'no entries at all'
  const peopleNote = !trackedCount
    ? 'no one logged a minute'
    : !mapped.value
      ? 'no member map yet'
      : names.length === 1
        ? `${names[0]} logged nothing`
        : names.length
          ? `${names.length} people logged nothing`
          : 'everyone logged time'
  return [
    {
      k: TILES[0],
      v: hours(total),
      small: '',
      q: !total
        ? 'nothing logged, so no change to compare'
        : weekDelta.value
          ? 'vs previous week'
          : 'previous week not read',
      delta: total ? weekDelta.value : null,
      title: `Monday to Sunday, ${state.value?.label || ''}`,
    },
    { k: TILES[1], v: String(entries.value), small: '', q: entriesNote, delta: null, title: entriesNote },
    {
      k: TILES[2],
      v: String(trackedCount),
      small: mapped.value ? ` / ${mapped.value}` : '',
      q: peopleNote,
      delta: null,
      title: peopleNote,
    },
    {
      k: TILES[3],
      v: String(projects.value.length),
      small: '',
      q: projects.value.length ? 'only the ones with hours' : 'no project has hours',
      delta: null,
      title: 'Reports only return projects that have hours',
    },
    {
      k: TILES[4],
      v: String(logged),
      small: ` / ${daily.value.length || 7}`,
      q: !daily.value.length
        ? 'no week read yet'
        : !logged
          ? 'the whole week is empty'
          : empty.length
            ? `${empty.join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty`
            : 'every day has hours',
      delta: null,
      title: 'Days with any entry',
    },
    {
      k: TILES[5],
      v: trackedCount ? hours(total / trackedCount) : '—',
      small: '',
      q: trackedCount ? `over the ${trackedCount} who tracked` : 'no one to average',
      delta: null,
      title: 'Total divided by the people who logged time',
    },
  ]
})

/* ── what went wrong, in the order a person can act on it ─────────────── */
const RATE_PAUSE_MS = 60_000

const failureCard = computed(() => {
  const problem = failure.value
  if (!problem) return null
  const known = {
    'clockify-no-key': {
      title: 'Connect Clockify first',
      action: 'overview',
      said:
        'This tab reads the Reports API with a key pasted once on the connector’s page. There is none on this machine yet.',
    },
    'clockify-no-workspace': {
      title: 'Pick a workspace first',
      action: 'overview',
      said:
        'Every read happens inside one Clockify workspace, and this workspace has not stored its id yet. Pick one on Overview, then paste the key.',
    },
    'clockify-401': {
      title: 'Clockify refused this key',
      action: 'overview',
      said:
        'Either the key was replaced or revoked, or the stored workspace id is not one this key can read — Clockify returns the same 401 for both, so check the workspace first.',
    },
    'clockify-403': {
      title: 'This key cannot read reports',
      action: '',
      said:
        'Clockify limits the Reports API to admins and roles with reports access. Ask an admin for the role, or use an admin’s key.',
    },
    'clockify-429': {
      title: 'Rate-limited by Clockify',
      action: 'wait',
      said:
        'Nothing is lost — the read is retried after the pause Clockify asks for. Refresh is disabled until then.',
    },
    'clockify-timeout': {
      title: 'Clockify did not answer in 20 s',
      action: 'retry',
      said:
        'The request was abandoned rather than left hanging. The last numbers are gone from this tab — they belong to a read that no longer holds.',
    },
  }[problem.code]
  /* An unrecognised failure still has a sentence from the main process, and printing
     it beats a card that says only "failed". */
  return known ? { ...known, said: known.said } : { title: 'Clockify did not answer', action: 'retry', said: problem.message }
})

const paused = computed(() => pausedUntil.value > clock.value)
const pauseLeft = computed(() => Math.max(0, Math.ceil((pausedUntil.value - clock.value) / 1000)))

function startPause() {
  pausedUntil.value = Date.now() + RATE_PAUSE_MS
  clock.value = Date.now()
  clearInterval(ticker)
  ticker = setInterval(() => {
    clock.value = Date.now()
    if (!paused.value) clearInterval(ticker)
  }, 1000)
}
onBeforeUnmount(() => clearInterval(ticker))

async function read({ force = false } = {}) {
  if (reading.value) return
  reading.value = true
  failure.value = null
  try {
    state.value = await call('connector.dashboard', {
      workspace: hub.workspace,
      week: week.value || undefined,
      force,
    })
  } catch (problem) {
    failure.value = { code: String(problem?.code || 'error'), message: String(problem?.message || problem) }
    if (failure.value.code === 'clockify-429') {
      /* A pause keeps the numbers that are already on screen: they were a real
         read, and the mockup's promise is that nothing is lost. Every other
         failure replaces them, because they belong to a read that no longer holds. */
      startPause()
    } else {
      state.value = null
    }
  } finally {
    reading.value = false
  }
}

async function readSpaces() {
  try {
    spaces.value = await call('connector.workspaces', { workspace: hub.workspace })
    spacesError.value = ''
  } catch (problem) {
    spaces.value = []
    spacesError.value = String(problem?.message || problem)
  }
}

/* Without the list, the workspace being read is still nameable by its id: an empty
   selector would look like a connector with no workspaces. */
const spaceRows = computed(() => {
  if (spaces.value.length) return spaces.value
  const id = state.value?.workspaceId
  return id ? [{ id, name: id, members: mapped.value }] : []
})

async function useSpace(space) {
  if (!space || reading.value || switching.value) return
  if (space.id === state.value?.workspaceId) return
  switching.value = space.id
  failure.value = null
  try {
    await call('connector.setFields', {
      workspace: hub.workspace,
      id: 'clockify',
      fields: {
        workspaceId: space.id,
        /* The member map stores Clockify user ids, and those are per workspace: an
           id read in one workspace names nobody in another. Dropping it makes the
           next read ask for everyone, which is the connector's documented fallback. */
        members: {},
      },
    })
    /* Old numbers are dropped, not dimmed: they answer about a workspace that is no
       longer the subject. */
    state.value = null
    week.value = ''
    picked.value = ''
    await Promise.all([read({ force: true }), readSpaces()])
    emit('changed')
  } catch (problem) {
    failure.value = { code: String(problem?.code || 'error'), message: String(problem?.message || problem) }
  } finally {
    switching.value = ''
  }
}

function step(key) {
  if (!key || reading.value) return
  week.value = key
  picked.value = ''
  read()
}

onMounted(async () => {
  await Promise.all([readSpaces(), read()])
})
</script>

<template>
  <div class="dsh-band">
    <div class="dsh-bar ck-lines">
      <div class="ck-line">
        <span class="ck-lead">Workspace</span>
        <!-- Two buttons, not a `<select>`: this is a choice between two or three
             things, and a pressed state has to be readable at a glance. -->
        <div
          v-if="spaceRows.length"
          class="seg ck-seg"
          role="group"
          aria-label="Which Clockify workspace to read"
        >
          <button
            v-for="space in spaceRows"
            :key="space.id"
            type="button"
            :aria-pressed="space.id === state?.workspaceId"
            :aria-busy="switching === space.id ? 'true' : undefined"
            :disabled="Boolean(switching) || reading"
            @click="useSpace(space)"
          ><span class="nm">{{ space.name }}</span><span
            v-if="space.id === state?.workspaceId && mapped"
            class="n"
          >{{ mapped }}/{{ space.members }}</span></button>
        </div>
        <span v-if="spacesError" class="ck-src" data-tone="bad" :title="spacesError">
          the workspace list could not be read
        </span>
        <!-- The provenance of the list itself. `new` is the honest label: this call
             did not exist before the tab did. -->
        <span class="ck-src" aria-hidden="true">from <code>GET /v1/workspaces</code> <span class="ck-new">new</span></span>
        <div class="dsh-when">
          <span>{{ reading ? 'reading…' : state ? `read ${ago(state.readAt)}` : 'not read yet' }}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="ck-wk" role="group" aria-label="Which week to read">
            <button
              class="ck-wkbtn"
              type="button"
              :disabled="reading || !state"
              :aria-label="`Previous week, ${state?.previousLabel || ''}`"
              @click="step(state?.previousKey)"
            ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg></button>
            <span class="ck-wktext">week {{ state?.label || '—' }}</span>
            <button
              class="ck-wkbtn"
              type="button"
              :disabled="reading || !state || state.isCurrent"
              :aria-label="`Next week, ${state?.nextLabel || ''}`"
              @click="step(state?.nextKey)"
            ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg></button>
          </span>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="reading || paused"
            @click="read({ force: true })"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
            {{ paused ? `Refresh in ${pauseLeft}s` : reading ? 'Reading…' : 'Refresh' }}
          </button>
        </div>
      </div>
      <!-- The same sentence at every width above 560 px: a provenance line that
           re-wraps is a provenance line nobody reads. It hides rather than wraps. -->
      <div class="ck-line">
        <span class="ck-src">
          {{ state?.delta ? 'Two calls per week, two weeks' : 'Two calls per week, one week' }}
          · member map: {{ mapped || 'none' }} · timezone {{ state?.timezone || '—' }}
        </span>
      </div>
    </div>

    <!-- One card, keyed on the error's code. The control is chosen there too: 403
         offers none, because every retry spends the same rate limit for the same
         answer. -->
    <div v-if="failureCard" class="dsh-err" role="alert">
      <b>{{ failureCard.title }}</b>
      <p>{{ failureCard.said }}</p>
      <div v-if="failureCard.action" class="dsh-err-act">
        <button
          v-if="failureCard.action === 'retry'"
          class="btn btn-sm"
          type="button"
          :disabled="reading"
          @click="read({ force: true })"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          Retry
        </button>
        <button
          v-else-if="failureCard.action === 'wait'"
          class="btn btn-sm"
          type="button"
          disabled
        >Refresh in {{ pauseLeft }}s</button>
        <button v-else class="btn btn-sm" type="button" @click="emit('overview')">
          Check on Overview
        </button>
      </div>
    </div>

    <!-- Six tiles in the settled grid, so the skeleton holds the box the numbers
         will occupy. -->
    <div class="dsh-kpis" role="list" aria-label="This week at a glance">
      <div v-for="tile in kpis" :key="tile.k" class="dsh-kpi" role="listitem" :title="tile.title">
        <span class="k">{{ tile.k }}</span>
        <span v-if="!state" class="v"><span class="dsh-skel" style="width: 56px; height: 15px" /></span>
        <span v-else class="v">{{ tile.v }}<small v-if="tile.small" class="ck-sub">{{ tile.small }}</small></span>
        <span v-if="!state" class="q"><span class="dsh-skel" style="width: 78px; height: 9px" /></span>
        <span v-else class="q">
          <span v-if="tile.delta" class="ck-delta" :class="tile.delta.tone">{{ tile.delta.text }}</span>
          {{ tile.q }}
        </span>
      </div>
    </div>

    <div v-if="state || reading" class="dsh">
      <div class="dsh-main">
        <section class="dsh-card dsh-tblcard" aria-labelledby="ck-team-head">
          <div class="hd">
            <h3 id="ck-team-head">Team</h3>
            <span class="n">{{ spaceRows.find((space) => space.id === state?.workspaceId)?.name || 'this workspace' }}</span>
            <span class="spacer"></span>
            <span v-if="state" class="hd-when">week {{ state.label }} · {{ tracked.length }} of {{ mapped || people.length }} tracked</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="ck-team-head">
            <table class="dsh-tbl ck-tbl" role="table">
              <caption class="sr-only">
                Hours per member for {{ state?.label || 'the week' }}, from the Clockify Reports API.
              </caption>
              <colgroup>
                <col />
                <col style="width: 32%" />
                <col style="width: 84px" />
                <col v-if="state?.delta" style="width: 88px" />
              </colgroup>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">Member</th>
                  <th scope="col" role="columnheader">Share</th>
                  <th scope="col" role="columnheader" class="num">Hours</th>
                  <th v-if="state?.delta" scope="col" role="columnheader" class="num">vs previous</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                <template v-if="!state">
                  <tr v-for="n in 3" :key="`tks${n}`" class="skrow" role="row">
                    <td role="cell" class="c-nm"><span class="dsh-skel" style="width: 104px; height: 11px" /></td>
                    <td role="cell" class="c-bar"><span class="dsh-skel" style="width: 100%; height: 7px; border-radius: var(--r-pill)" /></td>
                    <td role="cell" class="c-hr num"><span class="dsh-skel" style="width: 40px; height: 11px" /></td>
                  </tr>
                </template>
                <tr v-else-if="!people.length" class="emptyrow" role="row">
                  <td :colspan="state.delta ? 4 : 3" role="cell" class="c-nm">
                    <b>Nobody logged time in {{ state.label }}</b>
                    <span>Clockify answered 200 with an empty summary. That is a quiet week, not a broken connector.</span>
                  </td>
                </tr>
                <template v-else>
                  <tr v-for="row in people" :key="row.login" role="row">
                    <td role="cell" class="c-nm">
                      <span class="ck-who">
                        <span class="ck-name" :title="row.name">
                          <button
                            class="ck-pick"
                            type="button"
                            :aria-pressed="row.login === person?.login"
                            :aria-label="`Show ${row.name}’s individual report`"
                            @click="picked = row.login"
                          >{{ row.name }}</button>
                        </span>
                        <span class="ck-login">@{{ row.login }}</span>
                      </span>
                    </td>
                    <td role="cell" class="c-bar">
                      <div v-if="row.seconds" class="ck-bar" aria-hidden="true">
                        <i :style="{ width: `${share(row.seconds, totalSeconds)}%` }" />
                      </div>
                      <div v-else class="ck-bar mut" aria-hidden="true" />
                    </td>
                    <td role="cell" class="c-hr num">
                      <span v-if="row.seconds">{{ hours(row.seconds) }}</span>
                      <span v-else class="ck-none">no entries</span>
                    </td>
                    <td v-if="state.delta" role="cell" class="c-dv num">
                      <span class="ck-delta" :class="deltas[row.login].tone">{{ deltas[row.login].text }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
              <tfoot v-if="state && people.length" role="rowgroup">
                <tr role="row">
                  <td role="cell" class="c-nm"><b>{{ hours(totalSeconds) }}</b> across {{ tracked.length }} {{ tracked.length === 1 ? 'person' : 'people' }} · {{ projects.length }} {{ projects.length === 1 ? 'project' : 'projects' }}</td>
                  <td role="cell" class="c-bar" aria-hidden="true"></td>
                  <td role="cell" class="c-hr num"><b>{{ totalSeconds ? '100%' : '—' }}</b></td>
                  <td v-if="state.delta" role="cell" class="c-dv num">
                    <span class="ck-delta" :class="weekDelta.tone">{{ weekDelta.text }}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section class="dsh-card dsh-tblcard" aria-labelledby="ck-proj-head">
          <div class="hd">
            <h3 id="ck-proj-head">Projects</h3>
            <span class="n">where the team’s week went</span>
            <span class="spacer"></span>
            <span v-if="state" class="hd-when">{{ projects.length }} with hours · others not returned</span>
          </div>
          <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="ck-proj-head">
            <table class="dsh-tbl ck-tbl" role="table">
              <caption class="sr-only">Hours per project for {{ state?.label || 'the week' }}.</caption>
              <colgroup>
                <col />
                <col style="width: 40%" />
                <col style="width: 84px" />
              </colgroup>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">Project</th>
                  <th scope="col" role="columnheader">Share</th>
                  <th scope="col" role="columnheader" class="num">Hours</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                <template v-if="!state">
                  <tr v-for="n in 3" :key="`pks${n}`" class="skrow" role="row">
                    <td role="cell" class="c-nm"><span class="dsh-skel" style="width: 112px; height: 11px" /></td>
                    <td role="cell" class="c-bar"><span class="dsh-skel" style="width: 100%; height: 7px; border-radius: var(--r-pill)" /></td>
                    <td role="cell" class="c-hr num"><span class="dsh-skel" style="width: 40px; height: 11px" /></td>
                  </tr>
                </template>
                <tr v-else-if="!projects.length" class="emptyrow" role="row">
                  <td colspan="3" role="cell" class="c-nm">
                    <b>No project has hours in {{ state.label }}</b>
                    <span>Reports only return projects with time against them, so this is an empty week rather than a missing project list.</span>
                  </td>
                </tr>
                <tr v-else v-for="project in projects" :key="project.label" role="row">
                  <td role="cell" class="c-nm">
                    <span class="ck-name" :title="project.client ? `${project.label} · ${project.client}` : project.label">
                      {{ project.label }}
                      <span class="ck-login">{{ project.members.length }} {{ project.members.length === 1 ? 'person' : 'people' }}</span>
                    </span>
                  </td>
                  <td role="cell" class="c-bar">
                    <div class="ck-bar" aria-hidden="true">
                      <i :style="{ width: `${share(project.seconds, totalSeconds)}%` }" />
                    </div>
                  </td>
                  <td role="cell" class="c-hr num">{{ hours(project.seconds) }}</td>
                </tr>
              </tbody>
              <tfoot v-if="state && projects.length" role="rowgroup">
                <tr role="row">
                  <td role="cell" class="c-nm"><b>{{ hours(totalSeconds) }}</b> in total</td>
                  <td role="cell" class="c-bar" aria-hidden="true"></td>
                  <td role="cell" class="c-hr num"><b>{{ totalSeconds ? '100%' : '—' }}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section class="dsh-card dsh-tblcard ck-me" aria-labelledby="ck-me-head">
          <div class="hd">
            <h3 id="ck-me-head">Individual</h3>
            <span class="n">pick a row above to change this</span>
            <span class="spacer"></span>
            <span class="hd-when">same read · no extra call</span>
          </div>
          <template v-if="person">
            <div class="ck-me-head">
              <span class="ck-av" aria-hidden="true">{{ initials(person.name) }}</span>
              <div class="ck-me-who">
                <b>{{ person.name }}</b>
                <span>@{{ person.login }} · {{ state?.members?.[person.login] ? 'member map in this connector' : 'from this week’s report' }}</span>
              </div>
              <div class="ck-me-tot">
                <b>{{ hours(person.seconds) }}</b>
                <span>
                  <span v-if="person.seconds === 0">no entries this week</span>
                  <template v-else-if="personDelta">
                    <span class="ck-delta" :class="personDelta.tone">{{ personDelta.text }}</span> vs previous week
                  </template>
                  <template v-else-if="!state?.delta">previous week not read</template>
                </span>
              </div>
            </div>
            <!-- One column, not two: the day series is the workspace's own grouping,
                 so a per-person day would need a third `groups: USER, DATE` call that
                 the two-calls-per-week rule does not allow. The project split is what
                 this read can honestly produce for one person. -->
            <div class="ck-me-cols">
              <div>
                <h4>Projects this week</h4>
                <ul v-if="personProjects.length" class="ck-me-list">
                  <li v-for="entry in personProjects" :key="entry.label">
                    <span class="nm" :title="entry.label">{{ entry.label }}</span>
                    <span class="hr">{{ hours(entry.seconds) }}</span>
                    <div class="ck-bar" aria-hidden="true">
                      <i :style="{ width: `${share(entry.seconds, person.seconds)}%` }" />
                    </div>
                  </li>
                </ul>
                <p v-else class="dsh-foot">No entries in this week, so no project to split.</p>
              </div>
            </div>
          </template>
          <p v-else class="dsh-foot ck-me-empty">
            {{ reading ? 'Reading this week…' : 'Nobody to show: this week has no entries and no member map to name anyone from.' }}
          </p>
        </section>
      </div>

      <div class="dsh-rail">
        <section class="dsh-card dsh-tblcard" aria-labelledby="ck-week-head">
          <div class="hd">
            <h3 id="ck-week-head">The week</h3>
            <span class="spacer"></span>
            <span class="hd-when">mon – sun</span>
          </div>
          <div class="ck-week">
            <div v-for="day in daily" :key="day.id" class="ck-day">
              <span class="ck-col">
                <span
                  class="ck-fill"
                  :class="{ zero: !day.seconds }"
                  :style="{ height: day.seconds && bestDay ? `${Math.max(3, (day.seconds / bestDay.seconds) * 100)}%` : '3%' }"
                />
              </span>
              <span class="ck-hr">{{ day.seconds ? hours(day.seconds) : '0h' }}</span>
              <span class="ck-dl">{{ day.label }}</span>
            </div>
          </div>
          <p v-if="daily.length" class="dsh-foot">
            Best day <b>{{ bestDay?.label || '—' }}{{ bestDay ? ` · ${hours(bestDay.seconds)}` : '' }}</b> ·
            weekend <b>{{ hours(daily.filter((day) => ['Sat', 'Sun'].includes(day.label)).reduce((sum, day) => sum + day.seconds, 0)) }}</b>
          </p>
        </section>

        <section class="dsh-card" aria-labelledby="ck-cov-head">
          <div class="hd">
            <h3 id="ck-cov-head">Coverage</h3>
            <span class="spacer"></span>
            <span class="hd-when">{{ quiet.length }} of {{ people.length }} with none</span>
          </div>
          <p v-if="quiet.length === 1" class="dsh-foot">
            <b>{{ quiet[0].name }} has no entries.</b> Their week is 0h in every project, not missing data — Clockify returned the person with an empty total.
          </p>
          <p v-else-if="quiet.length" class="dsh-foot">
            <b>{{ quiet.length }} people have no entries.</b>
            {{ quiet.map((row) => row.name).join(', ') }} were returned with an empty total, which is a week nobody tracked rather than a read that missed them.
          </p>
          <p v-else-if="people.length" class="dsh-foot">
            <b>Everyone tracked time.</b> Every row in this week's report has hours against it.
          </p>
          <p v-else class="dsh-foot">
            No member map in this connector yet, so nobody can be named who is not in the report itself.
          </p>
        </section>

        <section class="dsh-card dsh-tblcard ck-io" aria-labelledby="ck-src-head">
          <div class="hd">
            <h3 id="ck-src-head">Where this came from</h3>
            <span class="spacer"></span>
            <span class="hd-when">{{ state?.calls?.length || 0 }} calls</span>
          </div>
          <div v-if="state" class="ck-io-rows">
            <div v-for="entry in state.calls" :key="entry.n" class="r">
              <span class="k">call {{ entry.n }}</span>
              <span class="v">
                <code>POST /v1/workspaces/{{ shortId }}/reports/summary</code>
                <span class="g">groups: {{ entry.groups }} · {{ entry.week }}</span>
              </span>
            </div>
            <div v-if="windowText" class="r">
              <span class="k">window</span>
              <span class="v">{{ windowText }}</span>
            </div>
            <div class="r">
              <span class="k">timezone</span>
              <span class="v">{{ state.timezone }}</span>
            </div>
            <div class="r">
              <span class="k">returned</span>
              <span class="v">{{ tracked.length }} people with time · {{ projects.length }} projects · {{ entries }} entries</span>
            </div>
            <div class="r">
              <span class="k">cache</span>
              <span class="v">{{ state.cached ? 'served from the stored answer' : 'read from Clockify' }}{{ cacheText ? ` · good for ${cacheText}` : '' }}</span>
            </div>
          </div>
          <p class="dsh-foot">
            Calls 1 and 2 are this week — hours per project <em>and</em> per person, so the
            team table and the individual card are two readings of one payload and cannot
            disagree; call 2 is the day series. Calls 3 and 4 repeat both for the previous
            week and exist only for the <i>vs previous</i> column: drop that column and the
            read halves. No member list is ever called, so no email leaves the app.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
