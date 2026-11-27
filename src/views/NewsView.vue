<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiIcon from '@/components/UiIcon.vue'
import ViewToggle from '@/components/ViewToggle.vue'
import { call } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import { dialogDepth } from '@/composables/useDialog'
import { cachedUntil } from '@/connectors/parts/readClock'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { plural } from '@/lib/transfer'
import { ago, hub, toast } from '@/stores/hub'

/**
 * News — what this workspace's feeds last said (ENTITY-76).
 *
 * This page is a **reader**. A feed is a connector, installed in Configurations →
 * Connectors, and nothing here creates, edits or removes one: there is no route
 * from this file to a write, which is why every member can open it and why the
 * snapshot is written by the main process alone. `news.read` is its one call.
 *
 * The two tabs read **disjoint** source sets — General every installed news feed,
 * Trends the Google Trends connector and nothing else — so the tab is a source
 * boundary, not a sort. That is why the tab is the filter, and why the chips
 * inside it are only the feeds the tab actually reads.
 *
 * The word *shared* is load-bearing: the feeds are the workspace's, read once,
 * identical for everyone in it.
 *
 * `ponytail:` two deliberate departures from the mockup. There is no `⋯` button in
 * the bar — a menu with nothing in it is a control that lies about what exists,
 * and the shell's own top bar already carries the palette and the shortcut guide.
 * And the bar carries the page's one verb (Refresh) rather than a second head
 * block under it, which is how `EntitiesView` and `MachinesView` are built.
 */
const route = useRoute()
const router = useRouter()

const TABS = ['general', 'trends']
const PAGE = 25

const tab = ref(TABS.includes(String(route.query.tab)) ? String(route.query.tab) : 'general')
const reading = ref(false)
const loaded = ref(false)
const loadError = ref('')
const readAt = ref('')
const cacheTtlMs = ref(0)
const stale = ref(false)
const feeds = ref([])
const items = ref([])

const query = ref('')
const chip = ref('')
const sort = ref('rising')
/* The mode is the drawing, not the data: one `paged` array, two renderings. A
   plain ref, like `ManageWorkspacesView.vue` — nothing here is stored, and no
   handler resets it, because a mode change narrows nothing. */
const view = ref('grid')
const page = ref(1)
const searchField = ref(null)
const searchKey = shortcutLabel('inventory-search')

const workspace = computed(() => String(route.params.workspace || hub.workspace || ''))
const workspaceLabel = computed(() => hub.workspaceLabel || hub.workspace || '')

/* ── the URL ─────────────────────────────────────────────────────────────────
   The tab, the filter and the page live in the query string, so a reloaded tab,
   a shared link and Back all land on the same rows. The tab is the only key the
   mockup names, and it is the only one a person would ever type. */
const sameQuery = (a, b) => {
  const left = Object.keys(a).sort()
  const right = Object.keys(b).sort()
  return left.length === right.length && left.every((key, i) => key === right[i] && String(a[key]) === String(b[key]))
}

function readQuery(source) {
  tab.value = TABS.includes(String(source.tab)) ? String(source.tab) : 'general'
  query.value = typeof source.q === 'string' ? source.q : ''
  chip.value = typeof source.feed === 'string' ? source.feed : ''
  sort.value = source.sort === 'newest' ? 'newest' : 'rising'
  const at = Number.parseInt(String(source.page || '1'), 10)
  page.value = Number.isFinite(at) && at > 0 ? at : 1
}

function writeQuery() {
  const next = {}
  if (tab.value !== 'general') next.tab = tab.value
  if (query.value) next.q = query.value
  if (chip.value) next.feed = chip.value
  if (tab.value === 'trends' && sort.value !== 'rising') next.sort = sort.value
  if (page.value > 1) next.page = String(page.value)
  if (sameQuery(next, route.query)) return
  router.replace({ name: 'news', params: { workspace: route.params.workspace }, query: next })
}

readQuery(route.query)

/* ── the read ────────────────────────────────────────────────────────────────
   One call, on mount and on Refresh. `refresh` skips the store's window so the
   verb means what it says; every other open is answered from the snapshot. */
