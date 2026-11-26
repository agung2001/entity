/**
 * What moved on a YouTube Studio channel in the last 28 days, read by the grant
 * this machine already holds for that connector.
 *
 * Two answers, both read-only:
 *
 *   roster()             every YouTube Studio account, and the channels it owns
 *   dashboard({…})       six counts, the daily series, the videos, the traffic
 *
 * **Nothing here writes to YouTube and no scope beyond reading is used.** Five
 * Analytics reports and at most two Data API calls per read; why each one exists
 * is noted where it is made.
 *
 * **A metric the grant cannot read is `null`, never `0`.** `0` is an answer about
 * the window ("nothing happened"); `null` is an answer about the grant ("this
 * token may not see it"). Summing the visible half of a half-readable report
 * would print a smaller true-looking number, so one unknown keeps the count
 * unknown and the page prints `—` with the missing scope named.
 *
 * **Every window ends `today − 2`,** because Analytics settles two days late and
 * asking for today returns a partial day that reads as a collapse on the chart.
 * The window arithmetic is `ytWindow` from the connector itself, so the dashboard
 * and the `@youtube-studio:` mention can never disagree about which days they mean.
 *
 * **One read a day.** The answer is written to
 * `<~/.entity>/youtube-studio-dashboard.json` and served from there for a day: a
 * dashboard number that changed twice in an afternoon is not the number a person
 * is asking about. The file is read on every call — nothing is held in this
 * process's memory between visits — and the key covers the account, the channel,
 * the window start and the scopes, so signing in, switching channel or the day
 * rolling over misses instead of serving somebody else's answer.
 *
 * **A failed read is never cached.** A refused or rate-limited read leaves the
 * stored answer where it was, so the page can keep showing the last good numbers
 * with their own `readAt` instead of a zero it invented.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { accountsOf, accessToken, get } = require('../_shared.cjs')
const {
  ytChannels,
  ytWindow,
  YT_TRAFFIC_NAMES,
} = require('./mention.cjs')

const CONNECTOR = 'youtube-studio'
/* One visit, one read. `Refresh` is the only thing that reads sooner. */
const CACHE_MS = 24 * 60 * 60_000
/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'youtube-studio-dashboard.json')
/* Bumped when the payload grows: a stored answer from before the playlist card
   would render a table of dashes rather than a table the reader can trust. */
const CACHE_SCHEMA = 2

const YT_DATA = 'https://www.googleapis.com/youtube/v3'
const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports'

const DEFAULT_DAYS = 28
const MAX_DAYS = 730
/* Analytics is the scale here; anything longer is a mistake or an injection
   attempt, and a Google URL is only ever built from an id that matches this. */
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/
/* The seven counts, in one request. Revenue is deliberately not in this list. */
const METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'subscribersGained',
  'subscribersLost',
  'likes',
  'comments',
].join(',')
const MONEY = 'estimatedRevenue,estimatedAdRevenue'

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** `PT1H2M3S` → 3723. Analytics rates a video by minutes; a length column has to
 *  speak seconds or `1:02:03` becomes `62:03`. */
function secondsOf(iso) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''))
  if (!match) return null
  const [, d, h, m, s] = match.map((part) => Number(part) || 0)
  const total = d * 86_400 + h * 3_600 + m * 60 + s
  return total || null
}

/* ── the day-long cache, on disk ───────────────────────────────────
   One JSON file holds the last answer. `at` is when the read finished, `key` is
   what it was read for, and `value` is the payload verbatim — `readAt` inside it
   is what the page stamps. A cache nobody can write is a cache that misses:
   every failure here is a miss, never a read that fails. */
function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA || !Number.isFinite(raw?.at) || !raw?.value) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(key, value) {
  const body = `${JSON.stringify({ schema: CACHE_SCHEMA, key, at: Date.now(), value }, null, 2)}\n`
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CACHE_FILE)
  } catch {
    /* read-only home, a full disk: the next visit asks Google again. */
  }
}

/* ── the two transports, each recording what it cost ─────────────────
   A call that fails is a *named* gap, not a silent `null`: the page's footers say
   which call produced a card and, when one was not called or was refused, which
   one and what Google said. `null` and `[]` are different answers — a refusal is
   `null`, an empty window is `[]`. */

