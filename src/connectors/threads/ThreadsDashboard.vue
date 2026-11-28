<script setup>
import { computed, onMounted } from 'vue'
import { ago } from '@/stores/hub'
import { readReport, readState, threads } from '@/connectors/threads/useThreads'

/**
 * The Threads connector's Dashboard tab: the last 30 days of one account, read from
 * the Graph API by the main process.
 *
 * Nothing here calls Threads and nothing here posts. The token never reaches this
 * file — `threads.dashboard` reads it in the main process, which is why a page that
 * is screenshotted or opened from disk cannot leak one — and every request behind
 * these numbers is a GET.
 *
 * **Nothing here invents a number.** A missing token, a refused read and a window with
 * no posts each print a sentence instead of the tiles: `0 views` would be a claim about
 * a month, and "nothing was read" is not one.
 *
 * The pane reads itself on mount, like Clockify's and Fitbit's, which is why the table
 * entry declares `read: null` and why a locked body is absent rather than empty.
 */
const nFmt = new Intl.NumberFormat('en-gb')
const num = (value) => (Number.isFinite(Number(value)) ? nFmt.format(Number(value)) : '—')
/* A rate is a share of the views, printed to one decimal: two would claim a precision
   the API's own counts do not have. */
const pct = (value) => `${(Number(value) * 100 || 0).toFixed(1)}%`

const totals = computed(() => threads.totals)
const rates = computed(() => threads.rates)
const posts = computed(() => (Array.isArray(threads.posts) ? threads.posts : []))
const tiles = computed(() => [
  { k: 'Views', v: totals.value.views, q: 'on every post in the window' },
  { k: 'Likes', v: totals.value.likes, q: `${pct(rates.value.likeRate)} of views` },
  { k: 'Replies', v: totals.value.replies, q: `${pct(rates.value.replyRate)} of views` },
  { k: 'Reposts', v: totals.value.reposts, q: `${pct(rates.value.repostRate)} of views` },
])
const dayText = (iso) => {
  const date = new Date(`${String(iso)}T12:00:00`)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short' })
    : String(iso || '—')
}
const windowText = computed(() => {
  const { since, until } = threads.window
  return since && until ? `${dayText(since)} – ${dayText(until)}` : ''
})
const stamp = computed(() =>
  threads.reading ? 'Reading…' : threads.readAt ? `read ${ago(threads.readAt)}` : 'not read yet',
)

onMounted(async () => {
  await readState()
  await readReport()
})

/* The one verb on the page. A read already in flight turns it into a no-op rather
   than a disabled button: a disabled button leaves the tab order, and the person who
   tabbed to it would hear nothing about why pressing it did nothing. */
function refresh() {
  if (!threads.reading) readReport({ force: true })
}
</script>

<template>
  <div class="dsh-band">
    <!-- A refusal, in the main process's own sentence: the code behind it is
         `threads-no-token` or `threads-upstream`, and the fix for both is the same
         card on Overview rather than a form in the middle of a report. -->
    <div v-if="threads.problem" class="dsh-err" role="alert">
      <b>Threads could not be read.</b>
      <p>{{ threads.problem }}</p>
      <div class="dsh-err-act">
        <button class="btn btn-sm" type="button" :disabled="threads.reading" @click="refresh">Try again</button>
      </div>
    </div>

    <div v-if="!threads.problem" class="dsh-bar">
      <div class="dsh-when">
        <span>Last 30 days<template v-if="windowText"> · {{ windowText }}</template></span>
        <span class="sep" aria-hidden="true">·</span>
        <!-- One polite region for the one thing that changes on its own: the stamp. -->
        <span role="status" aria-live="polite">{{ stamp }}</span>
        <button class="btn btn-sm" type="button" :disabled="threads.reading" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
          {{ threads.reading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- A window that was read and holds no post is a real zero, and it is said once
         rather than drawn as four tiles of nothing. -->
    <div v-if="!threads.problem && threads.readAt && !posts.length" class="dsh-wait">
      <span class="k">No posts</span>
      <p>
        <b>This account posted nothing in the last 30 days</b><template v-if="windowText"> ({{ windowText }})</template>.
        Nothing is broken here — a post is written in
        <a href="https://www.threads.net" target="_blank" rel="noopener noreferrer">Threads</a>, not on this page.
      </p>
    </div>

    <template v-if="!threads.problem && posts.length">
      <div class="dsh-kpis dsh-wkfigs" role="list" aria-label="The last 30 days" :aria-busy="threads.reading ? 'true' : 'false'">
        <div v-for="tile in tiles" :key="tile.k" class="dsh-kpi" role="listitem">
          <span class="k">{{ tile.k }}</span>
          <b class="v">{{ num(tile.v) }}</b>
          <span class="q">{{ tile.q }}</span>
        </div>
      </div>

      <section class="dsh-card dsh-tblcard" aria-labelledby="dsh-threads-head">
        <div class="hd">
          <h3 id="dsh-threads-head">The posts</h3>
          <span class="n">{{ num(totals.posts) }}</span>
          <span class="spacer"></span>
          <span class="hd-when">Newest first, as read</span>
        </div>
        <div class="dsh-tblscroll" tabindex="0" role="region" aria-labelledby="dsh-threads-head">
          <table class="dsh-tbl">
            <caption class="sr-only">The posts of the last 30 days, with their views, likes, replies and reposts</caption>
            <thead>
              <tr>
                <th scope="col">Post</th>
                <th scope="col">Date</th>
                <th scope="col" class="upd">Views</th>
                <th scope="col" class="upd">Likes</th>
                <th scope="col" class="upd">Replies</th>
                <th scope="col" class="upd">Reposts</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="post in posts" :key="post.id">
                <td>
                  <div class="dsh-pr">
                    <!-- The link is the permalink: a number nobody trusts is one click
                         from the post it came from. `noopener` because the page is a
                         different origin. -->
                    <a :href="post.permalink" target="_blank" rel="noopener noreferrer" :title="post.text">
                      {{ post.text || '(no text)' }}
                    </a>
                  </div>
                </td>
                <td class="mono">{{ dayText(post.date) }}</td>
                <td class="upd mono">{{ num(post.views) }}</td>
                <td class="upd mono">{{ num(post.likes) }}</td>
                <td class="upd mono">{{ num(post.replies) }}</td>
                <td class="upd mono">{{ num(post.reposts) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
