/**
 * What the workspace actually spent.
 *
 * A chat turn stores its own execution: model, duration, token counts and, when
 * the harness reports it, a cost. Those records are the only honest source of
 * spend — run files carry timing, not money — so the summary reads the thread
 * files and folds them by local calendar day.
 *
 * Everything is cached against the threads' mtimes: the overview and an entity
 * page ask for the same year within a second of each other, and re-reading a
 * thousand conversations for the second chart would be wasteful. A change to
 * any thread invalidates the cache.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')

const CACHE_LIMIT = 8
const MAX_THREAD_BYTES = 8 * 1024 * 1024
const cache = new Map()

function localDay(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function number(...values) {
  for (const value of values) {
    const current = Number(value)
    if (Number.isFinite(current)) return current
  }
  return 0
}

/** USD. Claude/Codex report `costUsd`; pi reports `usage.cost.total`. */
function costOf(execution) {
  if (!execution) return 0
  if (Number.isFinite(execution.costUsd)) return execution.costUsd
  const cost = execution.usage?.cost
  if (cost && Number.isFinite(cost.total)) return cost.total
  return 0
}

function usageOf(execution) {
  const usage = execution?.usage
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 }
  return {
    input: number(usage.input, usage.input_tokens, usage.prompt_tokens),
    output: number(usage.output, usage.output_tokens, usage.completion_tokens),
  }
}

function emptyDay() {
  return { costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0 }
}

function buckets() {
  return { totals: { costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0, threads: 0, priced: 0 }, days: {}, entities: {} }
}

function add(bucket, day, costUsd, tokensIn, tokensOut) {
  if (!bucket.totals) bucket.totals = { costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0, priced: 0 }
  if (!day) return
  bucket.days[day] = bucket.days[day] || emptyDay()
  const cell = bucket.days[day]
  cell.costUsd += costUsd
  cell.tokensIn += tokensIn
  cell.tokensOut += tokensOut
  cell.turns += 1
  bucket.totals.costUsd += costUsd
  bucket.totals.tokensIn += tokensIn
  bucket.totals.tokensOut += tokensOut
  bucket.totals.turns += 1
  if (costUsd > 0) bucket.totals.priced += 1
}

const round = (value) => Math.round(value * 1e6) / 1e6

function rounded(bucket) {
  for (const day of Object.values(bucket.days)) day.costUsd = round(day.costUsd)
  bucket.totals.costUsd = round(bucket.totals.costUsd)
  for (const entity of Object.values(bucket.entities)) {
    for (const day of Object.values(entity.days)) day.costUsd = round(day.costUsd)
    entity.totals.costUsd = round(entity.totals.costUsd)
  }
  return bucket
}

function threadFiles(record) {
  const dir = path.join(record.path, 'chats')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((file) => file.endsWith('.json') && !file.startsWith('.'))
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name))
      files.push({ name, at: stat.mtimeMs, size: stat.size })
    } catch {
      /* deleted between readdir and stat */
    }
  }
  return files.sort((a, b) => b.at - a.at)
}

function readThread(file) {
  if (file.size > MAX_THREAD_BYTES) return null
  try {
    return JSON.parse(fs.readFileSync(file.path, 'utf8'))
  } catch {
    return null
  }
}

function compute(record, year) {
  const result = buckets()
  const files = threadFiles(record)
  for (const entry of files) {
    const full = { ...entry, path: path.join(record.path, 'chats', entry.name) }
    const thread = readThread(full)
    if (!thread) continue
    result.totals.threads += 1
    const entityName = String(thread.entity || '')
    const entity = result.entities[entityName] || { totals: null, days: {} }
    let counted = false
    for (const message of thread.messages || []) {
      const execution = message?.execution
      if (!execution) continue
      const day = localDay(execution.endedAt || execution.startedAt || message.at || thread.updatedAt)
      if (!day || !day.startsWith(`${year}-`)) continue
      const { input, output } = usageOf(execution)
      const cost = costOf(execution)
      add(result, day, cost, input, output)
      add(entity, day, cost, input, output)
      counted = true
    }
    if (counted && entityName) result.entities[entityName] = entity
  }
  rounded(result)
  /* Flatten each entity into `{costUsd, tokensIn, tokensOut, turns, days}` so
     the renderer does not need to know about the internal totals bucket. */
  const entities = {}
  for (const [name, entity] of Object.entries(result.entities)) {
    entities[name] = { ...entity.totals, days: entity.days }
  }
  return { ...result, entities }
}

function signature(record, year) {
  const files = threadFiles(record)
  const newest = files[0]?.at || 0
  return `${record.id}:${year}:${files.length}:${Math.round(newest)}`
}

/** Folded spend for one workspace and calendar year. */
function summary({ workspace, year = new Date().getFullYear() } = {}) {
  const record = workspaces.open(workspace)
  const wanted = Number(year) || new Date().getFullYear()
  const key = signature(record, wanted)
  const hit = cache.get(record.id)
  if (hit && hit.key === key && hit.year === wanted) return hit.value

  const value = compute(record, wanted)
  cache.set(record.id, { key, year: wanted, value })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return value
}

module.exports = { summary, costOf, usageOf, localDay }
