/**
 * Drafting a goal's tasks — one harness turn, one JSON list.
 *
 * The sentence is the brief; the context is read, not guessed. An `@orca:<name>`
 * mention is resolved to the project Orca lists, and the model is handed that
 * project's file tree plus its README/package.json/docs, bounded, because a
 * one-shot runs in a scratch directory and cannot open a repository itself. A
 * sentence that names two projects gets both, which is what a gap analysis
 * ("what does One have that Entity does not") needs to be an analysis instead of
 * a line-by-line restatement.
 *
 * Numbers are not this module's business: it returns tasks, never a figure. The
 * answer is cleaned field by field, so a model that sends `"P1"`, a date outside
 * the window, or the same title twice cannot put any of it on the page.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const mention = require('./mention-ref.cjs')
const { runOneShot, lastJson } = require('./oneshot.cjs')
const workspaces = require('./workspace-store.cjs')

const TIMEOUT_MS = 120_000
const MAX_TASKS = 24
const MAX_TREE = 320
const MAX_DOC = 6_000
const MAX_DOCS = 8
const MAX_DIGEST = 48_000
const PRIORITIES = new Set(['critical', 'major', 'normal', 'minor'])

const trim = (value, limit) => {
  const text = String(value ?? '').trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

const localDay = (at = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** A stored day, or '' — the deadline and every proposed date go through here. */
function dayOf(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const [year, month, date] = text.split('-').map(Number)
  const at = new Date(year, month - 1, date)
  const same = at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === date
  return same ? text : ''
}

/** A file a tree may list: no dot-directories, no vendored trees, no secrets. */
function listable(rel) {
  const segments = String(rel).split('/')
  if (segments.some((part) => /^(\.|node_modules$|dist$|build$|coverage$)/.test(part) && part !== '.github')) return false
  return !/(^|\/)(auth\.json|auth\.key|secrets?|credentials?|\.env[^/]*)$/i.test(rel)
}

/**
 * The bounded, machine-readable half of "the context this sentence names": the
 * mentioned Orca projects as a tree and their own docs, plus the composer's
 * attachments as labels. Nothing is fetched over the network here.
 *
 * Every named project gets a fair share of the budget, so naming two does not
 * push the second one out of the brief — which is exactly the sentence that asks
 * for a gap between two projects.
 */
async function digest(sentence, context) {
  const blocks = []
  const named = [
    ...new Set([...String(sentence || '').matchAll(/@orca:([A-Za-z0-9._-]+)/g)].map((hit) => hit[1].toLowerCase())),
  ]
  if (named.length) {
    let repos = []
    try {
      repos = await mention.orcaRepos()
    } catch (error) {
      blocks.push(`Orca could not be read: ${String(error?.message || error)}`)
    }
    const budget = Math.max(8_000, Math.floor(MAX_DIGEST / named.length))
    for (const name of named) {
      const repo = repos.find((entry) => {
        const label = String(entry.displayName || path.basename(String(entry.path || ''))).toLowerCase()
        return label === name || path.basename(String(entry.path || '')).toLowerCase() === name
      })
      if (!repo) {
        blocks.push(`@orca:${name} is not a project Orca knows.`)
        continue
      }
      const root = path.resolve(String(repo.path))
      const files = mention.listProjectFiles(root, MAX_TREE).filter(listable)
      const head = [
        `## @orca:${repo.displayName || path.basename(root)} — ${root}`,
        `Files (${files.length}):`,
        ...files,
      ]
      const docs = files
        .filter((rel) => /^(README[^/]*|package\.json|pyproject\.toml|Cargo\.toml|docs\/[^/]+\.md)$/i.test(rel))
        .slice(0, MAX_DOCS)
      for (const rel of docs) {
        if (head.join('\n').length > budget - MAX_DOC) break
        try {
          head.push(`\n### ${rel}\n${fs.readFileSync(path.join(root, rel), 'utf8').slice(0, MAX_DOC)}`)
        } catch {
          /* an unreadable doc is not a reason to lose the tree */
        }
      }
      blocks.push(head.join('\n').slice(0, budget))
    }
  }
  if (Array.isArray(context) && context.length) {
    blocks.push(
      [
        '## Attached context',
        ...context
          .slice(0, 20)
          .map((entry) => `- ${entry.kind}: ${entry.label || entry.value}${entry.url ? ` (${entry.url})` : ''}`),
      ].join('\n'),
    )
  }
  return blocks.join('\n\n').slice(0, MAX_DIGEST)
}

