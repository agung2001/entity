/**
 * Learning: read how an entity was actually used, then propose better standing
 * instructions.
 *
 * The model sees the current instructions and the last ten conversations, and
 * answers with a short summary plus a complete replacement body. Nothing is
 * written here — the person reviews a side-by-side diff and applies it
 * themselves. A proposal is a proposal; the file changes only on `apply`.
 */
const fs = require('node:fs')
const path = require('node:path')
const entities = require('./entity-store.cjs')
const workspaces = require('./workspace-store.cjs')
const { runOneShot, lastJson } = require('./oneshot.cjs')

const THREADS = 10
const MAX_CONTEXT = 26_000
const MAX_INSTRUCTIONS = 60_000
const TIMEOUT_MS = 120_000

const INSTRUCTION = [
  "You maintain an AI entity's standing instructions by learning from how people",
  'actually use it. You are given the current instructions and the ten most recent',
  'conversations with this entity.',
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

function recentFor(record, entity, limit) {
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
    let thread
    try {
      thread = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'))
    } catch {
      continue
    }
    if (String(thread.entity || '') !== entity) continue
    const spoken = (thread.messages || []).filter(
      (message) => (message.who === 'me' || message.who === 'agent') && String(message.text || '').trim(),
    )
    if (!spoken.length) continue
    rows.push({
      id: thread.id || path.basename(entry.file, '.json'),
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
async function review({ workspace, entity } = {}) {
  const name = String(entity || '').trim()
  if (!name) throw new Error('Choose an entity first.')
  const current = entities.read(workspace, name)
  if (!current) throw new Error(`No entity called "${name}" in this workspace.`)
  if (!current.harness) throw new Error(`${name} has no harness, so it cannot review its own instructions.`)

  const record = workspaces.open(workspace)
  const rows = recentFor(record, name, THREADS)
  if (!rows.length) {
    throw new Error(`No conversations with ${name} yet. Chat with it first, then learn from them.`)
  }

  const prompt = [
    `Entity: ${name}`,
    `Harness: ${current.harness}${current.model ? ` · model ${current.model}` : ''}`,
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
