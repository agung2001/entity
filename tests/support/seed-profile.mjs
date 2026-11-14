/**
 * Build the disposable profile the E2E suite runs against.
 *
 * Everything here is generated at run time inside `.tmp/` (gitignored):
 * an account with a random password that is never written anywhere, one or two
 * workspaces, entities wired to the deterministic stub, a workspace skill,
 * artifact fixtures and the prompt/attachment fixtures.
 *
 * There are no credentials, host names, tokens or SSH details in this file or
 * in the repository. The CLIs under test use whatever auth their own user
 * profile already has; this script never reads it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function write(entities, workspace, name, harness, dir, instructions, description = '') {
  return entities.write({
    workspace,
    name,
    harness,
    model: '',
    dir,
    skills: [],
    mcp: [],
    instructions,
    frontmatter: description ? { description } : {},
  })
}

export function seedProfile({ root, profile, stateDir, external, stubLog }) {
  process.env.ENTITY_HOME = profile

  resetDir(profile)
  resetDir(stateDir)
  resetDir(external)
  resetDir(stubLog)

  const auth = require(path.join(root, 'electron', 'auth-store.cjs'))
  const workspaces = require(path.join(root, 'electron', 'workspace-store.cjs'))
  const entities = require(path.join(root, 'electron', 'entity-store.cjs'))
  const harnesses = require(path.join(root, 'electron', 'harness-store.cjs'))

  /* A synthetic identity. The password exists only in this call; it is never
     written to the state file and no test signs in with it. */
  const nonce = crypto.randomBytes(4).toString('hex')
  const email = `e2e-${nonce}@example.test`
  const username = `e2e-${nonce}`
  const password = crypto.randomBytes(24).toString('base64url')
  auth.register({ email, name: username, password })

  const record = workspaces.create({
    label: 'chat-uat',
    owner: { name: username, email },
  })
  const workspace = record.id
  const workspacePath = record.path

  /* A second workspace exists only to prove containment and to keep the
     workspace picker honest. No test writes through the UI into it. */
  const other = workspaces.create({
    label: 'other-ws',
    owner: { name: username, email },
  })

  const missingDir = path.join(root, '.tmp', 'e2e-missing-dir')
  fs.rmSync(missingDir, { recursive: true, force: true })

  const entitiesByName = {
    'chief-of-staff': ['claude', external, '# Chief of Staff\n\nYou are the E2E chief of staff. Answer briefly.\n\n## Rules\n- Be plain.\n'],
    reviewer: ['claude', external, '# Reviewer\n\nYou review a short piece of text and answer in one sentence.\n'],
    secretary: ['claude', external, '# Secretary\n\nYou handle small jobs and read the files you are asked about.\n'],
    'self-editor': ['claude', external, '# Self Editor\n\nE2E-SELF-EDIT-BASELINE\n\nYou may read and rewrite your own entity file through the entity CLI when asked.\n\n## Rules\n- Read first, then write.\n'],
    'broken-dir': ['claude', missingDir, '# Broken directory\n\nThis entity points at a directory that does not exist.\n'],
    'opencode-agent': ['opencode', external, '# OpenCode agent\n\nAnswer the person briefly. Do not use tools unless asked.\n'],
    'pi-agent': ['pi', external, '# Pi agent\n\nAnswer the person briefly. Do not use tools unless asked.\n'],
    'mention-a': ['claude', external, '# Mention A\n\nAnswer in one short sentence.\n'],
    'mention-b': ['claude', external, '# Mention B\n\nAnswer in one short sentence.\n'],
    'mention-c': ['claude', external, '# Mention C\n\nAnswer in one short sentence.\n'],
    'remote-agent': ['claude', external, '# Remote agent\n\nUsed by the optional remote suite. Answer briefly.\n'],
  }
  for (const [name, [harness, dir, body]] of Object.entries(entitiesByName)) {
    write(entities, workspace, name, harness, dir, body)
  }
  write(entities, other.id, 'private-agent', 'claude', external, '# Private agent\n\nDo not touch from another workspace.\n')

  /* A workspace skill, created in place so the suite does not need to modify
     any real harness library under the user's home directory. */
  const skillDir = path.join(workspacePath, 'skills', 'uat-alpha')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', 'name: uat-alpha', 'description: E2E skill fixture', '---', '', 'When loaded, begin your reply with E2E-SKILL-LOADED.', ''].join('\n'),
    'utf8',
  )
  /* A second skill reserved for the opt-in remote `//` install test. It has a
     unique name so a run cannot collide with a real skill on the host. */
  const remoteSkillDir = path.join(workspacePath, 'skills', 'e2e-remote-alpha')
  fs.mkdirSync(remoteSkillDir, { recursive: true })
  fs.writeFileSync(
    path.join(remoteSkillDir, 'SKILL.md'),
    ['---', 'name: e2e-remote-alpha', 'description: E2E remote-install fixture', '---', '', 'When loaded, begin your reply with E2E-REMOTE-SKILL-LOADED.', ''].join('\n'),
    'utf8',
  )

  /* Artifact shelf fixtures. The PNG is a real 1x1 image so the preview path
     is exercised, not mocked. */
  const artifactDir = path.join(workspacePath, 'artifacts', 'notes')
  fs.mkdirSync(artifactDir, { recursive: true })
  fs.writeFileSync(path.join(artifactDir, 'e2e-note.md'), '# E2E note\n\nARTIFACT-NOTE-CANARY\n', 'utf8')
  fs.writeFileSync(
    path.join(workspacePath, 'artifacts', 'e2e-shot.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
      'base64',
    ),
  )

  /* External-file fixtures: the entity's working directory is outside both the
     workspace and the profile, exactly like a real person's documents folder. */
  fs.mkdirSync(path.join(external, 'nested'), { recursive: true })
  fs.mkdirSync(path.join(external, 'with space'), { recursive: true })
  fs.writeFileSync(path.join(external, 'brief.md'), 'E2E-EXTERNAL-CANARY-42\n', 'utf8')
  fs.writeFileSync(path.join(external, 'data.csv'), 'id,name\n1,alpha\n2,beta\n', 'utf8')
  fs.writeFileSync(path.join(external, 'nested', 'deep.txt'), 'E2E-NESTED-CANARY-9\n', 'utf8')
  fs.writeFileSync(path.join(external, 'with space', 'quarterly report.txt'), 'E2E-SPACE-CANARY-7\n', 'utf8')
  fs.writeFileSync(path.join(external, 'empty.txt'), '', 'utf8')
  const huge = path.join(external, 'huge.bin')
  fs.writeFileSync(huge, '')
  fs.truncateSync(huge, 26 * 1024 * 1024)

  /* Install the deterministic stub under the profile. It is a real executable
     file, so `harness.list` reports claude as installed and the normal spawn
     path is exercised. */
  const harnessDir = path.join(profile, 'harness')
  fs.mkdirSync(harnessDir, { recursive: true })
  const stubSource = fs.readFileSync(path.join(root, 'tests', 'support', 'stub-harness.sh'), 'utf8')
  const stub = path.join(harnessDir, 'claude')
  const failStub = path.join(harnessDir, 'claude-fail')
  const flakyStub = path.join(harnessDir, 'claude-flaky')
  for (const [file, body] of [
    [stub, stubSource],
    [failStub, stubSource],
    [flakyStub, stubSource],
  ]) {
    fs.writeFileSync(file, body, { mode: 0o755 })
    fs.chmodSync(file, 0o755)
  }
  harnesses.setPath({ id: 'claude', path: stub })

  const harnessList = harnesses.list().map((item) => ({
    id: item.id,
    label: item.label,
    installed: item.installed,
  }))

  const state = {
    baseURL: '',
    profile,
    workspace,
    workspacePath,
    otherWorkspace: other.id,
    otherWorkspacePath: other.path,
    user: { username, email },
    paths: { external, stubLog, stub, failStub, flakyStub },
    entities: Object.keys(entitiesByName),
    skill: { name: 'uat-alpha', path: skillDir },
    artifacts: {
      note: 'notes/e2e-note.md',
      image: 'e2e-shot.png',
    },
    fixtures: {
      brief: path.join(external, 'brief.md'),
      data: path.join(external, 'data.csv'),
      nested: path.join(external, 'nested', 'deep.txt'),
      spaced: path.join(external, 'with space', 'quarterly report.txt'),
      empty: path.join(external, 'empty.txt'),
      huge,
    },
    harnesses: harnessList,
  }

  const stateFile = path.join(stateDir, 'profile.json')
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(stateFile, 0o600)
  return { state, stateFile }
}

export function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}
