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
const os = require('node:os')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const { createParser } = require('./chat-transcript.cjs')
const harnesses = require('./harness-store.cjs')
const mention = require('./mention-ref.cjs')
const { lastJson } = require('./oneshot.cjs')
const { chatInvocation } = require('./runner-local.cjs')
const workspaces = require('./workspace-store.cjs')

const TIMEOUT_MS = 120_000
const MAX_TASKS = 24
const MAX_TREE = 320
const MAX_DOC = 6_000
const MAX_DOCS = 8
const MAX_DIGEST = 48_000
const PRIORITIES = new Set(['critical', 'major', 'normal', 'minor'])
const EFFORTS = new Set(['small', 'medium', 'large'])

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

/**
 * What the streaming row says about one parser step: the tool and the one thing
 * it is pointed at. Never a file's contents — the card is a progress line, not a
 * transcript.
 */
function stepLabel(event) {
  const step = event?.step || {}
  const input = step.input && typeof step.input === 'object' ? step.input : {}
  const detail = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
  if (step.type === 'tool_use') {
    return {
      type: 'tool',
      tool: detail(step.tool || step.name || 'Tool'),
      detail: detail(
        input.file_path ||
          input.path ||
          input.pattern ||
          input.query ||
          input.command ||
          input.url ||
          input.description ||
          '',
      ),
    }
  }
  if (step.type === 'thinking') return { type: 'thinking', tool: 'Thinking', detail: detail(step.content) }
  if (step.type === 'text') return { type: 'text', tool: 'Writing the plan', detail: detail(step.content) }
  if (step.type === 'error') return { type: 'error', tool: 'Error', detail: detail(step.content) }
  return null
}

/**
 * One harness turn, streamed: the parent gets `goal.draft` phases over `emit`
 * (`start` / `step` / `end`), so the create page can show what is happening and
 * how long it has been happening instead of a bare spinner. The final answer is
 * the parser's own trailing text — the same reader the chat uses per harness.
 */
function runStreaming({ harness, model, instruction, prompt, workspace, draftId, emit }) {
  const id = String(harness || '')
  const meta = harnesses.META.find((item) => item.id === id)
  if (!meta) throw new Error('Choose a local harness first.')
  const spec = chatInvocation(id, instruction, prompt, model)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-goaldraft-'))
  const started = Date.now()
  const send = (phase, data) => {
    try {
      emit({ kind: 'goal.draft', workspace, draftId, phase, at: new Date().toISOString(), data })
    } catch {
      /* a window that closed mid-plan must not break the plan */
    }
  }
  const late = new Map()
  const parser = createParser(id, {
    onStep: (event) => {
      if (event?.action === 'add') {
        const label = stepLabel(event)
        if (label) send('step', label)
        return
      }
      /* text arrives block by block; keep one "Writing" row and refresh it,
         at most a few times a second */
      if (event?.action === 'update' && event.step?.type === 'text') {
        const now = Date.now()
        if (now - (late.get('text') || 0) < 350) return
        late.set('text', now)
        send('step', { type: 'text', tool: 'Writing the plan', detail: String(event.step.content || '').replace(/\s+/g, ' ').slice(-140) })
      }
    },
  })

  return new Promise((resolve, reject) => {
    let child = null
    let timedOut = false
    let timer = null
    let stderr = ''
    const settle = (fn) => {
      if (timer) clearTimeout(timer)
      fs.rmSync(cwd, { recursive: true, force: true })
      fn()
    }
    try {
      child = spawnTracked(spec.cmd, spec.argv, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        kind: 'oneshot',
        label: `goal draft (${id})`,
      })
    } catch (error) {
      settle(() => {
        send('end', { ok: false, ms: Date.now() - started })
        reject(new Error(`The ${meta.label} CLI could not start: ${error?.message || error}`))
      })
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      try {
        killTree(child, 'SIGKILL')
      } catch {
        /* the close handler reports the failure */
      }
    }, TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    let firstChunk = true
    child.stdout?.on('data', (chunk) => {
      if (firstChunk) {
        firstChunk = false
        send('step', { type: 'status', tool: 'Writing the plan', detail: '' })
      }
      parser.push(String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000)
    })
    child.on('error', (error) => {
      settle(() => {
        send('end', { ok: false, ms: Date.now() - started })
        reject(
          new Error(
            error?.code === 'ENOENT'
              ? `${meta.label} is not installed on this machine, or not on PATH.`
              : String(error?.message || error),
          ),
        )
      })
    })
    child.on('close', (code) => {
      const result = parser.finish()
      const ms = Date.now() - started
      if (timedOut) {
        settle(() => {
          send('end', { ok: false, ms })
          reject(new Error(`The ${meta.label} CLI did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.`))
        })
        return
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
        settle(() => {
          send('end', { ok: false, ms })
          reject(
            new Error(
              `The ${meta.label} CLI exited with code ${code}${detail ? `: ${detail}` : '.'}`,
            ),
          )
        })
        return
      }
      settle(() => {
        send('end', { ok: true, ms })
        resolve({ text: result.answer || '', harness: id, model: String(model || ''), steps: result.steps })
      })
    })
    try {
      if (spec.stdin) child.stdin.write(spec.stdin)
      child.stdin.end()
    } catch {
      /* close/error reports a dead child */
    }
  })
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
  '- "entity" is exactly one of the entity names provided, the one best suited to',
  '  the job. Do not invent an entity. Omit it only when no entity fits.',
  '- "effort" is Small, Medium or Large — the size of the job, not its urgency.',
  '- "token" is the project or file the task was reasoned from, short.',
  '- 3 to 20 tasks. If the sentence only supports one job, return one.',
  '- "summary" is 2–4 sentences for the person deciding whether to pursue the goal:',
  '  what the plan covers, which entity carries the load, and the one risk or gap',
  '  that is easiest to miss. No marketing, no restating the tasks one by one.',
  '',
  'Answer with JSON only, no prose and no code fences:',
  '{"summary":"…","tasks":[{"title":"…","priority":"Major","date":"YYYY-MM-DD","entity":"…","effort":"Medium","token":"@orca:One"}]}',
].join('\n')

