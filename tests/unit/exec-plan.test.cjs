/**
 * The Windows launch gap: a harness is an npm `.cmd` shim, and `spawn` cannot
 * run one. These tests pin the two things that fix it — unwrapping the shim to
 * its real program, and refusing (rather than corrupting) a newline argument a
 * shell could not carry. On POSIX the planner is a pass-through, and that is
 * asserted too.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { planSpawn, resolveExecutable, readCmdShim, IS_WINDOWS } = require('../../electron/exec-plan.cjs')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entity-exec-plan-'))
}

test('on POSIX the planner changes nothing', { skip: IS_WINDOWS }, () => {
  const plan = planSpawn('pi', ['-p', 'line one\nline two'], { env: process.env })
  assert.equal(plan.command, 'pi')
  assert.deepEqual(plan.args, ['-p', 'line one\nline two'])
  assert.deepEqual(plan.options, {})
})

test('resolveExecutable leaves a path alone and finds a bare name on Windows', () => {
  assert.equal(resolveExecutable(path.join('a', 'b', 'tool')), path.join('a', 'b', 'tool'))
  if (!IS_WINDOWS) return
  const found = resolveExecutable('node')
  assert.match(found, /node\.exe$/i)
})

test('a newline argument is refused when the shim cannot be read', { skip: !IS_WINDOWS }, () => {
  const shim = path.join(tmpdir(), 'opaque.cmd')
  fs.writeFileSync(shim, '@echo off\r\necho %*\r\n', 'utf8')
  assert.throws(() => planSpawn(shim, ['fine', 'line one\nline two']), /newline/)
  /* without a newline the same shim still gets a best-effort shell wrap */
  const plan = planSpawn(shim, ['fine', 'two words'])
  assert.equal(plan.options.windowsVerbatimArguments, true)
  assert.match(plan.command, /cmd\.exe$/i)
})

test('an npm cmd-shim is unwrapped to its node script', { skip: !IS_WINDOWS }, () => {
  const dir = tmpdir()
  const script = path.join(dir, 'node_modules', 'pkg', 'cli.js')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, '// cli\n', 'utf8')
  const shim = path.join(dir, 'pkg.cmd')
  fs.writeFileSync(
    shim,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*',
      '',
    ].join('\r\n'),
    'utf8',
  )

  const shimmed = readCmdShim(shim)
  assert.ok(shimmed, 'the shim is recognised')
  assert.equal(shimmed.args[0], script)

  const plan = planSpawn(shim, ['--append-system-prompt', 'line one\nline two'])
  assert.deepEqual(plan.args, [script, '--append-system-prompt', 'line one\nline two'])
  assert.match(plan.command, /node(\.exe)?$/i)
})

test('a shim that calls a sibling program runs that program', { skip: !IS_WINDOWS }, () => {
  const dir = tmpdir()
  const exe = path.join(dir, 'tool.exe')
  fs.writeFileSync(exe, '', 'utf8')
  const shim = path.join(dir, 'tool.cmd')
  fs.writeFileSync(shim, '@echo off\r\n"%~dp0tool.exe" %*\r\n', 'utf8')

  const plan = planSpawn(shim, ['run', 'a b'])
  assert.equal(plan.command, exe)
  assert.deepEqual(plan.args, ['run', 'a b'])
})

test('an electron-as-node shim keeps its env flag', { skip: !IS_WINDOWS }, () => {
  const dir = tmpdir()
  const exe = path.join(dir, 'electron.exe')
  const cli = path.join(dir, 'cli.cjs')
  fs.writeFileSync(exe, '', 'utf8')
  fs.writeFileSync(cli, '// cli\n', 'utf8')
  const shim = path.join(dir, 'entity.cmd')
  fs.writeFileSync(
    shim,
    `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${cli}" %*\r\n`,
    'utf8',
  )

  const plan = planSpawn(shim, ['entity', 'list'], { env: { PATH: process.env.PATH } })
  assert.equal(plan.command, exe)
  assert.deepEqual(plan.args, [cli, 'entity', 'list'])
  assert.equal(plan.options.env.ELECTRON_RUN_AS_NODE, '1')
})

test('a shebang script runs under its interpreter', { skip: !IS_WINDOWS }, (t) => {
  const sh = resolveExecutable('sh')
  if (sh === 'sh' || !/sh\.exe$/i.test(sh)) {
    t.skip('no sh on PATH (Git Bash not installed)')
    return
  }
  const script = path.join(tmpdir(), 'tool')
  fs.writeFileSync(script, '#!/bin/sh\necho hi\n', 'utf8')
  const plan = planSpawn(script, ['a', 'line one\nline two'])
  assert.equal(plan.command, sh)
  assert.deepEqual(plan.args, [script, 'a', 'line one\nline two'])
})

test('a /usr/bin/env shebang is understood', { skip: !IS_WINDOWS }, (t) => {
  const sh = resolveExecutable('sh')
  if (sh === 'sh' || !/sh\.exe$/i.test(sh)) {
    t.skip('no sh on PATH (Git Bash not installed)')
    return
  }
  const script = path.join(tmpdir(), 'tool')
  fs.writeFileSync(script, '#!/usr/bin/env sh\necho hi\n', 'utf8')
  const plan = planSpawn(script, [])
  assert.equal(plan.command, sh)
  assert.deepEqual(plan.args, [script])
})

test('a file without a shebang is left alone', { skip: !IS_WINDOWS }, () => {
  const script = path.join(tmpdir(), 'plain')
  fs.writeFileSync(script, 'not a script\n', 'utf8')
  const plan = planSpawn(script, ['x'])
  assert.equal(plan.command, script)
  assert.deepEqual(plan.args, ['x'])
})
