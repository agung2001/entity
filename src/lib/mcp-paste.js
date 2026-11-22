/**
 * Reading an MCP server definition out of a paste.
 *
 * Pure: no Electron, no DOM, no network. The caller decides what to do with an
 * error; this module never guesses, and it never writes.
 *
 * A person arriving at "connect this server" has one artifact — a block of text
 * copied from a docs page. It is an `mcpServers` wrapper, a bare definition, a
 * `[mcp_servers.x]` TOML table, or just a URL, and they should not have to know
 * which. That is the whole point of the paste box, and why this is one function
 * rather than a form with six fields.
 *
 * **The output is a whitelist, never a passthrough.** Only the keys the runtime
 * can execute survive — `command`, `args`, `url`, `headers`, `env`, `type` — so
 * a `description` or a harness-only `exposure` copied through verbatim cannot
 * land in `mcp.json` where nothing reads it. Every drop is reported back.
 */

/** The aliases a definition may carry, and the only keys that survive a read. */
const KNOWN_KEYS = ['url', 'serverUrl', 'server_url', 'command', 'args', 'headers', 'env', 'environment', 'type']

/** Envelope keys, matching what `mcp-store.cjs` reads from the harness files. */
const ENVELOPES = ['mcpServers', 'mcp', 'servers', 'mcp_servers']

/** A URL, possibly with no trailing wrapper: the simplest thing a docs page gives. */
const URL_SHAPE = /^https?:\/\/\S+$/i

function textOf(value) {
  return String(value ?? '').trim()
}

/** `command` is a string or an argv array; both become `command` + `args`. */
function commandOf(raw, args) {
  let command = raw
  let rest = args
  if (Array.isArray(command)) {
    const [first, ...others] = command.map(textOf).filter(Boolean)
    command = first || ''
    rest = rest === undefined ? others : rest
  }
  if (typeof rest === 'string') rest = [rest]
  if (!Array.isArray(rest)) rest = []
  return { command: textOf(command), args: rest.map(textOf).filter(Boolean) }
}

/** `env | environment` is a name → value map, an array of names, or absent. */
function envOf(raw) {
  if (Array.isArray(raw)) return raw.map(textOf).filter(Boolean)
  if (raw && typeof raw === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(raw)) out[textOf(key)] = textOf(value)
    return out
  }
  return undefined
}

function headersOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const [key, value] of Object.entries(raw)) out[textOf(key)] = textOf(value)
  return Object.keys(out).length ? out : undefined
}

/**
 * One server entry → a definition, plus the keys that were dropped.
 *
 * The aliases here are the same ones `normaliseServer` in `mcp-store.cjs` knows,
 * because a paste that works from a harness config and one that works here must
 * not be two different dialects.
 */
function entryOf(name, raw) {
  const dropped = []
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const { command, args } = commandOf(source.command, source.args)
  const url = textOf(source.url || source.serverUrl || source.server_url)
  const env = envOf(source.env ?? source.environment)
  const headers = headersOf(source.headers)
  const type = textOf(source.type)

  const definition = {}
  if (url) definition.url = url
  if (command) definition.command = command
  if (args.length) definition.args = args
  if (headers) definition.headers = headers
  if (env !== undefined) definition.env = env
  if (type) definition.type = type

  /* Everything the whitelist does not carry, named so the box can say so. This
     is the one list: a key the runtime cannot execute must not reach
     `mcp.json`, where nothing would ever read or repair it. */
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.includes(key)) dropped.push(key)
  }

  return { name: textOf(name), definition, dropped }
}

