/**
 * One file is the entity.
 *
 *   <ws>/entities/<name>.md
 *
 * Frontmatter is the configuration (`harness`, `model`, `dir`), the body is the
 * instructions the harness receives. Three things read that file and they must
 * not disagree: this app, a person with `$EDITOR`, and git.
 *
 * There is no per-entity access list. Skills and MCP servers belong to the
 * workspace, so every entity sees all of them — an entity file cannot take one
 * away from itself or from its siblings. `skills:`/`mcp:` lines in older files
 * are left alone by the reader and dropped by the next write.
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  HOME,
  tilde,
  expandHome,
  parseFrontmatter,
  frontmatterBody,
  mdRules,
  firstHeading,
  firstParagraph,
} = require('./frontmatter.cjs')
const harnesses = require('./harness-store.cjs')
const workspaces = require('./workspace-store.cjs')

/** `claude | codex | pi | opencode | gemini` — the harnesses this step can run.
 *  Read from `harness-store`'s META so an added CLI is one edit, not two. */
const HARNESSES = harnesses.META.map((meta) => meta.id)

const NAME = /^[a-z0-9][a-z0-9-]*$/

function entityDir(workspaceId) {
  const record = workspaces.open(workspaceId)
  return path.join(record.path, 'entities')
}

function safeName(value) {
  const name = String(value || '').trim()
  if (!NAME.test(name) || name.includes('..')) {
    throw new Error('An entity name is lowercase letters, digits and dashes.')
  }
  return name
}

function entityPath(workspaceId, name) {
  return path.join(entityDir(workspaceId), `${safeName(name)}.md`)
}

function problemsFor(workspaceId, entity) {
  const problems = []
  if (!HARNESSES.includes(entity.harness)) {
    problems.push(
      entity.harness
        ? `harness "${entity.harness}" is unknown`
        : 'harness is not set',
    )
  }
  if (!entity.dir) {
    problems.push('dir is not set')
  } else {
    const absolute = expandHome(entity.dir)
    const stat = fs.statSync(absolute, { throwIfNoEntry: false })
    if (!stat || !stat.isDirectory()) problems.push(`dir ${tilde(absolute)} does not exist`)
  }

  /* Skills and MCP servers are the workspace's, so there is nothing here to be
     missing: a skill this machine cannot see is reported once on the skills
     page, and a parked server is still in the pool (see `remote-manifest.cjs`).
     An entity that cannot reference them has no way to be wrong about them. */

  return problems
}

