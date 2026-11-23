/**
 * Learning: read how an entity was actually used, then propose better standing
 * instructions.
 *
 * The model sees the current instructions and a scope of recent conversations,
 * and answers with a short summary plus a complete replacement body. Nothing is
 * written here — the person reviews a side-by-side diff and applies it
 * themselves. A proposal is a proposal; the file changes only on `apply`.
 */
const fs = require('node:fs')
const path = require('node:path')
const entities = require('./entity-store.cjs')
const workspaces = require('./workspace-store.cjs')
const { runOneShot, lastJson } = require('./oneshot.cjs')

const THREADS = 10
/* ponytail: the scope ceiling is a number the renderer may not raise. A review
   is one harness turn over whole transcripts, so 200 threads is already far
   past what the context cut keeps; the upgrade path is a second pass that
   summarises in chunks, not a bigger ceiling. */
const MAX_THREADS = 200
const MAX_CONTEXT = 26_000
const MAX_INSTRUCTIONS = 60_000
/* The answer is a whole instructions file, not a paragraph: a 27 KB `coder.md`
   came back as ~24 KB in 148s on the smallest possible scope, because the cost
   is generating the replacement, not reading the transcripts (2 conversations
   at 22 KB took 148s; 10 at 50 KB took 112s). 45s is the sibling one-shots'
   number and their answers are a few lines; 120s was under the shortest review
   this workspace can ask for.
   ponytail: one ceiling for every scope, because a wait the person is told about
   is one number. Scaling it by file size would be a second number to explain;
   the upgrade path is streaming a diff instead of a whole body, which removes
   the size dependency rather than giving it a formula. */
const TIMEOUT_MS = 300_000

const INSTRUCTION = [
  "You maintain an AI entity's standing instructions by learning from how people",
  'actually use it. You are given the current instructions and a scope of recent',
  'conversations with this entity; the header above them states how many were read',
  'and the date range they were chosen from.',
  '',
  'Propose an improved version of the instructions that:',
  '- keeps everything that already works, including headings and tone;',
  '- adds only rules that the conversations actually support (recurring asks,',
  '  corrections, formats people expect, steps the entity kept missing);',
  '- removes or sharpens rules the conversations show to be counterproductive;',
  '- never invents tools, MCP servers, skills or capabilities that are not in the',
  '  current instructions;',
  '- stays the same kind of document: Markdown, addressed to the entity, no',
  '  frontmatter, no commentary about this review.',
  '',
  'Answer with JSON only, no prose and no code fences:',
  '{"summary":"<2-4 sentences: what the conversations show and what you changed>",',
  ' "instructions":"<the complete replacement instructions body in Markdown>"}',
].join('\n')

function trim(text, limit) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim()
  if (value.length <= limit) return value
  const head = Math.round(limit * 0.7)
  const tail = limit - head
  return `${value.slice(0, head)}\n\n… (trimmed) …\n\n${value.slice(-tail)}`
}

function chatsDir(record) {
  return path.join(record.path, 'chats')
}

/* ── the scope, validated at the trust boundary ────────────────────────────
   `entity.learn` is reachable from the renderer, so every argument is a claim,
   not a value: a string `limit`, a `NaN`, a `0` or a date-shaped lie is an
   error with a sentence, never a silent fallback to the ten most recent. */

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` → the epoch ms it starts at (UTC), or `null` if it is not a day. */
function dayStart(value) {
  if (typeof value !== 'string' || !DATE_SHAPE.test(value.trim())) return null
  const at = Date.parse(`${value.trim()}T00:00:00.000Z`)
  if (!Number.isFinite(at)) return null
  /* Date.parse rolls 2026-02-31 into March: a day that does not exist is unparseable */
  if (new Date(at).toISOString().slice(0, 10) !== value.trim()) return null
  return at
}

function scopeOf({ limit, since, until, ids } = {}) {
  let count = THREADS
  if (limit !== undefined && limit !== null) {
    const value = Number(limit)
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('A review reads at least one conversation, so the count must be a whole number above zero.')
    }
    count = Math.min(value, MAX_THREADS)
  }

  const bounds = {}
  for (const [key, value] of [['since', since], ['until', until]]) {
    if (value === undefined || value === null || value === '') continue
    const at = dayStart(value)
    if (at === null) throw new Error(`"${value}" is not a date. Use YYYY-MM-DD, or leave the field empty for no bound.`)
    bounds[key] = at
  }
  if (bounds.since !== undefined && bounds.until !== undefined && bounds.since > bounds.until) {
    throw new Error(`The range ends before it starts: ${since} is after ${until}.`)
  }

  let wanted = null
  if (ids !== undefined && ids !== null) {
    if (!Array.isArray(ids)) throw new Error('A conversation list must be an array of thread ids.')
    if (!ids.length) throw new Error('Choose at least one conversation to review.')
    wanted = new Set(ids.map((id) => String(id)))
  }

  return { limit: count, ...bounds, ids: wanted }
}

/** The day a thread last changed: its own `updatedAt`, or the file's mtime. */
function threadDay(thread, at) {
  const own = Date.parse(String(thread?.updatedAt || ''))
  if (Number.isFinite(own)) return own
  return Number.isFinite(at) ? at : null
}

/**
 * The threads a review reads, newest first.
 *
 * `scope` is optional so the old `(record, entity, limit)` call still means
 * "the N most recent". A date range and an id list are applied *before* the
 * count, so "3 of 34" always means three threads whose dates matched, not
 * three threads inside a scan of three.
 */
function recentFor(record, entity, scope = {}) {
  const options = typeof scope === 'number' ? { limit: scope } : scope || {}
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : THREADS
  const since = options.since ?? null
  const until = options.until ?? null
  const ids = options.ids || null

  const dir = chatsDir(record)
  let files = []
  try {
    files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .map((file) => {
        try {
          return { file, at: fs.statSync(path.join(dir, file)).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }

  const rows = []
  for (const entry of files) {
    if (rows.length >= limit) break
    const id = path.basename(entry.file, '.json')
    /* An id list is a filter, not a hint: an unknown id reads nothing. */
    if (ids && !ids.has(id)) continue
    let thread
    try {
      thread = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'))
    } catch {
      continue
    }
    if (String(thread.entity || '') !== entity) continue
    if (since !== null || until !== null) {
      const at = threadDay(thread, entry.at)
      if (at === null) continue
      /* both bounds are inclusive of the whole day */
      if (since !== null && at < since) continue
      if (until !== null && at >= until + 86_400_000) continue
    }
    const spoken = (thread.messages || []).filter(
      (message) => (message.who === 'me' || message.who === 'agent') && String(message.text || '').trim(),
    )
    if (!spoken.length) continue
    rows.push({
      id: thread.id || id,
      title: String(thread.title || '').trim() || 'Untitled conversation',
      updatedAt: thread.updatedAt || '',
      messages: spoken,
    })
  }
  return rows
}

function transcript(rows) {
  const parts = []
  let used = 0
  for (const thread of rows) {
    const header = `## Conversation: ${thread.title}${thread.updatedAt ? ` (${thread.updatedAt.slice(0, 10)})` : ''}`
    const lines = [header]
    for (const message of thread.messages) {
      const who = message.who === 'me' ? 'User' : 'Entity'
      const text = trim(message.text, 1800)
      const block = `${who}: ${text}`
      if (used + block.length > MAX_CONTEXT) break
      lines.push(block)
      used += block.length
    }
    if (lines.length > 1) parts.push(lines.join('\n\n'))
    if (used >= MAX_CONTEXT) break
  }
  return parts.join('\n\n---\n\n')
}

