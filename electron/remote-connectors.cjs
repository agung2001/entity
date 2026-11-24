/**
 * The workspace's connectors, in words, for a turn that runs on another machine.
 *
 * A remote turn stages entities, skills and artifacts, and nothing else. The
 * workspace MCP set (`mcp.json`) stays here, so the harness on the far side reads
 * its own machine configuration instead. That is a real difference, not a missing
 * server: Maka at `http://127.0.0.1:4780/mcp` is connected on the laptop that runs
 * the app, and it cannot answer from a container on another host.
 *
 * Without this note the agent sees a staged `maka` skill, finds no `maka_*` tool,
 * and tells the person the connector is "not connected" — which is false and the
 * reason a whole thread was spent diagnosing something that was never broken.
 *
 * The note is deliberately narrow: a name, a target, and the reason it cannot
 * travel. Headers, env values and query strings never reach it — the prompt is a
 * file on another machine, and a token that rides in one is a leak, not context.
 */
const path = require('node:path')
const manifest = require('./remote-manifest.cjs')

/** One line: control characters out, length bounded, like every prompt field. */
const clean = (value, max = 200) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/**
 * A URL without its credentials, query or fragment. A streamable-HTTP MCP URL can
 * carry `?token=`; the host and path answer "which service", which is all the
 * model needs to have this conversation.
 */
function safeUrl(raw) {
  try {
    const parsed = new URL(String(raw))
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return clean(raw)
  }
}

/** A command name only — never its arguments, which can hold a token. */
function safeCommand(raw) {
  const value = clean(raw)
  return value ? path.basename(value) : ''
}

function targetOf(entry) {
  if (entry && entry.url) return safeUrl(entry.url)
  if (entry && entry.command) return safeCommand(entry.command)
  return ''
}

function cannotTravel(entry) {
  const reason = manifest.machineBoundReason(entry)
  if (reason) return manifest.machineBoundNote(reason)
  return 'its definition would travel, but this run was not handed the workspace binding'
}

/**
 * The section appended to the remote turn's instructions, or `''` when the
 * workspace has no enabled MCP server to explain.
 *
 * `alias` is the ssh host the turn runs on; it is named so the answer can be
 * specific ("this turn is on root-ubuntu") instead of a vague refusal.
 */
function brief({ alias = '', pool, delivered = [] } = {}) {
  const servers = pool && pool.servers && typeof pool.servers === 'object' ? pool.servers : {}
  const names = Object.keys(servers).sort()
  if (!names.length) return ''
  const sent = new Set(Array.isArray(delivered) ? delivered.map((name) => String(name)) : [])
  const machine = clean(alias) || 'another machine'
  const lines = names.map((name) => {
    const target = targetOf(servers[name])
    const fate = sent.has(name)
      ? 'delivered to this run — its tools are real here, reached through the ssh tunnel opened for this turn'
      : cannotTravel(servers[name])
    return `- **${clean(name, 80)}**${target ? ` — ${target}` : ''} — ${fate}.`
  })
  return [
    '## Connectors in this workspace',
    '',
    `This turn runs on ${machine}. The workspace MCP set is handed to the harness when it can be:`,
    'http servers directly, and a loopback server through an ssh tunnel opened for this turn.',
    'A connector marked *delivered* has tools here. One that was not sent has none — say which, and',
    `say it answers on the machine that owns it and this turn runs on ${machine}.`,
    '',
    'Do not call a delivered connector "not connected", "not set up" or "missing" — call its tools.',
    '',
    ...lines,
  ].join('\n')
}

module.exports = { brief, targetOf, cannotTravel, safeUrl, safeCommand }
