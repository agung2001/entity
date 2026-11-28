<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FeedMark from '@/components/FeedMark.vue'
import { call } from '@/composables/localBridge'
import { feedFamily } from '@/lib/newsFeed'
import { ago, hub } from '@/stores/hub'

/**
 * One trend, at reading size (ENTITY-81).
 *
 * A Google Trends item has no article behind it: its RSS `<link>` is the feed's
 * own XML, so the card used to send a reader to a page of angle brackets. This is
 * where that click lands instead — the four facts the store returns, drawn large
 * — with the one way out being Google's own page for the same query.
 *
 * Read-only, like the list it comes from: `news.read` is its one call, and it
 * asks for the snapshot the list already took rather than a refresh, so opening a
 * trend costs no request and changes no data.
 */
const route = useRoute()
const router = useRouter()

const reading = ref(true)
const busy = ref(false)
const failed = ref(false)
const readAt = ref('')
const feeds = ref([])
const items = ref([])

const workspace = computed(() => String(route.params.workspace || ''))
const workspaceLabel = computed(() => hub.workspaceLabel || hub.workspace || workspace.value)
const feedId = computed(() => String(route.params.feedId || ''))
const rank = computed(() => String(route.params.rank || ''))

/* The item is found by the pair the list keyed it with, not by title: a trend can
   repeat a query and two rows can share one. */
const item = computed(
  () => items.value.find((row) => row.feedId === feedId.value && String(row.rank) === rank.value) || null,
)
const feed = computed(() => feeds.value.find((entry) => entry.id === feedId.value) || null)
const family = computed(() => feedFamily(feed.value))
const feedItems = computed(() => items.value.filter((row) => row.feedId === feedId.value))

/* Google prints `10000+`, so `parseFloat` is the only honest reading of it. */
const figure = (row) => {
  const digits = Number.parseFloat(String(row?.volume || ''))
  return Number.isFinite(digits) ? digits : -1
}

/* Scaled to the biggest figure in *this feed's* read, which is the only maximum
   this page can see — `10000+` as often as `100`, so a bar against an arbitrary
   ceiling would say nothing. */
const top = computed(() => Math.max(1, ...feedItems.value.map(figure)))
const share = computed(() => {
  const digits = figure(item.value)
  return digits > 0 ? `${Math.max(4, Math.round((digits / top.value) * 100))}%` : '0%'
})

/* Google's own page for this query.
   `ponytail:` the feed's `geo` is not carried by the store (it has no country
   table, by design), so this opens the worldwide trend for the same words. The
   upgrade path is the table, not a second link. */
const explore = computed(() =>
  item.value ? `https://trends.google.com/trends/explore?q=${encodeURIComponent(item.value.title)}` : '',
)

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

async function load(again = false) {
  busy.value = true
  try {
    const answer = await call('news.read', { workspace: workspace.value, refresh: again })
    readAt.value = String(answer?.readAt || '')
    feeds.value = Array.isArray(answer?.feeds) ? answer.feeds : []
    items.value = Array.isArray(answer?.items) ? answer.items : []
  } catch {
    failed.value = true
  } finally {
    reading.value = false
    busy.value = false
  }
}

/* Back to where the click came from — the same page of the same filter — and to
   the list's own address when this page was opened cold and there is nothing to
   go back to. */
function back() {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'news', params: { workspace: workspace.value } })
}

onMounted(load)
</script>

