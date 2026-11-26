/**
 * `@youtube:<account|all>:<query>` — search public videos, or read one by id.
 *
 * This is the *public* surface: what anyone can see. The channel's own analytics
 * live in `@youtube-studio:`, which is a different grant — a person who wants to
 * search videos should never be asked for revenue access.
 */

const { accountScope, accessToken, get, idScope, quotaFor, connectorOfKind } = require('../_shared.cjs')

const MAX_PER_SOURCE = 3

async function resolveYoutube(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@youtube:all: needs a search, e.g. @youtube:all:deploy guide')
  const accounts = accountScope('youtube', segment.account, 'youtube')
  const ids = idScope(query)
  const quota = quotaFor(accounts, limit)
  const rows = []
  const skipped = []
  for (const [index, account] of accounts.entries()) {
    let token
    try {
      token = await accessToken('youtube', account.localpart)
    } catch {
      skipped.push(account.localpart)
      continue
    }
    /* The picked form: one direct read per id, no search. */
    if (ids) {
      const picked = new URL('https://www.googleapis.com/youtube/v3/videos')
      picked.searchParams.set('part', 'snippet')
      picked.searchParams.set('id', ids.join(','))
      picked.searchParams.set('maxResults', String(quota[index]))
      const found = await get(picked, token, 'youtube')
      for (const item of found.items || []) {
        const snippet = item.snippet || {}
        rows.push({
          id: item.id || '',
          account: account.email,
          label: snippet.title || '(untitled)',
          detail: [snippet.channelTitle, snippet.publishedAt?.slice(0, 10)].filter(Boolean).join(' · '),
          url: item.id ? `https://www.youtube.com/watch?v=${item.id}` : '',
        })
        if (rows.length >= limit) break
      }
      if (rows.length >= limit) break
      continue
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/search')
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('type', 'video')
    url.searchParams.set('maxResults', String(quota[index]))
    url.searchParams.set('q', query)
    const body = await get(url, token, 'youtube')
    for (const item of body.items || []) {
      const snippet = item.snippet || {}
      rows.push({
        id: item.id?.videoId || '',
        account: account.email,
        label: snippet.title || '(untitled)',
        detail: [snippet.channelTitle, snippet.publishedAt?.slice(0, 10)].filter(Boolean).join(' · '),
        url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
      })
      if (rows.length >= limit) break
    }
  }
  segment.skipped = skipped
  return rows.slice(0, limit)
}

module.exports = { resolveYoutube }