/** A `[mcp_servers.x]` TOML block, read by the same rules the store uses. */
function readToml(text) {
  const servers = []
  const byName = new Map()
  let current = null
  let envTarget = null

  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[mcp_servers\.(.+)\]\s*$/)
    if (section) {
      const raw = section[1].trim()
      if (raw.endsWith('.env')) {
        const owner = raw.slice(0, -4).replace(/^["']|["']$/g, '')
        current = null
        envTarget = byName.get(owner) || null
        continue
      }
      const name = raw.replace(/^["']|["']$/g, '')
      current = { name, raw: {} }
      envTarget = null
      byName.set(name, current)
      servers.push(current)
      continue
    }
    if (/^\s*\[/.test(line)) {
      current = null
      envTarget = null
      continue
    }

    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()

    if (envTarget) {
      envTarget.raw.env = [...(envTarget.raw.env || []), key]
      continue
    }
    if (!current) continue

    if (key === 'command') current.raw.command = value.replace(/^["']|["']$/g, '')
    else if (key === 'args') {
      const args = []
      for (const match of value.matchAll(/"((?:\\.|[^"])*)"/g)) args.push(match[1])
      current.raw.args = args
    } else if (key === 'url' || key === 'server_url') current.raw.url = value.replace(/^["']|["']$/g, '')
    else if (key === 'env') {
      /* an inline table: `env = { A = "1", B = "2" }` */
      const pairs = {}
      for (const match of value.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"((?:\\.|[^"])*)"/g)) {
        pairs[match[1]] = match[2]
      }
      current.raw.env = [...(current.raw.env || []), ...Object.keys(pairs)]
    }
  }

  return servers.map((entry) => entryOf(entry.name, entry.raw))
}

/** The first envelope that actually holds servers, in the order a person expects. */
function unwrap(parsed) {
  for (const key of ENVELOPES) {
    const table = parsed[key]
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      const names = Object.keys(table)
      if (!names.length) continue
      return { envelope: key, entries: names.map((name) => entryOf(name, table[name])) }
    }
  }
  return null
}

/**
 * Read one paste.
 *
 * Returns `{ servers, envelope, dropped, error }` and never throws: the caller
 * is a dialog that has to show the reason in place of the answer.
 *
 * - `servers` is the whitelisted output, one entry per server.
 * - `envelope` is how it was wrapped, for the chip that says so.
 * - `dropped` names every key that could not be executed.
 * - `error` is a sentence a person can read, and it is set only when nothing
 *   usable came out.
 */
function readPaste(input) {
  const text = textOf(input)
  const empty = { servers: [], envelope: '', dropped: [], error: '' }
  if (!text) {
    return { ...empty, error: 'Paste something first — a definition, a URL, or the block from the docs page.' }
  }

  /* A bare URL is the smallest thing a docs page hands out, and it is not JSON. */
  if (URL_SHAPE.test(text)) {
    return {
      servers: [{ name: '', definition: { url: text }, dropped: [] }],
      envelope: 'url',
      dropped: [],
      error: '',
    }
  }

  const looksLikeToml = /^\s*\[mcp_servers\./m.test(text)
  if (looksLikeToml) {
    const servers = readToml(text)
    const dropped = [...new Set(servers.flatMap((entry) => entry.dropped))]
    if (!servers.length) {
      return { ...empty, error: 'That TOML block has no `[mcp_servers.<name>]` table in it.' }
    }
    return { servers, envelope: 'toml', dropped, error: '' }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ...empty,
      error: 'That is not JSON, a TOML block, or a URL. Paste the whole block from the docs page and nothing around it.',
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...empty,
      error: 'That is a JSON list or a value, not a server. Paste the object the docs page shows.',
    }
  }

  const wrapped = unwrap(parsed)
  const entries = wrapped ? wrapped.entries : [entryOf('', parsed)]
  const envelope = wrapped ? wrapped.envelope : 'bare'

  /* A wrapper with an empty table is a shape we recognise but cannot use. */
  if (wrapped && !wrapped.entries.length) {
    return { ...empty, error: `That \`${envelope}\` wrapper has no servers inside it.` }
  }

  const usable = entries.filter((entry) => entry.definition.url || entry.definition.command)
  const dropped = [...new Set(entries.flatMap((entry) => entry.dropped))]

  if (!usable.length) {
    return {
      ...empty,
      envelope,
      dropped,
      error: 'That has neither a `url` nor a `command`, so there is nothing for Entity to run. Check the block you copied.',
    }
  }

  return { servers: usable, envelope, dropped, error: '' }
}

export { readPaste, readToml, entryOf, unwrap, commandOf, envOf, headersOf, textOf, KNOWN_KEYS, ENVELOPES, URL_SHAPE }
