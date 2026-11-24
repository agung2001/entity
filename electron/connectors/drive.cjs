/**
 * `@drive:<account|all>:<query>` — search files, or read one by id.
 *
 * Drive takes a **query language**, not a search string, so plain words are turned
 * into `name contains` / `fullText contains` clauses (each word ANDed, so two words
 * mean both), while a query already in Drive's grammar passes through untouched.
 * A quoted phrase stays a phrase. `id:<fileId>` is the picked form.
 */

const { accountScope, accessToken, get, idScope, quotaFor, connectorOfKind } = require('./_shared.cjs')

const MAX_PER_SOURCE = 3

/* The fields Drive's query language actually knows. A query that starts with one
   of these is grammar, and is passed through; anything else is a person's words. */
const DRIVE_FIELDS = new Set([
  'name', 'fulltext', 'mimetype', 'modifiedtime', 'createdtime', 'trashed', 'starred',
  'sharedwithme', 'parents', 'owners', 'writers', 'readers', 'properties',
  'appproperties', 'visibility', 'viewedbymetime', 'recency',
])

/** Does this query already speak Drive's grammar?
 *
 * Deliberately strict, because the loose version was wrong in a way that fails
 * silently: `report in march` and `Q3 and Q4` matched an `and`/`in` keyword and
 * were sent to Drive verbatim, which Drive rejects as invalid syntax. Ordinary
 * English uses those words constantly, so they cannot be the signal. Only a real
 * Drive field, or a `field op value` comparison, counts. */
function isDriveGrammar(raw) {
  const text = String(raw || '')
  const first = text.trim().split(/[\s(]/, 1)[0].toLowerCase()
  if (DRIVE_FIELDS.has(first)) return true
  /* `mimeType = 'x'`, `modifiedTime > 2025-01-01`, `name contains 'y'` */
  return /^\s*[A-Za-z]+\s*(=|!=|<=|>=|<|>|contains)\s*/i.test(text)
}

/** Drive's `q`, from a person's words.
 *
 * Drive takes a *query language*, not a search string, so words have to be turned
 * into comparisons. Two inputs are supported:
 *
 *   - a query in Drive's own grammar (`mimeType = 'application/pdf'`,
 *     `modifiedTime > 2025-01-01`) is passed through untouched;
 *   - anything else is words, and **each word** becomes a `name contains` clause
 *     OR'd with a `fullText contains` clause. Words are ANDed, which is what a
 *     person means by typing two of them — Drive's `contains` is a substring test,
 *     so `contains 'Q3 report bergstrom'` would only match that exact run and
 *     find nothing.
 *
 * A **quoted phrase** stays a phrase: `"Q3 report"` searches that sequence, not
 * the three words separately. The quotes are stripped before they reach Drive,
 * because Drive has no quoting of its own — it would search for the quote
 * character. That was the bug in the first version: `"Q3 report"` was sent with
 * its quotes intact and matched nothing.
 */
function driveQuery(text) {
  const raw = String(text || '').trim()
  if (isDriveGrammar(raw)) return raw

  const escape = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  /* Split into quoted phrases and bare words, keeping the quotes off the value. */
  const parts = raw.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const clauses = []
  for (const part of parts) {
    const quoted = /^"[^"]*"$|^'[^']*'$/.test(part)
    const value = quoted ? part.slice(1, -1) : part
    if (!value.trim()) continue
    const safe = escape(value)
    /* A phrase is content, not a file name, so it is searched as text. */
    clauses.push(
      quoted
        ? `fullText contains '${safe}'`
        : `(name contains '${safe}' or fullText contains '${safe}')`,
    )
  }
  if (!clauses.length) return ''
  /* Every word must appear; the OR inside a clause is name-vs-content. */
  return clauses.join(' and ')
}

/** Drive: `@drive:<account|all>:<query>` — a file search. */
async function resolveDrive(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@drive:all: needs a search, e.g. @drive:all:Q3 report')
  const accounts = accountScope(connectorOfKind('drive'), segment.account, 'drive')
  const ids = idScope(query)
  const quota = quotaFor(accounts, limit)
  const rows = []
  const skipped = []
  for (const [index, account] of accounts.entries()) {
    let token
    try {
      token = await accessToken(connectorOfKind('drive'), account.localpart)
    } catch {
      skipped.push(account.localpart)
      continue
    }
    /* The picked form: one direct read per id, no search. */
    if (ids) {
      for (const fileId of ids) {
        const file = await get(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink`,
          token,
          'google-drive',
        ).catch(() => null)
        if (!file) continue
        rows.push({
          id: file.id,
          account: account.email,
          label: file.name || file.id,
          detail: [account.email, file.mimeType?.split('.').pop(), file.modifiedTime?.slice(0, 10)]
            .filter(Boolean)
            .join(' · '),
          url: file.webViewLink || '',
        })
        if (rows.length >= limit) break
      }
      if (rows.length >= limit) break
      continue
    }

    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('q', driveQuery(query))
    url.searchParams.set('pageSize', String(quota[index]))
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink)')
    const body = await get(url, token, 'google-drive')
    for (const file of body.files || []) {
      rows.push({
        id: file.id,
        account: account.email,
        label: file.name || file.id,
        detail: [account.email, file.mimeType?.split('.').pop(), file.modifiedTime?.slice(0, 10)]
          .filter(Boolean)
          .join(' · '),
        url: file.webViewLink || '',
      })
      if (rows.length >= limit) break
    }
  }
  segment.skipped = skipped
  return rows.slice(0, limit)
}

module.exports = { resolveDrive }
