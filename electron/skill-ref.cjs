/**
 * A skill reference at the start of a prompt.
 *
 *   /workspace:<name>   a skill attached to this workspace  (<ws>/skills/<name>)
 *   /<harness>:<name>   a skill in that harness's own library (~/.claude/skills, …)
 *   /<name>             any library on this machine, when exactly one has it
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
 * Three rules keep the bare form (`/web-research`) safe:
 *
 *   - one candidate on this machine  → resolve it
 *   - several candidates             → error listing the qualified names, because
 *                                      picking a library for the person would
 *                                      load the wrong instructions silently
 *   - none                           → left untouched, so `/review` and any other
 *                                      harness-owned command keeps working
 *
 * A reference is resolved on the machine the thread is pinned to. Only this
 * machine's libraries are readable, so a reference on any other machine is an
 * error rather than a local path the far side cannot see.
 */
const path = require('node:path')
const localData = require('./local-data.cjs')

const WORKSPACE = 'workspace'
const WORKSPACE_LABEL = 'Workspace'
const LOCAL_MACHINE = 'local'

/* `[A-Za-z0-9._-]+` on purpose: a reference is typed, so a skill whose name has
   a space stays reachable by its directory name but not by `/workspace:…`. */
const REF = /^\/([a-z0-9][a-z0-9-]*):([A-Za-z0-9._-]+)(?:\s+|$)/
const LOCAL_REF = /^\/\/([a-z0-9][a-z0-9-]*):([A-Za-z0-9._-]+)(?:\s+|$)/
/* no colon: a bare name, or a command that belongs to the harness */
const BARE = /^\/([A-Za-z0-9._-]+)(?:\s+|$)/
const LOCAL_BARE = /^\/\/([A-Za-z0-9._-]+)(?:\s+|$)/

const harnessById = new Map(localData.HARNESSES.map((harness) => [harness.id, harness]))

/** `'/workspace:code review this'` → `{ namespace, name, rest, bare }`, or null. */
function parse(text) {
  const source = String(text || '')
  const localQualified = source.match(LOCAL_REF)
  if (localQualified) {
    return {
      namespace: localQualified[1].toLowerCase(),
      name: localQualified[2],
      rest: source.slice(localQualified[0].length).trim(),
      bare: false,
      local: true,
    }
  }
  const qualified = source.match(REF)
  if (qualified) {
    return {
      namespace: qualified[1].toLowerCase(),
      name: qualified[2],
      rest: source.slice(qualified[0].length).trim(),
      bare: false,
    }
  }
  const localBare = source.match(LOCAL_BARE)
  if (localBare) {
    return {
      namespace: '',
      name: localBare[1],
      rest: source.slice(localBare[0].length).trim(),
      bare: true,
      local: true,
    }
  }
  const bare = source.match(BARE)
  if (bare) {
    return {
      namespace: '',
      name: bare[1],
      rest: source.slice(bare[0].length).trim(),
      bare: true,
    }
  }
  return null
}

function describe(item, namespace, label) {
  return {
    namespace,
    label,
    name: item.name,
    /* a skill is a directory holding SKILL.md; a single-file skill is the file */
    path: item.absolutePath,
    realPath: item.realPath || item.absolutePath,
    entry: item.entry,
    singleFile: Boolean(item.singleFile),
  }
}

function workspaceItems(record) {
  return localData.scanSkillDir(path.join(record.path, 'skills'), {
    harness: WORKSPACE,
    harnessLabel: WORKSPACE_LABEL,
    detectHarness: true,
  })
}

function libraryItems() {
  return localData.scanSkillNames({ machine: LOCAL_MACHINE }).items
}

