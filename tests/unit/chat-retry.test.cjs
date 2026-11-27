const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-retry-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const harnesses = require('../../electron/harness-store.cjs')

/* The stand-ins are POSIX shell scripts, spawned with an argv array — they
   cannot run on Windows. */
const POSIX = process.platform !== 'win32'

/**
 * A harness that answers, and keeps every prompt it was handed. The prompt is
 * what a *new* process knows, which is the whole subject of this file: nothing
 * survives a turn except what is written into the next prompt.
 */
function standIn(root) {
  const fake = path.join(root, 'recording-pi')
  const seq = path.join(root, 'seq')
  const prompts = path.join(root, 'prompts')
  fs.mkdirSync(prompts, { recursive: true })
  fs.writeFileSync(
    fake,
    `#!/bin/sh
n=$(cat "${seq}" 2>/dev/null || echo 0)
n=$((n + 1))
echo $n > "${seq}"
cat > "${prompts}/$n.txt"
printf '%s\\n' '${JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'drafted' },
 })}'
exit 0
`,
    { mode: 0o755 },
  )
  return { fake, promptFile: (n) => path.join(prompts, `${n}.txt`) }
}

/** What a timed-out turn leaves on disk: no answer, and the files it saved. */
function failLastTurn(workspace, threadId, artifacts) {
  const root = path.join(PROFILE, 'workspaces', workspace, 'artifacts')
  for (const id of artifacts) {
    const file = path.join(root, id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '<!doctype html>\n')
  }
  const file = path.join(PROFILE, 'workspaces', workspace, 'chats', `${threadId}.json`)
  const thread = JSON.parse(fs.readFileSync(file, 'utf8'))
  thread.messages[thread.messages.length - 1] = {
    who: 'sys',
    id: 'm_failed',
    text: 'Harness error: The turn ran past its 90-minute limit and was stopped.',
    at: new Date().toISOString(),
    error: true,
    steps: [],
    artifacts: artifacts.map((id) => ({
      id,
      name: id.split('/').pop(),
      kind: 'file',
      mime: 'application/octet-stream',
    })),
  }
  fs.writeFileSync(file, JSON.stringify(thread, null, 2))
}

test('a retry names the files its failed turn saved', { skip: !POSIX }, async (t) => {
  const avatar = standIn(fs.mkdtempSync(path.join(os.tmpdir(), 'entity-retry-run-')))
  const record = workspaces.create({ label: 'retry-files' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'designer', harness: 'pi' })
  harnesses.setPath({ id: 'pi', path: avatar.fake })

  const thread = await chats.create({ workspace, entity: 'designer', harness: 'pi' })
  t.after(() => chats.closeAll())

  await chats.send({ workspace, id: thread.id, text: 'redesign the machine page' })
  await chats.send({ workspace, id: thread.id, text: 'add the missing reports' })
  const failed = ['design/machine-detail/index.html', 'design/machine-detail/spec.md']
  failLastTurn(workspace, thread.id, failed)

  /* A turn that answered on its own names nothing: the block is evidence of a
     turn that could not say what it did, not a directory listing. */
  assert.ok(!fs.readFileSync(avatar.promptFile(1), 'utf8').includes('read what'))
  assert.ok(!fs.readFileSync(avatar.promptFile(2), 'utf8').includes('read what'))

  const updated = await chats.send({ workspace, id: thread.id, retry: true })

  /* The retry is still a replacement, not a second copy of the question. */
  const asked = updated.messages.filter((m) => m.who === 'me' && m.text === 'add the missing reports')
  assert.equal(asked.length, 1)
  assert.ok(!updated.messages.some((m) => m.error), 'the failed row is replaced')

  /* …and the new process is told what is already on disk, by a path it can
     open from its own cwd. */
  const prompt = fs.readFileSync(avatar.promptFile(3), 'utf8')
  assert.match(prompt, /Files an earlier attempt in this thread already wrote/)
  for (const id of failed) {
    assert.ok(prompt.includes(id), `${id} must be named in the retry prompt`)
  }
  assert.ok(
    prompt.includes(path.join(PROFILE, 'workspaces', workspace, 'artifacts', 'design')),
    'the block names absolute paths, not ids alone',
  )
  /* the question itself still leads the prompt */
  assert.ok(prompt.indexOf('add the missing reports') < prompt.indexOf('Files an earlier attempt'))
})

test('a plain message after a dead turn names those files too', { skip: !POSIX }, async (t) => {
  const avatar = standIn(fs.mkdtempSync(path.join(os.tmpdir(), 'entity-retry-after-')))
  const record = workspaces.create({ label: 'retry-after' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'designer', harness: 'pi' })
  harnesses.setPath({ id: 'pi', path: avatar.fake })

  const thread = await chats.create({ workspace, entity: 'designer', harness: 'pi' })
  t.after(() => chats.closeAll())

  await chats.send({ workspace, id: thread.id, text: 'redesign the machine page' })
  failLastTurn(workspace, thread.id, ['design/machine-detail/index.html'])

  /* The failed row stays in the transcript here — the asymmetry is that
     `promptFor` reads prose and that row has none. */
  const updated = await chats.send({
    workspace,
    id: thread.id,
    text: 'keep going from the files that are already there',
  })
  const prompt = fs.readFileSync(avatar.promptFile(2), 'utf8')
  assert.match(prompt, /Files an earlier attempt in this thread already wrote/)
  assert.ok(prompt.includes('design/machine-detail/index.html'))
  /* the dead row itself is not replayed as a turn: it is not prose */
  assert.ok(!prompt.includes('Harness error'))
  assert.ok(updated.messages.some((m) => m.who === 'me' && m.text.startsWith('keep going')))
})
