/**
 * A clearer rewrite of a prompt, before it costs a turn.
 *
 * One `runOneShot` on the thread's own harness and model — the same call shape
 * as `suggest.cjs`, and the same 45 s ceiling — answering `count` variations of
 * the draft, plus the optional extra instruction from the dialog's Advanced
 * disclosure.
 *
 * Two deliberate differences from the follow-up suggestions:
 *
 *   - there is **no cache**. A suggestion strip is a page decoration and a
 *     repeat is waste; a rewrite was asked for explicitly and a stale answer
 *     would be applied as if it were new;
 *   - a failure **surfaces**. The caller keeps every input and offers Retry, so
 *     this module throws with a sentence a person can read instead of returning
 *     an empty list.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const { runOneShot, lastJson } = require('./oneshot.cjs')

const TIMEOUT_MS = 45_000
const MAX_VARIATIONS = 5
/* Long enough for any prompt worth rewriting; the draft itself is already
   capped at 20 000 characters by `normaliseDraft` on the renderer side. */
const MAX_DRAFT = 20_000
const MAX_GUIDE = 2_000

const INSTRUCTION = [
  'You rewrite a person’s prompt so it is clearer and cheaper to answer.',
  '',
  'Keep the intent exactly: the same task, the same constraints, the same facts.',
  'Make it concrete: name what a good answer has to contain, what to check first,',
  'and what to leave alone. Drop pleasantries and anything the person did not ask for.',
  'Do not answer the prompt. Do not invent files, tools, dates or requirements.',
  '',
  'For every variation write:',
  '- "text": the complete rewritten prompt, in the person’s own voice, ready to send;',
  '- "differs": one sentence on what this variation does differently, for a person',
  '  comparing rows side by side.',
  'Answer with JSON only, no prose and no code fences:',
  '{"variations":[{"text":"…","differs":"…"}]}',
].join('\n')

function trim(text, limit) {
  const value = String(text || '').trim()
  return value.length <= limit ? value : value.slice(0, limit)
}

/** The count the dialog asked for, clamped; anything else is one variation. */
function countOf(value) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number) || number < 1) return 1
  return Math.min(MAX_VARIATIONS, number)
}

/** One row per variation: non-empty, bounded, deduplicated, never more than asked. */
function cleanVariations(list, count = MAX_VARIATIONS) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    /* a model that answers with bare strings is still a usable answer */
    const text = trim(typeof item === 'string' ? item : item?.text, MAX_DRAFT)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text, differs: trim(item?.differs, 400).replace(/\s+/g, ' ') })
    if (out.length >= count) break
  }
  return out
}

async function enhance({ workspace, threadId, draft, count, guide, harness, model } = {}) {
  const text = String(draft || '').trim()
  if (!text) throw new Error('There is nothing in the composer to rewrite.')
  const id = String(threadId || '')
  const record = workspaces.open(workspace)
  let thread = null
  if (id) {
    try {
      thread = JSON.parse(fs.readFileSync(path.join(record.path, 'chats', `${id}.json`), 'utf8'))
    } catch {
      thread = null
    }
    if (!thread) throw new Error('That thread no longer exists.')
  }
  /* A goal's composer is not a thread: it names the harness it wants, and the
     rewrite runs there instead of borrowing a conversation's history. */
  const targetHarness = String(thread?.harness || harness || '')
  const targetModel = String(thread?.model || model || '')
  if (!targetHarness) throw new Error(id ? 'That thread has no harness.' : 'No thread is open.')

  const wanted = countOf(count)
  const extra = trim(guide, MAX_GUIDE)

  const prompt = [
    `Rewrite this prompt into ${wanted} ${wanted === 1 ? 'variation' : 'variations'}.`,
    extra ? `Extra instruction from the person: ${extra}` : '',
    '',
    'The prompt:',
    '"""',
    trim(text, MAX_DRAFT),
    '"""',
  ]
    .filter((line) => line !== '')
    .join('\n')

  let result
  try {
    result = await runOneShot({
      harness: targetHarness,
      model: targetModel,
      instruction: INSTRUCTION,
      prompt,
      timeoutMs: TIMEOUT_MS,
      label: 'prompt enhancement',
    })
  } catch (error) {
    throw new Error(error?.message || 'The rewrite did not run.')
  }

  const parsed = lastJson(result.text)
  const variations = cleanVariations(parsed?.variations, wanted)
  if (!variations.length) {
    throw new Error(
      `${targetHarness || 'The harness'} returned no text. Nothing was applied to your draft.`,
    )
  }
  return { variations, harness: targetHarness, model: targetModel }
}

module.exports = { enhance, cleanVariations, countOf }