/** The skill a qualified reference names, or null when this workspace cannot reach it. */
function resolve(record, ref) {
  const wanted = String(ref.name || '').toLowerCase()

  if (ref.namespace === WORKSPACE) {
    const item = workspaceItems(record).find(
      (entry) => entry.name.toLowerCase() === wanted && !entry.missing,
    )
    return item ? describe(item, WORKSPACE, WORKSPACE_LABEL) : null
  }

  const harness = harnessById.get(ref.namespace)
  if (!harness) return null
  const item = libraryItems().find(
    (entry) =>
      entry.harness === harness.id && entry.name.toLowerCase() === wanted && !entry.missing,
  )
  return item ? describe(item, harness.id, harness.label) : null
}

/**
 * Every distinct file on this machine named `<name>`, workspace first.
 *
 * A workspace skill is usually a symlink into a harness library, so the two
 * entries are the same file; `realPath` collapses them instead of offering the
 * same skill twice.
 */
function candidates(record, name) {
  const wanted = String(name || '').toLowerCase()
  const seen = new Set()
  const found = []

  for (const item of workspaceItems(record)) {
    if (item.missing || item.name.toLowerCase() !== wanted) continue
    const key = item.realPath || item.absolutePath
    if (seen.has(key)) continue
    seen.add(key)
    found.push(describe(item, WORKSPACE, WORKSPACE_LABEL))
  }

  for (const item of libraryItems()) {
    if (item.missing || item.name.toLowerCase() !== wanted) continue
    const key = item.realPath || item.absolutePath
    if (seen.has(key)) continue
    seen.add(key)
    found.push(describe(item, item.harness, item.harnessLabel))
  }

  /* workspace first, then by namespace, so the error message is deterministic */
  return found.sort((a, b) => {
    if (a.namespace === WORKSPACE) return -1
    if (b.namespace === WORKSPACE) return 1
    return a.namespace.localeCompare(b.namespace)
  })
}

function prompt(skill, ref) {
  return {
    text: ref.rest ? `use this skill ${skill.path}\n\n${ref.rest}` : `use this skill ${skill.path}`,
    ref: skill,
  }
}

/**
 * Rewrite a prompt that starts with a skill reference.
 *
 * Returns `{ text, ref }`; `ref` is null when the prompt carried no reference
 * this app owns, and then `text` is unchanged. Throws when the reference names a
 * skill this machine should have but cannot reach, or when a bare name is
 * ambiguous.
 */
function rewrite(record, text, { machine = LOCAL_MACHINE } = {}) {
  const source = String(text || '')
  const ref = parse(source)
  if (!ref) return { text: source, ref: null }

  const remote = Boolean(machine) && machine !== LOCAL_MACHINE
  const owned = !ref.bare && (ref.namespace === WORKSPACE || harnessById.has(ref.namespace))

  if (remote) {
    /* A qualified reference is ours: the far side cannot see this machine's
       libraries, and a local absolute path would be a lie. */
    if (owned) {
      throw new Error(
        `/${ref.namespace}:${ref.name} cannot be resolved on ${machine}. ` +
          'Skills on another machine are not readable yet — send this thread to this machine.',
      )
    }
    /* A bare `/name` is indistinguishable from a harness command here, so it is
       forwarded untouched rather than guessed at. */
    return { text: source, ref: null }
  }

  if (owned) {
    const skill = resolve(record, ref)
    if (!skill) {
      throw new Error(
        `/${ref.namespace}:${ref.name} is not a skill this workspace can reach. ` +
          'Type / in the composer to see the names it can use.',
      )
    }
    return prompt(skill, ref)
  }

  if (ref.bare) {
    const found = candidates(record, ref.name)
    if (!found.length) return { text: source, ref: null }
    if (found.length > 1) {
      const names = found.map((skill) => `/${skill.namespace}:${skill.name}`).join(', ')
      throw new Error(
        `/${ref.name} is a skill in more than one library: ${names}. ` +
          'Type the qualified name so the right one is loaded.',
      )
    }
    return prompt(found[0], ref)
  }

  return { text: source, ref: null }
}

module.exports = { WORKSPACE, LOCAL_MACHINE, parse, resolve, candidates, rewrite }