async function load(again = false) {
  if (reading.value) return
  reading.value = true
  loadError.value = ''
  try {
    const answer = await call('news.read', { workspace: workspace.value, refresh: again })
    readAt.value = String(answer?.readAt || '')
    feeds.value = Array.isArray(answer?.feeds) ? answer.feeds : []
    items.value = Array.isArray(answer?.items) ? answer.items : []
    /* The clock is the main process's: the page prints `next read …` from this
       number and never types a duration of its own. */
    cacheTtlMs.value = Number(answer?.cacheTtlMs) || 0
    stale.value = Boolean(answer?.stale)
    /* A read that came back stale is a read that failed, and the app has one
       place that tells a person about a failure: the toast, with the retry on
       it. The page keeps its own note as well — a toast is gone in three
       seconds and the state it announced is not. */
    if (stale.value && feeds.value.length) {
      announce(feeds.value.find((feed) => feed.error)?.error || 'The feeds did not answer.')
    }
  } catch (problem) {
    loadError.value = problem?.message || 'The feeds could not be read.'
    announce(loadError.value)
  } finally {
    reading.value = false
    loaded.value = true
  }
}

/** The app's notification: one sentence, and the verb that answers it. */
function announce(reason) {
  toast(`News could not read its feeds — ${reason}`, {
    actionLabel: 'Read it again',
    onAction: () => load(true),
  })
}

/* ── what the tabs read ──────────────────────────────────────────────────────
   Split on the *feed entry's* `trend` flag, which the store derives from the
   URL: an item carries no opinion about which tab wants it. A feed that was
   removed elsewhere keeps its entry (`status: 'removed'`) so its rows stay one
   read longer, exactly as a failed feed keeps its chip. */
const newsFeeds = computed(() => feeds.value.filter((feed) => !feed.trend))
const trendFeeds = computed(() => feeds.value.filter((feed) => feed.trend))
const failing = computed(() => feeds.value.filter((feed) => feed.status === 'failed'))
const leaving = computed(() => feeds.value.filter((feed) => feed.status === 'removed'))

const feedIndex = computed(() => new Map(feeds.value.map((feed) => [feed.id, feed])))

const idsOf = (list) => new Set(list.map((feed) => feed.id))
const generalItems = computed(() => {
  const ids = idsOf(newsFeeds.value)
  return items.value.filter((item) => ids.has(item.feedId))
})
const trendItems = computed(() => {
  const ids = idsOf(trendFeeds.value)
  return items.value.filter((item) => ids.has(item.feedId))
})

const counts = computed(() => {
  const map = new Map()
  for (const item of items.value) map.set(item.feedId, (map.get(item.feedId) || 0) + 1)
  return map
})
const countOf = (id) => counts.value.get(id) || 0

/* ── state ───────────────────────────────────────────────────────────────────
   `dead` is the one page that has nothing behind it: the call refused, or every
   feed failed on a workspace that had never read well. A stale read is *not*
   dead — it has rows, and the note says how old they are. */
const skel = computed(() => !loaded.value)
const nothingInstalled = computed(() => loaded.value && !loadError.value && !feeds.value.length)
const dead = computed(
  () => Boolean(loadError.value) || (stale.value && !readAt.value && !nothingInstalled.value),
)

/* Nothing installed is answered **before** "dead": a workspace with no feed
   answers `{ readAt: '', stale: true, feeds: [] }`, which read as a failed read and
   put a note saying `0 feeds failed` over a page that had simply never been given a
   feed to read. A count of zero failures is not a failure — it is the empty state,
   and that state already names where a feed comes from. */
const shape = computed(() => {
  if (skel.value) return 'cold'
  if (nothingInstalled.value) return 'none'
  if (dead.value) return 'dead'
  if (tab.value === 'trends' && !trendFeeds.value.length) return 'notrend'
  return 'list'
})

/* ── order ───────────────────────────────────────────────────────────────────
   General's order is the store's (publish time, newest first). Trends has two,
   and Rising is the default: Google's figure leads, and a tie falls back to the
   feed's own order so a re-render never reshuffles equal rows. */
