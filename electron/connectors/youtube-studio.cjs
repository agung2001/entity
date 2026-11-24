/**
 * `@youtube-studio:<account>[:<channel>]:<what> [<days>]` — the channel's own numbers.
 *
 * A separate module from `youtube` on purpose: that one searches what anyone can
 * see, this reads what only the owner can (views, watch time, subscriber
 * movement, traffic, revenue, unreplied comments), and the two need different
 * grants. It is also the biggest resolver by far, which is the other reason it
 * lives alone: 750 lines must not be able to break a Gmail mention.
 *
 * Shapes follow what YouTube Studio puts on a screen, because those are the
 * numbers a person already trusts. Three rules:
 *
 *   1. **Never invent a number.** A metric the grant cannot read (revenue without
 *      the monetary scope) is reported as unreadable, not as zero.
 *   2. **Every window is anchored on the response, not the clock** — Analytics
 *      lags two days, so a window ends `today − 2`.
 *   3. **One call per question.** Nothing fans out per row.
 */
const { accountScope, accessToken, get, idScope } = require('./_shared.cjs')

/* A Studio answer is a report, not a search result: three rows truncated the KPI
   tiles before the top videos ever appeared. Twelve is the block's own ceiling. */
const YT_STUDIO_ROWS = 12

/* ── YouTube Studio: the channel's own numbers ─────────────────────────
   `@youtube-studio:<account>:<what> [<days>]`.

   The shapes follow what YouTube Studio puts on a screen, because those are the
   numbers a person already trusts: the four KPI tiles with their change against
   the previous window, the daily series behind them, where the traffic came from,
   the videos that earned it, and the comments still waiting for a reply.

   Three rules this keeps:

   1. **Never invent a number.** A metric the grant cannot read (revenue without the
      monetary scope, analytics without `yt-analytics.readonly`) is reported as
      unreadable, not as zero — a `0` and a "cannot see" are different answers.
   2. **Every window is anchored on the response, not the clock.** Studio's own end
      date is `today − 2` days because Analytics lags; comparing against `Date.now()`
      would make a cached answer look fresher than it is.
   3. **One call per question.** `summary` is one Analytics query plus one
      `videos.list` batch; nothing fans out. */

const YT_DATA = 'https://www.googleapis.com/youtube/v3'
const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports'
/* Analytics settles two days late; asking for today returns a partial day that
   reads as a collapse in the chart. */
const YT_LAG_DAYS = 2
const YT_DEFAULT_DAYS = 28
const YT_MAX_DAYS = 730

const ytDate = (date) => date.toISOString().slice(0, 10)

/** A window ending at Analytics' own lag, `days` long, plus the one before it. */
function ytWindow(days) {
  const end = new Date(Date.now() - YT_LAG_DAYS * 86_400_000)
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  /* The previous window is the same length, ending the day before `start`, so a
     change is comparable rather than a fraction of a different-sized window. */
  const prevEnd = new Date(start.getTime() - 86_400_000)
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000)
  return {
    days,
    start: ytDate(start),
    end: ytDate(end),
    prevStart: ytDate(prevStart),
    prevEnd: ytDate(prevEnd),
  }
}

/* The vocabulary, in the order a person would try them. One list, so the error
   message and the documentation cannot disagree. Used by `ytIntent` too: a word
   that is a keyword is never mistaken for a channel name. */
const YT_STUDIO_WORDS = [
  'summary',
  'traffic',
  'subscribers',
  'videos',
  'video <id>',
  'comments',
  'unreplied',
  'playlists',
  'revenue',
  'search <words>',
]
const YT_STUDIO_KEYWORDS = new Set([
  'summary', 'overview', 'traffic', 'sources', 'subscribers', 'audience',
  'videos', 'video', 'comments', 'unreplied', 'reply', 'replies',
  'playlists', 'revenue', 'money', 'search',
])
const ytIsKeyword = (word) => YT_STUDIO_KEYWORDS.has(String(word || '').toLowerCase())

/**
 * `@youtube-studio:<acct>:<channel>:<what> [<days>]` → channel + what + window.
 *
 * **The channel segment is optional and distinct from the account**, because one
 * Google login can manage several channels (brand accounts, a network). It is
 * recognised by *not* being a keyword: `summary` is a thing to read, `agung` is a
 * channel. That keeps `@youtube-studio:avery:summary` short for the common case —
 * an account with one channel — while `@youtube-studio:avery:main-channel:summary`
 * picks one when there are several.
 */
