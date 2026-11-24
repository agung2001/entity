/**
 * The workspace MCP set for a turn that runs on another machine.
 *
 * A remote turn stages entities, skills and artifacts; it used to stage nothing
 * about MCP. So a workspace connector such as Maka — `http://127.0.0.1:4780/mcp`,
 * served by the desktop app on this laptop — had no tool on the far side, and the
 * agent reported a working connector as "not connected".
 *
 * This module closes that gap without pretending the far side is this machine:
 *
 *   - **http + loopback** — an ssh reverse tunnel (`-R`) is opened for the turn on
 *     the same port, so the definition reaches the far side unchanged. The port
 *     matters: Maka answers only to `Host: 127.0.0.1:4780`, so rewriting it to a
 *     free port would be a 403, and the tunnel is the one place the two machines
 *     can agree on a name. The listener and its bearer token never leave this
 *     machine; the tunnel dies with the ssh process that runs the turn.
 *   - **http + a real host** — passed through as-is.
 *   - **stdio / a command in a home directory** — cannot travel (the program is
 *     not on the far side), so it is left out and named. Silence would let the
 *     agent promise a tool it does not have.
 *
 * Nothing is installed on the host for a normal turn: the config files are staged
 * inside the throwaway run directory and deleted with it.
 *
 * The per-harness shapes come from `mcp-runtime` (the same ones a local turn gets),
 * so a `maka` definition cannot mean two different things depending on where the
 * turn runs.
 */
const fs = require('node:fs')
const path = require('node:path')
const mcpRuntime = require('./mcp-runtime.cjs')

/* Client-side loopback names. `0.0.0.0` is not a connectable address, but people
   paste it, and on the machine that wrote it the service is still local. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

function remotePathOf(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/mcp/${name}`
}

function write(dir, name, value, mode = 0o600) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  const body = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  fs.writeFileSync(file, body, { encoding: 'utf8', mode })
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* a filesystem without modes still gets a private run directory */
  }
  return file
}

/**
 * @param {{ record: object, harness: string, stage: string, remoteDir: string,
 *           busyPorts?: Set<number>, alias?: string }} args
 * @returns {{
 *   servers: string[], forwards: {name: string, localPort: number, remotePort: number, spec: string}[],
 *   argv: string[], env: Record<string,string>, notes: string[], files: string[],
 * }}
 */
function plan({ record, harness = '', stage = '', remoteDir = '', busyPorts = new Set(), alias = '' } = {}) {
  const result = { servers: [], forwards: [], argv: [], env: {}, notes: [], files: [] }
  if (!record || !stage) return result

  const { servers } = mcpRuntime.resolveServers(record)
  const built = {}
  for (const name of Object.keys(servers).sort()) {
    const missing = []
    const entry = mcpRuntime.buildEntry(servers[name], missing)
    if (missing.length) {
      result.notes.push(`${name} needs ${missing.join(', ')} set in the app's environment and was not sent`)
      continue
    }
    if (!entry.url) {
      result.notes.push(`${name} is a local program on the machine that started this turn and was not sent`)
      continue
    }
    let url
    try {
      url = new URL(entry.url)
    } catch {
      result.notes.push(`${name} has a URL the remote harness cannot parse and was not sent`)
      continue
    }
    if (LOOPBACK.has(url.hostname.toLowerCase())) {
      const localPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      if (!Number.isFinite(localPort) || localPort <= 0) {
        result.notes.push(`${name} has a loopback URL with no usable port and was not sent`)
        continue
      }
      if (busyPorts.has(localPort)) {
        result.notes.push(`${name} was not sent: ${alias || 'the remote host'} already listens on port ${localPort}`)
        continue
      }
      result.forwards.push({
        name,
        localPort,
        remotePort: localPort,
        /* bind on the far side's loopback only — the tunnel is for this turn, not
           for every process on that host's network */
        spec: `127.0.0.1:${localPort}:127.0.0.1:${localPort}`,
      })
      /* unchanged: the server's Host check is part of its contract */
      built[name] = entry
    } else {
      built[name] = entry
    }
  }

  const names = Object.keys(built)
  if (!names.length) {
    if (!result.notes.length) result.notes.push('No MCP server from this workspace could be handed to this host')
    return result
  }

  const dir = path.join(stage, 'mcp')
  if (harness === 'pi') {
    write(dir, 'pi.mjs', mcpRuntime.piExtension(built))
    result.argv.push('--extension', remotePathOf(remoteDir, 'pi.mjs'))
    result.files.push(path.join(dir, 'pi.mjs'))
  } else if (harness === 'claude') {
    write(dir, 'claude.json', { mcpServers: built })
    result.argv.push('--mcp-config', remotePathOf(remoteDir, 'claude.json'), '--strict-mcp-config')
    result.files.push(path.join(dir, 'claude.json'))
  } else if (harness === 'opencode') {
    write(dir, 'opencode.json', { mcp: mcpRuntime.opencodeServers(built) })
    result.env.OPENCODE_CONFIG = remotePathOf(remoteDir, 'opencode.json')
    result.files.push(path.join(dir, 'opencode.json'))
  } else if (harness === 'codex') {
    const spec = { argv: [], env: {}, notes: [] }
    mcpRuntime.codexSpec(built, spec)
    result.argv.push(...spec.argv)
    Object.assign(result.env, spec.env)
    result.notes.push(...spec.notes)
  } else {
    /* ollama and gemini have no surface this module can write without editing the
       far side's own settings; say so instead of sending a definition nobody reads */
    result.notes.push(`${harness} has no MCP configuration surface this turn can write; no server was sent`)
    return result
  }

  result.servers = names
  return result
}

module.exports = { plan, LOOPBACK }
