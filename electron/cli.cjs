#!/usr/bin/env node
/**
 * `entity` — the CLI a running agent uses to look at and change the things that
 * define it: its own instructions, its siblings', this workspace's MCP pool and
 * attached skills, and the workspace-level context.
 *
 * It is deliberately a thin transport. Every verb lives in `platform-core.cjs`,
 * which is also what the call table uses, so the CLI cannot do something the
 * window cannot and vice versa. Nothing here touches a path directly.
 *
 * Contract, and the reason for each line:
 *   - Positional verbs, `--flag value` / `--flag=value` flags. No subcommand
 *     library: an agent that has read `--help` once should not need to learn a
 *     framework.
 *   - `--output json` writes data to stdout and nothing else. Diagnostics go to
 *     stderr, so `... | jq` cannot be poisoned by a warning.
 *   - Failures are `{ ok: false, code, error }` on stdout with exit 1. A caller
 *     that merges streams would see a success as a failure and retry a write.
 *   - `--<field>-stdin` for every free-text field. Instructions are multi-line;
 *     they must not be re-quoted by whatever shell the harness happens to use.
 */
const fs = require('node:fs')
const path = require('node:path')
const core = require('./platform-core.cjs')
const audit = require('./platform-audit.cjs')

const USAGE = `entity — read and change the files that define the agents in a workspace

  entity entity list
  entity entity get <name>
  entity entity set-instructions <name> (--body <text> | --body-stdin | --body-file <f>)
                                  [--if-unchanged '<stamp json from get>']
  entity entity set-fields <name> [--harness h] [--model m] [--dir d]
                                  [--skills a,b] [--mcp x,y]
  entity entity audit [--limit n]

  entity mcp list
  entity mcp add <name> (--command <cmd> | --url <u>) [--args a,b] [--env K1,K2]
  entity mcp add <name> --spec-stdin      # {"command"|"url","args":[],"env":[names]}
  entity mcp remove <name>

  entity skill list
  entity skill create <name> [--description <text>] (--body <text> | --body-stdin)
  entity skill attach <name> [--harness h]
  entity skill detach <name>

  entity workspace get
  entity workspace set-context (--context <text> | --context-stdin)

Global flags
  --workspace <id>   defaults to $ENTITY_WORKSPACE, or the only workspace
  --output json|table
  --help

Notes
  - \`env\` on an MCP server is a list of variable NAMES. This app never stores or
    returns a secret value; set the variable in the environment the app runs in.
  - Writes are real. Each one is appended to <workspace>/audit.jsonl.
  - Read, then write: a get returns a stamp, and passing it back as
    --if-unchanged makes the write fail with code "conflict" instead of silently
    discarding an edit somebody made in between.
`

/* ── argument parsing ─────────────────────────────────────────────── */

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[key] = String(next)
      i += 1
    } else {
      /* a bare flag is a boolean switch: --help, --body-stdin */
      flags[key] = true
    }
  }
  return { positional, flags }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/* ── output ───────────────────────────────────────────────────────── */

