/**
 * The links beside a product row, and the name check beside the table.
 *
 * Two questions, both answered from strings the read already has:
 *
 *   1. **Which page sells this product?** The public marketplace document lists
 *      `{ title, url }` per product. A spreadsheet's name is a shorthand of that
 *      title, so the match is exact first, then a unique token-subset — and an
 *      ambiguous match is no link at all, because a plausible wrong link is worse
 *      than a missing one.
 *   2. **Does this sheet's name still describe its own rows?** The other direction
 *      of the same match: every token of the sheet name must appear in the title
 *      its rows carry. A name token that is missing means the content belongs to
 *      a different product, and the table says so in amber.
 *
 * **Never throws.** A marketplace outage degrades the links to the previous
 * snapshot's, never the report: the numbers do not depend on this file.
 *
 * Only `{ title, url }` survives the fetch. The host is allowlisted and `http` is
 * upgraded, so a link is either a `lynk.id` page, a page on the marketplace's own
 * host, or nothing.
 *
 * **Where the marketplace is, is a setting, not a constant.** This app is public;
 * the store that reads it is one person's. A URL baked in here would publish one
 * workspace's site to everyone who clones the repository, and would hard-code a
 * domain into a program that must work for any store. So the document's location is
 * a field on the connector row (`marketplaceUrl`), the host it names is the host
 * `landingUrl()` then trusts, and with no URL there are no landing links at all —
 * which is the honest default, not a broken one.
 */
/* The two hosts a link may point at whatever the marketplace is: the storefront a
   product page lives on. The third is the marketplace's own, read off the setting. */
const BASE_LANDING_HOSTS = ['lynk.id', 'www.lynk.id']
const MAX_LANDING_TITLE = 300
const MAX_MARKETPLACE_BODY = 2_000_000
const MAX_MARKETPLACE_ENTRIES = 500
const FETCH_TIMEOUT_MS = 5_000

/* A Drive id is one url-safe token. Anything outside that alphabet is not an id a
   link may be built from, so it becomes no link rather than a crafted URL. */
const ID = /^[A-Za-z0-9_-]{20,60}$/

/**
 * `Akademi Prompt Engineering 101 🚀 (AS-e094c0b5)` → `akademi prompt engineering 101 as e094c0b5`.
 *
 * NFKD so a `é` and an `e`+accent compare equal, punctuation folded to spaces so a
 * colon or an em dash is not a mismatch.
 */
const normalizeTitle = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** The words a name is made of: one-letter tokens prove nothing, so they are out. */
const nameTokens = (value) =>
  normalizeTitle(value)
    .split(' ')
    .filter((token) => token.length >= 2)

/**
 * The host a configured marketplace URL names, or `''`.
 *
 * Parsed rather than pattern-matched: a setting that is not a URL is not a host, and
 * `new URL` is the only thing that decides that. `https` is required — a link built
 * from an `http` setting would be downgraded silently, and an upgraded one would go
 * to a host that may not serve TLS.
 */
function marketplaceHost(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 500) return ''
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

/** The hosts a landing link may point at: the storefront, plus the marketplace's own. */
function landingHosts(marketplaceUrl) {
  const hosts = new Set(BASE_LANDING_HOSTS)
  const host = marketplaceHost(marketplaceUrl)
  if (host) hosts.add(host)
  return hosts
}

/**
 * `https` only, allowlisted host only, and never a host this file did not choose.
 *
 * `hosts` is what `landingHosts()` answered for the configured marketplace: an
 * absent set means nothing is allowed, so a caller that forgot it gets no link
 * rather than an unvetted one.
 */
function landingUrl(raw, hosts) {
  if (typeof raw !== 'string' || !raw || raw.length > 500) return null
  if (!(hosts instanceof Set) || !hosts.size) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const href = url.toString().replace(/^http:/, 'https:')
  if (!href.startsWith('https:') || !hosts.has(url.hostname.toLowerCase())) return null
  return href
}

/** The Google Sheet behind one spreadsheet file, or `null` for an id that is not one. */
const sheetUrl = (id) => (ID.test(String(id ?? '')) ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null)

/** The Drive folder the report reads, or `null` when there is no usable id. */
const folderUrl = (id) => (ID.test(String(id ?? '')) ? `https://drive.google.com/drive/folders/${id}` : null)

/**
 * Exact title, then a unique token-subset hit.
 *
 * Zero or at least two hits is ambiguous, and an ambiguous product keeps no link.
 * A sheet may append a quantity the marketplace title does not repeat ("Akademi
 * Prompt Engineering 101"), so all-digit tokens are dropped once, and only once:
 * every other token must still match.
 */
