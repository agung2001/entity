/**
 * How to actually start a command — the Windows gap between "found on PATH"
 * and "spawn can run it".
 *
 * On POSIX this module is a pass-through: `spawn(cmd, argv)` is the whole
 * story. Windows is where the trouble is, and it is not optional trouble:
 * every harness this app runs is a CLI, and npm installs a CLI on Windows as
 * a `.cmd` batch shim (`pi.cmd`, `claude.cmd`, `npx.cmd`) plus an
 * extensionless shell script. `child_process.spawn` cannot execute either:
 *
 *   - a bare `pi` fails with ENOENT (spawn applies no PATHEXT), and
 *   - an absolute `C:\…\pi.cmd` fails with EINVAL.
 *
 * The obvious repair is `cmd.exe /d /s /c "…"`, and for a one-line argument
 * list it works. It cannot work here: a harness is handed its system prompt
 * as an argument (`--append-system-prompt`), and a newline inside a Windows
 * command line ends the command. A shell-wrapped prompt is a truncated
 * prompt, silently.
 *
 * So instead of asking a shell to interpret the shim, read it. An npm shim is
 * a fixed template that ends in `"%_prog%"  "%dp0%\…\cli.js" %*`, and a custom
 * shim usually calls a sibling program. Either way we can name the real
 * program and hand `spawn` the argv untouched — newlines, quotes and `%`
 * survive, exactly as they do on macOS. Only a shim we cannot read falls back
 * to `cmd.exe`, and even then a newline argument is refused rather than
 * corrupted.
 *
 * The escaping helpers are from cross-spawn (MIT), kept verbatim so the rare
 * fallback behaves like the battle-tested library rather than a fresh guess.
 */
const fs = require('node:fs')
const path = require('node:path')

const IS_WINDOWS = process.platform === 'win32'

/* cross-spawn/lib/util/escape.js — see http://www.robvanderwoude.com/escapechars.php */
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

function escapeCommand(value) {
  return String(value).replace(META_CHARS, '^$1')
}

function escapeArgument(value, doubleEscapeMetaChars) {
  let arg = `${value}`
  /* backslashes before a quote are doubled, and the quote escaped */
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  /* backslashes before the closing quote are doubled */
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1')
  arg = `"${arg}"`
  arg = arg.replace(META_CHARS, '^$1')
  if (doubleEscapeMetaChars) arg = arg.replace(META_CHARS, '^$1')
  return arg
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function pathExtensions(env) {
  return String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * Resolve a bare command name the way a shell would — PATH, then PATHEXT. On
 * POSIX (and for an absolute path) the name is returned unchanged.
 */
function resolveExecutable(cmd, env = process.env) {
  const name = String(cmd || '')
  if (!IS_WINDOWS || !name) return name
  if (/[\\/]/.test(name)) return name
  const extensions = path.extname(name) ? [''] : pathExtensions(env)
  const dirs = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return name
}

/** `%~dp0`/`%dp0%` both mean "the directory this shim lives in". */
function expandShimPath(token, dir) {
  return path.normalize(
    String(token)
      .replace(/%~dp0/gi, `${dir}\\`)
      .replace(/%dp0%/gi, `${dir}\\`),
  )
}

/** The node runtime an npm shim would use: a local `node.exe`, else PATH. */
function nodeRuntime(dir) {
  const local = path.join(dir, 'node.exe')
  if (isFile(local)) return local
  return resolveExecutable('node') || 'node'
}

/**
 * The interpreter named on a script's first line, e.g. `#!/usr/bin/env node`
 * → `node`. Windows cannot run a `#!` file directly, but it can run the
 * interpreter it names. An empty string means "not a shebang script".
 */
function readShebang(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(256)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const first = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0]
    if (!first.startsWith('#!')) return ''
    const parts = first.slice(2).trim().split(/\s+/)
    if (!parts.length) return ''
    let name = path.basename(parts[0])
    if (name === 'env') {
      /* `env -S bash -e` is legal, so skip flags before the program name */
      name = path.basename(parts.slice(1).find((part) => !part.startsWith('-')) || '')
    }
    return name
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Read a `.cmd`/`.bat` and return the real `{ command, args, env }` it would
 * run, or null when the file is not a shape we recognise.
 *
 * The last line containing `%*` is the exec line (npm puts a few `CALL`/`GOTO`
 * lines above it). Two shapes cover the field:
 *
 *   "…%_prog%"  "%dp0%\…\cli.js" %*   npm's cmd-shim → node <cli.js>
 *   "%~dp0tool.exe" %*                a wrapper → the sibling program
 *
 * An app-generated shim (`set ELECTRON_RUN_AS_NODE=1` then an `electron.exe
 * cli.cjs`) is kept as-is: it already avoids needing `node` on PATH, so the
 * env flag travels with it.
 */
function readCmdShim(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const dir = path.dirname(file)
  const asNode = /ELECTRON_RUN_AS_NODE\s*=\s*1/i.test(text)
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.includes('%*')) continue

    /* npm's cmd-shim, or any shim that runs one program with another as its
       first argument. */
    let match = /"([^"]+)"\s+"([^"]+)"\s+%\*/.exec(line)
    if (match) {
      const program = expandShimPath(match[1], dir)
      const target = expandShimPath(match[2], dir)
      const env = asNode ? { ELECTRON_RUN_AS_NODE: '1' } : null
      if (/\.(?:js|cjs|mjs)$/i.test(target)) {
        /* a real interpreter next to the shim (electron-as-node) beats guessing
           `node` from PATH, which a GUI may not have */
        if (isFile(program) && !/node(?:\.exe)?$/i.test(program)) {
          return { command: program, args: [target], env }
        }
        return { command: nodeRuntime(dir), args: [target] }
      }
      if (isFile(target)) return { command: target, args: [] }
      if (isFile(program)) return { command: program, args: [target], env }
    }

    /* a single quoted program, e.g. `"%~dp0opencode.exe" %*` */
    match = /"([^"]+)"\s+%\*/.exec(line)
    if (match) {
      const target = expandShimPath(match[1], dir)
      if (/\.(?:js|cjs|mjs)$/i.test(target)) return { command: nodeRuntime(dir), args: [target] }
      if (isFile(target)) return { command: target, args: [] }
    }
  }
  return null
}

