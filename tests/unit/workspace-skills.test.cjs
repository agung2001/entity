/**
 * A workspace skill is portable data, not a pointer.
 *
 * A symlink into `~/.pi/agent/skills` breaks the moment the workspace is backed
 * up or pulled on another machine. Attaching copies the bytes; the migration
 * converts links written by older builds.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `workspace-store` resolves ROOT at require time. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skills-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const localData = require('../../electron/local-data.cjs')

function writeSkill(dir, text) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
  const script = path.join(dir, 'bin', 'run.sh')
  fs.writeFileSync(script, '#!/bin/sh\necho ok\n')
  fs.chmodSync(script, 0o755)
  return dir
}

test('attaching a library skill copies its files instead of linking', () => {
  const source = writeSkill(
    fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skill-src-')),
    '# source\n\nCopy me.\n',
  )
  localData.skillSources = () => [
    {
      name: 'copy-me',
      harness: 'pi',
      harnessLabel: 'pi',
      absolutePath: source,
      realPath: source,
    },
  ]

  const record = workspaces.create({ label: 'skills-copy', skills: [] })
  const result = workspaces.attachSkill({ id: record.id, name: 'copy-me', harness: 'pi' })
  const target = path.join(record.path, 'skills', 'copy-me')

  assert.equal(result.copied, true)
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false)
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /Copy me/)
  /* Windows does not carry an execute bit; the copy is checked by content. */
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(target, 'bin', 'run.sh')).mode & 0o100)
  }
})

test('the migration turns an old workspace link into a real copy', { skip: process.platform === 'win32' }, () => {
  const source = writeSkill(
    fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skill-old-')),
    '# old\n\nOriginal bytes.\n',
  )
  const record = workspaces.create({ label: 'skills-migrate', skills: [] })
  fs.mkdirSync(path.join(record.path, 'skills'), { recursive: true })
  const link = path.join(record.path, 'skills', 'legacy')
  fs.symlinkSync(source, link)

  const migrated = workspaces.materialiseSkillLinks(record)
  assert.deepEqual(migrated, ['legacy'])
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false)
  assert.match(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), /Original bytes/)

  /* It is a copy: changing the workspace does not touch the library. */
  fs.writeFileSync(path.join(link, 'SKILL.md'), '# changed\n')
  assert.match(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), /Original bytes/)

  /* And it is idempotent. */
  assert.deepEqual(workspaces.materialiseSkillLinks(record), [])
})