function write(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function writeErr(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

function fail(message, code = 'invalid') {
  write(JSON.stringify({ ok: false, code, error: String(message) }, null, 2))
  process.exit(1)
}

function emitJson(data) {
  write(JSON.stringify({ ok: true, data }, null, 2))
}

function table(rows, columns) {
  if (!rows.length) return '  (empty)'
  const cells = rows.map((row) => columns.map((col) => String(col.get(row) ?? '')))
  const widths = columns.map((col, index) =>
    Math.max(col.label.length, ...cells.map((cell) => cell[index].length)),
  )
  const line = (values) =>
    '  ' + values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()
  return [line(columns.map((col) => col.label)), ...cells.map(line)].join('\n')
}

/* ── result handling ──────────────────────────────────────────────── */

function unwrap(result) {
  if (!result?.ok) fail(result?.error || 'The call failed.', result?.code || 'error')
  return result.data
}

function resolveWorkspace(flags) {
  const ambient = String(process.env.ENTITY_WORKSPACE || '').trim()
  const flagged = typeof flags.workspace === 'string' ? flags.workspace.trim() : ''
  /* Inside a run the workspace is pinned. An explicit --workspace is how a
     person reaches another workspace from a shell, not how an agent escapes
     the one it was started in. */
  if (ambient && flagged && flagged !== ambient) {
    fail(
      `--workspace ${flagged} is not reachable from this run (pinned to ${ambient}).`,
      'denied',
    )
  }
  const explicit = flagged || ambient
  if (explicit && explicit !== true) return String(explicit)

  let list = []
  try {
    list = require('./workspace-store.cjs').list()
  } catch (error) {
    fail(`Could not read ~/.entity/workspaces: ${error?.message || error}`, 'error')
  }
  if (list.length === 1) return list[0].id
  if (!list.length) fail('There is no workspace yet.', 'not_found')
  fail(
    `Which workspace? --workspace <id>. Available: ${list.map((ws) => ws.id).join(', ')}.`,
  )
}

/* ── verbs ────────────────────────────────────────────────────────── */

function runEntity(action, rest, flags, workspace, output) {
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('entity.list', { workspace }))
      if (output === 'table') {
        return write(
          table(data, [
            { label: 'NAME', get: (row) => row.name },
            { label: 'HARNESS', get: (row) => row.harness || '—' },
            { label: 'MODEL', get: (row) => row.model || '—' },
            { label: 'STATE', get: (row) => (row.ok ? 'ok' : `! ${row.problems.join('; ')}`) },
            { label: 'SUMMARY', get: (row) => row.summary },
          ]),
        )
      }
      return emitJson(data)
    }

    case 'get': {
      if (!name) fail('entity get <name>')
      return emitJson(unwrap(core.call('entity.get', { workspace, name })))
    }

    case 'set-instructions': {
      if (!name) fail('entity set-instructions <name> --body-stdin')
      let body
      if ('body-stdin' in flags) body = readStdin()
      else if ('body-file' in flags) body = fs.readFileSync(path.resolve(String(flags['body-file'])), 'utf8')
      else if (typeof flags.body === 'string') body = flags.body
      else fail('Pass --body-stdin (preferred), --body-file <path>, or --body <text>.')
      if (!String(body).trim()) fail('Refusing to write empty instructions. Delete the entity instead.')

      /* A stamp from a previous `get` turns the write into a conditional one. */
      let expect
      if (typeof flags['if-unchanged'] === 'string') {
        try {
          expect = JSON.parse(flags['if-unchanged'])
        } catch {
          fail("--if-unchanged takes the `stamp` object from `entity get`, as JSON.")
        }
      }
      const data = unwrap(core.call('entity.setInstructions', { workspace, name, body, expect }))
      if (output === 'table') {
        return write(`  ${data.name}.md written (${data.bytes} bytes, was ${data.previousBytes})`)
      }
      return emitJson(data)
    }

    case 'set-fields': {
      if (!name) fail('entity set-fields <name> --model <m>')
      const patch = {}
      for (const key of ['harness', 'model', 'dir', 'skills', 'mcp']) {
        if (key in flags) patch[key] = flags[key] === true ? '' : String(flags[key])
      }
      if (!Object.keys(patch).length) {
        fail('Nothing to set. Use --harness, --model, --dir, --skills or --mcp.')
      }
      return emitJson(unwrap(core.call('entity.setFields', { workspace, name, patch })))
    }

    case 'audit': {
      const limit = Number(flags.limit || 20)
      const record = require('./workspace-store.cjs').open(workspace)
      const rows = audit.read(record, { limit: Number.isFinite(limit) ? limit : 20 })
      if (output === 'table') {
        return write(
          table(rows, [
            { label: 'AT', get: (row) => row.at },
            { label: 'VERB', get: (row) => row.verb },
            { label: 'TARGET', get: (row) => row.target || '' },
          ]),
        )
      }
      return emitJson(rows)
    }

    default:
      return fail(`Unknown entity action "${action}". Try \`entity --help\`.`)
  }
}

