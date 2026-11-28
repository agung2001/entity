/**
 * Goals: one workspace file, one record per goal, and its tasks inside it.
 *
 * A goal is a sentence and a date; a task is a row inside that goal. Both live in
 * `goals.json` in the workspace directory, which is what makes a task one object
 * rather than four copies — the goal page, the backlog and the calendar read the
 * same records, so a tick is one write to one task and no page has to be told
 * what the others did.
 *
 * Nothing here reads a connector. `refresh` is the GOAL.js runner's, and it is
 * the only verb that may put a new *figure* on the page; the file only ever holds
 * what the last run returned (`read`) and when (`readAt`).
 *
 * Archiving keeps the record. `goals.remove` stamps `archivedAt` instead of
 * deleting a goal and its tasks: no surface in this feature offers an undo, and a
 * delete would be the one loss nobody could see coming. An archived goal is
 * simply not "open" any more, which is the number the rail shows.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const workspaces = require('./workspace-store.cjs')
const runner = require('./goal-runner.cjs')

const FILE = 'goals.json'
const PRIORITIES = ['critical', 'major', 'normal', 'minor']
const PRIVACY = ['private', 'workspace']
const TOKEN_KINDS = ['connector', 'file', 'artifact', 'note', 'issue', 'draft']
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every refusal says the second sentence a person needs: nothing moved. */
function refusal(message, code = 'goal') {
  const error = new Error(`${message} Nothing was changed.`)
  error.code = code
  return error
}

const text = (value, max = 400) => String(value ?? '').trim().slice(0, max)

/**
 * A calendar day, `YYYY-MM-DD`, or `''`. Bounded by the same three fields a
 * person typed: `2025-02-31` would otherwise be quietly stored as 3 March, and a
 * deadline that moves itself is the one thing §8 rule 4 forbids.
 */
function day(value) {
  const at = String(value ?? '').trim()
  if (!DAY.test(at)) return ''
  const [year, month, date] = at.split('-').map(Number)
  const when = new Date(Date.UTC(year, month - 1, date))
  const same =
    when.getUTCFullYear() === year && when.getUTCMonth() === month - 1 && when.getUTCDate() === date
  return same ? at : ''
}

/**
 * The context a person picked in the composer: connector rows, a Drive file, an
 * Orca project, an MCP server, an entity. References are kept; a local file's
 * bytes are not — `data` would put a base64 upload in every read of the goal.
 */
function contextOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 40)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      return {
        kind: text(entry.kind, 40),
        value: text(entry.value, 500),
        label: text(entry.label || entry.name, 200),
        detail: text(entry.detail, 300),
        url: text(entry.url, 800),
        account: text(entry.account, 120),
      }
    })
    .filter((entry) => entry && (entry.value || entry.label))
}

function tokenOf(raw) {
  return {
    kind: TOKEN_KINDS.includes(String(raw?.kind)) ? String(raw.kind) : 'draft',
    label: text(raw?.label, 120),
  }
}

/** A stored task, normalised. A row without a title is not a row. */
function taskOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = text(raw.title, 500)
  if (!title) return null
  return {
    id: text(raw.id, 80) || crypto.randomUUID(),
    priority: PRIORITIES.includes(String(raw.priority)) ? String(raw.priority) : 'normal',
    title,
    token: tokenOf(raw.token),
    date: day(raw.date),
    done: raw.done === true,
  }
}

function goalOf(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 80)
  const title = text(raw.title, 500)
  if (!id || !title) return null
  return {
    id,
    title,
    sentence: text(raw.sentence, 4000),
    deadline: day(raw.deadline),
    privacy: PRIVACY.includes(String(raw.privacy)) ? String(raw.privacy) : 'private',
    /* Which entity plans this goal. A name, because an entity is a file in the
       workspace and its name is the identity — renaming the agent is a rename of
       the file, which a goal cannot follow. */
    entity: text(raw.entity, 200),
    harness: text(raw.harness, 80),
    context: contextOf(raw.context),
    /* The identity, not a display name: the read-only rule compares this with the
       person opening the goal, and a renamed member must not lose their goals. */
    owner: text(raw.owner, 200),
    createdAt: String(raw.createdAt || ''),
    archivedAt: String(raw.archivedAt || ''),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.map(taskOf).filter(Boolean) : [],
    script: String(raw.script || ''),
    /* Written only by the runner. Anything that is not an object is a read that
       never happened, and `null` is how the page prints an em dash. */
    read: raw.read && typeof raw.read === 'object' ? raw.read : null,
    readAt: String(raw.readAt || ''),
  }
}

/** A submitted task list: every row keeps its id, so a tick after an edit lands. */
function taskList(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw refusal('The task list must be an array.', 'invalid')
  const seen = new Set()
  return value.map((raw) => {
    const task = taskOf(raw)
    if (!task) throw refusal('Every task needs a title.', 'invalid')
    if (seen.has(task.id)) throw refusal(`Two tasks share the id ${task.id}.`, 'invalid')
    seen.add(task.id)
    return task
  })
}

/**
 * The stored script: the caller's, bounded, or the counting default. It is code,
 * so the ceiling is applied when it is saved — a 2 MB script should be refused
 * at the write, not fail for ever on the first Refresh.
 */
function scriptOf(value) {
  const script = String(value ?? '').trim()
  if (!script) return runner.DEFAULT_SCRIPT
  if (script.length > runner.MAX_SCRIPT) {
    throw refusal(`GOAL.js is larger than ${runner.MAX_SCRIPT / 1024} kB.`, 'invalid')
  }
  return script
}

/**
 * The workspace directory, after `open` has refused one that is not there — so a
 * verb can never build a path out of an id the caller made up.
 */
