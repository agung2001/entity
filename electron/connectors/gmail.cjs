/**
 * `@gmail:<account|all>:<query>` — search mail, or read one thread by id.
 *
 * The account leads because Gmail is multi-account by design. The query is Gmail's
 * own search syntax, so `from:`, `subject:` and `has:attachment` work verbatim; a
 * quoted phrase stays a phrase. `id:<threadId>` is the picked form — one direct
 * thread read, no search.
 *
 * Rows are named by **thread**, not message: a thread survives replies, so a saved
 * mention keeps working, and the row carries a `mail.google.com` link.
 */
const { accountScope, accessToken, get, idScope, quotaFor } = require('./_shared.cjs')

const MAX_PER_SOURCE = 3

/** The Gmail web address for a thread. `u/0` is the first signed-in account,
 *  which is what this machine's token is; the thread anchor keeps working as the
 *  conversation grows, where a message anchor pins one reply. */
const gmailThreadUrl = (threadId) => `https://mail.google.com/mail/u/0/#all/${threadId}`

const headerOf = (meta, name) =>
  (meta?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

/** One message's display fields, from a metadata read. */
function gmailRow(meta, threadId, account) {
  return {
    /* The **thread** id, not the message id: a thread is stable across replies, so
       a saved mention does not rot the moment someone answers. */
    id: threadId || meta.threadId || meta.id,
    messageId: meta.id,
    account: account.email,
    label: `${headerOf(meta, 'Subject') || '(no subject)'} — ${headerOf(meta, 'From') || 'unknown sender'}`,
    detail: [account.email, headerOf(meta, 'Date')].filter(Boolean).join(' · '),
    url: gmailThreadUrl(threadId || meta.threadId || meta.id),
  }
}

/**
 * Headers for many messages in one request.
 *
 * Gmail's batch endpoint is a `multipart/mixed` POST of sub-requests — the reason
 * this is not a one-liner — and it is the difference between one round-trip and
 * one-per-message. A failed batch degrades to no rows rather than a failed turn,
 * because a mention is context, not a gate.
 */
async function gmailMetaBatch(accessTokenValue, ids) {
  const out = new Map()
  if (!ids.length) return out
  const boundary = `entity-${Date.now().toString(36)}-${ids.length}`
  const eol = '\r\n'
  const parts = ids.map(
    (id) =>
      `--${boundary}${eol}` +
      `Content-Type: application/http${eol}` +
      `Content-ID: <${id}>${eol}${eol}` +
      `GET /gmail/v1/users/me/messages/${id}?${GMAIL_META}${eol}${eol}`,
  )
  const payload = `${parts.join('')}--${boundary}--${eol}`
  try {
    const response = await fetch('https://gmail.googleapis.com/batch/gmail/v1', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessTokenValue}`,
        'content-type': `multipart/mixed; boundary=${boundary}`,
      },
      body: payload,
    })
    if (!response.ok) return out
    const text = await response.text()
    /* **Google replaces our boundary** with its own (`batch_<random>`), so splitting
       on the boundary we sent finds nothing — the id has to come from each
       `Content-ID` part instead. That is also what keeps a reordered answer from
       mislabelling a row. */
    const chunks = text.split(/Content-ID:\s*<([^>]+)>/i)
    /* split() with a capture group alternates: [text, id, body, id, body, …] */
    for (let at = 1; at < chunks.length; at += 2) {
      const id = String(chunks[at]).replace(/^response-/, '')
      const body = chunks[at + 1] || ''
      const start = body.indexOf('{')
      const end = body.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      try {
        out.set(id, JSON.parse(body.slice(start, end + 1)))
      } catch {
        /* one malformed part must not lose the others */
      }
    }
  } catch {
    /* the batch endpoint is best-effort; an empty map means fewer rows */
  }
  return out
}

const GMAIL_META =
  'format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date'

async function resolveGmail(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  const accounts = accountScope('gmail', segment.account, 'gmail')
  /* `id:` is the picked form: one direct read per id, no search at all. */
  const ids = idScope(query)
  if (!ids && !query) throw new Error('@gmail:all: needs a search, e.g. @gmail:all:from:stripe')
  const quota = quotaFor(accounts, limit)
  const rows = []
  const skipped = []
  for (const [index, account] of accounts.entries()) {
    let token
    try {
      token = await accessToken('gmail', account.localpart)
    } catch {
      skipped.push(account.localpart)
      continue
    }

    if (ids) {
      for (const threadId of ids) {
        /* A thread read returns every message in it; the first message carries the
           subject/from the row shows, which is what a person recognises. */
        const thread = await get(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?${GMAIL_META}`,
          token,
          'gmail',
        ).catch(() => null)
        const messages = Array.isArray(thread?.messages) ? thread.messages : []
        const first = messages[0]
        if (!first) continue
        const count = messages.length
        rows.push({
          ...gmailRow(first, threadId, account),
          detail: [
            [account.email, headerOf(first, 'Date')].filter(Boolean).join(' · '),
            `${count} message${count === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · '),
        })
        if (rows.length >= limit) break
      }
      if (rows.length >= limit) break
      continue
    }

    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(quota[index]))
    const body = await get(url, token, 'gmail')
    const found = (body.messages || []).slice(0, quota[index])
    if (found.length) {
      /* **One** call for N message headers, not N calls. `messages.get` per hit is
         the whole latency of a search — measured at ~9.7 s for seven keystrokes of
         a three-row query, because each keystroke refetched three messages
         serially. `batchGet` answers all of them in one round-trip. */
      const metas = await gmailMetaBatch(token, found.map((message) => message.id))
      for (const message of found) {
        const meta = metas.get(message.id)
        if (!meta) continue
        rows.push(gmailRow(meta, message.threadId || meta.threadId, account))
        if (rows.length >= limit) break
      }
    }
  }
  segment.skipped = skipped
  return rows.slice(0, limit)
}
module.exports = { resolveGmail }
