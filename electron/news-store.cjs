/**
 * News: what this workspace's RSS connectors last said.
 *
 * Read-only by construction. A feed is a **connector** — `connectors.json` holds
 * the row and its URL — and this module never writes one: the only file it ever
 * touches is `news-snapshot.json`, and it only ever replaces it with a *better*
 * answer. That is what makes the page safe: there is no route from News to a new,
 * edited or removed feed, so a read can never be a write to someone's config.
 *
 * Fetched here, in the main process, credentialless: a URL is the whole feed, so
 * there is no token to leak into a renderer, and 8 s / 512 kB are policy applied
 * where the request actually happens. One feed failing is one row's failure — the
 * snapshot is written when **at least one** feed answered, and kept untouched
 * when none did, so a bad hour never deletes a good read.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const connectorStore = require('./connector-store.cjs')

const FILE = 'news-snapshot.json'
const TTL = 6 * 60 * 60 * 1000
const CAP = 512 * 1024
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The installed `rss` rows, in index order — the feeds a read would fetch. */
function feeds({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const rows = connectorStore.readIndex(record).rows || {}
  return Object.entries(rows)
    .filter(([, row]) => row.kind === 'rss' && row.url)
    .map(([id, row]) => ({
      id,
      label: row.label || id,
      url: String(row.url),
      /* The feed's own ceiling, from the row's `fields` — one number per feed, so a
         filter is never the thing standing between an aggregator and the page. */
      limit: connectorStore.itemLimitOf(row),
    }))
}

/** A feed's ceiling, for a caller that built the feed by hand (the probe, a test). */
const limitOf = (feed) =>
  Number.isInteger(feed?.limit) ? feed.limit : connectorStore.DEFAULT_ITEM_LIMIT

/* ── parsing: RSS 2.0 and Atom, with string tools only ──────────────────
   A dependency for two element names would be a dependency to audit, pin and
   ship; the two shapes this page reads are stable and small. `&amp;` last, so a
   feed's own escaped entity survives one decode. */
const decode = (value) =>
  String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim()

const tagOf = (chunk, name) => {
  const hit = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return hit ? decode(hit[1]) : ''
}

/**
 * The stories Google attaches to a trend: up to three `<ht:news_item>` blocks of
 * its own, each with a headline, a link and a publisher.
 *
 * Only `http(s)` links survive: this is somebody else's markup, and an `href` out
 * of it is a link this app hands to a browser. A block with no headline or no
 * usable URL is dropped rather than printed as an empty row. `snippet` is not
 * read because this feed leaves it empty.
 */
function newsOf(chunk) {
  return chunk
    .split(/<ht:news_item[\s>]/i)
    .slice(1)
    .map((block) => ({
      title: tagOf(block, 'ht:news_item_title'),
      url: tagOf(block, 'ht:news_item_url'),
      source: tagOf(block, 'ht:news_item_source'),
    }))
    .filter((story) => story.title && /^https?:\/\//i.test(story.url))
}

const linkOf = (chunk) => {
  const alternate = chunk.match(/<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i)
  if (alternate) return decode(alternate[1])
  const inline = chunk.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)
  if (inline && inline[1].trim()) return decode(inline[1])
  const href = chunk.match(/<link\b[^>]*\bhref="([^"]+)"/i)
  return href ? decode(href[1]) : ''
}