test('a pre-scanned library index attaches without walking the libraries again', () => {
  const one = writeSkill(fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skill-a-')), '# one\n')
  const two = writeSkill(fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skill-b-')), '# two\n')
  const record = workspaces.create({ label: 'skills-index', skills: [] })

  /* The real scan reads every harness skill directory: 40-80 ms on a machine
     with a few libraries. A sync that attaches a roster must pay that once. */
  let scans = 0
  const real = localData.skillSources
  localData.skillSources = () => {
    scans += 1
    return [one, two].map((dir) => ({
      name: path.basename(dir),
      harness: 'pi',
      harnessLabel: 'pi',
      absolutePath: dir,
      realPath: dir,
    }))
  }
  try {
    const sources = workspaces.skillSourceIndex()
    assert.equal(scans, 1)
    for (const name of [path.basename(one), path.basename(two)]) {
      workspaces.attachSkill({ id: record.id, name, harness: 'pi', sources })
    }
    assert.equal(scans, 1, 'attaching two skills re-used the one scan')
  } finally {
    localData.skillSources = real
  }

  for (const dir of [one, two]) {
    const landed = path.join(record.path, 'skills', path.basename(dir), 'SKILL.md')
    assert.equal(fs.existsSync(landed), true)
    assert.equal(fs.lstatSync(path.dirname(landed)).isSymbolicLink(), false)
  }
})

/**
 * Copying between workspaces — the byte path behind the `Copy…` sheet.
 *
 * `attachSkill` reads a harness library, so a second workspace used to be
 * re-attached by hand and got the library's version instead of the edits. These
 * cases pin the three things that make the copy safe: the source is untouched, a
 * clash is resolved before anything is written, and a failure leaves no
 * half-written directory in the target.
 */
function readyWorkspace(label, skillName, body) {
  const record = workspaces.create({ label, skills: [] })
  const dir = path.join(record.path, 'skills', skillName)
  writeSkill(dir, body)
  return record
}

test('a workspace copy keeps the source and carries the edits, not the library', () => {
  const from = readyWorkspace('copy-source', 'shared', '# v2\n\nEdited in the workspace.\n')
  const to = workspaces.create({ label: 'copy-target', skills: [] })

  const result = workspaces.copySkill({ from: from.id, to: to.id, name: 'shared' })

  assert.equal(result.name, 'shared')
  assert.equal(result.replaced, false)
  assert.equal(result.target, to.id)
  assert.equal(result.files, 2)
  assert.equal(fs.existsSync(path.join(from.path, 'skills', 'shared', 'SKILL.md')), true)
  const landed = path.join(to.path, 'skills', 'shared', 'SKILL.md')
  assert.match(fs.readFileSync(landed, 'utf8'), /Edited in the workspace/)
  assert.equal(fs.lstatSync(path.dirname(landed)).isSymbolicLink(), false)
  /* nothing staged is left behind */
  assert.deepEqual(
    fs.readdirSync(path.join(to.path, 'skills')).filter((entry) => entry.endsWith('.tmp')),
    [],
  )
})

test('a clash is refused by default, replaced or kept both on request', () => {
  const from = readyWorkspace('clash-source', 'code', '# the one being copied\n')
  const to = readyWorkspace('clash-target', 'code', '# the copy that is already there\n')

  assert.throws(
    () => workspaces.copySkill({ from: from.id, to: to.id, name: 'code' }),
    /already has a skill called "code"/,
  )
  /* a refusal writes nothing */
  assert.match(
    fs.readFileSync(path.join(to.path, 'skills', 'code', 'SKILL.md'), 'utf8'),
    /already there/,
  )

  const kept = workspaces.copySkill({ from: from.id, to: to.id, name: 'code', onConflict: 'keep' })
  assert.equal(kept.name, 'code-2')
  assert.equal(kept.replaced, true)
  assert.match(
    fs.readFileSync(path.join(to.path, 'skills', 'code', 'SKILL.md'), 'utf8'),
    /already there/,
    'keep both never touches the existing copy',
  )
  assert.match(
    fs.readFileSync(path.join(to.path, 'skills', 'code-2', 'SKILL.md'), 'utf8'),
    /being copied/,
  )

  const replaced = workspaces.copySkill({
    from: from.id,
    to: to.id,
    name: 'code',
    onConflict: 'replace',
  })
  assert.equal(replaced.name, 'code')
  assert.match(
    fs.readFileSync(path.join(to.path, 'skills', 'code', 'SKILL.md'), 'utf8'),
    /being copied/,
  )
})

test('keep both counts up from the first free name', () => {
  const from = readyWorkspace('free-source', 'writer', '# new\n')
  const to = readyWorkspace('free-target', 'writer', '# old\n')
  fs.cpSync(path.join(to.path, 'skills', 'writer'), path.join(to.path, 'skills', 'writer-2'), {
    recursive: true,
  })

  workspaces.copySkill({ from: from.id, to: to.id, name: 'writer', onConflict: 'keep' })
  assert.equal(fs.existsSync(path.join(to.path, 'skills', 'writer-3', 'SKILL.md')), true)
})

test('a renamed copy renames what the skill calls itself', () => {
  const record = workspaces.create({ label: 'rename-source', skills: [] })
  const target = workspaces.create({ label: 'rename-target', skills: [] })
  const dir = path.join(record.path, 'skills', 'author')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', 'name: author', 'description: writes things', '---', '', '# author\n'].join('\n'),
    'utf8',
  )
  workspaces.copySkill({ from: record.id, to: target.id, name: 'author' })
  fs.cpSync(path.join(target.path, 'skills', 'author'), path.join(target.path, 'skills', 'author-2'), {
    recursive: true,
  })

  const result = workspaces.copySkill({
    from: record.id,
    to: target.id,
    name: 'author',
    onConflict: 'keep',
  })
  assert.equal(result.name, 'author-3')
  const landed = fs.readFileSync(path.join(target.path, 'skills', 'author-3', 'SKILL.md'), 'utf8')
  assert.match(landed, /^name: author-3$/m)
  assert.match(landed, /description: writes things/)
  /* the copies that were already there are untouched */
  assert.match(
    fs.readFileSync(path.join(target.path, 'skills', 'author', 'SKILL.md'), 'utf8'),
    /^name: author$/m,
  )
})

test('a copy into itself is rejected, and so is an unknown skill', () => {
  const from = readyWorkspace('self-source', 'solo', '# solo\n')
  assert.throws(
    () => workspaces.copySkill({ from: from.id, to: from.id, name: 'solo' }),
    /already lives in/,
  )
  assert.throws(
    () => workspaces.copySkill({ from: from.id, to: from.id, name: '../escape' }),
    /is not a skill name/,
  )
  const other = workspaces.create({ label: 'self-target', skills: [] })
  assert.throws(
    () => workspaces.copySkill({ from: from.id, to: other.id, name: 'ghost' }),
    /No skill called "ghost"/,
  )
})

test(
  'a copy that cannot be read leaves nothing behind in the target',
  { skip: process.platform === 'win32' },
  () => {
    const from = readyWorkspace('fail-source', 'blocked', '# blocked\n')
    const to = workspaces.create({ label: 'fail-target', skills: [] })
    const source = path.join(from.path, 'skills', 'blocked')
    /* the staged copy fails halfway: the target must not keep a directory it
       cannot vouch for */
    fs.chmodSync(source, 0o000)
    try {
      assert.throws(() => workspaces.copySkill({ from: from.id, to: to.id, name: 'blocked' }))
    } finally {
      fs.chmodSync(source, 0o755)
    }
    const landed = path.join(to.path, 'skills')
    const leftovers = fs.existsSync(landed) ? fs.readdirSync(landed) : []
    assert.deepEqual(leftovers, [], 'a failed copy leaves no directory behind')
  },
)

test('a dangling link has nothing to copy', { skip: process.platform === 'win32' }, () => {
  const from = workspaces.create({ label: 'dangling-source', skills: [] })
  const to = workspaces.create({ label: 'dangling-target', skills: [] })
  fs.mkdirSync(path.join(from.path, 'skills'), { recursive: true })
  fs.symlinkSync(
    path.join(os.tmpdir(), 'entity-skill-nowhere'),
    path.join(from.path, 'skills', 'broken'),
  )

  assert.throws(
    () => workspaces.copySkill({ from: from.id, to: to.id, name: 'broken' }),
    /has no files to copy/,
  )
  assert.equal(fs.existsSync(path.join(to.path, 'skills', 'broken')), false)
})