function fileOf(workspace) {
  workspaces.open(workspace)
  return path.join(workspaces.workspaceDir(workspace), FILE)
}

function readGoals(workspace) {
  const file = fileOf(workspace)
  let body
  try {
    body = fs.readFileSync(file, 'utf8')
  } catch (error) {
    /* No file is an empty workspace: the first create writes one. */
    if (error?.code === 'ENOENT') return []
    throw refusal(`The goals file could not be read (${error.message}).`, 'unreadable')
  }
  let raw
  try {
    raw = JSON.parse(body)
  } catch {
    /* A malformed file is not an empty one. Returning [] here would let the next
       write replace every goal with the one just created. */
    throw refusal(`${FILE} is not readable JSON, so reading it would guess at your goals.`, 'unreadable')
  }
  if (!Array.isArray(raw?.goals)) throw refusal(`${FILE} does not hold a goal list.`, 'unreadable')
  return raw.goals.map(goalOf).filter(Boolean)
}

function writeGoals(workspace, goals) {
  /* `writeJson` is the workspace store's staged rename: a reader never sees half
     a file, and a failed write leaves the previous one whole. */
  workspaces.writeJson(fileOf(workspace), { schema: 1, goals })
  return goals
}

/* ── the verbs ────────────────────────────────────────────────────────── */

function read({ workspace } = {}) {
  return { goals: readGoals(workspace) }
}

function create({ workspace, goal } = {}) {
  const goals = readGoals(workspace)
  const title = text(goal?.title, 500)
  if (!title) throw refusal('A goal needs a title.', 'invalid')
  const sentence = text(goal?.sentence, 4000)
  if (!sentence) throw refusal('A goal needs a sentence.', 'invalid')
  const deadline = day(goal?.deadline)
  if (!deadline) throw refusal('A goal needs a date.', 'invalid')
  const record = {
    id: crypto.randomUUID(),
    title,
    sentence,
    deadline,
    privacy: PRIVACY.includes(String(goal?.privacy)) ? String(goal.privacy) : 'private',
    entity: text(goal?.entity, 200),
    harness: text(goal?.harness, 80),
    context: contextOf(goal?.context),
    owner: text(goal?.owner, 200),
    createdAt: new Date().toISOString(),
    archivedAt: '',
    tasks: taskList(goal?.tasks),
    /* A new goal starts with the counting script, on the record. An empty string
       would make Refresh answer `null` for ever, which is honest but useless;
       a script in the store's code would be a number nobody can read or edit. */
    script: scriptOf(goal?.script),
    read: null,
    readAt: '',
  }
  writeGoals(workspace, [...goals, record])
  return { goal: record, goals: [...goals, record] }
}

/**
 * The whole task list and the sentence — the two things a person edits after the
 * draft. Both are replaced in one write so a reordered list never half-lands, and
 * a task's id is kept, which is why a tick still finds the row afterwards.
 */
function update({ workspace, id, sentence, tasks } = {}) {
  const goals = readGoals(workspace)
  const at = goals.findIndex((goal) => goal.id === String(id || ''))
  if (at < 0) throw refusal('That goal is not in this workspace.', 'not_found')
  const goal = { ...goals[at] }
  if (sentence !== undefined) {
    const next = text(sentence, 4000)
    if (!next) throw refusal('A goal sentence cannot be empty.', 'invalid')
    goal.sentence = next
  }
  if (tasks !== undefined) goal.tasks = taskList(tasks)
  goals[at] = goal
  writeGoals(workspace, goals)
  return { goals }
}

/**
 * One task, one boolean. A tick is the action the feature exists to serve, so it
 * costs one call and one field — never a rewrite of the whole goal from a stale
 * renderer copy, which is how a second tab's edit would disappear.
 */
function tick({ workspace, id, task, done } = {}) {
  const goals = readGoals(workspace)
  const goal = goals.find((entry) => entry.id === String(id || ''))
  if (!goal) throw refusal('That goal is not in this workspace.', 'not_found')
  const row = goal.tasks.find((entry) => entry.id === String(task || ''))
  if (!row) throw refusal('That task is not in this goal.', 'not_found')
  row.done = done === true
  writeGoals(workspace, goals)
  return { goals }
}

/** Archive, not delete: the row leaves the index and the file keeps everything. */
function remove({ workspace, id } = {}) {
  const goals = readGoals(workspace)
  const goal = goals.find((entry) => entry.id === String(id || ''))
  if (!goal) throw refusal('That goal is not in this workspace.', 'not_found')
  goal.archivedAt = new Date().toISOString()
  writeGoals(workspace, goals)
  return { goals }
}

/**
 * Refresh — the one door a new figure comes in by.
 *
 * The script runs in `goal-runner.cjs`'s context, and its answer is stored as the
 * goal's `read` with its own `readAt`. A throw, a timeout or an empty read stores
 * `null` and keeps the attempt's reason for the caller: the page prints an em
 * dash, never a zero, and the Sources panel can say why.
 */
async function refresh({ workspace, id } = {}) {
  const goals = readGoals(workspace)
  const at = goals.findIndex((goal) => goal.id === String(id || ''))
  if (at < 0) throw refusal('That goal is not in this workspace.', 'not_found')
  const goal = goals[at]
  const { read, error } = await runner.run(goal.script, { goal })
  goals[at] = {
    ...goal,
    read,
    /* Only a landed read stamps the clock: `stale` means "a read answered, a
       while ago", and a failed attempt is `unread`, not stale. */
    readAt: read ? new Date().toISOString() : '',
  }
  writeGoals(workspace, goals)
  return { goal: goals[at], goals, error: error || '' }
}

module.exports = { FILE, read, create, update, tick, remove, refresh }