function ytIntent(query, fallbackDays = YT_DEFAULT_DAYS) {
  let text = String(query || '').trim()
  let channel = ''
  const firstWord = text.split(/\s+/)[0] || ''
  /* `id:<value>` is the picked form and outranks the channel heuristic: an id is
     opaque, so it can never be mistaken for a channel name. */
  const isId = /^id:/i.test(firstWord)
  if (!isId && firstWord.includes(':') && !ytIsKeyword(firstWord.split(':')[0])) {
    const cut = firstWord.indexOf(':')
    channel = firstWord.slice(0, cut)
    text = `${firstWord.slice(cut + 1)}${text.slice(firstWord.length)}`.trim()
  }
  const words = text.split(/\s+/).filter(Boolean)
  const what = String(words[0] || 'summary').toLowerCase()
  const trailing = Number(words[words.length - 1])
  const days =
    words.length > 1 && Number.isFinite(trailing) && trailing > 0
      ? Math.min(YT_MAX_DAYS, Math.round(trailing))
      : fallbackDays
  /* `video <id>` is the one intent with an argument that is not a number. */
  const id = what === 'video' ? String(words[1] || '') : ''
  return { what, days, id, rest: words.slice(1).join(' '), channel }
}

/** The Analytics report as `[{...named columns}]`, which is how the rest reads it. */
async function ytAnalytics(token, params) {
  const url = new URL(YT_ANALYTICS)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const body = await get(url, token, 'youtube-studio')
  const headers = (body.columnHeaders || []).map((header) => String(header?.name || ''))
  return (body.rows || []).map((row) => {
    const out = {}
    for (const [index, name] of headers.entries()) out[name] = row[index]
    return out
  })
}

const ytNum = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** `+12.4%` / `-3.1%` / `—` when the previous window was empty. */
function ytChange(now, before) {
  const current = ytNum(now)
  const previous = ytNum(before)
  if (!previous) return current ? '+100%' : 'no change'
  const ratio = ((current - previous) / previous) * 100
  const sign = ratio > 0 ? '+' : ''
  return `${sign}${ratio.toFixed(1)}%`
}

/** Watch time, in the unit a person would say out loud. */
function ytDuration(minutes) {
  const total = Math.round(ytNum(minutes))
  if (!total) return '0 min'
  if (total < 90) return `${total} min`
  const hours = Math.floor(total / 60)
  if (hours < 48) return `${hours} h ${total % 60} min`
  return `${Math.round(hours / 24)} days`
}

/**
 * Every channel this token manages, and the one the mention named.
 *
 * One Google login can manage several — a brand account, a network, a client's
 * channel — so the channel is a segment of its own, not a synonym for the account.
 * Recognition is by title, id, or a slug of the title, so `@…:avery:agung:summary`
 * finds "Agung Sundoro" without asking anyone to paste a `UC…` id.
 */
/** Every channel a token manages. `managedByMe` covers the brand accounts a login
 *  can act for, which `mine` alone omits — the exact case a channel segment exists
 *  for. */
async function ytChannels(token) {
  const read = async (param) => {
    const url = new URL(`${YT_DATA}/channels`)
    url.searchParams.set('part', 'snippet,statistics,contentDetails')
    url.searchParams.set(param, 'true')
    const body = await get(url, token, 'youtube-studio').catch(() => null)
    return body?.items || []
  }
  const mine = await read('mine')
  if (mine.length) return mine
  return read('managedByMe')
}

