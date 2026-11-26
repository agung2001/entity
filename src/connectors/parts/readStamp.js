import { ago } from '@/stores/hub'
import { cachedUntil } from '@/connectors/parts/readClock'

/**
 * The stamp a dashboard's band prints: `read 3 h ago · cached until 18 Sep, 09:40`,
 * or the honest short form while a read is in flight or has never landed.
 *
 * It is separate from `readClock.js` because this line needs `ago()` — a store import
 * — and that import is exactly what would keep the arithmetic (and its unit tests)
 * out of a plain node test. Two files, one rule.
 */
export function readStamp({ readAt = '', loading = false, ttlMs = 0 } = {}) {
  if (loading) return 'reading…'
  if (!readAt) return 'not read yet'
  const read = `read ${ago(readAt)}`
  const until = cachedUntil(readAt, ttlMs)
  return until ? `${read} · cached until ${until}` : read
}
