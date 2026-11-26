/**
 * The account-bearing connector facade: what `mention-ref.cjs` and the token verbs
 * ask about a resolver kind.
 *
 * **The map lives in `registry.cjs`.** This file used to hold it twice — a 12-case
 * `switch` that mapped a head to a module, and a `SUFFIX` table that mapped the same
 * head to `resolve<Name>`. Two hand-kept maps of the same fact is how a connector
 * came to resolve in the composer and not in a turn.
 *
 * What stays here is the *shape* of the question: a module exports
 * `{ resolve, preview }`, and a module's optional extras (`verify`, `ROW_CEILING`,
 * the Studio vocabulary) are read off it by name. Whether a head has any of them is
 * the module's business, not this file's.
 *
 * A connector module exports:
 *
 *   resolve(segment, options)   the rows the turn gets; throws to report a refusal
 *   preview(fields, options)    rows for the composer's menu; must never throw
 *
 * Both receive a `segment` whose `account` and `query` are already parsed, and a
 * `limit`. Keeping `preview` beside `resolve` in the same file is deliberate: when
 * they were written in different files they disagreed three times, and every time
 * the symptom was an empty menu for a valid mention.
 */
const registry = require('./registry.cjs')

/** Every head this facade answers, in the order a person would try them. */
const HEADS = registry.KINDS

const has = (head) => HEADS.includes(String(head))

const load = (head) => registry.mentionModule(head)

/** The resolver for a head, or null. */
const resolverFor = (head) => registry.resolverFor(head)

/** A head whose answer is a report, not a list, sets its own row ceiling. */
function rowCeiling(head, fallback) {
  const mod = load(head)
  return mod?.ROW_CEILING || mod?.YT_STUDIO_ROWS || fallback
}

/** The composer's suggestions for a head, or null when the module ships none. */
function previewFor(head) {
  return load(head)?.preview || null
}

/** The save-time check a `credential: 'token'` connector ships, or null.
 *
 * It lives on the connector's *descriptor* (`connectors/<id>/connector.cjs`), not on
 * the mention module: a check is about the credential, and the descriptor is where a
 * connector's credential is described. */
function verifyFor(head) {
  return registry.verifyFor(head)
}

/** The vocabulary a head reads, for the composer's completion list. */
function wordsFor(head) {
  return load(head)?.YT_STUDIO_WORDS || []
}

/** The channels a studio account manages, for the composer's channel segment. */
function channelsFor(head) {
  return load(head)?.ytChannelChoices || null
}

/** Is this word one of a head's readers (`summary`, `traffic`…)? */
function isKeyword(head, word) {
  const mod = load(head)
  return mod?.ytIsKeyword ? mod.ytIsKeyword(word) : false
}

module.exports = { HEADS, has, resolverFor, previewFor, verifyFor, rowCeiling, wordsFor, channelsFor, isKeyword }
