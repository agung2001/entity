/**
 * The one shape the Dashboard tab's lock is read in.
 *
 * A gate is the answer to "may this tab open?", and it has **three** answers, not
 * two: *unread* (nobody has asked yet), *open*, and *locked with a sentence*. The
 * first two both mean "not locked" to the strip, and everything downstream reads
 * `{ locked, why, opens }`, so the translation happens here rather than in each
 * caller.
 *
 * It is a module of its own, with no imports, because that is what makes it testable
 * without a browser: the crash this file exists to prevent was `undefined.why`, when
 * a page with no Dashboard tab asked for its gate and the table lookup answered
 * nothing. A helper that cannot be reached by a unit test is a helper whose edge
 * cases are discovered by a person on the losing end.
 */

/** A gate nobody has answered yet. Not locked — an unread tab must not be refused
    before the read that would allow it lands. */
export const UNREAD = Symbol('unread')

/** A gate that is answered and open. */
export const OPEN = null

/** The open answer, as a value: shared, so its fields cannot drift from the locked
    one's. */
export const OPEN_GATE = Object.freeze({ locked: false, why: null, opens: 'overview' })

/**
 * A gate's answer, in the shape the strip reads.
 *
 * `undefined` is treated exactly like `UNREAD`: a descriptor that forgot to return
 * would otherwise either lock the tab forever or throw `undefined.why`. Opening is
 * the safe direction — a tab blocked by a missing answer is one nobody can unblock.
 */
export function toGate(answer) {
  if (answer === UNREAD || answer == null) return OPEN_GATE
  return {
    locked: true,
    why: answer.why || null,
    /* The folder lock is the one whose fix is a control on the page rather than a
       card on Overview, so its answer names the control. */
    opens: answer.opens || 'overview',
  }
}
