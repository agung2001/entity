/**
 * The account-bearing connector registry: one entry per mention head.
 *
 * This is the seam between the mention grammar (in `mention-ref.cjs`) and the five
 * connectors that answer from an account (in the files beside this one). The
 * grammar owns *how a mention is written*; these own *what an answer is*.
 *
 * **Loaded lazily, on first use.** `mention-ref.cjs` is required by `rpc.cjs`, so
 * it loads at app start in every workspace, and `youtube-studio.cjs` alone is 778
 * lines of analytics shaping that most turns never touch. A `require` inside each
 * getter means a Gmail mention never parses the Studio module — and a mention that
 * arrives in a turn is the one moment the cost is unavoidable, because the answer
 * cannot be produced without it.
 *
 * A connector module exports `{ resolve, preview }`:
 *
 *   resolve(segment, options)   the rows the turn gets; throws to report a refusal
 *   preview(fields, options)    rows for the composer's menu; must never throw
 *
 * Both receive a `segment` whose `account` and `query` are already parsed, and a
 * `limit`. Keeping `preview` beside `resolve` in the same file is deliberate: when
 * they were written in different files they disagreed three times, and every time
 * the symptom was an empty menu for a valid mention.
 */
const cache = new Map()

/** `require` once per head, then hand back the same module. */
function load(head) {
  if (cache.has(head)) return cache.get(head)
  let mod = null
  switch (head) {
    case 'gmail':
      mod = require('./gmail.cjs')
      break
    case 'drive':
      mod = require('./drive.cjs')
      break
    case 'calendar':
      mod = require('./calendar.cjs')
      break
    case 'youtube':
      mod = require('./youtube.cjs')
      break
    case 'youtube-studio':
      mod = require('./youtube-studio.cjs')
      break
    case 'x':
      mod = require('./x.cjs')
      break
    case 'clockify':
      mod = require('./clockify.cjs')
      break
    case 'habitify':
      mod = require('./habitify.cjs')
      break
    case 'opendesign':
      mod = require('./opendesign.cjs')
      break
    default:
      mod = null
  }
  cache.set(head, mod)
  return mod
}

/** Every head this registry answers, in the order a person would try them. */
const HEADS = [
  'gmail',
  'drive',
  'calendar',
  'youtube',
  'youtube-studio',
  'x',
  'clockify',
  'habitify',
  'opendesign',
]

const has = (head) => HEADS.includes(String(head))

/** The resolver for a head, or null.
 *
 * Each module exports `resolve<Name>` (`resolveGmail`, `resolveX`…) so its file
 * reads as the thing it is; this is the one place that maps a head to that name.
 * `resolve` is accepted too, for a module that prefers the generic name. */
function resolverFor(head) {
  const mod = load(head)
  if (!mod) return null
  return mod.resolve || mod[`resolve${SUFFIX[head] || ''}`] || null
}

/** `gmail` → `Gmail`, `youtube-studio` → `YoutubeStudio`, `x` → `X`. */
const SUFFIX = {
  gmail: 'Gmail',
  drive: 'Drive',
  calendar: 'Calendar',
  youtube: 'Youtube',
  'youtube-studio': 'YoutubeStudio',
  x: 'X',
  clockify: 'Clockify',
  habitify: 'Habitify',
  opendesign: 'Opendesign',
}

/** A head whose answer is a report, not a list, sets its own row ceiling. */
function rowCeiling(head, fallback) {
  const mod = load(head)
  return mod?.ROW_CEILING || mod?.YT_STUDIO_ROWS || fallback
}

/** The composer's suggestions for a head, or null when the module ships none. */
function previewFor(head) {
  return load(head)?.preview || null
}

/** The save-time check a `credential: 'token'` head ships, or null. */
function verifyFor(head) {
  return load(head)?.verify || null
}

/** The vocabulary a head reads, for the composer's completion list. */
function wordsFor(head) {
  const mod = load(head)
  return mod?.YT_STUDIO_WORDS || []
}

/** The channels a studio account manages, for the composer's channel segment. */
function channelsFor(head) {
  const mod = load(head)
  return mod?.ytChannelChoices || null
}

/** Is this word one of a head's readers (`summary`, `traffic`…)? */
function isKeyword(head, word) {
  const mod = load(head)
  return mod?.ytIsKeyword ? mod.ytIsKeyword(word) : false
}

module.exports = { HEADS, has, resolverFor, previewFor, verifyFor, rowCeiling, wordsFor, channelsFor, isKeyword }