/** The answer, field by field. Anything outside the window is dropped, not clamped. */
function cleanTasks(list, { today, deadline, entities = [] }) {
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
    /* the model may answer with a name this workspace does not have; only one
       the caller listed is stored, so a row can never point at nobody */
    const wanted = String(item?.entity || '').trim().toLowerCase()
    const entity = entities.find((entry) => String(entry).toLowerCase() === wanted) || ''
    const effort = String(item?.effort || '').toLowerCase()
    tasks.push({
      id: crypto.randomUUID(),
      priority: PRIORITIES.has(priority) ? priority : 'normal',
      title,
      token: { kind: 'draft', label: trim(item?.token, 120) || 'from the plan' },
      date,
      done: false,
      entity,
      effort: EFFORTS.has(effort) ? effort : '',
    })
    if (tasks.length >= MAX_TASKS) break
  }
  return tasks
}

async function draft({
  workspace,
  entity,
  harness,
  model,
  sentence,
  deadline,
  context,
  entities = [],
  draftId = '',
  emit = () => {},
} = {}) {
  workspaces.open(workspace)
  const text = trim(sentence, 8_000)
  if (!text) throw new Error('Write the sentence first. Nothing was planned.')
  const id = String(harness || '').trim()
  if (!id) throw new Error('Choose an entity or a harness to plan with. Nothing was planned.')
  const due = dayOf(deadline)
  const today = localDay()

  const send = (phase, data) => {
    try {
      emit({ kind: 'goal.draft', workspace, draftId, phase, at: new Date().toISOString(), data })
    } catch {
      /* a window that closed mid-plan must not break the plan */
    }
  }
  const named = [
    ...new Set([...text.matchAll(/@orca:([A-Za-z0-9._-]+)/g)].map((hit) => hit[1])),
  ]
  send('start', { harness: id })
  send('step', {
    type: 'status',
    tool: named.length ? 'Reading the context' : 'Reading the goal',
    detail: named.map((name) => `@orca:${name}`).join(', '),
  })
  const contextBlock = await digest(text, context)
  if (named.length) {
    send('step', {
      type: 'status',
      tool: 'Context read',
      detail: `${named.length} ${named.length === 1 ? 'project' : 'projects'} · ${Math.round(contextBlock.length / 1024)} kB`,
    })
  }
  const available = (Array.isArray(entities) ? entities : [])
    .map((entry) => trim(entry, 200))
    .filter(Boolean)
    .slice(0, 40)
  const prompt = [
    `Entity planning this goal: ${trim(entity, 200) || '(none)'}`,
    `Entities available for the tasks: ${available.length ? available.join(', ') : '(none listed)'}`,
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
    answer = await runStreaming({
      harness: id,
      model: String(model || ''),
      instruction: INSTRUCTION,
      prompt,
      workspace,
      draftId,
      emit,
    })
  } catch (error) {
    throw new Error(`${String(error?.message || error)} Nothing was created.`)
  }

  const parsed = lastJson(answer.text)
  const summary = trim(parsed?.summary, 1_400)
  const tasks = cleanTasks(parsed?.tasks, { today, deadline: due, entities: available })
  if (!tasks.length) {
    throw new Error(
      `${answer.harness || id} answered with no task list. Nothing was created — retry, or write the tasks yourself.`,
    )
  }
  return { summary, tasks, harness: answer.harness, model: answer.model }
}

module.exports = { draft, runStreaming, cleanTasks, digest, stepLabel }