function cleanInstructions(value) {
  let text = String(value || '').replace(/\r\n/g, '\n').trim()
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i)
  if (fenced) text = fenced[1].trim()
  if (text.length > MAX_INSTRUCTIONS) text = text.slice(0, MAX_INSTRUCTIONS)
  return text
}

/** Ask the entity's own harness for a proposal. Never writes. */
async function review({ workspace, entity, limit, since, until, ids } = {}) {
  const name = String(entity || '').trim()
  if (!name) throw new Error('Choose an entity first.')
  const current = entities.read(workspace, name)
  if (!current) throw new Error(`No entity called "${name}" in this workspace.`)
  if (!current.harness) throw new Error(`${name} has no harness, so it cannot review its own instructions.`)

  const scope = scopeOf({ limit, since, until, ids })
  const record = workspaces.open(workspace)
  const rows = recentFor(record, name, scope)
  if (!rows.length) {
    throw new Error(`No conversations with ${name} match that scope. Widen the dates, or chat with it first.`)
  }

  /* What was actually read, in the words of the scope — the prompt may not
     claim ten conversations when the range handed over two. */
  const asked = scope.limit
  const bounds = [
    scope.since !== undefined ? `since ${since}` : '',
    scope.until !== undefined ? `until ${until}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const prompt = [
    `Entity: ${name}`,
    `Harness: ${current.harness}${current.model ? ` · model ${current.model}` : ''}`,
    `Conversations: ${rows.length} of up to ${asked}${bounds ? ` · ${bounds}` : ''}`,
    '',
    '### Current instructions',
    trim(current.instructions, 16_000) || '(empty)',
    '',
    `### Recent conversations (${rows.length})`,
    transcript(rows),
  ].join('\n')

  const started = Date.now()
  const result = await runOneShot({
    harness: current.harness,
    model: current.model,
    instruction: INSTRUCTION,
    prompt,
    timeoutMs: TIMEOUT_MS,
    label: `learning review (${name})`,
  })

  const parsed = lastJson(result.text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The review came back without the JSON summary. Nothing was changed.')
  }
  const proposed = cleanInstructions(parsed.instructions)
  if (!proposed) {
    throw new Error('The review did not propose any instructions. Nothing was changed.')
  }
  const summary = String(parsed.summary || '').trim() || 'The review proposed updated instructions.'

  return {
    entity: name,
    harness: result.harness,
    model: result.model,
    ms: Date.now() - started,
    summary: summary.slice(0, 2000),
    current: current.instructions,
    proposed,
    asked,
    sources: rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt })),
  }
}

/** Write the reviewed body back to the entity file, keeping its frontmatter. */
function apply({ workspace, entity, instructions } = {}) {
  const name = String(entity || '').trim()
  const body = cleanInstructions(instructions)
  if (!name) throw new Error('Choose an entity first.')
  if (!body) throw new Error('There is nothing to apply.')
  const current = entities.read(workspace, name)
  if (!current) throw new Error(`No entity called "${name}" in this workspace.`)
  return entities.write({ ...current, instructions: body })
}

module.exports = { review, apply, recentFor, INSTRUCTION }