async function query(token, params, calls, name) {
  const at = Date.now()
  try {
    const url = new URL(YT_ANALYTICS)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const body = await get(url, token, CONNECTOR)
    calls.push({ call: name, ok: true, ms: Date.now() - at })
    const headers = (body.columnHeaders || []).map((header) => String(header?.name || ''))
    return (body.rows || []).map((row) => {
      const out = {}
      for (const [index, header] of headers.entries()) out[header] = row[index]
      return out
    })
  } catch (problem) {
    calls.push({ call: name, ok: false, ms: Date.now() - at, why: reasonOf(problem) })
    return null
  }
}

async function data(token, name, url, calls) {
  const at = Date.now()
  try {
    const body = await get(url, token, CONNECTOR)
    calls.push({ call: name, ok: true, ms: Date.now() - at })
    return body
  } catch (problem) {
    calls.push({ call: name, ok: false, ms: Date.now() - at, why: reasonOf(problem) })
    return null
  }
}

const reasonOf = (problem) => String(problem?.message || problem).slice(0, 300)

/* A quota is a clock and a refused scope is a state of the grant; both arrive as
   `403`, and only the sentence separates them. */
const quotaWhy = (calls) =>
  calls.find((entry) => entry.ok === false && /quota/i.test(String(entry.why || ''))) || null

/* ── who is here, and which channels they own ────────────────────── */

/**
 * Every YouTube Studio account on this machine, with the channels each one owns.
 *
 * A row is one account and never rejects: a refused grant is a row carrying
 * Google's own sentence, because hiding the account would hide which one broke.
 * `channels` comes from one `channels.list` per readable account, and only an
 * account whose token actually refreshes is asked — a row with no token has
 * nothing to ask with.
 */
async function roster() {
  const rows = accountsOf(CONNECTOR)
  const accounts = []
  for (const row of rows) {
    const entry = {
      localpart: String(row.localpart || ''),
      email: String(row.email || ''),
      status: String(row.status || ''),
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      missing: Array.isArray(row.missing) ? row.missing : [],
      hasToken: row.hasToken === true,
      channels: [],
      error: null,
    }
    if (!entry.hasToken) {
      /* Not an error the person caused, but it is why the tab is locked. */
      entry.error = 'no token is stored for this account on this machine'
      accounts.push(entry)
      continue
    }
    try {
      const token = await accessToken(CONNECTOR, entry.localpart)
      const items = await ytChannels(token)
      entry.channels = items
        .filter((item) => item?.id && ID_RE.test(String(item.id)))
        .map((item) => ({
          id: String(item.id),
          title: String(item.snippet?.title || item.id),
          handle: String(item.snippet?.customUrl || ''),
          url: `https://studio.youtube.com/channel/${item.id}`,
          subscribers: num(item.statistics?.subscriberCount),
          videos: num(item.statistics?.videoCount),
          uploads: ID_RE.test(String(item.contentDetails?.relatedPlaylists?.uploads || ''))
            ? String(item.contentDetails.relatedPlaylists.uploads)
            : '',
        }))
      /* `ytChannels` answers `[]` for a refused call as well as for an account
         that owns nothing, so a grant that dies between the refresh and
         `channels.list` reads as "no channel". The card keeps the row either way.
         ponytail: one extra `get` would separate them — only if a real grant
         turns out to die in that window. */
    } catch (problem) {
      entry.error = reasonOf(problem)
    }
    accounts.push(entry)
  }
  return { accounts, readAt: new Date().toISOString() }
}

/* ── the numbers ─────────────────────────────────────────────────── */

/** One Analytics row, in the shape the tiles read. Every field may be `null`. */
function totalsOf(row, revenue) {
  const gained = num(row?.subscribersGained)
  const lost = num(row?.subscribersLost)
  return {
    views: num(row?.views),
    minutes: num(row?.estimatedMinutesWatched),
    avgViewSeconds: num(row?.averageViewDuration),
    avgViewPercent: num(row?.averageViewPercentage),
    gained,
    lost,
    net: gained === null || lost === null ? null : gained - lost,
    likes: num(row?.likes),
    comments: num(row?.comments),
    revenue: num(revenue?.estimatedRevenue),
    adRevenue: num(revenue?.estimatedAdRevenue),
  }
}

