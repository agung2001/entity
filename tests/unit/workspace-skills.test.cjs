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
  assert.ok(fs.statSync(path.join(target, 'bin', 'run.sh')).mode & 0o100)
})

test('the migration turns an old workspace link into a real copy', () => {
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
