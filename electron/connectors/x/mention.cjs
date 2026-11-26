/**
 * `@x:<account|all>:<query>` — search recent posts, or read one by id.
 *
 * X's search covers recent posts only; the account decides whose grant runs the
 * call. Retweets are excluded so the rows are original posts.
 */

const { accountScope, accessToken, get, idScope, quotaFor, connectorOfKind } = require('../_shared.cjs')

const MAX_PER_SOURCE = 3

async function resolveX(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@x:all: needs a search, e.g. @x:all:from:stripe')
  const accounts = accountScope('x', segment.account, 'x')
  const ids = idScope(query)
  const quota = quotaFor(accounts, limit)
  const rows = []
  const skipped = []
  for (const [index, account] of accounts.entries()) {
    let token
    try {
      token = await accessToken('x', account.localpart)
    } catch {
      skipped.push(account.localpart)
      continue
    }
    /* The picked form: one direct read per id, no search. */
    if (ids) {
      const picked = new URL('https://api.x.com/2/tweets')
      picked.searchParams.set('ids', ids.slice(0, 100).join(','))
      picked.searchParams.set('tweet.fields', 'created_at,author_id')
      const found = await get(picked, token, 'x')
      for (const tweet of found.data || []) {
        rows.push({
          id: tweet.id,
          account: account.email,
          label: String(tweet.text || '').replace(/\s+/g, ' ').slice(0, 120),
          detail: [account.email, tweet.created_at?.slice(0, 10)].filter(Boolean).join(' · '),
          url: `https://x.com/i/web/status/${tweet.id}`,
        })
        if (rows.length >= limit) break
      }
      if (rows.length >= limit) break
      continue
    }

    const url = new URL('https://api.x.com/2/tweets/search/recent')
    url.searchParams.set('query', `${query} -is:retweet`)
    /* X rejects fewer than 10 per call, so the per-account quota is floored there
       and the rows are trimmed to the mention's own limit below. */
    url.searchParams.set('max_results', String(Math.min(100, Math.max(10, quota[index]))))
    url.searchParams.set('tweet.fields', 'created_at,author_id')
    const body = await get(url, token, 'x')
    for (const tweet of body.data || []) {
      rows.push({
        id: tweet.id,
        account: account.email,
        label: String(tweet.text || '').replace(/\s+/g, ' ').slice(0, 120),
        detail: [account.email, tweet.created_at?.slice(0, 10)].filter(Boolean).join(' · '),
        url: `https://x.com/i/web/status/${tweet.id}`,
      })
      if (rows.length >= limit) break
    }
  }
  segment.skipped = skipped
  return rows.slice(0, limit)
}

module.exports = { resolveX }
