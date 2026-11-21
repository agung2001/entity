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
  entity entity create <name> [--harness h] [--model m] [--dir d]
                                  [--description <text>]
                                  [--shape s] [--color c] [--mood m]
                                  [--body <text> | --body-stdin | --body-file <f>]
  entity entity clone <name> [--from <workspace>] [--to <workspace>] [--name <new>]
                                  [--shape s] [--color c] [--mood m]
  entity entity get <name>
  entity entity set-instructions <name> (--body <text> | --body-stdin | --body-file <f>)
                                  [--if-unchanged '<stamp json from get>']
  entity entity set-fields <name> [--harness h] [--model m] [--dir d]
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
  entity workspace list
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
  - A run is pinned to the workspace it was started in. It may READ another
    workspace with --workspace (logged in its own audit.jsonl) and may not write
    to one. From a shell outside the app — including the in-app terminal — nothing
    is pinned, so --workspace <id> works for reads and writes alike.
  - Clone is the one write with a consent path: a pinned run copying into
    another workspace gets code "needs_consent" and writes nothing there until
    the person allows that exact content in the window.
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

function fail(message, code = 'invalid', data = null) {
  write(
    JSON.stringify(
      { ok: false, code, error: String(message), ...(data ? { data } : {}) },
      null,
      2,
    ),
  )
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
  if (!result?.ok) {
    fail(result?.error || 'The call failed.', result?.code || 'error', result?.data || null)
  }
  return result.data
}

function resolveTarget(flags) {
  const ambient = String(process.env.ENTITY_WORKSPACE || '').trim()
  const flagged = typeof flags.workspace === 'string' ? flags.workspace.trim() : ''
  /* Inside a run the workspace is pinned. An explicit --workspace may REACH
     another workspace to read it — the run's own shell can read those files
     anyway, so refusing would be theatre — but a pinned run may never write
     there. That is the C07 boundary: a prompt-injected agent must not be able to
     rewrite the agents of a workspace the person is not looking at. */
  if (ambient && flagged && flagged !== ambient) {
    return { workspace: String(flagged), pinned: ambient, cross: true }
  }
  const explicit = flagged || ambient
  if (explicit && explicit !== true) {
    return { workspace: String(explicit), pinned: ambient || '', cross: false }
  }

  let list = []
  try {
    list = require('./workspace-store.cjs').list()
  } catch (error) {
    fail(`Could not read ~/.entity/workspaces: ${error?.message || error}`, 'error')
  }
  if (list.length === 1) return { workspace: list[0].id, pinned: '', cross: false }
  if (!list.length) fail('There is no workspace yet.', 'not_found')
  fail(
    `Which workspace? --workspace <id>. Available: ${list.map((ws) => ws.id).join(', ')}.`,
  )
}

/**
 * A cross-workspace write is refused, and the refusal names the way out, so the
 * caller does not retry the same command with a different spelling.
 */
function guardWrite(target, verb) {
  if (!target.cross) return
  fail(
    `${verb} cannot write to ${target.workspace}: this run is pinned to ${target.pinned}. ` +
      'Reads are allowed; ask the person to open that workspace, or use the in-app terminal, where nothing is pinned.',
    'denied',
  )
}

/** A cross-workspace read is a real event: record it where the run can be seen. */
function noteCrossRead(target, verb, name) {
  if (!target.cross) return
  try {
    const store = require('./workspace-store.cjs')
    audit.append(store.open(target.pinned), {
      verb: `cross.read ${verb}`,
      target: `${target.workspace}${name ? `/${name}` : ''}`,
    })
  } catch {
    /* an audit that cannot be written must not fail the read */
  }
}

/* ── verbs ────────────────────────────────────────────────────────── */