/**
 * Decide the command, argv and spawn options for one call.
 *
 * Returns `{ command, args, options }`; merge `options` into the spawn
 * options. On POSIX nothing changes.
 */
function planSpawn(cmd, argv = [], options = {}) {
  const command = String(cmd || '')
  const args = (Array.isArray(argv) ? argv : []).map((value) => String(value))
  if (!IS_WINDOWS || options.shell) return { command, args, options: {} }

  const resolved = resolveExecutable(command, options.env || process.env)
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    return planShim(resolved, args, options)
  }

  /* A POSIX launcher is a `#!` script — npm's extensionless bin, or a test
     harness. Windows cannot spawn it, but the interpreter named on line one
     can run it, and the argv is passed through untouched. */
  if (!/\.(?:exe|com)$/i.test(resolved) && isFile(resolved)) {
    const interpreter = readShebang(resolved)
    if (interpreter) {
      const program = resolveExecutable(interpreter, options.env || process.env)
      if (program !== interpreter || isFile(program)) {
        return { command: program, args: [resolved, ...args], options: {} }
      }
    }
  }

  return { command: resolved, args, options: {} }
}

/** Run the real program a `.cmd`/`.bat` names, or fall back to cmd.exe. */
function planShim(resolved, args, options) {
  const shim = readCmdShim(resolved)
  if (shim) {
    const plan = { command: shim.command, args: [...shim.args, ...args], options: {} }
    /* a shim that turns the binary into node keeps that flag with it */
    if (shim.env) plan.options.env = { ...(options.env || process.env), ...shim.env }
    return plan
  }

  /* A shim we cannot read. cmd.exe is the only way left, and it drops a
     newline argument on the floor — so say so instead of starting a turn with
     half a system prompt. */
  if (args.some((value) => /[\r\n]/.test(value))) {
    const error = new Error(
      `${resolved} is a Windows .cmd shim with no readable target, and an argument contains a newline, which a shell cannot carry.`,
    )
    error.code = 'ENOEXEC'
    throw error
  }
  const line = [escapeCommand(resolved), ...args.map((value) => escapeArgument(value, false))].join(' ')
  return {
    command: process.env.comspec || process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}

module.exports = { planSpawn, resolveExecutable, readCmdShim, IS_WINDOWS }
