/**
 * Skill references: `/workspace:<name>`, `/<harness>:<name>`, and a bare
 * `/<name>` when exactly one library on this machine has it.
 *
 * The library inventory is stubbed, so the test does not depend on what the
 * developer happens to have installed under ~/.claude/skills.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const localData = require('./local-data.cjs')
const skillRef = require('./skill-ref.cjs')

function tmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skillref-'))
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
  return { record: { id: 'ws', path: root }, root, skills: path.join(root, 'skills') }
}

function writeSkill(dir, name) {
  const full = path.join(dir, name)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`, 'utf8')
  return full
}

function libraryItem(dir, name, harness, harnessLabel) {
  const full = writeSkill(dir, `${harness}-${name}`)
  return {
    name,
    harness,
    harnessLabel,
    absolutePath: full,
    realPath: fs.realpathSync(full),
    entry: 'SKILL.md',
    singleFile: false,
    missing: false,
  }
}

/** Replace the machine inventory for the duration of one test. */
function stubLibrary(items) {
  const original = localData.scanSkillNames
  localData.scanSkillNames = () => ({ machine: 'local', items, count: items.length })
  return () => {
    localData.scanSkillNames = original
  }
}

test('a workspace reference resolves to the workspace directory', () => {
  const ws = tmpWorkspace()
  const dir = writeSkill(ws.skills, 'pdf-ocr')

  const out = skillRef.rewrite(ws.record, '/workspace:pdf-ocr read the invoice', {
    machine: 'local',
  })
  assert.equal(out.ref.namespace, 'workspace')
  assert.equal(out.ref.path, dir)
  assert.equal(out.text, `use this skill ${dir}\n\nread the invoice`)
})

test('a workspace reference that does not resolve is an error, not a prompt', () => {
  const ws = tmpWorkspace()
  assert.throws(
    () => skillRef.rewrite(ws.record, '/workspace:ghost go', { machine: 'local' }),
    /not a skill this workspace can reach/,
  )
})

test('a qualified harness reference reaches any library on this machine', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const restore = stubLibrary([libraryItem(lib, 'web-research', 'claude', 'Claude Code')])
  try {
    const out = skillRef.rewrite(ws.record, '/claude:web-research find x', { machine: 'local' })
    assert.equal(out.ref.namespace, 'claude')
    assert.match(out.ref.path, /claude-web-research$/)
    assert.equal(out.text, `use this skill ${out.ref.path}\n\nfind x`)
  } finally {
    restore()
  }
})

test('a bare name resolves when exactly one library has it', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const restore = stubLibrary([libraryItem(lib, 'web-research', 'claude', 'Claude Code')])
  try {
    const out = skillRef.rewrite(ws.record, '/web-research find x', { machine: 'local' })
    assert.equal(out.ref.name, 'web-research')
    assert.equal(out.ref.namespace, 'claude')
  } finally {
    restore()
  }
})

test('a bare name in two libraries refuses to guess', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const restore = stubLibrary([
    libraryItem(lib, 'code-review', 'pi', 'pi'),
    libraryItem(lib, 'code-review', 'claude', 'Claude Code'),
  ])
  try {
    assert.throws(
      () => skillRef.rewrite(ws.record, '/code-review look', { machine: 'local' }),
      /\/claude:code-review, \/pi:code-review/,
    )
  } finally {
    restore()
  }
})

test('a name this app does not own is forwarded untouched', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const restore = stubLibrary([libraryItem(lib, 'web-research', 'claude', 'Claude Code')])
  try {
    const out = skillRef.rewrite(ws.record, '/review the diff', { machine: 'local' })
    assert.equal(out.ref, null)
    assert.equal(out.text, '/review the diff')
  } finally {
    restore()
  }
})

test('a workspace symlink and the library skill are one candidate', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const target = writeSkill(lib, 'web-research')
  let linked = true
  try {
    fs.symlinkSync(target, path.join(ws.skills, 'web-research'), 'dir')
  } catch {
    /* a filesystem without symlink permission; the copy case is not this test */
    linked = false
  }
  const restore = stubLibrary([
    {
      ...libraryItem(lib, 'web-research', 'claude', 'Claude Code'),
      absolutePath: target,
      realPath: fs.realpathSync(target),
    },
  ])
  try {
    if (!linked) return
    const out = skillRef.rewrite(ws.record, '/web-research go', { machine: 'local' })
    assert.equal(out.ref.namespace, 'workspace')
    assert.equal(out.ref.path, path.join(ws.skills, 'web-research'))
  } finally {
    restore()
  }
})

test('another machine cannot resolve a reference to a local path', () => {
  const ws = tmpWorkspace()
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lib-'))
  const restore = stubLibrary([libraryItem(lib, 'web-research', 'claude', 'Claude Code')])
  try {
    assert.throws(
      () => skillRef.rewrite(ws.record, '/claude:web-research go', { machine: 'srv-a' }),
      /cannot be resolved on srv-a/,
    )
    /* a bare token could be a harness command, so it is not guessed at */
    const bare = skillRef.rewrite(ws.record, '/web-research go', { machine: 'srv-a' })
    assert.equal(bare.ref, null)
    assert.equal(bare.text, '/web-research go')
  } finally {
    restore()
  }
})

test('parse separates the qualified and bare forms', () => {
  assert.deepEqual(skillRef.parse('/workspace:x go'), {
    namespace: 'workspace',
    name: 'x',
    rest: 'go',
    bare: false,
  })
  assert.deepEqual(skillRef.parse('/x go'), { namespace: '', name: 'x', rest: 'go', bare: true })
  assert.equal(skillRef.parse('/workspace:x:y'), null)
  assert.equal(skillRef.parse('no reference here'), null)
})

test('double slash marks the local copy but resolves to the same skill', () => {
  const ws = tmpWorkspace()
  const dir = writeSkill(ws.skills, 'local-only')
  const ref = skillRef.parse('//workspace:local-only go')
  assert.equal(ref.local, true)
  const out = skillRef.rewrite(ws.record, '//workspace:local-only go', { machine: 'local' })
  assert.equal(out.ref.path, dir)
  assert.equal(out.text, `use this skill ${dir}\n\ngo`)
})
