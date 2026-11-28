/**
 * A delegated run's trace, as the *parent* transcript keeps it.
 *
 * A fan-out is up to a dozen harnesses, and each one streams its tool output at
 * full length. That trace already has a home: the session `spawnMentionSession`
 * writes is the child's own conversation, and it is where somebody opens it to
 * read what happened. The parent only ever needs a caption — the last two lines
 * of a killed run (`stepTail` in `DelegationCard.vue`) and whichever workspace
 * path the run named (the worktree chip reads it through `recordPaths`).
 *
 * Keeping the whole trace in the parent as well was writing the same megabytes
 * three times per delegation (the question's `mentions`, the answer's
 * `execution.mentions`, and the session), and one eight-message thread grew to
 * 20 MB of which 98% was that triplicate. Every read of the workspace paid for
 * it again, because attribution (`attachArtifactsByTurn`) has to know which turn
 * wrote which file and reads the siblings to decide.
 *
 * So the parent keeps a digest: the last few steps, each clipped, plus the paths
 * the dropped ones mentioned so the chip still resolves. Nothing renders a
 * delegation's step trace in full, so nothing loses a pixel.
 */
const MAX_STEPS = 4
const MAX_TEXT_CHARS = 1200
const MAX_INPUT_CHARS = 300
const MAX_PATHS = 8
/* How much dropped trace is worth scanning for paths at all: a fan-out's steps
   are megabytes, and the path a card needs is a short string. */
const MAX_SCAN_CHARS = 200_000

/* Absolute POSIX and Windows paths, as a run writes them in prose: after a
   space, a quote, an opening bracket or a colon. */
const PATH_SHAPE = /(?:^|[\s"'`(=:[{,])((?:~?\/|[A-Za-z]:[\\/])[^\s"'`()<>\]},;]+)/g

const clip = (value, limit) => {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** One step, with its two long fields bounded. Shape is preserved: the card
    reads `tool`, `input` and `content`/`output` by name. */
function clipStep(step) {
  if (!step || typeof step !== 'object') return step
  const out = { ...step }
  for (const key of ['content', 'output']) {
    if (typeof out[key] === 'string') out[key] = clip(out[key], MAX_TEXT_CHARS)
  }
  if (out.input && typeof out.input === 'object' && !Array.isArray(out.input)) {
    const input = {}
    for (const [key, value] of Object.entries(out.input)) {
      if (typeof value === 'string') input[key] = clip(value, MAX_INPUT_CHARS)
      else if (value === null || typeof value !== 'object') input[key] = value
      /* a nested object is display-only here, so a clipped string is enough */
      else input[key] = clip(JSON.stringify(value), MAX_INPUT_CHARS)
    }
    out.input = input
  }
  return out
}

/** The readable text of one step, for the path scan. */
function stepText(step) {
  if (!step || typeof step !== 'object') return ''
  const parts = []
  for (const key of ['content', 'output', 'tool']) {
    if (typeof step[key] === 'string') parts.push(step[key])
  }
  if (step.input && typeof step.input === 'object') {
    for (const value of Object.values(step.input)) {
      if (typeof value === 'string') parts.push(value)
    }
  }
  return parts.join('\n')
}

/** Absolute paths named in the steps this digest drops. */
function pathsIn(steps) {
  const found = []
  const seen = new Set()
  let budget = MAX_SCAN_CHARS
  for (const step of steps) {
    if (budget <= 0) break
    const text = stepText(step)
    if (!text) continue
    const slice = text.length > budget ? text.slice(0, budget) : text
    budget -= slice.length
    for (const [, raw] of slice.matchAll(PATH_SHAPE)) {
      const at = raw.replace(/[.,;:!?]+$/, '')
      if (!at || at === '~' || seen.has(at)) continue
      seen.add(at)
      found.push(at)
      if (found.length >= MAX_PATHS) return found
    }
  }
  return found
}

/**
 * `{ steps, paths }` for a transcript that has to stay small.
 *
 * The tail is what a card shows, so it is kept whole (clipped); everything
 * before it is scanned for paths and dropped. An absent trace answers
 * `{ steps: [], paths: [] }`, and a trace that already fits is returned as it
 * was, so a second digest is a no-op rather than a slow shrink.
 */
function digestSteps(steps) {
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) return { steps: [], paths: [] }
  const cut = Math.max(0, list.length - MAX_STEPS)
  const paths = pathsIn(list.slice(0, cut))
  return { steps: list.slice(cut).map(clipStep), paths }
}

module.exports = { digestSteps, MAX_STEPS, MAX_TEXT_CHARS }