const INSTRUCTION = [
  'You plan a dated goal. Turn the person’s sentence into the smallest list of',
  'concrete tasks that would make it true by its deadline.',
  '',
  'Rules:',
  '- One task is one job a person can finish and tick. Never a heading, a restatement',
  '  of the sentence, or a section of a plan.',
  '- Read the context. If the sentence asks to compare or migrate between projects,',
  '  name the actual features, screens, endpoints or files that have to move, taken',
  '  from the context. Do not invent what you cannot see; leave it out instead.',
  '- Order the tasks in the order the work has to happen.',
  '- "priority" is exactly one of: Critical, Major, Normal, Minor.',
  '- "date" is YYYY-MM-DD, between today and the deadline, in that order.',
  '- "token" is the project or file the task was reasoned from, short.',
  '- 3 to 20 tasks. If the sentence only supports one job, return one.',
  '',
  'Answer with JSON only, no prose and no code fences:',
  '{"tasks":[{"title":"…","priority":"Major","date":"YYYY-MM-DD","token":"@orca:One"}]}',
].join('\n')

/** The answer, field by field. Anything outside the window is dropped, not clamped. */
function cleanTasks(list, { today, deadline }) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const tasks = []
  for (const item of list) {
    const title = trim(typeof item === 'string' ? item : item?.title, 200)
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const priority = String(item?.priority || '').toLowerCase()
    let date = dayOf(item?.date)
    if (date && ((today && date < today) || (deadline && date > deadline))) date = ''
    tasks.push({
      id: crypto.randomUUID(),
      priority: PRIORITIES.has(priority) ? priority : 'normal',
      title,
      token: { kind: 'draft', label: trim(item?.token, 120) || 'from the plan' },
      date,
      done: false,
    })
    if (tasks.length >= MAX_TASKS) break
  }
  return tasks
}

async function draft({ workspace, entity, harness, model, sentence, deadline, context } = {}) {
  workspaces.open(workspace)
  const text = trim(sentence, 8_000)
  if (!text) throw new Error('Write the sentence first. Nothing was planned.')
  const id = String(harness || '').trim()
  if (!id) throw new Error('Choose an entity or a harness to plan with. Nothing was planned.')
  const due = dayOf(deadline)
  const today = localDay()

  const contextBlock = await digest(text, context)
  const prompt = [
    `Entity: ${trim(entity, 200) || '(none)'}`,
    `Today: ${today}`,
    `Deadline: ${due || '(none)'}`,
    '',
    'The goal:',
    '"""',
    text,
    '"""',
    '',
    'The context the goal names:',
    contextBlock || '(none provided)',
  ].join('\n')

  let answer
  try {
    answer = await runOneShot({
      harness: id,
      model: String(model || ''),
      instruction: INSTRUCTION,
      prompt,
      timeoutMs: TIMEOUT_MS,
      label: 'goal draft',
    })
  } catch (error) {
    throw new Error(`${String(error?.message || error)} Nothing was created.`)
  }

  const parsed = lastJson(answer.text)
  const tasks = cleanTasks(parsed?.tasks, { today, deadline: due })
  if (!tasks.length) {
    throw new Error(
      `${answer.harness || id} answered with no task list. Nothing was created — retry, or write the tasks yourself.`,
    )
  }
  return { tasks, harness: answer.harness, model: answer.model }
}

module.exports = { draft, cleanTasks, digest }
