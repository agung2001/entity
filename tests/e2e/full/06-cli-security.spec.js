import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { cliEntityGet, cliSetInstructions, runCli } from '../helpers/cli.js'
import { entityFile, entityText } from '../helpers/profile.js'

/**
 * UAT C03/C04/C07 — the agent-facing CLI is a security boundary, not a
 * convenience wrapper. These cases drive it directly, in the disposable
 * profile, exactly as a harness would.
 */
test.describe('agent CLI boundaries', () => {
  test('a stale stamp refuses the write and keeps the human edit', () => {
    const profile = readProfile()
    const before = cliEntityGet('self-editor', { p: profile })
    expect(before.status).toBe(0)
    expect(before.json.ok).toBe(true)

    fs.appendFileSync(entityFile(profile, 'self-editor'), '\n<!-- human edit wins -->\n', 'utf8')

    const stale = cliSetInstructions(
      'self-editor',
      '# Should not overwrite\n',
      ['--if-unchanged', JSON.stringify(before.json.data.stamp)],
      { p: profile },
    )
    expect(stale.status).toBe(1)
    expect(stale.json.ok).toBe(false)
    expect(stale.json.code).toBe('conflict')
    expect(entityText(profile, 'self-editor')).toContain('human edit wins')
  })

  test('empty instructions are refused and the file is untouched', () => {
    const profile = readProfile()
    const before = entityText(profile, 'self-editor')
    const empty = cliSetInstructions('self-editor', '   \n', [], { p: profile })
    expect(empty.status).toBe(1)
    expect(empty.json.ok).toBe(false)
    expect(empty.stdout).toContain('Refusing to write empty instructions')
    expect(entityText(profile, 'self-editor')).toBe(before)
  })

  test('path-like names cannot escape the workspace', () => {
    const profile = readProfile()
    for (const name of ['../evil', '/etc/passwd', 'a/b']) {
      const result = cliEntityGet(name, { p: profile })
      expect(result.status, name).toBe(1)
      expect(result.json?.ok, name).toBe(false)
    }
  })

  test('the CLI refuses to mutate another workspace', () => {
    /* C07 in reports/tests/chat.md. Inside a run ENTITY_WORKSPACE pins the
       reachable workspace; an explicit --workspace must be the same one. */
    const profile = readProfile()
    const otherFile = path.join(profile.otherWorkspacePath, 'entities', 'private-agent.md')
    const before = fs.readFileSync(otherFile, 'utf8')

    const cross = cliSetInstructions('private-agent', '# cross-workspace write\n', [
      '--workspace',
      profile.otherWorkspace,
    ], { p: profile })
    expect(cross.status).toBe(1)
    expect(cross.json?.ok).toBe(false)
    expect(cross.json?.code).toBe('denied')
    expect(fs.readFileSync(otherFile, 'utf8')).toBe(before)
  })
})
