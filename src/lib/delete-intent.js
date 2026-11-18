/**
 * "Delete @secretary" is an action, not a sentence to delegate.
 *
 * The chat intercepts a message that asks to remove an entity before it reaches
 * the harness, and asks the person to confirm. Detection only proposes; the
 * dialog is the only way anything is removed.
 *
 * Two rules keep it from firing on long briefs, which is where it went wrong:
 * a verb only targets what **follows it in the same clause** (`delete the
 * worktree named entity-23, then report to @coder` is not about coder), and a
 * **negated** verb is not a request at all (`Never … delete the worktree or the
 * branch` in a delegate's brief used to open "delete coder").
 */
const VERB = /\b(?:delete|remove|trash|discard|get rid of)\b/gi
/* Up to two qualifiers between the verb and its object: "delete the @x". */
const FILLERS = /^(?:(?:the|that|this|my|our|your|entity|agent|old|unused|extra|whole)\s+){0,2}/i
/* A dash is a break too: "no, not that one — delete @x" is a request whose own
   clause carries no negation. */
const CLAUSE = /[.;!?\n—–]/
/* Starting at the verb and looking back within its own clause. */
const NEGATION = /\b(?:never|not|no|without|avoid|n't)\b/i
const TAIL = 60

/** The entity named directly after a verb, or null. */
function objectOf(tail, known) {
  const rest = String(tail).replace(/^\s+/, '').replace(FILLERS, '')
  const mention = rest.match(/^@@?([A-Za-z0-9._-]+)/)
  if (mention) return known.get(mention[1].toLowerCase()) || null
  const word = rest.match(/^([A-Za-z0-9._-]+)/)
  return word ? known.get(word[1].toLowerCase()) || null : null
}

/**
 * @param {string} text what the person typed
 * @param {Array} agents the workspace entities (`{name}` or names)
 * @returns {{names: string[]} | null} canonical names, or null
 */
export function deletionTarget(text, agents = []) {
  const value = String(text || '')
  if (!value) return null

  const known = new Map()
  for (const agent of agents || []) {
    const name = typeof agent === 'string' ? agent : agent?.name
    if (name) known.set(String(name).toLowerCase(), String(name))
  }
  if (!known.size) return null

  /* The whole message, when no verb appears at all — the common case. */
  VERB.lastIndex = 0
  if (!VERB.test(value)) return null

  const names = []
  VERB.lastIndex = 0
  let match
  while ((match = VERB.exec(value))) {
    const start = match.index
    /* The clause the verb sits in: back to the last sentence break, and forward
       to the next one. A deletion 40 words away is not a request about this
       entity. */
    const back = clauseStart(value, start)
    if (NEGATION.test(value.slice(back, start))) continue
    const forward = value.slice(start + match[0].length)
    const cut = forward.search(CLAUSE)
    const tail = (cut >= 0 ? forward.slice(0, cut) : forward).slice(0, TAIL)
    const name = objectOf(tail, known)
    if (name && !names.includes(name)) names.push(name)
  }
  return names.length ? { names } : null
}

function clauseStart(value, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (CLAUSE.test(value[i])) return i + 1
  }
  return 0
}