/**
 * The video table.
 *
 * Analytics is what makes a *window* number possible, so without it the table
 * falls back to the Data API's lifetime counts — the uploads playlist gives the
 * ids in publish order and `videos.list` gives each one's lifetime views and
 * comments. Those rows carry `lifetime: true` and the card says so: a lifetime
 * count printed under a 28-day heading would be the same lie as a `0`.
 */
async function fallbackVideos(token, picked, calls) {
  const uploads = picked.uploads
  if (!uploads) return { videos: [], videoCount: null, lifetime: true }
  const playlist = new URL(`${YT_DATA}/playlistItems`)
  playlist.searchParams.set('part', 'snippet,contentDetails')
  playlist.searchParams.set('playlistId', uploads)
  playlist.searchParams.set('maxResults', '25')
  const listing = await data(token, 'playlistItems.list', playlist, calls)
  const ids = (listing?.items || [])
    .map((item) => String(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId || ''))
    .filter((id) => ID_RE.test(id))
  if (!ids.length) return { videos: [], videoCount: 0, lifetime: true }

  const detail = new URL(`${YT_DATA}/videos`)
  detail.searchParams.set('part', 'snippet,statistics,status,contentDetails')
  detail.searchParams.set('id', ids.join(','))
  const body = await data(token, 'videos.list', detail, calls)
  const byId = new Map((body?.items || []).map((item) => [String(item.id), item]))
  const videos = ids
    .map((id) => {
      const item = byId.get(id)
      if (!item) return null
      return {
        id,
        title: String(item.snippet?.title || id),
        privacy: String(item.status?.privacyStatus || ''),
        views: num(item.statistics?.viewCount),
        minutes: null,
        likes: num(item.statistics?.likeCount),
        comments: num(item.statistics?.commentCount),
        durationSeconds: secondsOf(item.contentDetails?.duration),
        published: String(item.snippet?.publishedAt || '').slice(0, 10),
        lifetime: true,
      }
    })
    .filter(Boolean)
  return { videos, videoCount: videos.length, lifetime: true }
}

/** Titles, privacy, length and publish dates for the videos the window ranked. */
async function videoMeta(token, ids, calls) {
  if (!ids.length) return new Map()
  const url = new URL(`${YT_DATA}/videos`)
  /* `contentDetails` rides the call that already runs: a length costs no extra
     unit, and the table has a column for it. */
  url.searchParams.set('part', 'snippet,status,contentDetails')
  url.searchParams.set('id', ids.join(','))
  const body = await data(token, 'videos.list', url, calls)
  return new Map((body?.items || []).map((item) => [String(item.id), item]))
}

/**
 * Comments with no reply, oldest first — the thing Studio buries two clicks deep.
 *
 * `commentThreads.list` costs one Data API unit and needs `youtube.force-ssl`, so
 * it is asked only when the grant carries that scope; the card's footer names the
 * scope instead of printing a zero it never measured.
 */
async function unreplied(token, picked, calls) {
  const url = new URL(`${YT_DATA}/commentThreads`)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('allThreadsRelatedToChannelId', picked.id)
  url.searchParams.set('order', 'time')
  url.searchParams.set('maxResults', '100')
  const body = await data(token, 'commentThreads.list', url, calls)
  if (!body) return { comments: null, unreplied: null }
  const waiting = (body.items || [])
    .filter((item) => item?.snippet && Number(item.snippet.totalReplyCount) === 0)
    .map((item) => {
      const snippet = item.snippet
      const top = snippet.topLevelComment?.snippet || {}
      return {
        id: String(item.id || ''),
        author: String(top.authorDisplayName || ''),
        text: String(top.textDisplay || ''),
        videoId: String(snippet.videoId || ''),
        publishedAt: String(top.publishedAt || snippet.publishedAt || ''),
      }
    })
    /* Oldest first: the comment that has waited longest is the one to answer. */
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  const now = Date.now()
  const kept = waiting.slice(0, 3).map((entry) => {
    const at = Date.parse(entry.publishedAt)
    return {
      ...entry,
      waitingDays: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 86_400_000)) : null,
    }
  })
  return { comments: kept, unreplied: waiting.length }
}