const iso = (value) => {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

const isTrends = (url) => /^https?:\/\/trends\.google\./i.test(url)

/**
 * The channel's own name: RSS's `<channel><title>` or Atom's `<feed><title>`.
 *
 * Read from the head of the document — everything before the first item — because
 * the parser's `tagOf` would otherwise find the first *item's* title, which is a
 * headline and not the feed.
 */
const channelTitleOf = (body) => {
  const head = String(body).split(/<item[\s>]|<entry[\s>]/i)[0]
  return tagOf(head, 'title')
}

/** The `<item>` / `<entry>` bodies, or an empty list for a document with neither. */
function blocksOf(body) {
  const atom = body.split(/<entry[\s>]/i)
  if (atom.length > 1) return atom.slice(1).map((chunk) => chunk.split(/<\/entry>/i)[0])
  const rss = body.split(/<item[\s>]/i)
  return rss.length > 1 ? rss.slice(1).map((chunk) => chunk.split(/<\/item>/i)[0]) : []
}

/**
 * One feed's items, ranked by their own order — `rank` is the position in the
 * feed, never renumbered by a filter downstream, because a renumbered rank would
 * claim the filtered set is the whole set.
 */
function parseFeed(body, feed) {
  const blocks = blocksOf(body)
  if (!blocks.length) throw new Error('carried no items')
  const trend = isTrends(feed.url)
  return blocks.map((chunk, index) => ({
    feedId: feed.id,
    feed: feed.label,
    rank: index + 1,
    title: tagOf(chunk, 'title'),
    url: linkOf(chunk),
    published: iso(tagOf(chunk, 'pubDate') || tagOf(chunk, 'published') || tagOf(chunk, 'updated')),
    /* Only Google prints a figure, and it is printed back exactly — the `+`
       included. Anything else is `''`, never an invented number. */
    volume: trend ? tagOf(chunk, 'ht:approx_traffic') : '',
    /* ponytail: Trends' geo name would need a country table to render
       `explore → google trends · indonesia`; the URL's own code is not a name, so
       the subline stops at the source until a table is worth its lines. */
    provenance: trend ? 'explore → google trends' : feed.label,
    /* A trend's own page has one thing to add: the articles behind the search.
       The list prints four facts and stays quiet; the page a row opens prints
       these, because a reader who clicked a trend is asking what happened. */
    news: trend ? newsOf(chunk) : [],
  }))
}

/* ── fetching ───────────────────────────────────────────────────────── */

async function readCapped(response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > CAP) {
      try {
        await reader.cancel()
      } catch {
        /* the body is already gone; the refusal stands */
      }
      throw new Error('larger than 512 kB')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One feed, in isolation: a failure is this feed's sentence, never a thrown read. */
const said = (error) => {
  const reason = String(error?.message || error)
  /* A timeout and a dead host both arrive as transport errors; both read as a
     sentence here so the note can print `<Feed> timed out after 8s`. */
  if (/timeout|abort/i.test(reason)) return 'timed out after 8s'
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network/i.test(reason)) {
    return `could not be reached (${reason})`
  }
  return reason
}

async function fetchFeed(feed) {
  try {
    if (!/^https?:\/\//i.test(feed.url)) throw new Error('is not an http or https URL')
    const response = await fetch(feed.url, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept:
          'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      },
      signal: AbortSignal.timeout(8_000),
    })
    /* A redirect re-checked on the URL that answered: `follow` would happily
       leave http(s) for something else, and the check before the request cannot
       see that. */
    if (!/^https?:\/\//i.test(String(response.url || feed.url))) {
      throw new Error('redirected away from http or https')
    }
    if (!response.ok) throw new Error(`returned ${response.status} ${response.statusText}`.trim())
    if (/text\/html/i.test(String(response.headers.get('content-type') || ''))) {
      throw new Error('answered HTML, not a feed')
    }
    const body = await readCapped(response)
    if (/^\s*<(!doctype\s+html|html)\b/i.test(body)) throw new Error('answered HTML, not a feed')
    const items = parseFeed(body, feed)
    /* The ceiling is applied here, between the parse and the snapshot, so no later
       reader has to remember it: one aggregator returning 300 items cannot flood
       General, and `total` keeps the honest count for the probe's sentence. */
    return {
      feed,
      items: items.slice(0, limitOf(feed)),
      total: items.length,
      title: channelTitleOf(body),
    }
  } catch (error) {
    return { feed, error: `${feed.label} ${said(error)}` }
  }
}

/* ── the snapshot ───────────────────────────────────────────────────── */

const fileOf = (record) => path.join(record.path, FILE)

function readSnapshot(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(raw?.items) || !Array.isArray(raw?.feeds)) return null
    return { readAt: String(raw.readAt || ''), feeds: raw.feeds, items: raw.items }
  } catch {
    return null
  }
}

