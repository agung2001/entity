/**
 * One file is the entity.
 *
 *   <ws>/entities/<name>.md
 *
 * Frontmatter is the configuration (`harness`, `model`, `dir`, `skills`, `mcp`),
 * the body is the instructions the harness receives. Three things read that file
 * and they must not disagree: this app, a person with `$EDITOR`, and git.
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  HOME,
  tilde,
  expandHome,
  parseFrontmatter,
  frontmatterBody,
  splitList,
  mdRules,
  firstHeading,
  firstParagraph,
} = require('./frontmatter.cjs')
const localData = require('./local-data.cjs')
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
  const record = workspaces.open(workspaceId)

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

  const attached = new Set(
    localData
      .scanSkillDir(path.join(record.path, 'skills'), { detectHarness: true })
      .map((skill) => skill.name.toLowerCase()),
  )
  for (const skill of entity.skills) {
    if (!attached.has(skill.toLowerCase())) problems.push(`skill "${skill}" is missing`)
  }

  const pool = workspaces.mcp(workspaceId)
  for (const server of entity.mcp) {
    if (!pool.names.includes(server)) problems.push(`mcp server "${server}" is not in this workspace`)
  }

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
    skills: splitList(fm.skills),
    mcp: splitList(fm.mcp),
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
        skills: [],
        mcp: [],
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

const KNOWN_KEYS = new Set(['name', 'harness', 'model', 'dir', 'skills', 'mcp'])

function serialize(entity) {
  const lines = ['---', `name: ${entity.name}`, `harness: ${entity.harness}`]
  if (entity.model) lines.push(`model: ${entity.model}`)
  lines.push(`dir: ${entity.dir}`)
  if (entity.skills?.length) lines.push(`skills: ${entity.skills.join(', ')}`)
  if (entity.mcp?.length) lines.push(`mcp: ${entity.mcp.join(', ')}`)
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

function scaffold({ workspace, name, harness = 'claude', model = '', description = '', shape = '', color = '', mood = '' }) {
  const safe = safeName(name)
  const file = entityPath(workspace, safe)
  if (fs.existsSync(file)) throw new Error(`${safe}.md already exists in this workspace.`)
  const brief = String(description || '').trim()
  const oneLine = brief.replace(/\s+/g, ' ').trim()
  const body = `# ${safe}\n\n${brief || 'What this entity is for.'}\n\n## Rules\n- One rule per line.\n`
  return write({
    workspace,
    name: safe,
    harness: HARNESSES.includes(harness) ? harness : 'claude',
    model: String(model || '').trim(),
    dir: '~',
    skills: [],
    mcp: [],
    instructions: body,
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
    throw new Error(`${target}.md already exists in this workspace.`)
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
  remove,
  locate,
  resolveDir,
  safeName,
  problemsFor,
}