const leading = (volume) => {
  const digits = Number.parseFloat(String(volume || ''))
  return Number.isFinite(digits) ? digits : -1
}

const ordered = computed(() => {
  if (tab.value === 'general') return generalItems.value
  const list = [...trendItems.value]
  if (sort.value === 'rising') list.sort((a, b) => leading(b.volume) - leading(a.volume) || a.rank - b.rank)
  else list.sort((a, b) => String(b.published).localeCompare(String(a.published)) || a.rank - b.rank)
  return list
})

/* The search reads the title and the provenance line — never the article body,
   which is not fetched, so a match is always a match on something on screen. */
const filtered = computed(() =>
  ordered.value.filter(
    (item) =>
      (!chip.value || item.feedId === chip.value) &&
      matchesQuery(`${item.title} ${item.provenance}`, query.value),
  ),
)

const word = computed(() => (tab.value === 'trends' ? 'trends' : 'items'))
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE)))
/* A URL can name a page the current filter no longer has — narrowing keeps the
   page in the handlers, but a link can still arrive one read out of date. */
const atPage = computed(() => Math.min(Math.max(1, page.value), pages.value))
const paged = computed(() => filtered.value.slice((atPage.value - 1) * PAGE, atPage.value * PAGE))

const pagerLabel = computed(() => {
  if (skel.value) return `Page — of — · — ${word.value}`
  if (!filtered.value.length) {
    const inScope = chip.value ? countOf(chip.value) : ordered.value.length
    return `Page 0 of 0 · 0 of ${inScope} ${word.value}`
  }
  const first = (atPage.value - 1) * PAGE + 1
  const last = first + paged.value.length - 1
  return `Page ${atPage.value} of ${pages.value} · ${first}–${last} of ${filtered.value.length} ${word.value}`
})

/* ── copy ────────────────────────────────────────────────────────────────────
   The eyebrow is the machinery, the h1 is the tab's own name. Nothing here says
   how long a read stands: `cachedUntil` reads that off the TTL the store sent. */