function landingForName(name, entries, hosts) {
  const tokens = nameTokens(name)
  if (!tokens.length) return null
  const wanted = normalizeTitle(name)
  const exact = entries.filter((entry) => normalizeTitle(entry.title) === wanted)
  // Two marketplace rows with the same title are ambiguous by definition.
  if (exact.length > 1) return null
  if (exact.length === 1) return landingUrl(exact[0].url, hosts)
  const subset = (candidates) => {
    const hits = entries.filter((entry) => {
      const set = new Set(normalizeTitle(entry.title).split(' '))
      return candidates.every((token) => set.has(token))
    })
    return hits.length === 1 ? landingUrl(hits[0].url, hosts) : null
  }
  const direct = subset(tokens)
  if (direct) return direct
  const withoutNumbers = tokens.filter((token) => !/^\d+$/.test(token))
  return withoutNumbers.length && withoutNumbers.length < tokens.length ? subset(withoutNumbers) : null
}

/**
 * Does a sheet's own name still describe the product title its rows carry?
 *
 * Token-subset agreement, one direction: extra title tokens are normal (a subtitle,
 * an emoji, an `(AS-…)` tag); a name token missing from the title means the rows
 * belong to something else. A generic name agrees with almost any title, which is a
 * false negative rather than a false alarm — the safe direction for a list people
 * trust.
 */
function checkSheetName(name, titles) {
  const wanted = nameTokens(name)
  // A one-letter name, or a sheet with no readable title, cannot be judged.
  if (!wanted.length || !titles.length) return { kind: 'unchecked' }
  const foreign = titles.filter((entry) => {
    const set = new Set(nameTokens(entry.title))
    return !wanted.every((token) => set.has(token))
  })
  if (!foreign.length) return { kind: 'agree' }
  const ranked = [...foreign].sort((a, b) => b.rows - a.rows)
  return {
    kind: 'mismatch',
    title: ranked[0].title,
    titles: foreign.length,
    rows: foreign.reduce((sum, entry) => sum + entry.rows, 0),
  }
}

/**
 * The marketplace, or `null`.
 *
 * Never throws: a timeout, a 500, a body that is not JSON and a body over 2 MB are
 * all the same answer — no links this time, and the previous snapshot's links stay.
 */
async function readMarketplace({ url = '' } = {}) {
  /* No setting, no fetch: this store has said nothing about where its marketplace
     is, so there is nothing to read and no request to spend finding out. */
  const target = String(url || '').trim()
  if (!target || !marketplaceHost(target)) return null
  const hosts = landingHosts(target)
  try {
    const response = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok || text.length > MAX_MARKETPLACE_BODY) return null
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed?.products) ? parsed.products : []
    return rows.slice(0, MAX_MARKETPLACE_ENTRIES).flatMap((row) => {
      const value = row && typeof row === 'object' ? row : {}
      const title = typeof value.title === 'string' ? value.title.trim().slice(0, MAX_LANDING_TITLE) : ''
      const href = landingUrl(value.url, hosts)
      return title && href ? [{ title, url: href }] : []
    })
  } catch {
    return null
  }
}

/**
 * One link per spreadsheet id, keyed by the file's id — the stable key, because a
 * file gets renamed and a name is what the match produced, not what it is stored by.
 *
 * `previous` is the map the last read stored: a failed fetch keeps it, so a
 * marketplace outage does not strip every link off the table until the next refresh.
 */
function linkMap(files, entries, previous = null, hosts = null) {
  const urls = {}
  const allowed = hosts instanceof Set ? hosts : landingHosts('')
  if (entries) {
    for (const file of files) urls[String(file.id)] = landingForName(file.name, entries, allowed)
    return { ok: true, at: new Date().toISOString(), urls }
  }
  const kept = previous && typeof previous.urls === 'object' && previous.urls ? previous.urls : {}
  for (const file of files) {
    const known = landingUrl(kept[String(file.id)], allowed)
    if (known) urls[String(file.id)] = known
  }
  return { ok: false, at: String(previous?.at || ''), urls }
}

module.exports = {
  BASE_LANDING_HOSTS,
  marketplaceHost,
  landingHosts,
  normalizeTitle,
  nameTokens,
  landingUrl,
  landingForName,
  checkSheetName,
  readMarketplace,
  linkMap,
  sheetUrl,
  folderUrl,
}
