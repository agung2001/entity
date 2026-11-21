/**
 * An MCP server definition, read out of whatever a person pasted.
 *
 * The deterministic reader in the view (`readPaste`) handles the four shapes a
 * docs page actually uses — a `mcpServers` wrapper, a bare definition, a
 * `[mcp_servers.x]` table, a URL. It does not handle a block that is *nearly*
 * one of those: a stray comment, a truncated tail, `"environment"` where the
 * runtime wants `env`, a bare token pasted on its own line next to the URL, an
 * `mcpServers` key spelled `mcp_servers`. That is what this module is for, and
 * why it is deliberately narrow:
 *
 *   - it is **only** reached when the local reader failed, so the 90 % case
 *     never spawns a harness and never waits on a model;
 *   - it answers with the same whitelist the local reader produces (`url`,
 *     `command`, `args`, `headers`, `env`, `type`), so a model cannot smuggle a
 *     `description` or an `exposure` into `mcp.json` even if it tries;
 *   - a harness that is missing, slow or refuses is **not** an error the caller
 *     has to handle — it throws one sentence, and the dialog keeps the paste.
 *
 * The model is the machine's own first installed CLI. This runs once, on a
 * person's click, with their own credentials: the same trust boundary as a
 * chat turn, and nothing leaves the machine that a turn would not.
 */
const harnesses = require('./harness-store.cjs')
const { runOneShot, lastJson } = require('./oneshot.cjs')

const TIMEOUT_MS = 45_000
const MAX_DRAFT = 20_000
const MAX_URL = 2_000

/** The keys a definition may carry. A model that adds its own is ignored. */
const KEYS = ['url', 'command', 'args', 'headers', 'env', 'type']

const INSTRUCTION = [
  'You turn a block of text a person copied from a docs page into one MCP server',
  'definition. The person is not technical: the text may be nearly-JSON, a fragment,',
  'a TOML table, or a URL with a token beside it.',
  '',
  'Rules:',
  '- Answer with JSON only, no prose and no code fences.',
  '- The only keys you may use are: url, command, args, headers, env, type.',
  '- Put a credential in "headers" (usually {"Authorization": "Bearer …"}).',
  '- If the text holds only a URL, answer {"url": "…"}.',
  '- Drop every other key. Do not invent a URL, a command, a token or a header',
  '  that the text does not contain.',
  '- If the text cannot describe a server at all, answer {"error": "<one sentence>"}.',
  '',
  'Answer shape:',
  '{"url":"…","headers":{"Authorization":"Bearer …"}}',
].join('\n')

function trim(text, limit) {
  const value = String(text || '').trim()
  return value.length <= limit ? value : value.slice(0, limit)
}

/**
 * The first CLI this machine can actually run, so the button is never dead.
 *
 * The path a person set under Account → Harnesses is the one that has to run;
 * `runOneShot` takes it as `binary` for exactly that reason.
 */
function harness() {
  const found = harnesses.list().find((entry) => entry.installed && entry.enabled)
  if (!found) return { id: '', binary: '' }
  return { id: found.id, binary: found.absolutePath || '' }
}

/** Only the whitelist, only strings, and only what the model really sent. */
function cleanDefinition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}

  const url = trim(raw.url, MAX_URL)
  if (url) out.url = url

  let command = raw.command
  let args = raw.args
  if (Array.isArray(command)) {
    const [first, ...rest] = command.map((entry) => String(entry ?? ''))
    command = first || ''
    args = args === undefined ? rest : args
  }
  if (typeof args === 'string') args = [args]
  if (!Array.isArray(args)) args = []
  const argv = args.map((entry) => String(entry ?? '')).filter(Boolean)
  if (command) out.command = String(command)
  if (argv.length) out.args = argv

  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    const headers = {}
    for (const [key, value] of Object.entries(raw.headers)) headers[String(key)] = String(value ?? '')
    if (Object.keys(headers).length) out.headers = headers
  }

  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env = {}
    for (const [key, value] of Object.entries(raw.env)) env[String(key)] = String(value ?? '')
    if (Object.keys(env).length) out.env = env
  } else if (Array.isArray(raw.env)) {
    const env = raw.env.map((entry) => String(entry ?? '')).filter(Boolean)
    if (env.length) out.env = env
  }

  const type = trim(raw.type, 40)
  if (type) out.type = type

  return out.url || out.command ? out : null
}

/**
 * Read a paste with the machine's own model.
 *
 * Returns `{ definition, harness, model }` or throws one sentence. Nothing is
 * written: the caller shows a diff and writes only if the person accepts it.
 */
async function interpret({ text } = {}) {
  const source = trim(text, MAX_DRAFT)
  if (!source) throw new Error('Paste something first.')

  const { id, binary } = harness()
  if (!id) {
    throw new Error(
      'No local harness is installed, so there is nothing to read the paste with. Install one under Account → Harnesses, or fix the format by hand.',
    )
  }

  let result
  try {
    result = await runOneShot({
      harness: id,
      binary,
      instruction: INSTRUCTION,
      prompt: ['The pasted text:', '"""', source, '"""'].join('\n'),
      timeoutMs: TIMEOUT_MS,
      label: 'read MCP paste',
    })
  } catch (error) {
    throw new Error(`${id} could not read the paste: ${error?.message || error}`)
  }

  const parsed = lastJson(result.text)
  if (!parsed) {
    throw new Error(`${id} answered with no JSON. Nothing was changed — try again, or fix the paste by hand.`)
  }
  if (parsed.error) throw new Error(String(parsed.error))

  const definition = cleanDefinition(parsed)
  if (!definition) {
    throw new Error(`${id} found neither a URL nor a command in that paste. Nothing was changed.`)
  }

  /* Anything the model added beyond the whitelist is dropped, and said so. */
  const dropped = Object.keys(parsed).filter((key) => !KEYS.includes(key) && key !== 'error')
  return { definition, dropped, harness: id }
}

module.exports = { interpret, cleanDefinition, KEYS }