function runEntity(action, rest, flags, target, output) {
  const workspace = target.workspace
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('entity.list', { workspace }))
      noteCrossRead(target, 'entity.list', '')
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

    case 'create': {
      if (!name) fail('entity create <name>')
      guardWrite(target, 'entity.create')
      const spec = {}
      for (const key of ['harness', 'model', 'dir', 'description', 'shape', 'color', 'mood']) {
        if (key in flags) spec[key] = String(flags[key])
      }
      if ('body-stdin' in flags) spec.body = readStdin()
      else if (typeof flags['body-file'] === 'string') {
        spec.body = fs.readFileSync(path.resolve(flags['body-file']), 'utf8')
      } else if (typeof flags.body === 'string') spec.body = flags.body
      return emitJson(unwrap(core.call('entity.create', { workspace, name, spec })))
    }

    case 'clone': {
      if (!name) fail('entity clone <name> [--from <workspace>] [--to <workspace>]')
      /* A cross-workspace `--workspace` is a read of that room, not permission
         to write it. Run the verb against the pinned record so the core sees
         the cross-write and asks for consent instead of treating the target as
         the caller's own workspace. */
      const from =
        typeof flags.from === 'string' && flags.from.trim()
          ? flags.from.trim()
          : target.cross
            ? target.pinned
            : workspace
      const to =
        typeof flags.to === 'string' && flags.to.trim()
          ? flags.to.trim()
          : target.cross
            ? target.workspace
            : workspace
      const spec = { name, from, to }
      if (typeof flags.name === 'string' && flags.name.trim()) spec.nextName = flags.name.trim()
      for (const key of ['shape', 'color', 'mood']) {
        if (typeof flags[key] === 'string') spec[key] = flags[key]
      }
      return emitJson(
        unwrap(core.call('entity.clone', { workspace: target.cross ? target.pinned : workspace, spec })),
      )
    }

    case 'get': {
      if (!name) fail('entity get <name>')
      const data = unwrap(core.call('entity.get', { workspace, name }))
      noteCrossRead(target, 'entity.get', name)
      return emitJson(data)
    }

    case 'set-instructions': {
      if (!name) fail('entity set-instructions <name> --body-stdin')
      guardWrite(target, 'entity.set-instructions')
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
      const result = core.call('entity.setInstructions', { workspace, name, body, expect })
      /* A parked write names itself, so the agent can repeat this exact command
         once the person has applied it. The clone path surfaces one the same way. */
      if (result?.code === 'needs_consent' && result.data && !result.data.command) {
        result.data.command = `entity set-instructions ${name} --body-stdin`
      }
      const data = unwrap(result)
      if (output === 'table') {
        return write(`  ${data.name}.md written (${data.bytes} bytes, was ${data.previousBytes})`)
      }
      return emitJson(data)
    }

    case 'set-fields': {
      if (!name) fail('entity set-fields <name> --model <m>')
      guardWrite(target, 'entity.set-fields')
      const patch = {}
      for (const key of ['harness', 'model', 'dir']) {
        if (key in flags) patch[key] = flags[key] === true ? '' : String(flags[key])
      }
      if (!Object.keys(patch).length) {
        fail('Nothing to set. Use --harness, --model or --dir.')
      }
      return emitJson(unwrap(core.call('entity.setFields', { workspace, name, patch })))
    }

    case 'audit': {
      const limit = Number(flags.limit || 20)
      const record = require('./workspace-store.cjs').open(workspace)
      const rows = audit.read(record, { limit: Number.isFinite(limit) ? limit : 20 })
      noteCrossRead(target, 'entity.audit', '')
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

function runMcp(action, rest, flags, target, output) {
  const workspace = target.workspace
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('mcp.list', { workspace }))
      noteCrossRead(target, 'mcp.list', '')
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
      guardWrite(target, 'mcp.add')
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
      guardWrite(target, 'mcp.remove')
      return emitJson(unwrap(core.call('mcp.remove', { workspace, name })))
    }

    default:
      return fail(`Unknown mcp action "${action}". Try \`entity mcp --help\`.`)
  }
}

function runSkill(action, rest, flags, target, output) {
  const workspace = target.workspace
  const name = rest[0]
  switch (action) {
    case 'list': {
      const data = unwrap(core.call('skill.list', { workspace }))
      noteCrossRead(target, 'skill.list', '')
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
      guardWrite(target, 'skill.create')
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
      guardWrite(target, 'skill.attach')
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
      guardWrite(target, 'skill.detach')
      return emitJson(unwrap(core.call('skill.detach', { workspace, name })))
    }

    default:
      return fail(`Unknown skill action "${action}". Try \`entity skill --help\`.`)
  }
}

function runWorkspace(action, flags, target, output) {
  const workspace = target.workspace
  switch (action) {
    case 'get': {
      const data = unwrap(core.call('workspace.get', { workspace }))
      noteCrossRead(target, 'workspace.get', '')
      return emitJson(data)
    }

    /* Every workspace on this machine, so a caller can name one instead of
       reading ~/.entity/workspaces with `ls`. Read-only either way. */
    case 'list': {
      let rows = []
      try {
        rows = require('./workspace-store.cjs').list()
      } catch (error) {
        return fail(`Could not read ~/.entity/workspaces: ${error?.message || error}`, 'error')
      }
      const data = rows.map((row) => ({
        id: row.id,
        label: row.label,
        kind: row.kind || 'local',
        entities: row.counts?.entities ?? 0,
        skills: row.counts?.skills ?? 0,
        machines: row.counts?.machines ?? 0,
        path: row.path,
        current: row.id === workspace,
      }))
      if (output === 'table') {
        return write(
          table(data, [
            { label: '', get: (row) => (row.current ? '*' : '') },
            { label: 'ID', get: (row) => row.id },
            { label: 'LABEL', get: (row) => row.label },
            { label: 'KIND', get: (row) => row.kind },
            { label: 'ENTITIES', get: (row) => row.entities },
            { label: 'SKILLS', get: (row) => row.skills },
          ]),
        )
      }
      return emitJson(data)
    }

    case 'set-context': {
      guardWrite(target, 'workspace.set-context')
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

  const target = resolveTarget(flags)

  switch (group) {
    case 'entity':
      return runEntity(action, rest, flags, target, output)
    case 'mcp':
      return runMcp(action, rest, flags, target, output)
    case 'skill':
      return runSkill(action, rest, flags, target, output)
    case 'workspace':
      return runWorkspace(action, flags, target, output)
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