<template>
  <div class="view detail-view">
    <div class="entp-bar">
      <button class="back" type="button" @click="back">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        News
      </button>
      <span class="entp-crumb">{{ workspaceLabel }} · trend</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <a v-if="explore" class="btn btn-sm" :href="explore" target="_blank" rel="noopener noreferrer">
          Explore on Google Trends
        </a>
      </div>
    </div>

    <div class="news-band">
      <!-- Nothing yet: two bars, then the page. The read is the snapshot the list
           already took, so this is a flash and not a spinner. -->
      <template v-if="reading">
        <div class="nvi-head" aria-hidden="true">
          <span class="dsh-skel" style="width: 150px; height: 9px"></span>
          <span class="dsh-skel" style="width: 68%; height: 26px; margin-top: 12px"></span>
          <span class="dsh-skel" style="width: 44%; height: 26px; margin-top: 6px"></span>
        </div>
      </template>

      <!-- The row left the snapshot between the click and the read. -->
      <div v-else-if="!item" class="news-none">
        <b>{{ failed ? 'The feeds could not be read.' : 'This trend is not in the latest read.' }}</b>
        <p>
          A read replaces the snapshot whole, so a row the feed no longer prints is gone rather than stale —
          there is nothing left here to open.
        </p>
        <button class="btn btn-sm" type="button" @click="back">Back to News</button>
      </div>

      <template v-else>
        <div class="nvi" :data-s="family">
          <div class="nvi-head">
            <p class="eyebrow">
              <i class="nv-gl" :data-s="family" aria-hidden="true"><FeedMark :family="family" /></i>
              {{ item.feed }} <span class="sep">·</span> rank {{ item.rank }} <span class="sep">·</span>
              {{ ago(item.published) }}
            </p>
            <h1>{{ item.title }}</h1>
            <p class="nv-sub nvi-lede">
              A trend is a search, not a story: this feed’s own link points at its XML, so the row opens here
              instead. The figure and the position are Google’s, printed back exactly as the feed carries
              them — <b>nothing on this page is estimated, rounded or scored.</b>
            </p>
          </div>

          <div class="nvi-facts">
            <div class="nvi-fact">
              <span class="k">Volume</span>
              <b>{{ item.volume || '—' }}</b>
              <span v-if="item.volume" class="nv-meter nvi-meter" aria-hidden="true"><i :style="{ width: share }"></i></span>
              <span class="s">against the biggest trend in this feed</span>
            </div>
            <div class="nvi-fact">
              <span class="k">Position</span>
              <b>#{{ item.rank }}</b>
              <span class="s">the feed’s own order, never renumbered</span>
            </div>
            <div class="nvi-fact">
              <span class="k">Seen</span>
              <b>{{ ago(item.published) }}</b>
              <span class="s">{{ absolute(item.published) }}</span>
            </div>
            <div class="nvi-fact">
              <span class="k">Feed</span>
              <b>{{ item.feed }}</b>
              <span class="s">{{ readAt ? `read ${ago(readAt)}` : 'not read yet' }}</span>
            </div>
          </div>

          <!-- The stories behind the search. Google attaches up to three to every
               trend, and they are the one thing a trend cannot say about itself:
               the figures say how many looked, these say what happened. -->
          <section v-if="item.news?.length" class="nvi-news">
            <h2>
              What happened · <span class="n">{{ item.news.length }}</span>
            </h2>
            <ul>
              <li v-for="story in item.news" :key="story.url">
                <a :href="story.url" target="_blank" rel="noopener noreferrer">{{ story.title }}</a>
                <span v-if="story.source" class="s">{{ story.source }}</span>
              </li>
            </ul>
          </section>

          <!-- The snapshot predates this page's own field. One read brings the
               stories with it; the verb is the shipped one. -->
          <p v-else-if="!Array.isArray(item.news)" class="nvi-old">
            This trend was read before its stories were.
            <button class="dsh-jump" type="button" :disabled="busy" @click="load(true)">
              {{ busy ? 'Reading the feeds…' : 'Read the feeds again' }}
            </button>
          </p>
        </div>

        <p class="dsh-foot nvi-foot">
          One read answers this page as well as the list: the snapshot was taken when the workspace asked for
          News, and nothing here goes back to Google to ask again. The <b>Refresh</b> verb on News is the one
          that reads every feed, and it is the only one that can change this row.
        </p>
      </template>
    </div>
  </div>
</template>