function readFile(workspaceId, file) {
  const text = fs.readFileSync(path.join(entityDir(workspaceId), file), 'utf8')
  const fm = parseFrontmatter(text)
  const name = String(fm.name || path.basename(file, path.extname(file))).trim()
  const instructions = frontmatterBody(text)
  const entity = {
    workspace: workspaceId,
    name,
    harness: String(fm.harness || '').trim(),
    model: String(fm.model || '').trim(),
    dir: String(fm.dir || '').trim(),
    /* a bookmark, not a grant: this only sorts the entity's own `/` menu */
    prefer: String(fm.prefer || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    mark: {
      shape: String(fm.shape || '').trim(),
      color: String(fm.color || '').trim(),
      mood: String(fm.mood || '').trim(),
    },
    instructions,
    rules: mdRules(instructions),
    summary: firstParagraph(instructions) || fm.description || '',
    title: firstHeading(instructions) || name,
    sourcePath: path.join(entityDir(workspaceId), file),
    displayPath: tilde(path.join(entityDir(workspaceId), file)),
    fileName: path.basename(file, path.extname(file)),
    /* kept verbatim so a write does not silently drop a key this UI never edits */
    frontmatter: fm,
    problems: [],
  }
  if (entity.fileName !== name) {
    entity.problems.push(`name "${name}" does not match the file name "${entity.fileName}"`)
  }
  entity.problems.push(...problemsFor(workspaceId, entity))
  entity.ok = entity.problems.length === 0
  return entity
}

function list(workspaceId) {
  let dir
  try {
    dir = entityDir(workspaceId)
  } catch {
    return []
  }
  let files
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    try {
      out.push(readFile(workspaceId, entry.name))
    } catch (error) {
      out.push({
        workspace: workspaceId,
        name: path.basename(entry.name, path.extname(entry.name)),
        harness: '',
        model: '',
        dir: '',
        mark: { shape: '', color: '', mood: '' },
        instructions: '',
        rules: [],
        summary: '',
        title: '',
        sourcePath: path.join(dir, entry.name),
        displayPath: tilde(path.join(dir, entry.name)),
        fileName: path.basename(entry.name, path.extname(entry.name)),
        problems: [`could not read the file: ${error.message}`],
        ok: false,
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function read(workspaceId, name) {
  const file = path.join(entityDir(workspaceId), `${safeName(name)}.md`)
  if (!fs.existsSync(file)) return null
  return readFile(workspaceId, path.basename(file))
}

/* Keys this writer owns. `skills` and `mcp` are here on purpose: they used to
   name a subset of the workspace, nothing reads them now, and listing them keeps
   a stale line from being copied forward forever with no effect. `prefer` is
   owned because it does have an effect — it is written back explicitly below. */
const KNOWN_KEYS = new Set(['name', 'harness', 'model', 'dir', 'prefer', 'skills', 'mcp'])

function serialize(entity) {
  const lines = ['---', `name: ${entity.name}`, `harness: ${entity.harness}`]
  if (entity.model) lines.push(`model: ${entity.model}`)
  lines.push(`dir: ${entity.dir}`)
  /* owned above, so the unknown-key loop below skips it — write it here or the
     next save silently drops the bookmark */
  if (entity.prefer?.length) lines.push(`prefer: ${entity.prefer.join(', ')}`)
  /* anything else the file carried survives the round trip */
  for (const [key, value] of Object.entries(entity.frontmatter || {})) {
    if (KNOWN_KEYS.has(key) || !String(value || '').trim()) continue
    lines.push(`${key}: ${value}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(entity.instructions || '').replace(/^\n+/, '')}`
}

/** tmp + rename: a crash cannot truncate an entity file. */
function write(entity) {
  const name = safeName(entity?.name)
  const file = entityPath(entity.workspace, name)
  const text = serialize({ ...entity, name })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return read(entity.workspace, name)
}

function scaffold({
  workspace,
  name,
  harness = 'claude',
  model = '',
  description = '',
  shape = '',
  color = '',
  mood = '',
  dir = '~',
  body = '',
}) {
  const safe = safeName(name)
  const file = entityPath(workspace, safe)
  if (fs.existsSync(file)) throw new Error(`${safe}.md already exists in this workspace.`)
  const brief = String(description || '').trim()
  const oneLine = brief.replace(/\s+/g, ' ').trim()
  const instructions = String(body || '').trim()
    ? String(body).replace(/^\n+/, '').replace(/\s+$/, '') + '\n'
    : `# ${safe}\n\n${brief || 'What this entity is for.'}\n\n## Rules\n- One rule per line.\n`
  return write({
    workspace,
    name: safe,
    harness: HARNESSES.includes(harness) ? harness : 'claude',
    model: String(model || '').trim(),
    dir: String(dir || '~').trim() || '~',
    instructions,
    frontmatter: {
      ...(oneLine ? { description: oneLine } : {}),
      ...(shape ? { shape: String(shape).trim() } : {}),
      ...(color ? { color: String(color).trim() } : {}),
      ...(mood ? { mood: String(mood).trim() } : {}),
    },
  })
}

/** Copy an entity file under a fresh name; every key survives. */
function duplicate({ workspace, name, nextName = '', shape = '', color = '', mood = '' }) {
  const source = read(workspace, name)
  if (!source) throw new Error(`${name}.md does not exist in this workspace.`)
  let target = String(nextName || '').trim()
  if (!target) {
    const base = `${source.name}-copy`
    target = base
    let n = 2
    while (fs.existsSync(entityPath(workspace, target))) target = `${base}-${n++}`
  }
  target = safeName(target)
  if (fs.existsSync(entityPath(workspace, target))) {
    throw new Error(
      `${target}.md already exists in this workspace. Rename the entity or pick another name.`,
    )
  }
  return write({
    ...source,
    workspace,
    name: target,
    frontmatter: {
      ...source.frontmatter,
      name: target,
      ...(shape ? { shape: String(shape).trim() } : {}),
      ...(color ? { color: String(color).trim() } : {}),
      ...(mood ? { mood: String(mood).trim() } : {}),
    },
  })
}

/** Copy one entity file into another workspace, never replacing an existing file. */
function cloneTo({ from, to, name, nextName = '', shape = '', color = '', mood = '' }) {
  if (!from || !to) throw new Error('Both the source and target workspace are required.')
  if (from === to) return duplicate({ workspace: from, name, nextName, shape, color, mood })
  const source = read(from, name)
  if (!source) throw new Error(`${name}.md does not exist in ${from}.`)
  const base = safeName(nextName || source.name)
  const target = base
  if (fs.existsSync(entityPath(to, target))) {
    throw new Error(
      `${target}.md already exists in ${to}. Rename the entity or pick another name.`,
    )
  }
  return write({
    ...source,
    workspace: to,
    name: target,
    frontmatter: {
      ...source.frontmatter,
      name: target,
      ...(shape ? { shape: String(shape).trim() } : {}),
      ...(color ? { color: String(color).trim() } : {}),
      ...(mood ? { mood: String(mood).trim() } : {}),
    },
  })
}

/** Delete the entity file. Conversations stay where they are. */
function remove({ workspace, name }) {
  const safe = safeName(name)
  const file = entityPath(workspace, safe)
  if (!fs.existsSync(file)) throw new Error(`${safe}.md does not exist in this workspace.`)
  fs.rmSync(file)
  return { name: safe }
}

/** The exact file path, for "Reveal in Finder" and for run headers. */
function locate({ workspace, name }) {
  return entityPath(workspace, name)
}

function resolveDir(entity) {
  if (!entity?.dir) throw new Error('This entity has no `dir` in its frontmatter.')
  const absolute = expandHome(entity.dir)
  const stat = fs.statSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) {
    throw new Error(`The working directory ${tilde(absolute)} does not exist.`)
  }
  return absolute
}

module.exports = {
  HARNESSES,
  HOME,
  list,
  read,
  write,
  scaffold,
  duplicate,
  cloneTo,
  remove,
  locate,
  resolveDir,
  safeName,
  problemsFor,
}