const until = computed(() => cachedUntil(readAt.value, cacheTtlMs.value))
const absolute = (iso) => {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return ''
  return new Date(at).toLocaleString('en-gb', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

const eyebrow = computed(() => {
  if (skel.value) return 'reading · shared by the workspace'
  if (loadError.value) return 'could not read · shared by the workspace'
  if (nothingInstalled.value) return '0 feeds · nothing installed · shared by the workspace'
  if (tab.value === 'trends' && !trendFeeds.value.length) {
    return `${plural(newsFeeds.value.length, 'news feed')} · no trend feed · read ${ago(readAt.value)}`
  }
  if (failing.value.length) {
    return `${plural(feeds.value.length, 'feed')} · ${failing.value.length} unreadable · read ${ago(readAt.value)}`
  }
  if (stale.value) return `${plural(feeds.value.length, 'feed')} · last readable ${ago(readAt.value)}`
  if (tab.value === 'trends') {
    const label = String(trendFeeds.value[0]?.label || '').toLowerCase()
    return `${plural(trendFeeds.value.length, 'feed')} · ${label} · read ${ago(readAt.value)} · shared by the workspace`
  }
  return `${plural(feeds.value.length, 'feed')} · read ${absolute(readAt.value)} · shared by the workspace`
})

const ownLabels = computed(() => newsFeeds.value.map((feed) => feed.label).join(' and '))
const onlyNewsFeed = computed(() => newsFeeds.value.length === 1)
/* The dead note's key names what failed, and "could not read" is what a call that
   never answered has to say — `0 feeds` is not a sentence about a failure. */
const deadKey = computed(() =>
  failing.value.length ? `${plural(failing.value.length, 'feed')} failed` : 'could not read',
)
const chipLabel = computed(() => feedIndex.value.get(chip.value)?.label || 'This feed')

/* The word a person installed — the failing feed's own sentence is the store's
   (`<label> returned 429 Too Many Requests`), so it is printed, not rebuilt. */
const failLine = computed(() => failing.value.map((feed) => `${feed.error}.`).join(' '))

const leavingLine = computed(() =>
  leaving.value
    .map(
      (feed) =>
        `${feed.label} is no longer installed in Connectors. Its ${plural(
          countOf(feed.id),
          'item',
        )} stay until the next read replaces the snapshot — this page has no control to remove them, and no button to bring the feed back.`,
    )
    .join(' '),
)

const headCount = computed(() => {
  if (skel.value) return '—'
  if (tab.value === 'trends') {
    return trendItems.value.length
      ? `${plural(trendItems.value.length, 'trend')} · every row carries a figure`
      : 'no trend feed'
  }
  if (!newsFeeds.value.length) return 'no feed installed'
  return `${plural(generalItems.value.length, 'item')} from ${plural(newsFeeds.value.length, 'feed')}`
})

const foot = computed(() => {
  if (skel.value || shape.value === 'notrend') return ''
  if (!filtered.value.length) {
    return 'The search runs over the feed’s title and its provenance line, not the article body — the body is never fetched, so a match here is a match on something the list already shows.'
  }
  if (leaving.value.length) {
    return 'A removal is a fact about the snapshot, not an edit to it. Nothing is deleted early and nothing is re-read just because a membership changed.'
  }
  if (tab.value === 'trends') {
    return 'Rising sorts by the leading digits of the figure Google prints, then by when the item appeared in the feed — a tie never reshuffles between renders. There is exactly one feed here, so there is nothing to filter by.'
  }
  return 'Ordered by when the feed published the item. The number is the feed’s own position, which is why it is not a sequence — these feeds are interleaved, not ranked. Nothing here is scored.'
})

/* What orders the open tab, in words. The strip's note and the item set's own
   heading say the same thing, so both read it off one computed. */
const orderLabel = computed(() =>
  tab.value === 'trends' && sort.value === 'rising' ? 'most rising first' : 'newest first',
)
/* The item set's heading, for the screen reader: how many, in what order, drawn
   how. A mode change re-announces the same rows, never new ones. */
const itemsHead = computed(
  () =>
    `${skel.value ? '—' : filtered.value.length} ${tab.value === 'trends' ? 'trends' : 'headlines'}, ${orderLabel.value}, ${view.value} view`,
)

const feedMark = (item) => {
  const feed = feedIndex.value.get(item.feedId)
  if (!feed) return undefined
  if (feed.trend) return 'gt'
  return /reddit/i.test(`${feed.label} ${feed.url}`) ? 'rd' : undefined
}
const feedGlyph = (item) => {
  const feed = feedIndex.value.get(item.feedId)
  if (!feed) return '?'
  return feed.trend ? 'G' : String(feed.label || '?').trim().charAt(0).toUpperCase()
}

/* ── acting ──────────────────────────────────────────────────────────────────
   Three verbs, and not one of them writes a feed: read again, narrow the list,
   or leave for the page that owns the list. */
const filtering = computed(() => Boolean(query.value || chip.value || sort.value !== 'rising'))

function reset() {
  query.value = ''
  chip.value = ''
  sort.value = 'rising'
  page.value = 1
}

function openConnectors() {
  router.push({
    name: 'workspace',
    params: { workspace: workspace.value },
    query: { tab: 'connectors' },
  })
}

function selectTab(next) {
  if (next === tab.value || !TABS.includes(next)) return
  tab.value = next
  page.value = 1
}

/* Trends is a lie until a read has landed — a tab you can open that has nothing
   behind it says a feed exists that does not. It is `aria-disabled`, never
   `disabled`: a disabled tab is unreachable by the arrow keys that move inside
   the strip, so the roving model would strand the reader on General. */
const canOpen = (id) => (id === 'general' ? true : loaded.value)

function focusTab(id) {
  document.getElementById(`news-tab-${id}`)?.focus()
}

function onTabKey(event) {
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const edge = event.key === 'Home' ? TABS[0] : TABS[TABS.length - 1]
    if (canOpen(edge)) selectTab(edge)
    focusTab(edge)
    return
  }
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!delta) return
  event.preventDefault()
  const at = TABS.indexOf(tab.value)
  const next = TABS[(at + delta + TABS.length) % TABS.length]
  if (!canOpen(next)) {
    focusTab(next)
    return
  }
  selectTab(next)
  focusTab(next)
}

