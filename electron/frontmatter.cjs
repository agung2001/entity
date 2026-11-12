/**
 * One frontmatter parser for the two file kinds that carry it: `SKILL.md` and
 * an entity's `ENTITY.md`-shaped markdown file.
 *
 * The format is deliberately flat — `key: value` pairs at the top of the file —
 * because three different readers need to agree on it: this app, a person with
 * `$EDITOR`, and the harness that receives the body as instructions.
 */
const os = require('node:os')
const path = require('node:path')

const HOME = os.homedir()

function stripQuotes(value) {
  const v = String(value || '').trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1)
  }
  return v
}

function expandHome(value) {
  if (!value) return value
  if (value === '~') return HOME
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(HOME, value.slice(2))
  return value
}

function tilde(value) {
  if (!value) return ''
  const normalized = String(value)
  if (normalized === HOME) return '~'
  if (normalized.startsWith(HOME + path.sep)) {
    return '~' + path.sep + normalized.slice(HOME.length + 1)
  }
  return normalized
}

/** The slice of `text` between the `---` fences, or null when there is none. */
function frontmatterBounds(text) {
  const source = String(text || '')
  if (!source.startsWith('---')) return null
  const end = source.indexOf('\n---', 3)
  if (end < 0) return null
  /* the closing fence's own line ends the block; the body starts after it */
  const bodyAt = source.indexOf('\n', end + 4)
  return { start: 3, end, bodyAt: bodyAt < 0 ? source.length : bodyAt + 1 }
}

function parseFrontmatter(text) {
  const bounds = frontmatterBounds(text)
  if (!bounds) return {}
  const lines = String(text).slice(bounds.start, bounds.end).split(/\r?\n/)
  const out = {}
  let key = null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) {
      key = match[1]
      out[key] = match[2]
      continue
    }
    if (key && (/^\s+/.test(line) || line.trim() === '') && line.trim()) {
      out[key] = `${out[key] ? `${out[key]} ` : ''}${line.trim()}`
    }
  }

  for (const k of Object.keys(out)) {
    out[k] = stripQuotes(String(out[k]).replace(/^[>|][+-]?\s*/, '')).trim()
  }
  return out
}

/** Everything after the frontmatter — the part a harness receives. */
function frontmatterBody(text) {
  const source = String(text || '')
  const bounds = frontmatterBounds(source)
  return (bounds ? source.slice(bounds.bodyAt) : source).replace(/^\s*\n/, '')
}

/** Comma and/or whitespace separated lists: `a, b` and `a b` are the same. */
function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value || '')
    .split(/[,\n]/)
    .flatMap((part) => part.trim().split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The bullet list under `## Rules`, which is the only section the UI reads. */
function mdRules(text) {
  const source = String(text || '')
  const body = frontmatterBody(source)
  const block = body.match(/^##\s+rules\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)
  if (!block) return []
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
}

/** `# title` as the display name, `## section` headings for the outline. */
function firstHeading(text) {
  const body = frontmatterBody(text)
  return body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || ''
}

/** The first paragraph under the heading — the one-line summary in the table. */
function firstParagraph(text) {
  const body = frontmatterBody(text)
  const lines = body.split(/\r?\n/)
  let seenHeading = false
  const collected = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!seenHeading) {
      if (trimmed.startsWith('#')) seenHeading = true
      continue
    }
    if (!trimmed) {
      if (collected.length) break
      continue
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('-') || trimmed.startsWith('```')) {
      if (collected.length) break
      continue
    }
    collected.push(trimmed)
  }
  return collected.join(' ').slice(0, 240)
}

module.exports = {
  HOME,
  stripQuotes,
  expandHome,
  tilde,
  frontmatterBounds,
  parseFrontmatter,
  frontmatterBody,
  splitList,
  mdRules,
  firstHeading,
  firstParagraph,
}
