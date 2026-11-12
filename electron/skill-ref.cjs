/**
 * A skill reference at the start of a prompt.
 *
 *   /workspace:<name>   a skill attached to this workspace  (<ws>/skills/<name>)
 *   /<harness>:<name>   a skill in that harness's own library (~/.claude/skills, …)
 *
 * The reference is resolved to an absolute path, and the prompt is rewritten to
 *
 *   use this skill <path>
 *
 *   <the rest of what was typed>
 *
 * That is what makes `skills:` in an entity file more than a comment: the
 * harness is told where the skill is instead of being expected to discover it.
 * A reference that does not resolve is an error, not a silently ignored token —
 * a typo should not turn into an answer without the skill it named.
 *
 * `/review` (no colon) and `/<namespace>:<name>` for an unknown namespace are
 * left untouched: those belong to the harness, not to this app.
 */
const path = require('node:path')
const localData = require('./local-data.cjs')

const WORKSPACE = 'workspace'
const WORKSPACE_LABEL = 'Workspace'

/* `[A-Za-z0-9._-]+` on purpose: a reference is typed, so a skill whose name has
   a space stays reachable by its directory name but not by `/workspace:…`. */
const REF = /^\/([a-z0-9][a-z0-9-]*):([A-Za-z0-9._-]+)(?:\s+|$)/

const harnessById = new Map(localData.HARNESSES.map((harness) => [harness.id, harness]))

/** `'/workspace:code review this'` → `{ namespace, name, rest }`, or null. */
function parse(text) {
  const source = String(text || '')
  const match = source.match(REF)
  if (!match) return null
  return {
    namespace: match[1].toLowerCase(),
    name: match[2],
    rest: source.slice(match[0].length).trim(),
  }
}

function describe(item, namespace, label) {
  return {
    namespace,
    label,
    name: item.name,
    /* a skill is a directory holding SKILL.md; a single-file skill is the file */
    path: item.absolutePath,
    entry: item.entry,
    singleFile: Boolean(item.singleFile),
  }
}

/** The skill a reference names, or null when this workspace cannot reach it. */
function resolve(record, ref) {
  const wanted = String(ref.name || '').toLowerCase()

  if (ref.namespace === WORKSPACE) {
    const items = localData.scanSkillDir(path.join(record.path, 'skills'), {
      harness: WORKSPACE,
      harnessLabel: WORKSPACE_LABEL,
      detectHarness: true,
    })
    const item = items.find((entry) => entry.name.toLowerCase() === wanted && !entry.missing)
    return item ? describe(item, WORKSPACE, WORKSPACE_LABEL) : null
  }

  const harness = harnessById.get(ref.namespace)
  if (!harness) return null
  const scan = localData.scanSkillLibrary()
  const item = scan.items.find(
    (entry) =>
      entry.harness === harness.id && entry.name.toLowerCase() === wanted && !entry.missing,
  )
  return item ? describe(item, harness.id, harness.label) : null
}

/**
 * Rewrite a prompt that starts with a skill reference.
 *
 * Returns `{ text, ref }`; `ref` is null when the prompt carried no reference
 * this app owns, and then `text` is unchanged. Throws when the reference names a
 * namespace this app owns but no skill the workspace can reach.
 */
function rewrite(record, text) {
  const source = String(text || '')
  const ref = parse(source)
  if (!ref) return { text: source, ref: null }

  const known = ref.namespace === WORKSPACE || harnessById.has(ref.namespace)
  if (!known) return { text: source, ref: null }

  const skill = resolve(record, ref)
  if (!skill) {
    throw new Error(
      `/${ref.namespace}:${ref.name} is not a skill this workspace can reach. ` +
        'Type / in the composer to see the names it can use.',
    )
  }

  const prompt = ref.rest
    ? `use this skill ${skill.path}\n\n${ref.rest}`
    : `use this skill ${skill.path}`
  return { text: prompt, ref: skill }
}

module.exports = { WORKSPACE, parse, resolve, rewrite }