/* ── keys and scroll ─────────────────────────────────────────────────────────
   The list-search key focuses this page's field, and Escape leaves the field
   before it leaves the page. Nothing on `/news` is a dialog, so the shared
   Escape stack is consulted rather than fed. */
function focusSearch() {
  const field = searchField.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

function back() {
  router.push({ name: 'overview', params: { workspace: workspace.value } })
}

function onKey(event) {
  if (event.key === 'Escape') {
    if (document.activeElement === searchField.value) {
      event.preventDefault()
      searchField.value.blur()
      return
    }
    if (isEditable(event.target)) return
    if (dialogDepth()) return
    back()
    return
  }
  if (!matchesShortcut('inventory-search', event)) return
  if (isEditable(event.target)) return
  event.preventDefault()
  focusSearch()
}

/* A tab or a page swap changes the dataset under a scroll position that belonged
   to the previous one, and the app scrolls in `.main-scroll`, not the window. */
function toTop() {
  document.querySelector('.main-scroll')?.scrollTo({ top: 0 })
}

/* Narrowing the set always returns to its first page: page 3 of a filter that
   now has four rows is not a place. It is done in the handlers rather than in a
   watcher so that a page arriving *from* the URL is not reset by its own
   arrival. */
function narrow() {
  page.value = 1
}

watch([tab, query, chip, sort, page], writeQuery)
watch(tab, toTop)
watch(
  () => route.query,
  (value) => readQuery(value),
  { deep: true },
)

onMounted(() => {
  window.addEventListener('keydown', onKey)
  load()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="view detail-view">
    <!-- `.entp-bar` and `.news-band` are siblings under `.detail-view`: the sheet
         hands every other child the reading measure and a 20px margin, so wrapping
         the page in one element would inset the bar from the window's edge. -->
    <div class="entp-bar">
      <span class="entp-crumb">
        News<span v-if="workspaceLabel" class="crumb-n">/ {{ workspaceLabel }}</span>
      </span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          :disabled="reading"
          title="Read every installed feed again"
          @click="load(true)"
        >
          <UiIcon name="refresh" />
          {{ reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <div class="news-band">
      <div class="pg-id">
        <p class="eyebrow">{{ eyebrow }}</p>
        <h1>{{ tab === 'trends' ? 'Trends' : 'News' }}</h1>
        <p class="sub">
          <template v-if="tab === 'trends' && trendFeeds.length">
            The <b>{{ trendFeeds[0].label }}</b> feed only — what is being searched right now, ordered by
            the volume it prints. Every other feed is in <b>General</b>.
          </template>
          <template v-else-if="tab === 'trends'">
            Trends reads exactly one feed — <b>the Google Trends connector</b> — and it is not installed in
            this workspace.
          </template>
          <template v-else>
            Every news feed installed in this workspace, newest first. The feeds are installed in
            <b>Connectors</b> and read once for the whole workspace, so this page is identical for every
            member.
          </template>
        </p>
      </div>

      <div class="sk-tabs" role="tablist" aria-label="News sections" @keydown="onTabKey">
        <button
          v-for="id in TABS"
          :id="`news-tab-${id}`"
          :key="id"
          type="button"
          role="tab"
          :aria-selected="tab === id ? 'true' : 'false'"
          :aria-controls="`news-panel-${id}`"
          :aria-disabled="canOpen(id) ? undefined : 'true'"
          :tabindex="tab === id ? 0 : -1"
          @click="canOpen(id) && selectTab(id)"
        >
          {{ id === 'trends' ? 'Trends' : 'General' }}
          <span class="n">{{ skel ? '—' : id === 'trends' ? trendItems.length : generalItems.length }}</span>
        </button>
        <span class="tab-why">
          {{ skel ? 'reading the feeds…' : orderLabel }}
        </span>
      </div>

      <div
        :id="`news-panel-${tab}`"
        role="tabpanel"
        :aria-labelledby="`news-tab-${tab}`"
      >
        <!-- Which feeds this tab reads, and where that list is edited. A noun,
             never an imperative: the page says where, it does not offer to. -->
        <p v-if="shape !== 'none' && shape !== 'dead'" class="dsh-from">
          <template v-if="tab === 'trends' && trendFeeds.length">
            Reading <b>{{ trendFeeds[0].label }}</b> only · {{ plural(trendItems.length, 'topic') }} from one
            read
          </template>
          <template v-else-if="tab === 'trends'">
            Reading <b>no trend feed</b> · this tab reads one feed and no other
          </template>
          <template v-else>
            Reading <b>all {{ newsFeeds.length }}</b> {{ newsFeeds.length === 1 ? 'feed' : 'feeds' }} ·
            installed in
            <button class="dsh-jump" type="button" @click="openConnectors">Connectors → RSS</button>
          </template>
        </p>

        <!-- One feed could not be read: named, quoted, and never counted for. -->
        <div v-if="failing.length && !stale" class="dsh-wait" data-tone="bad" role="status">
          <span class="k">{{ plural(failing.length, 'feed') }} failed</span>
          <!-- The failing feed's sentence is the store's; the half after it is the
               page's, and it says which way the page is wrong. -->
          <p>
            {{ failLine }}
            <template v-if="onlyNewsFeed">There is no other feed in this workspace to show.</template>
            <template v-else>The rows below are the other feeds — the page is <b>partial</b>, not broken.</template>
          </p>
          <span class="spacer"></span>
          <button class="dsh-jump" type="button" :disabled="reading" @click="load(true)">Read it again</button>
        </div>

        <!-- Every feed failed, but a good read exists: the old rows are the answer. -->
        <div v-else-if="stale && readAt" class="dsh-wait" role="status">
          <span class="k">every feed failed</span>
          <p>
            Nothing answered on the last attempt. These rows are the last read that did —
            <b>last readable {{ ago(readAt) }}</b>.
          </p>
          <span class="spacer"></span>
          <button class="dsh-jump" type="button" :disabled="reading" @click="load(true)">Read it again</button>
        </div>

        <!-- Every feed failed and nothing was ever stored. -->
        <div v-if="shape === 'dead'" class="dsh-wait" data-tone="bad" role="status">
          <span class="k">{{ deadKey }}</span>
          <p>{{ loadError || failLine }}</p>
          <span class="spacer"></span>
          <button class="dsh-jump" type="button" :disabled="reading" @click="load(true)">Read it again</button>
        </div>

        <!-- A feed removed elsewhere: the rows stay one read, the chip says leaving. -->
        <div v-if="leaving.length && shape === 'list'" class="dsh-wait" role="status">
          <span class="k">feed removed</span>
          <p>{{ leavingLine }}</p>
          <span class="spacer"></span>
          <button class="dsh-jump" type="button" @click="openConnectors">Open Connectors</button>
        </div>

        <!-- Nothing installed: no table, no skeleton, one verb that routes. -->
        <template v-if="shape === 'none'">
          <div class="news-none">
            <b>No RSS connector is installed in this workspace.</b>
            <p>
              Any RSS or Atom URL — including <b>Google Trends</b> and a <b>Reddit</b> feed — is installed in
              <b>Configurations → Connectors</b>. Once one is installed it is read for the whole workspace and
              appears here — for every member, not only the person who installed it.
            </p>
            <button class="btn btn-sm" type="button" @click="openConnectors">Open Connectors</button>
          </div>
          <p class="dsh-foot">
            An empty page is not a broken page. There is no skeleton and no spinner: nothing is being read,
            because there is nothing to read. <b>Open Connectors</b> routes; it does not install anything by
            itself.
          </p>
        </template>

        <!-- The other tab's feed is missing: the tab is open and explains itself. -->
        <template v-else-if="shape === 'notrend'">
          <div class="news-none">
            <b>No trend feed.</b>
            <p v-if="generalItems.length">
              General has {{ plural(generalItems.length, 'item') }} from <b>{{ ownLabels }}</b>. This tab stays
              empty until <b>Google Trends</b> is installed in <b>Configurations → Connectors</b>; no other feed
              can fill it, by design.
            </p>
            <p v-else>
              This tab stays empty until <b>Google Trends</b> is installed in
              <b>Configurations → Connectors</b>; no other feed can fill it, by design.
            </p>
            <button class="btn btn-sm" type="button" @click="openConnectors">Open Connectors</button>
          </div>
        </template>

        <template v-else-if="shape !== 'dead'">
          <div v-if="shape === 'list'" class="nv-bar">
            <label class="cxn-search">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <circle cx="7" cy="7" r="4.2" />
                <path d="M10.2 10.2l3 3" />
              </svg>
              <input
                ref="searchField"
                v-model="query"
                type="search"
                :placeholder="tab === 'trends' ? 'topic…' : 'headline…'"
                :aria-label="tab === 'trends' ? 'Search the Trend column' : 'Search the headlines'"
                @input="narrow"
              />
              <kbd class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
            </label>

            <div v-if="tab === 'general' && newsFeeds.length" class="dsh-chips" role="group" aria-label="Filter by feed">
              <button
                class="dsh-chip"
                type="button"
                :aria-pressed="chip ? 'false' : 'true'"
                @click="chip = ''; narrow()"
              >
                All <span class="n">{{ generalItems.length }}</span>
              </button>
              <template v-for="feed in newsFeeds" :key="feed.id">
                <!-- A feed the read could not answer keeps its chip, dashed: removing
                     it would hide which feed is broken. It does nothing, so it is not
                     a button and Tab walks past it. -->
                <span v-if="feed.status === 'failed'" class="dsh-chip" aria-disabled="true">
                  <span class="dot"></span>{{ feed.label }} <span class="n">failed</span>
                </span>
                <button
                  v-else
                  class="dsh-chip"
                  type="button"
                  :data-leaving="feed.status === 'removed' ? '1' : undefined"
                  :aria-pressed="chip === feed.id ? 'true' : 'false'"
                  @click="chip = chip === feed.id ? '' : feed.id; narrow()"
                >
                  <span class="dot" :data-on="feed.status === 'ok' ? '1' : undefined"></span>{{ feed.label }}
                  <span class="n">{{ feed.status === 'removed' ? 'leaving' : countOf(feed.id) }}</span>
                </button>
              </template>
            </div>

            <div v-if="tab === 'trends'" class="seg" role="group" aria-label="Sort">
              <button type="button" :aria-pressed="sort === 'rising' ? 'true' : 'false'" @click="sort = 'rising'; narrow()">
                Rising
              </button>
              <button type="button" :aria-pressed="sort === 'newest' ? 'true' : 'false'" @click="sort = 'newest'; narrow()">
                Newest
              </button>
            </div>

            <ViewToggle :view="view" :aria-disabled="skel" class="nv-seg" @update:view="view = $event" />

            <div class="nv-when">
              <span v-if="reading">reading…</span>
              <span v-else-if="readAt">read {{ ago(readAt) }}</span>
              <span v-else>not read yet</span>
              <template v-if="until && !reading">
                <span class="sep" aria-hidden="true">·</span>
                <span>next read {{ until }}</span>
              </template>
              <button v-if="filtering" class="dsh-jump" type="button" @click="reset">Reset</button>
            </div>
          </div>

          <section aria-labelledby="news-items-head">
            <h2 id="news-items-head" class="sr-only">{{ itemsHead }}</h2>
            <p class="nv-meta">{{ headCount }}</p>

            <!-- Zero rows after a filter is not an empty feed, and it names both.
                 It carries no verb: `Reset` lives in the read line above, once. -->
            <div v-if="!skel && !filtered.length" class="cxn-empty">
              <template v-if="query && chip">
                No {{ tab === 'trends' ? 'topic' : 'headline' }} matches “{{ query }}” in {{ chipLabel }}.
              </template>
              <template v-else-if="query">
                No {{ tab === 'trends' ? 'topic' : 'headline' }} matches “{{ query }}”.
              </template>
              <template v-else-if="chip">{{ chipLabel }} has no item in this read.</template>
              <template v-else>This read answered with no item.</template>
            </div>

            <!-- One set, two drawings. `paged` is the same slice in both: the
                 mode changes what a row becomes, never what it says. -->
            <ul v-else-if="view === 'grid'" class="nv-grid">
              <template v-if="skel">
                <li v-for="n in 9" :key="`skg${n}`" aria-hidden="true">
                  <div class="nv-card">
                    <p class="nv-top">
                      <span class="dsh-skel" style="width: 16px; height: 16px"></span>
                      <span class="dsh-skel" style="width: 72px; height: 9px"></span>
                      <span class="tm dsh-skel" style="width: 44px; height: 9px"></span>
                    </p>
                    <h3><span class="dsh-skel" style="width: 88%; height: 11px"></span></h3>
                    <p class="foot"><span class="dsh-skel" style="width: 104px; height: 9px"></span></p>
                  </div>
                </li>
              </template>
              <li v-for="row in skel ? [] : paged" :key="`${row.feedId}-${row.rank}`">
                <component
                  :is="row.url ? 'a' : 'div'"
                  class="nv-card"
                  :href="row.url || undefined"
                  :title="row.title"
                  :target="row.url ? '_blank' : undefined"
                  :rel="row.url ? 'noopener noreferrer' : undefined"
                >
                  <p class="nv-top">
                    <i class="nv-gl" :data-s="feedMark(row)" aria-hidden="true">{{ feedGlyph(row) }}</i>
                    <span class="fl">{{ row.feed }}</span>
                    <span class="tm">{{ ago(row.published) }}</span>
                  </p>
                  <h3>{{ row.title }}</h3>
                  <p class="foot">
                    <template v-if="tab === 'trends'">
                      rank {{ row.rank }} · volume
                      <span class="vol" :data-none="row.volume ? undefined : '1'">{{ row.volume || '—' }}</span>
                    </template>
                    <template v-else>{{ row.feed }} · {{ row.provenance }}</template>
                  </p>
                </component>
              </li>
            </ul>

            <ul v-else class="nv-list">
              <template v-if="skel">
                <li v-for="n in 6" :key="`skl${n}`" class="nv-row" aria-hidden="true">
                  <span class="dsh-skel" style="width: 16px; height: 16px"></span>
                  <div>
                    <span class="dsh-skel" style="width: 78%; height: 11px"></span>
                    <span class="dsh-skel" style="display: block; width: 96px; height: 9px; margin-top: 6px"></span>
                  </div>
                  <span class="tm dsh-skel" style="width: 44px; height: 9px"></span>
                </li>
              </template>
              <li v-for="row in skel ? [] : paged" :key="`${row.feedId}-${row.rank}`" class="nv-row">
                <i class="nv-gl" :data-s="feedMark(row)" aria-hidden="true">{{ feedGlyph(row) }}</i>
                <div>
                  <component
                    :is="row.url ? 'a' : 'span'"
                    class="nv-rt"
                    :href="row.url || undefined"
                    :title="row.title"
                    :target="row.url ? '_blank' : undefined"
                    :rel="row.url ? 'noopener noreferrer' : undefined"
                  >{{ row.title }}</component>
                  <p class="nv-prov">
                    <template v-if="tab === 'trends'">
                      {{ row.feed }} · rank {{ row.rank }} ·
                      <span class="vol" :data-none="row.volume ? undefined : '1'">{{ row.volume || '—' }}</span>
                    </template>
                    <template v-else>{{ row.feed }} · {{ row.provenance }}</template>
                  </p>
                </div>
                <span class="tm">{{ ago(row.published) }}</span>
              </li>
            </ul>

            <div class="nv-foot">
              <span class="lab" aria-live="polite">{{ pagerLabel }}</span>
              <span class="btns">
                <button class="btn btn-sm" type="button" :disabled="skel || atPage <= 1" @click="page -= 1">
                  Previous
                </button>
                <button class="btn btn-sm" type="button" :disabled="skel || atPage >= pages" @click="page += 1">
                  Next
                </button>
              </span>
            </div>
          </section>

          <p v-if="foot" class="dsh-foot">{{ foot }}</p>
        </template>
      </div>
    </div>
  </div>
</template>
