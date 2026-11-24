/**
 * The plumbing every account-bearing connector shares.
 *
 * This file exists because five connectors answer from the same Google (or X)
 * account and must agree about *how*: which account a mention names, what `all`
 * means, how a rejected token is reported, how a picked id is read, and how many
 * rows one account may take. Five copies of that is five places to break it — and
 * the mention grammar already broke three times by being written twice.
 *
 * A connector module exports `{ resolve, preview }` and imports from here. Nothing
 * in this file knows what a message, a file or a video is: it knows accounts,
 * tokens, HTTP and the row shape.
 */
const oauthAccounts = require('../oauth-accounts.cjs')

/* ── access tokens, cached ────────────────────────────────────────────────
   A refresh is a network round-trip, and the composer asks for a suggestion on
   nearly every keystroke. Without a cache, typing one search cost seven token
   refreshes before it cost seven searches (measured). An access token is good for
   an hour; it is held for 50 minutes, which leaves room for clock skew and never
   hands back one that expires mid-call. */
const TOKEN_TTL_MS = 50 * 60_000
const tokenCache = new Map()

/** A live access token for one account, reusing the last one until it is stale. */
async function accessToken(connector, localpart) {
  const key = `${connector}:${localpart}`
  const hit = tokenCache.get(key)
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token
  const answer = await oauthAccounts.accessTokenFor(connector, localpart)
  /* `accessTokenFor` answers `{ accessToken, scopes }`; every caller here wants the
     string, so the unwrapping happens once, here. Doing it at each call site is how
     `Bearer [object Object]` reached Google. */
  const token = String(answer?.accessToken || answer || '')
  if (!token) throw new Error(`@${connector}: no access token for ${localpart}.`)
  tokenCache.set(key, { token, at: Date.now() })
  /* A dead grant must not stay cached: the next mention should retry, because the
     person may have signed in again in between. */
  if (tokenCache.size > 64) tokenCache.delete(tokenCache.keys().next().value)
  return token
}

/** Drop a cached token — called when a refresh is rejected so the next attempt
 *  re-reads the store instead of repeating a dead token. */
function forgetToken(connector, localpart) {
  tokenCache.delete(`${connector}:${localpart}`)
}

/** The connector id a resolver kind reads accounts from (`drive` → `google-drive`). */
const CONNECTOR_OF = { drive: 'google-drive' }
const connectorOfKind = (kind) => CONNECTOR_OF[kind] || kind

/** Every account of a connector, with whether this machine holds a token for it. */
const accountsOf = (connector) => oauthAccounts.connectedAccounts(connector)

/**
 * The accounts a mention may read: the named one, or every usable one.
 *
 * `all` is a reserved scope word, so an account can never shadow it. An unknown
 * account is an **error** that names the accounts that exist — a typo must not
 * quietly become a search that returns mail from the wrong place.
 */
function accountScope(connector, localpart, head = '') {
  const accounts = accountsOf(connector)
  const usable = accounts.filter((entry) => entry.status === 'connected' && entry.hasToken)

  if (localpart === 'all') {
    if (!usable.length) {
      throw new Error(
        `@${head || connector}:all: has no usable account yet. Connect one on the connector's page.`,
      )
    }
    return usable
  }

  if (localpart) {
    const hit = accounts.filter(
      (entry) => entry.localpart === localpart || entry.email === localpart,
    )
    if (!hit.length) {
      const known = accounts.map((entry) => entry.localpart).filter(Boolean)
      throw new Error(
        known.length
          ? `@${head || connector}:${localpart}: is not an account here. This machine has: ${known.join(', ')}.`
          : `@${head || connector}:${localpart}: is not an account here. Connect it on the ${connector} page first.`,
      )
    }
    return hit
  }

  if (!usable.length) {
    throw new Error(
      `No usable account for @${head || connector}: yet. Connect one on the connector's page.`,
    )
  }
  return usable
}

/**
 * How many rows each account gets when one mention spans several.
 *
 * `all` must actually *read* every account: taking `limit` rows from the first one
 * left the rest unqueried, which made `all` a lie the moment there were two.
 */
const quotaFor = (accounts, limit) =>
  accounts.map(() => Math.max(1, Math.ceil(Number(limit) / Math.max(1, accounts.length))))

/** `id:<a>[,<b>…]` at the head of a query — the picked form. */
function idScope(query) {
  const match = /^id:\s*(.+)$/i.exec(String(query || '').trim())
  if (!match) return null
  /* Shape only: ids are opaque, and a provider may issue a short one. A length
     guard here silently demoted a real id to a search. */
  const ids = match[1]
    .split(',')
    .map((value) => value.trim().split(/\s+/)[0])
    .filter((value) => /^[A-Za-z0-9_-]+$/.test(value))
  return ids.length ? ids : null
}

/**
 * One authenticated GET, with the failure a person can act on.
 *
 * Three failures look alike and are not: a disabled API (a *project* problem, with
 * the console link Google supplied), a rejected token (a *consent* problem the card
 * already knows how to fix), and everything else.
 */
async function get(url, accessTokenValue, connector) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessTokenValue}`, accept: 'application/json' },
  })
  const body = await response.json().catch(() => ({}))
  if (response.ok) return body
  const said = String(body?.error?.message || body?.error || `HTTP ${response.status}`)
  if (
    body?.error?.status === 'PERMISSION_DENIED' ||
    /has not been used in project|is disabled/i.test(said)
  ) {
    throw new Error(
      `@${connector}: the API is not enabled in this Google Cloud project. Enable it, wait a minute, and try again — ${said.slice(0, 220)}`,
    )
  }
  if (response.status === 401 || /invalid_grant|Invalid Credentials/i.test(said)) {
    throw new Error(
      `@${connector}: needs a sign-in — Google rejected the token. Sign in on the connector's page.`,
    )
  }
  throw new Error(`@${connector}: Google answered ${said.slice(0, 180)}.`)
}

/** A picked row becomes a quoted query, never the row's whole label. */
function queryInsert(text, max = 60) {
  const clean = String(text || '')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  /* Cut on a word boundary, never mid-character: slicing through an emoji left
     half a code point and an unbalanced quote. */
  const cut =
    clean.length <= max
      ? clean
      : `${clean.slice(0, max).replace(/\s+\S*$/, '').trim() || clean.slice(0, max)}`
  const value = cut.trim()
  if (!value) return ''
  return /\s/.test(value) ? `"${value}"` : value
}

module.exports = {
  TOKEN_TTL_MS,
  accessToken,
  forgetToken,
  connectorOfKind,
  accountsOf,
  accountScope,
  quotaFor,
  idScope,
  get,
  queryInsert,
}
