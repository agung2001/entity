/**
 * `@opendesign:<artifact|file|search>:<query>` — the workspace's own design server.
 *
 * The server is not on a laptop: it lives in this workspace's `skills/opendesign/`,
 * installed by the catalog entry's `launcher` and reached through the ordinary
 * workspace MCP pool (`mcpTools.callTool`, the same path `@maka:` takes). That is
 * what makes the mention work on a teammate's machine — `skills/**` syncs.
 *
 * **Read-only, by design.** The pool also offers `delete_file` and `delete_project`;
 * this file never calls them, and `get_active_context` / `list_files` are exposed as
 * the way to look around. The list is declared on the catalog entry as data, so the
 * page can say the same thing without a second copy of it, and the rows below are the
 * fallback when the catalog is not in hand. A mention that could remove a design
 * artifact by typo is not a convenience.
 */
const MAX_PER_SOURCE = 3

/* The catalog's own list, read through the entry: one declaration, so the page's
   `read`/`write` split and this dispatch cannot disagree. */
const ENTRY = 'open-design'
const READ_TOOLS = ['get_active_context', 'get_artifact', 'get_file', 'search_files', 'list_files']

/* The words a mention may open with. A query that starts with something else is a
   search, because a design artifact's name is more likely to be a bare word than a
   verb this file forgot. */
const KINDS = new Set(['artifact', 'file', 'search'])

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** The tools this resolver is allowed to call, for the page and for a refusal. */
function readOnlyTools() {
  try {
    const entry = require('../../connector-catalog.cjs').entryOf(ENTRY)
    const declared = Array.isArray(entry?.readOnlyTools) ? entry.readOnlyTools : []
    return declared.length ? declared : READ_TOOLS
  } catch {
    return READ_TOOLS
  }
}

/** One call through the workspace pool, refusing anything that is not a read. */
async function callTool(ctx, tool, args) {
  if (!readOnlyTools().includes(tool)) {
    /* A tool the catalog does not declare read-only never leaves this file — the
       check is here rather than at the call sites so a new branch cannot skip it. */
    throw new Error(`@opendesign: ${tool} is not a read this connector offers.`)
  }
  const result = await ctx.deps.mcpCall({
    workspace: ctx.record.id,
    server: ENTRY,
    tool,
    arguments: args,
  })
  return result?.data ?? null
}

/** The rows a server answer becomes, whatever envelope it wrapped them in. */
function rowsOf(data) {
  if (!data) return []
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object')
  for (const key of ['results', 'files', 'artifacts', 'items', 'matches', 'data']) {
    const value = data[key]
    if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object')
  }
  /* A single object is one row: `get_artifact` answers with one design. */
  return typeof data === 'object' ? [data] : []
}

const labelOf = (row) =>
  text(row.title || row.name || row.path || row.id || row.slug, 120) || 'an artifact'
const whereOf = (row) => text(row.path || row.file || row.id || '', 200)

async function resolve(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const word = text(segment?.target, 40).toLowerCase()
  const query = text(segment?.query, 200)
  const kind = KINDS.has(word) ? word : 'search'
  const wanted = kind === word ? query : text(`${word} ${query}`, 200)
  if (!wanted) {
    throw new Error(
      '@opendesign: needs something to read, e.g. @opendesign:artifact:onboarding or @opendesign:search:nav bar',
    )
  }

  if (kind === 'file') {
    const data = await callTool(ctx, 'get_file', { path: wanted })
    return rowsOf(data)
      .slice(0, limit)
      .map((row) => ({ id: whereOf(row), label: labelOf(row), detail: whereOf(row), url: '' }))
  }

  if (kind === 'artifact') {
    /* A name is what a person has; an id is what the server may want. Both are sent,
       because a server that only accepts one of them should not need a second call. */
    const data = await callTool(ctx, 'get_artifact', { name: wanted, id: wanted })
    return rowsOf(data)
      .slice(0, limit)
      .map((row) => ({ id: whereOf(row), label: labelOf(row), detail: whereOf(row), url: '' }))
  }

  const data = await callTool(ctx, 'search_files', { query: wanted, limit })
  return rowsOf(data)
    .slice(0, limit)
    .map((row) => ({ id: whereOf(row), label: labelOf(row), detail: whereOf(row), url: '' }))
}

/**
 * The composer's suggestions: the words a mention may open with, then whatever the
 * design workspace already holds. Never throws and answers `[]` on failure — a menu
 * must not go blank because the server is still starting.
 */
async function preview(fields = [], { ctx, record, limit = 8 } = {}) {
  try {
    const typed = String(fields?.[0] || '').trim().toLowerCase()
    if (!typed || [...KINDS].some((kind) => kind.startsWith(typed))) {
      return [...KINDS]
        .filter((kind) => kind.startsWith(typed))
        .slice(0, limit)
        .map((kind) => ({ id: kind, label: kind, detail: 'what to read', mention: `@opendesign:${kind}:` }))
    }
    /* A bare word is a search, so the menu can show what that search would return. */
    /* The preview has no dispatch context, so the little it needs is built here: the
       workspace id is all a pool call takes. */
    const scope = ctx?.record?.id ? ctx : { record: record || {}, deps: { mcpCall: require('../../mcp-tools.cjs').callTool } }
    if (!scope.record?.id) return []
    const data = await callTool(scope, 'search_files', { query: typed, limit })
    return rowsOf(data)
      .slice(0, limit)
      .map((row) => ({
        id: whereOf(row),
        label: labelOf(row),
        detail: whereOf(row),
        mention: `@opendesign:file:${whereOf(row) || labelOf(row)}`,
      }))
  } catch {
    return []
  }
}

module.exports = { MAX_PER_SOURCE, READ_TOOLS, readOnlyTools, resolve, preview }
