/**
 * "Delete @secretary" is an action, not a sentence to delegate.
 *
 * The chat intercepts a message that asks to remove an entity before it reaches
 * the harness, and asks the person to confirm. Detection only proposes; the
 * dialog is the only way anything is removed.
 */
const VERB = /\b(delete|remove|trash|discard|get rid of)\b/i

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} text what the person typed
 * @param {Array} agents the workspace entities (`{name}` or names)
 * @returns {{names: string[]} | null} canonical names, or null
 */
export function deletionTarget(text, agents = []) {
  const value = String(text || '')
  if (!VERB.test(value)) return null

  const known = new Map()
  for (const agent of agents || []) {
    const name = typeof agent === 'string' ? agent : agent?.name
    if (name) known.set(String(name).toLowerCase(), String(name))
  }
  if (!known.size) return null

  const mentioned = []
  for (const match of value.matchAll(/@@?([A-Za-z0-9._-]+)/g)) {
    const canonical = known.get(match[1].toLowerCase())
    if (canonical && !mentioned.includes(canonical)) mentioned.push(canonical)
  }
  if (mentioned.length) return { names: mentioned }

  const named = []
  for (const [lower, canonical] of known) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9._-])${escape(lower)}([^A-Za-z0-9._-]|$)`, 'i')
    if (pattern.test(value)) named.push(canonical)
  }
  return named.length ? { names: named } : null
}