/**
 * The playlist table: the playlists Analytics ranked, joined to their titles.
 *
 * Analytics answers the *window* figures (views, watch time); `playlists.list`
 * answers everything else a Studio playlist row carries — how many videos it
 * holds, when the newest one went up. Two reads, because neither answers both.
 *
 * **Growth is deliberately absent.** Analytics refuses a `playlist` dimension
 * joined to a date, so "median views of the newest third against the rest" cannot
 * be computed from one query; asking per playlist would be a call per row. The
 * column is omitted rather than faked.
 * ponytail: no per-playlist growth — upgrade: one `playlist==<id>` query per row,
 * or a cached per-playlist refresh, once a channel asks for it.
 */
async function playlistsOf(token, picked, ranked, calls) {
  if (!ranked) return null
  const seen = new Map()
  for (const row of ranked) {
    const id = String(row.playlist || '')
    if (!ID_RE.test(id)) continue
    seen.set(id, {
      id,
      title: '',
      videoCount: null,
      totalViews: num(row.views),
      minutes: num(row.estimatedMinutesWatched),
      newestPublished: '',
    })
  }
  if (!seen.size) return []

  /* One `.list` covers every id: a per-playlist read would be 25 units for one
     table. Titles are what this read is for — the numbers already arrived. */
  const url = new URL(`${YT_DATA}/playlists`)
  url.searchParams.set('part', 'snippet,contentDetails')
  url.searchParams.set('id', [...seen.keys()].join(','))
  url.searchParams.set('maxResults', '50')
  const body = await data(token, 'playlists.list', url, calls)
  for (const item of body?.items || []) {
    const entry = seen.get(String(item.id))
    if (!entry) continue
    entry.title = String(item.snippet?.title || item.id)
    entry.videoCount = num(item.contentDetails?.itemCount)
    entry.newestPublished = String(item.snippet?.publishedAt || '').slice(0, 10)
  }
  /* A playlist Analytics knows but `playlists.list` did not describe (deleted,
     or moved to private mid-read) keeps its numbers and no name: the row is the
     views, and hiding it would shrink the total somebody came to read. */
  return [...seen.values()]
    .filter((entry) => entry.totalViews !== null)
    /* Watch time per playlist is minutes; the page divides by the count to get an
       average. `medianViews` is **not** here: Analytics answers no per-item row
       for a playlist, and a median over the playlist's newest rows would be a
       number about the last 28 days wearing the playlist's name. */
    .map((entry) => ({ ...entry, channelId: String(picked.id) }))
}

/** Where the views came from, as Studio names it. */
function trafficOf(rows) {
  if (!rows) return null
  const total = rows.reduce((acc, row) => acc + (num(row.views) || 0), 0)
  return rows.slice(0, 6).map((row) => {
    const key = String(row.insightTrafficSourceType || '')
    const views = num(row.views) || 0
    return {
      name: YT_TRAFFIC_NAMES[key] || key || 'Unknown',
      views,
      share: total ? Number(((views / total) * 100).toFixed(1)) : 0,
    }
  })
}

/**
 * Six counts, the daily series, the videos and the traffic for one channel.
 *
 * Throws only when there is nothing to read with — no usable account, no live
 * token, no channel. Everything Google refuses after that is a named gap in
 * `calls` and a `null` field, because a page that throws away the answer it
 * already has is worse than a page with one dash on it.
 */