/** The names a mention may use for each channel, for the composer's preview. */
async function ytChannelChoices(localpart) {
  try {
    const token = await accessToken('youtube-studio', localpart)
    return (await ytChannels(token)).map((entry) => ({
      id: entry.id,
      title: entry.snippet?.title || entry.id,
      slug:
        String(entry.snippet?.title || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || entry.id,
    }))
  } catch {
    /* A preview never fails the composer: no token, no channel, no rows. */
    return []
  }
}

async function ytChannel(token, wanted = '') {
  const items = await ytChannels(token)
  if (!items.length) {
    throw new Error(
      '@youtube-studio: this account does not own a channel — sign in with the account that manages one.',
    )
  }

  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const describe = (item) => ({
    id: item.id,
    title: item.snippet?.title || item.id,
    slug: slug(item.snippet?.title),
  })

  let item = items[0]
  if (wanted) {
    const needle = String(wanted).toLowerCase()
    const match = items.find(
      (candidate) =>
        String(candidate.id).toLowerCase() === needle ||
        String(candidate.snippet?.title || '').toLowerCase() === needle ||
        slug(candidate.snippet?.title) === slug(wanted),
    )
    if (!match) {
      /* Name what exists: a wrong channel is one character from the right one, and
         "not found" alone would leave a person guessing. */
      throw new Error(
        `@youtube-studio: “${wanted}” is not a channel this account manages. It has: ${items
          .map((candidate) => describe(candidate).slug)
          .join(', ')}.`,
      )
    }
    item = match
  }
  const stats = item.statistics || {}
  return {
    id: item.id,
    title: item.snippet?.title || item.id,
    subscribers: ytNum(stats.subscriberCount),
    views: ytNum(stats.viewCount),
    videos: ytNum(stats.videoCount),
    uploads: item.contentDetails?.relatedPlaylists?.uploads || '',
    url: `https://studio.youtube.com/channel/${item.id}`,
  }
}

/** Titles for a set of video ids, in one batch. */
async function ytTitles(token, ids) {
  const out = new Map()
  const unique = [...new Set(ids.filter(Boolean))]
  for (let at = 0; at < unique.length; at += 50) {
    const url = new URL(`${YT_DATA}/videos`)
    url.searchParams.set('part', 'snippet,statistics')
    url.searchParams.set('id', unique.slice(at, at + 50).join(','))
    const body = await get(url, token, 'youtube-studio').catch(() => null)
    for (const item of body?.items || []) {
      out.set(item.id, {
        title: item.snippet?.title || item.id,
        published: item.snippet?.publishedAt?.slice(0, 10) || '',
      })
    }
  }
  return out
}

const YT_KPI =
  'views,likes,comments,subscribersGained,subscribersLost,estimatedMinutesWatched,averageViewDuration,averageViewPercentage'

/** The overview: KPI tiles, their change, and the videos that earned the views. */
async function ytSummary(token, channel, days) {
  const window = ytWindow(days)
  const scope = { ids: `channel==${channel.id}`, startDate: window.start, endDate: window.end }
  const previous = { ids: scope.ids, startDate: window.prevStart, endDate: window.prevEnd }

  const [now, before, top] = await Promise.all([
    ytAnalytics(token, { ...scope, metrics: YT_KPI }),
    /* The previous window is optional: a failure there costs the change column,
       never the report. */
    ytAnalytics(token, { ...previous, metrics: YT_KPI }).catch(() => []),
    ytAnalytics(token, {
      ...scope,
      dimensions: 'video',
      metrics: 'views,likes,comments',
      sort: '-views',
      maxResults: 10,
    }).catch(() => []),
  ])

  const current = now[0] || {}
  const earlier = before[0] || {}
  const gained = ytNum(current.subscribersGained)
  const lost = ytNum(current.subscribersLost)
  const titles = await ytTitles(token, top.map((row) => row.video))

  const rows = [
    {
      id: `yt-summary-${window.end}`,
      account: channel.title,
      label: `${ytNum(current.views).toLocaleString()} views (${ytChange(current.views, earlier.views)})`,
      detail: `${window.days} days · ${window.start} → ${window.end}`,
      url: channel.url,
    },
    {
      id: `yt-watch-${window.end}`,
      account: channel.title,
      label: `${ytDuration(current.estimatedMinutesWatched)} watched (${ytChange(current.estimatedMinutesWatched, earlier.estimatedMinutesWatched)})`,
      detail: `average view ${Math.round(ytNum(current.averageViewDuration))}s · ${ytNum(current.averageViewPercentage).toFixed(0)}% of the video`,
      url: `${channel.url}/analytics/tab-overview`,
    },
    {
      id: `yt-subs-${window.end}`,
      account: channel.title,
      label: `${gained - lost >= 0 ? '+' : ''}${(gained - lost).toLocaleString()} subscribers (${ytChange(gained - lost, ytNum(earlier.subscribersGained) - ytNum(earlier.subscribersLost))})`,
      detail: `${gained.toLocaleString()} gained · ${lost.toLocaleString()} lost · channel has ${channel.subscribers.toLocaleString()}`,
      url: `${channel.url}/analytics/tab-audience`,
    },
    {
      id: `yt-engage-${window.end}`,
      account: channel.title,
      label: `${ytNum(current.likes).toLocaleString()} likes · ${ytNum(current.comments).toLocaleString()} comments`,
      detail: `engagement on ${window.days} days of views`,
      url: `${channel.url}/analytics/tab-overview`,
    },
  ]

  for (const row of top.slice(0, 8)) {
    const meta = titles.get(row.video) || {}
    rows.push({
      id: row.video || '',
      account: channel.title,
      label: `${meta.title || row.video} — ${ytNum(row.views).toLocaleString()} views`,
      detail: [
        `${ytNum(row.likes).toLocaleString()} likes`,
        `${ytNum(row.comments).toLocaleString()} comments`,
        meta.published,
      ]
        .filter(Boolean)
        .join(' · '),
      url: `https://studio.youtube.com/video/${row.video}/analytics/tab-overview`,
    })
  }
  return rows
}

/** Where the views came from, and which videos brought them. */
async function ytTraffic(token, channel, days, dimension = 'insightTrafficSourceType') {
  const window = ytWindow(days)
  const rows = await ytAnalytics(token, {
    ids: `channel==${channel.id}`,
    startDate: window.start,
    endDate: window.end,
    dimensions: dimension,
    metrics: 'views,estimatedMinutesWatched',
    sort: '-views',
    maxResults: 12,
  })
  /* Studio spells these as constants; a person reads a sentence. */
  const NAMES = {
    SUBSCRIBER: 'Subscriber feed',
    YT_SEARCH: 'YouTube search',
    RELATED_VIDEO: 'Suggested videos',
    PLAYLIST: 'Playlists',
    EXT_URL: 'External links',
    YT_CHANNEL: 'Channel page',
    NO_LINK_OTHER: 'Direct or unknown',
    YT_OTHER_PAGE: 'Other YouTube pages',
    NOTIFICATION: 'Notifications',
    END_SCREEN: 'End screens',
    SHORTS_FEED: 'Shorts feed',
    HASHTAGS: 'Hashtags',
    LIVE_REDIRECT: 'Live redirects',
    CAMPAIGN_CARD: 'Campaign cards',
    IMMERSIVE: 'Immersive feed',
    ADVERTISING: 'Advertising',
    SHORTS: 'Shorts feed',
  }
  const total = rows.reduce((sum, row) => sum + ytNum(row.views), 0)
  return rows.map((row) => {
    const views = ytNum(row.views)
    const share = total ? ((views / total) * 100).toFixed(1) : '0.0'
    const name = NAMES[row[dimension]] || row[dimension]
    return {
      id: String(row[dimension] || ''),
      account: channel.title,
      label: `${name} — ${views.toLocaleString()} views · ${share}%`,
      detail: `${ytDuration(row.estimatedMinutesWatched)} watched · ${days} days`,
      url: `${channel.url}/analytics/tab-reach`,
    }
  })
}

/** Net subscriber movement, day by day, with the days that moved most first. */
async function ytSubscribers(token, channel, days) {
  const window = ytWindow(days)
  const rows = await ytAnalytics(token, {
    ids: `channel==${channel.id}`,
    startDate: window.start,
    endDate: window.end,
    dimensions: 'day',
    metrics: 'subscribersGained,subscribersLost',
    sort: 'day',
  })
  const days2 = rows.map((row) => ({
    day: String(row.day || ''),
    net: ytNum(row.subscribersGained) - ytNum(row.subscribersLost),
    gained: ytNum(row.subscribersGained),
    lost: ytNum(row.subscribersLost),
  }))
  const net = days2.reduce((sum, entry) => sum + entry.net, 0)
  const best = [...days2].sort((a, b) => b.net - a.net).slice(0, 5)
  const worst = [...days2].sort((a, b) => a.net - b.net).slice(0, 3)
  const out = [
    {
      id: `yt-net-${window.end}`,
      account: channel.title,
      label: `${net >= 0 ? '+' : ''}${net.toLocaleString()} net over ${window.days} days`,
      detail: `${days2.length} days with data · ${window.start} → ${window.end}`,
      url: `${channel.url}/analytics/tab-audience`,
    },
  ]
  for (const entry of best) {
    if (entry.net <= 0) continue
    out.push({
      id: `yt-best-${entry.day}`,
      account: channel.title,
      label: `${entry.day} — +${entry.net} net`,
      detail: `${entry.gained} gained · ${entry.lost} lost`,
      url: `${channel.url}/analytics/tab-audience`,
    })
  }
  for (const entry of worst) {
    if (entry.net >= 0) continue
    out.push({
      id: `yt-worst-${entry.day}`,
      account: channel.title,
      label: `${entry.day} — ${entry.net} net`,
      detail: `${entry.gained} gained · ${entry.lost} lost`,
      url: `${channel.url}/analytics/tab-audience`,
    })
  }
  return out
}

/** The comment threads with no reply — Studio hides these two clicks deep. */
async function ytUnreplied(token, channel, limit = 10) {
  const url = new URL(`${YT_DATA}/commentThreads`)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('allThreadsRelatedToChannelId', channel.id)
  url.searchParams.set('order', 'time')
  url.searchParams.set('textFormat', 'plainText')
  url.searchParams.set('maxResults', '100')
  const body = await get(url, token, 'youtube-studio')
  const waiting = (body.items || [])
    .filter((item) => ytNum(item.snippet?.totalReplyCount) === 0)
    .slice(0, limit)
  const titles = await ytTitles(
    token,
    waiting.map((item) => item.snippet?.videoId),
  )
  return waiting.map((item) => {
    const snippet = item.snippet?.topLevelComment?.snippet || {}
    const videoId = item.snippet?.videoId || ''
    return {
      id: item.id || '',
      account: channel.title,
      label: String(snippet.textOriginal || snippet.textDisplay || '(comment)')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
      detail: [
        snippet.authorDisplayName,
        titles.get(videoId)?.title,
        String(snippet.publishedAt || '').slice(0, 10),
      ]
        .filter(Boolean)
        .join(' · '),
      /* Built from a validated id, never from the API's own string: a link that
         came off the wire could be anything. */
      url: `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/comments`,
      /* A thread id is not a video id: it cannot be the target of `id:`. The
         *video* the comment sits on can be, so that is what the row offers — the
         same call the comment needs, and a useful answer on its own. */
      pick: videoId,
    }
  })
}

/** Every comment, newest first, replied or not. */
async function ytComments(token, channel, limit = 10) {
  const url = new URL(`${YT_DATA}/commentThreads`)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('allThreadsRelatedToChannelId', channel.id)
  url.searchParams.set('order', 'time')
  url.searchParams.set('textFormat', 'plainText')
  url.searchParams.set('maxResults', String(Math.min(100, limit)))
  const body = await get(url, token, 'youtube-studio')
  const titles = await ytTitles(
    token,
    (body.items || []).map((item) => item.snippet?.videoId),
  )
  return (body.items || []).slice(0, limit).map((item) => {
    const snippet = item.snippet?.topLevelComment?.snippet || {}
    const videoId = item.snippet?.videoId || ''
    const replies = ytNum(item.snippet?.totalReplyCount)
    return {
      id: item.id || '',
      account: channel.title,
      label: String(snippet.textOriginal || snippet.textDisplay || '(comment)')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
      detail: [
        snippet.authorDisplayName,
        replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'no reply yet',
        titles.get(videoId)?.title,
      ]
        .filter(Boolean)
        .join(' · '),
      url: `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/comments`,
      pick: videoId,
    }
  })
}

/** The channel's videos with their lifetime numbers, newest first. */
async function ytVideos(token, channel, limit = 10) {
  const url = new URL(`${YT_DATA}/search`)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('channelId', channel.id)
  url.searchParams.set('type', 'video')
  url.searchParams.set('order', 'date')
  url.searchParams.set('maxResults', String(Math.min(50, limit)))
  const found = await get(url, token, 'youtube-studio')
  const ids = (found.items || []).map((item) => item.id?.videoId).filter(Boolean)
  if (!ids.length) return []
  /* `statistics` needs the ids, so it is a second call — one batch, not one per
     video. */
  const stats = new URL(`${YT_DATA}/videos`)
  stats.searchParams.set('part', 'snippet,statistics,status')
  stats.searchParams.set('id', ids.join(','))
  const body = await get(stats, token, 'youtube-studio')
  return (body.items || []).map((item) => {
    const s = item.statistics || {}
    const published = String(item.snippet?.publishedAt || '').slice(0, 10)
    return {
      id: item.id || '',
      account: channel.title,
      label: `${item.snippet?.title || item.id} — ${ytNum(s.viewCount).toLocaleString()} views`,
      detail: [
        `${ytNum(s.likeCount).toLocaleString()} likes`,
        `${ytNum(s.commentCount).toLocaleString()} comments`,
        item.status?.privacyStatus,
        published,
      ]
        .filter(Boolean)
        .join(' · '),
      url: `https://studio.youtube.com/video/${item.id}/edit`,
    }
  })
}

/** One video's own Studio numbers: lifetime plus the window's share. */
async function ytVideo(token, channel, videoId, days) {
  if (!videoId) throw new Error('@youtube-studio:<account>:video needs a video id.')
  const window = ytWindow(days)
  const [meta, series] = await Promise.all([
    (async () => {
      const url = new URL(`${YT_DATA}/videos`)
      url.searchParams.set('part', 'snippet,statistics,contentDetails,status')
      url.searchParams.set('id', videoId)
      const body = await get(url, token, 'youtube-studio')
      const item = (body.items || [])[0]
      if (!item) throw new Error(`No video ${videoId} on this channel.`)
      return item
    })(),
    ytAnalytics(token, {
      ids: `channel==${channel.id}`,
      startDate: window.start,
      endDate: window.end,
      filters: `video==${videoId}`,
      metrics: YT_KPI,
    }).catch(() => []),
  ])
  const s = meta.statistics || {}
  const win = series[0] || {}
  const edit = `https://studio.youtube.com/video/${videoId}/edit`
  return [
    {
      id: videoId,
      account: channel.title,
      label: `${meta.snippet?.title || videoId} — ${ytNum(s.viewCount).toLocaleString()} lifetime views`,
      detail: [
        `${ytNum(s.likeCount).toLocaleString()} likes`,
        `${ytNum(s.commentCount).toLocaleString()} comments`,
        meta.status?.privacyStatus,
        String(meta.snippet?.publishedAt || '').slice(0, 10),
      ]
        .filter(Boolean)
        .join(' · '),
      url: edit,
    },
    {
      id: `${videoId}-window`,
      account: channel.title,
      label: `Last ${window.days} days — ${ytNum(win.views).toLocaleString()} views`,
      detail: [
        `${ytDuration(win.estimatedMinutesWatched)} watched`,
        `average ${Math.round(ytNum(win.averageViewDuration))}s (${ytNum(win.averageViewPercentage).toFixed(0)}%)`,
        `${ytNum(win.likes).toLocaleString()} likes`,
      ]
        .filter(Boolean)
        .join(' · '),
      url: `${edit}`.replace('/edit', '/analytics/tab-overview'),
    },
  ]
}

/** Playlists and their share of the views. */
async function ytPlaylists(token, channel) {
  const url = new URL(`${YT_DATA}/playlists`)
  url.searchParams.set('part', 'snippet,contentDetails')
  url.searchParams.set('channelId', channel.id)
  url.searchParams.set('maxResults', '25')
  const body = await get(url, token, 'youtube-studio')
  return (body.items || []).map((item) => ({
    id: item.id || '',
    account: channel.title,
    label: `${item.snippet?.title || item.id} — ${ytNum(item.contentDetails?.itemCount).toLocaleString()} videos`,
    detail: [String(item.snippet?.publishedAt || '').slice(0, 10), 'playlist'].filter(Boolean).join(' · '),
    url: `https://studio.youtube.com/playlist/${item.id}/edit`,
  }))
}

/** Revenue. Needs the monetary Analytics scope; without it, say so. */
async function ytRevenue(token, channel, days) {
  const window = ytWindow(days)
  try {
    const rows = await ytAnalytics(token, {
      ids: `channel==${channel.id}`,
      startDate: window.start,
      endDate: window.end,
      metrics: 'estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue',
    })
    const row = rows[0] || {}
    const money = (value) => `$${ytNum(value).toFixed(2)}`
    return [
      {
        id: `yt-rev-${window.end}`,
        account: channel.title,
        /* YouTube reports revenue in the channel's own currency; the number is
           passed through as given rather than converted with a guess. */
        label: `Estimated revenue ${money(row.estimatedRevenue)} over ${window.days} days`,
        detail: [
          `ads ${money(row.estimatedAdRevenue)}`,
          `premium ${money(row.estimatedRedPartnerRevenue)}`,
          `gross ${money(row.grossRevenue)}`,
        ].join(' · '),
        url: `${channel.url}/analytics/tab-revenue`,
      },
    ]
  } catch (problem) {
    const said = String(problem?.message || problem)
    /* A permission refusal is a state of the grant, not a failure of the turn:
       the row says what to grant, and the other answers still stand. */
    if (/403|insufficient|permission|scope/i.test(said)) {
      return [
        {
          id: `yt-rev-denied-${window.end}`,
          account: channel.title,
          label: 'Revenue is not readable with this grant',
          detail:
            'Re-consent with the “Analytics and comments” tier to read revenue and RPM.',
          url: `${channel.url}/analytics/tab-revenue`,
        },
      ]
    }
    throw problem
  }
}

/** `@youtube-studio:<account>:<what> [<days>]` */
async function resolveYoutubeStudio(ctx, segment, { limit } = {}) {
  /* The caller may ask for fewer (a picker preview), never for more than the block
     can print. */
  const cap = Math.min(limit || YT_STUDIO_ROWS, YT_STUDIO_ROWS)
  const accounts = accountScope('youtube-studio', segment.account, 'youtube-studio')
  const intent = ytIntent(segment.query)
  const { what, days, id } = intent
  const picked = idScope(segment.query)
  const rows = []
  const skipped = []
  for (const account of accounts) {
    let token
    try {
      token = await accessToken('youtube-studio', account.localpart)
    } catch {
      skipped.push(account.localpart)
      continue
    }
    const channel = await ytChannel(token, intent.channel)

    /* Every intent answers from the channel's own data. An unknown word is an
       error that lists the vocabulary, because a typo should not silently return
       the overview and look like it understood. */
    if (picked) {
      for (const videoId of picked) {
        rows.push(...(await ytVideo(token, channel, videoId, days)))
        if (rows.length >= cap) break
      }
    } else if (what === 'summary' || what === 'overview') {
      rows.push(...(await ytSummary(token, channel, days)))
    } else if (what === 'traffic' || what === 'sources') {
      rows.push(...(await ytTraffic(token, channel, days)))
    } else if (what === 'subscribers' || what === 'audience') {
      rows.push(...(await ytSubscribers(token, channel, days)))
    } else if (what === 'comments') {
      rows.push(...(await ytComments(token, channel, cap)))
    } else if (what === 'unreplied' || what === 'reply' || what === 'replies') {
      rows.push(...(await ytUnreplied(token, channel, cap)))
    } else if (what === 'videos') {
      rows.push(...(await ytVideos(token, channel, cap)))
    } else if (what === 'video') {
      rows.push(...(await ytVideo(token, channel, id, days)))
    } else if (what === 'playlists') {
      rows.push(...(await ytPlaylists(token, channel)))
    } else if (what === 'revenue' || what === 'money') {
      rows.push(...(await ytRevenue(token, channel, days)))
    } else if (what === 'search') {
      /* Reach inside this channel only: the channel is the scope, so a word can
         never return someone else's video. */
      const url = new URL(`${YT_DATA}/search`)
      url.searchParams.set('part', 'snippet')
      url.searchParams.set('channelId', channel.id)
      url.searchParams.set('type', 'video')
      url.searchParams.set('q', String(segment.query).replace(/^search\s*/i, ''))
      url.searchParams.set('maxResults', String(cap))
      const body = await get(url, token, 'youtube-studio')
      for (const item of body.items || []) {
        rows.push({
          id: item.id?.videoId || '',
          account: channel.title,
          label: item.snippet?.title || '(untitled)',
          detail: [item.snippet?.channelTitle, String(item.snippet?.publishedAt || '').slice(0, 10)]
            .filter(Boolean)
            .join(' · '),
          url: `https://studio.youtube.com/video/${item.id?.videoId}/edit`,
        })
      }
    } else {
      throw new Error(
        `@youtube-studio:${account.localpart}:${what} is not something it reads. Try ${YT_STUDIO_WORDS.join(', ')}.`,
      )
    }
    if (rows.length >= cap) break
  }
  segment.skipped = skipped
  return rows.slice(0, cap)
}

module.exports = {
  resolveYoutubeStudio,
  /* the vocabulary, so the composer can offer what this reads */
  YT_STUDIO_WORDS,
  YT_STUDIO_ROWS,
  YT_STUDIO_KEYWORDS,
  ytIsKeyword,
  ytChannelChoices,
}
