/**
 * The read envelope's arithmetic: how long an answer stays good, and when it stops.
 *
 * This half has **no imports**, which is what lets a unit test pin it: the rule
 * `DESIGN.md` calls out ("never hardcode the duration") becomes a function with cases
 * instead of eight copies of a sentence. The line that also prints *when* something
 * was read needs `ago()`, so it lives in `readStamp.js` beside this file.
 *
 * This rule was written eight times — once per dashboard — and `DESIGN.md` calls the
 * mistake it prevents by name: *never hardcode the duration in copy*, because a
 * `cached 15 min` label that outlives the constant is a lie about the app's own
 * behaviour. Eight copies of that rule is eight chances to type the number.
 *
 * What each dashboard keeps is what is actually *its own*: a quota it must mention, a
 * timezone the day was bucketed in, a stale flag rather than a cached one. Everything
 * below is the shared half, and the main process sends `cacheTtlMs` with every payload
 * so the words follow the constant.
 */

/** `1 day`, `6 hours`, `5 minutes` — the largest unit that divides the TTL exactly. */
export function ttlWords(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const of = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
  const days = value / 86_400_000
  if (days >= 1 && Number.isInteger(days)) return of(days, 'day')
  const hours = value / 3_600_000
  if (hours >= 1 && Number.isInteger(hours)) return of(hours, 'hour')
  return of(Math.max(1, Math.round(value / 60_000)), 'minute')
}

/** When the stored answer stops being good: the read plus its clock, to the minute. */
export function cachedUntil(readAt, ttlMs) {
  const ms = Number(ttlMs)
  const read = new Date(readAt).getTime()
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(read)) return ''
  return new Date(read + ms).toLocaleString('en-gb', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * The foot of a card: what was done, and how long it stands.
 *
 * `style` is the one honest difference between the pages — a card that says
 * `cached for 1 day` and one that says `cached 1 day` are the same fact in two
 * grammars, and each page has been read by people who expect its own.
 */
export function cacheNote({ cached = false, ttlMs = 0, style = 'for' } = {}) {
  const ttl = ttlWords(ttlMs)
  if (cached) return ttl ? `served from the ${ttl} cache` : 'served from the stored cache'
  if (!ttl) return 'cached'
  return style === 'bare' ? `cached ${ttl}` : `cached for ${ttl}`
}
