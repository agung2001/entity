/**
 * Token search for every filter box in the hub.
 *
 * A model name is a path: `commandcode/deepseek/deepseek-v4-pro`. People type
 * it as "commandcode deepseek", so a query is split into words and every word
 * must appear somewhere in the haystack, in any order. Whole-string matching
 * made multi-word searches return nothing even when the exact model was there.
 */
export function queryTokens(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function matchesQuery(text, query) {
  const tokens = Array.isArray(query) ? query : queryTokens(query)
  if (!tokens.length) return true
  const haystack = String(text || '').toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}