async function dashboard({ account = '', channel = '', days = DEFAULT_DAYS, force = false } = {}) {
  const rows = accountsOf(CONNECTOR).filter(
    (row) => row.hasToken === true && row.status === 'connected',
  )
  const wanted = String(account || '')
  const row = wanted
    ? rows.find((entry) => entry.localpart === wanted || entry.email === wanted)
    : rows[0]
  if (!row) {
    throw new Error(
      wanted
        ? `No YouTube Studio account called ${wanted} is signed in on this machine.`
        : 'No YouTube Studio account on this machine is answering. Sign in on this page first.',
    )
  }

  const span = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(days)) || DEFAULT_DAYS))
  const window = ytWindow(span)
  const scopes = Array.isArray(row.scopes) ? row.scopes : []
  /* Reading a number and being allowed to read it are different questions. This
     is the grant's answer, not the call's: a scope that is present but whose
     call fails must not be reported as a missing permission — the banner for
     that is `calls`, which says what Google actually said. */
  const canAnalytics = scopes.includes('yt-analytics.readonly')
  const canComments = scopes.includes('youtube.force-ssl')

  /* An empty `channel` means "whichever channel this account leads with", so the
     cache can be consulted before the channel is resolved — a visit that is
     served from the file then costs Google nothing at all. */
  const asked = String(channel || '')
  const key = [
    row.localpart,
    ID_RE.test(asked) ? asked : 'first',
    span,
    window.start,
    scopes.slice().sort().join(','),
  ].join('|')
  const stored = readCache()
  const fresh = stored && stored.key === key && Date.now() - stored.at < CACHE_MS
  if (!force && fresh) return { ...stored.value, cached: true }

  const calls = []
  const token = await accessToken(CONNECTOR, row.localpart)
  const owned = await ytChannels(token)
  /* `ytChannels` answers `[]` for "owns none" and for "the call was refused"
     alike — it is the composer's helper and a preview must never throw. Both
     mean this page has no channel to show, so the sentence names both ways out
     instead of guessing which happened. */
  const picked = ID_RE.test(asked)
    ? owned.find((item) => String(item.id) === asked) || null
    : owned[0]
  if (!picked) {
    throw new Error(
      asked
        ? `@${CONNECTOR}:${row.localpart}: ${asked} is not a channel this grant can read. Sign in again if the channel was there before.`
        : `@${CONNECTOR}:${row.localpart}: no channel came back for this account — sign in with the account that manages one.`,
    )
  }

  const ids = `channel==${picked.id}`

  /* One query per question, all in flight together: nine round trips in sequence
     is nine latencies for one screen. */
  const [current, previous, series, byVideo, traffic, byPlaylist, money, moneyBefore] = await Promise.all([
    canAnalytics
      ? query(
          token,
          { ids, startDate: window.start, endDate: window.end, metrics: METRICS },
          calls,
          'reports.query · totals',
        )
      : null,
    canAnalytics
      ? query(
          token,
          { ids, startDate: window.prevStart, endDate: window.prevEnd, metrics: METRICS },
          calls,
          'reports.query · previous window',
        )
      : null,
    canAnalytics
      ? query(
          token,
          {
            ids,
            startDate: window.start,
            endDate: window.end,
            dimensions: 'day',
            metrics: 'views',
            sort: 'day',
          },
          calls,
          'reports.query · daily series',
        )
      : null,
    canAnalytics
      ? query(
          token,
          {
            ids,
            startDate: window.start,
            endDate: window.end,
            dimensions: 'video',
            metrics: 'views,estimatedMinutesWatched,likes,comments',
            sort: '-views',
            maxResults: 50,
          },
          calls,
          'reports.query · videos',
        )
      : null,
    canAnalytics
      ? query(
          token,
          {
            ids,
            startDate: window.start,
            endDate: window.end,
            dimensions: 'insightTrafficSourceType',
            metrics: 'views',
            sort: '-views',
            maxResults: 25,
          },
          calls,
          'reports.query · traffic sources',
        )
      : null,
    /* The playlist ranking is a second dimension on the same window, so it costs
       one query and the whole table. */
    canAnalytics
      ? query(
          token,
          {
            ids,
            startDate: window.start,
            endDate: window.end,
            dimensions: 'playlist',
            metrics: 'views,estimatedMinutesWatched',
            sort: '-views',
            maxResults: 25,
          },
          calls,
          'reports.query · playlists',
        )
      : null,
    /* Revenue is deliberately its own request: a grant without the monetary scope
       must cost the revenue tile and nothing else. */
    canAnalytics
      ? query(
          token,
          { ids, startDate: window.start, endDate: window.end, metrics: MONEY },
          calls,
          'reports.query · revenue',
        )
      : null,
    canAnalytics
      ? query(
          token,
          { ids, startDate: window.prevStart, endDate: window.prevEnd, metrics: MONEY },
          calls,
          'reports.query · revenue, previous window',
        )
      : null,
  ])

  const totals = current ? totalsOf(current[0], money?.[0]) : null
  const before = previous ? totalsOf(previous[0], moneyBefore?.[0]) : null

  let videos = []
  let videoCount = null
  let lifetime = false
  if (byVideo) {
    videoCount = byVideo.length
    videos = byVideo.slice(0, 10)
    const meta = await videoMeta(
      token,
      videos.map((entry) => String(entry.video)).filter((id) => ID_RE.test(id)),
      calls,
    )
    videos = videos
      .map((entry) => {
        const id = String(entry.video || '')
        if (!ID_RE.test(id)) return null
        const item = meta.get(id)
        return {
          id,
          title: String(item?.snippet?.title || id),
          privacy: String(item?.status?.privacyStatus || ''),
          views: num(entry.views),
          minutes: num(entry.estimatedMinutesWatched),
          likes: num(entry.likes),
          comments: num(entry.comments),
          durationSeconds: secondsOf(item?.contentDetails?.duration),
          published: String(item?.snippet?.publishedAt || '').slice(0, 10),
        }
      })
      .filter(Boolean)
  } else {
    const fallback = await fallbackVideos(token, picked, calls)
    videos = fallback.videos
    videoCount = fallback.videoCount
    lifetime = fallback.lifetime
  }

  let threads = { comments: null, unreplied: null }
  if (canComments) threads = await unreplied(token, picked, calls)
  /* Titles for the videos the comment rows point at, so the second table's
     "Video" column is a title and not a `UC…` id. Free when the ids already came
     back in the top-ten batch. */
  const missing = (threads.comments || [])
    .map((entry) => entry.videoId)
    .filter((id) => ID_RE.test(id) && !videos.some((video) => video.id === id))
  if (missing.length) {
    const meta = await videoMeta(token, [...new Set(missing)], calls)
    threads.comments = (threads.comments || []).map((entry) => ({
      ...entry,
      videoTitle: String(meta.get(entry.videoId)?.snippet?.title || entry.videoId),
    }))
  } else {
    threads.comments = (threads.comments || []).map((entry) => ({
      ...entry,
      videoTitle: videos.find((video) => video.id === entry.videoId)?.title || entry.videoId,
    }))
  }

  const quota = quotaWhy(calls)
  /* A quota is a clock, not an error: the last good answer stays on screen with
     its own `readAt`, which is the only honest thing to show when Google will not
     answer until midnight Pacific. */
  if (quota && stored?.key === key && stored.value) {
    return {
      ...stored.value,
      cached: true,
      stale: true,
      quota: { message: quota.why, readAt: stored.value.readAt },
    }
  }

  const value = {
    key,
    readAt: new Date().toISOString(),
    cached: false,
    /* How long a stored answer stays good, so the page can print the rule rather
       than hardcoding a number that drifts from this constant. */
    cacheTtlMs: CACHE_MS,
    channel: {
      id: String(picked.id),
      title: String(picked.snippet?.title || picked.id),
      handle: String(picked.snippet?.customUrl || ''),
      url: `https://studio.youtube.com/channel/${picked.id}`,
      subscribers: num(picked.statistics?.subscriberCount),
      videos: num(picked.statistics?.videoCount),
      /* Lifetime views for the whole channel. It rides the `channels.list` this
         read already made, so it costs nothing and gives the window's views
         something to be a fraction of. */
      lifetimeViews: num(picked.statistics?.viewCount),
    },
    window: {
      days: span,
      start: window.start,
      end: window.end,
      prevStart: window.prevStart,
      prevEnd: window.prevEnd,
    },
    scopes: {
      analytics: canAnalytics,
      revenue: canAnalytics && money !== null,
      comments: canComments,
    },
    totals,
    previous: before,
    series: series
      ? series.map((entry) => ({
          day: String(entry.day || ''),
          views: num(entry.views) || 0,
        }))
      : null,
    videos,
    videoCount,
    channelVideos: num(picked.statistics?.videoCount),
    lifetime,
    playlists: await playlistsOf(token, picked, byPlaylist, calls),
    traffic: trafficOf(traffic),
    comments: threads.comments,
    unreplied: threads.unreplied,
    calls,
    /* Analytics is not unit-metered; the Data API is, at 10,000 units a day, and
       every `.list` above is one unit. The channel pick is the read the connector
       helper made before this list existed, so it is counted here rather than
       vanished. Print what this read actually spent. */
    quotaUnits: 1 + calls.filter((entry) => /\.list/.test(entry.call)).length,
  }
  /* A refused scope is a stable fact of the grant and worth storing; a spent
     quota is not, because the answer would come back refused for a day. */
  if (!quota) writeCache(key, value)
  return value
}

module.exports = {
  CACHE_MS,
  CACHE_FILE,
  DEFAULT_DAYS,
  roster,
  dashboard,
}