function writeSnapshot(file, snapshot) {
  const staged = `${file}.${process.pid}.tmp`
  fs.writeFileSync(staged, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  fs.renameSync(staged, file)
}

/* `trend` travels with the entry so the page can tell the one Google feed from
   the news feeds without re-deriving the rule from a URL on the renderer side. */
const entryOf = ({ feed, items, error }) => ({
  id: feed.id,
  label: feed.label,
  url: feed.url,
  trend: isTrends(feed.url),
  status: error ? 'failed' : 'ok',
  count: error ? 0 : items.length,
  error: error || '',
})

/**
 * The stored read, with membership applied as a *report*: a feed that is no
 * longer installed keeps its rows and its chip until the next read replaces the
 * snapshot, and simply says it is leaving. A removal is a fact about the
 * snapshot, not an edit to it.
 */
function decorate(snapshot, installed) {
  const current = new Map(installed.map((feed) => [feed.id, feed]))
  return {
    readAt: snapshot.readAt,
    feeds: snapshot.feeds.map((entry) => {
      const live = current.get(entry.id)
      return live
        ? { ...entry, label: live.label, url: live.url }
        : { ...entry, status: 'removed' }
    }),
    items: snapshot.items,
  }
}

/**
 * The one read. `refresh` skips the 6 h window; a null answer with no snapshot is
 * the page's "every feed failed" state, and an old snapshot is returned stale
 * rather than replaced by nothing.
 */
/* The clock travels with the answer, for the same reason every dashboard sends
   one: the page prints `next read in …` and must not type the duration itself.
   Stamped on the way out, never into the file — the constant cannot go stale on
   disk. */
const stamped = (answer) => ({ ...answer, cacheTtlMs: TTL })

async function read({ workspace, refresh } = {}) {
  const record = workspaces.open(workspace)
  const installed = feeds({ workspace })
  const file = fileOf(record)
  const previous = readSnapshot(file)
  /* Nothing installed **and** nothing stored is an empty workspace, not a failed
     read: it answers empty, so `stale` keeps meaning "a read was attempted and did
     not land". Reported stale, it made the page announce `0 feeds failed` about a
     workspace that had never been given a feed to fail. A workspace that removed
     its last feed still has a snapshot, and keeps the rows it holds — below. */
  if (!installed.length && !previous) return stamped({ readAt: '', feeds: [], items: [] })
  /* A feed added since the snapshot is not in it: fetch now, so installing a
     feed in Connectors is visible on the next read without a second click. A
     feed *removed* since does not trigger one — its rows are the historical fact
     the page reports. */
  const known = new Set((previous?.feeds || []).map((entry) => entry.id))
  const added = installed.some((feed) => !known.has(feed.id))
  const readAt = Date.parse(previous?.readAt || '')
  const fresh =
    previous && !refresh && !added && Number.isFinite(readAt) && Date.now() - readAt < TTL
  if (fresh) return stamped(decorate(previous, installed))

  const results = await Promise.all(installed.map(fetchFeed))
  const answered = results.filter((result) => !result.error)
  const errors = results.filter((result) => result.error).map(entryOf)

  if (answered.length) {
    const snapshot = {
      readAt: new Date().toISOString(),
      feeds: results.map(entryOf),
      /* General's order: newest published first. Trends re-sorts on the page, so
         one store order serves both. */
      items: answered
        .flatMap((result) => result.items)
        .sort((a, b) => String(b.published).localeCompare(String(a.published))),
    }
    writeSnapshot(file, snapshot)
    return stamped(snapshot)
  }

  const failed = { feeds: results.map(entryOf), items: [], errors, stale: true }
  if (!previous) return stamped({ readAt: '', ...failed })
  /* Every feed failed and a good read exists: return it, say it is stale, and
     never overwrite a readable snapshot with an empty one. */
  return stamped({ ...decorate(previous, installed), stale: true, errors })
}

/* ── the probe: one URL, asked once, nothing written ──────────────────── */

/** A feed as a person sees it before it is saved: its host, or the URL itself. */
const labelOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return String(url || 'that URL')
  }
}

const SAMPLE_LIMIT = 6

/**
 * “Does this URL answer, and with what?” — the one read-only verb behind the
 * Connectors page's **Test feed**.
 *
 * The fetch is `fetchFeed`'s, so the 8 s timeout, the 512 kB cap and the HTML
 * refusal are the same policy the page itself is read under; nothing here writes,
 * and nothing here touches the snapshot.
 */
async function probe({ workspace, url } = {}) {
  /* The workspace is this verb's scope rather than a path: `open` is how the call
     table refuses a workspace that no longer exists. */
  workspaces.open(workspace)
  const target = String(url || '')
  const result = await fetchFeed({
    id: 'probe',
    label: labelOf(target),
    url: target,
    limit: connectorStore.DEFAULT_ITEM_LIMIT,
  })
  if (result.error) {
    return { ok: false, detail: result.error, samples: [], total: 0, samplesLabel: 'items' }
  }
  /* The feed's own count, not the ceiling's: the number beside the limit field is
     what that field is for, and it would be a poor guide if it read `100` for a
     feed that carries 300. */
  const total = Number.isInteger(result.total) ? result.total : result.items.length
  return {
    ok: true,
    detail: `${total} ${total === 1 ? 'item' : 'items'} · ${result.title || labelOf(target)}`,
    samples: result.items.slice(0, SAMPLE_LIMIT).map((item) => item.title).filter(Boolean),
    total,
    samplesLabel: 'items',
  }
}

module.exports = { FILE, TTL, feeds, read, probe, parseFeed, fetchFeed, blocksOf }