function runMcp(action, rest, flags, workspace, output) {
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('mcp.list', { workspace }))
      if (output === 'table') {
        return write(
          table(data.names, [
            { label: 'NAME', get: (server) => server },
            { label: 'COMMAND', get: (server) => data.servers[server].command || '—' },
            { label: 'URL', get: (server) => data.servers[server].url || '—' },
            { label: 'ENV', get: (server) => data.servers[server].envKeys.join(', ') },
          ]),
        )
      }
      return emitJson(data)
    }

    case 'add': {
      if (!name) fail('mcp add <name> --command <cmd>')
      let spec
      if ('spec-stdin' in flags) {
        const raw = readStdin().trim()
        if (!raw) fail('--spec-stdin was set but stdin was empty.')
        try {
          spec = JSON.parse(raw)
        } catch (error) {
          fail(`stdin is not JSON: ${error.message}`)
        }
      } else {
        spec = {}
        if ('command' in flags) spec.command = String(flags.command)
        if ('url' in flags) spec.url = String(flags.url)
        if ('args' in flags) spec.args = String(flags.args)
        if ('env' in flags) spec.env = String(flags.env)
      }
      return emitJson(unwrap(core.call('mcp.add', { workspace, name, spec })))
    }

    case 'remove': {
      if (!name) fail('mcp remove <name>')
      return emitJson(unwrap(core.call('mcp.remove', { workspace, name })))
    }

    default:
      return fail(`Unknown mcp action "${action}". Try \`entity mcp --help\`.`)
  }
}

function runSkill(action, rest, flags, workspace, output) {
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('skill.list', { workspace }))
      if (output === 'table') {
        return write(
          `  attached: ${data.attached.join(', ') || '(none)'}\n  available: ${
            data.sources.join(', ') || '(none)'
          }`,
        )
      }
      return emitJson(data)
    }

    case 'create': {
      if (!name) fail('skill create <name> (--body <text> | --body-stdin)')
      let body
      if ('body-stdin' in flags) body = readStdin()
      else if (typeof flags.body === 'string') body = flags.body
      else fail('Pass --body-stdin (preferred) or --body <text>.')
      return emitJson(
        unwrap(
          core.call('skill.create', {
            workspace,
            name,
            body,
            description: typeof flags.description === 'string' ? flags.description : '',
          }),
        ),
      )
    }

    case 'attach': {
      if (!name) fail('skill attach <name>')
      return emitJson(
        unwrap(
          core.call('skill.attach', {
            workspace,
            name,
            harness: typeof flags.harness === 'string' ? flags.harness : '',
          }),
        ),
      )
    }

    case 'detach': {
      if (!name) fail('skill detach <name>')
      return emitJson(unwrap(core.call('skill.detach', { workspace, name })))
    }

    default:
      return fail(`Unknown skill action "${action}". Try \`entity skill --help\`.`)
  }
}

function runWorkspace(action, flags, workspace, output) {
  switch (action) {
    case 'get':
      return emitJson(unwrap(core.call('workspace.get', { workspace })))

    case 'set-context': {
      let context
      if ('context-stdin' in flags) context = readStdin()
      else if (typeof flags.context === 'string') context = flags.context
      else fail('Pass --context-stdin (preferred) or --context <text>.')
      return emitJson(unwrap(core.call('workspace.setContext', { workspace, context })))
    }

    default:
      return fail(`Unknown workspace action "${action}". Try \`entity workspace --help\`.`)
  }
}

/* ── entry ────────────────────────────────────────────────────────── */

function main(argv) {
  const { positional, flags } = parseArgs(argv)

  if (!positional.length || 'help' in flags || positional[0] === 'help') {
    return write(USAGE.replace(/\n+$/, ''))
  }

  const group = positional[0]
  const action = positional[1] || (group === 'workspace' ? 'get' : 'list')
  const rest = positional.slice(2)
  const output = flags.output === 'table' ? 'table' : 'json'

  if (!['entity', 'mcp', 'skill', 'workspace'].includes(group)) {
    return fail(`Unknown command "${group}". Try \`entity --help\`.`)
  }

  const workspace = resolveWorkspace(flags)

  switch (group) {
    case 'entity':
      return runEntity(action, rest, flags, workspace, output)
    case 'mcp':
      return runMcp(action, rest, flags, workspace, output)
    case 'skill':
      return runSkill(action, rest, flags, workspace, output)
    case 'workspace':
      return runWorkspace(action, flags, workspace, output)
    default:
      return fail(`Unknown command "${group}".`)
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    /* an unexpected throw is still a machine-readable failure */
    writeErr(`entity: ${error?.stack || error}`)
    fail(String(error?.message || error), 'error')
  }
}

module.exports = { main, parseArgs }
