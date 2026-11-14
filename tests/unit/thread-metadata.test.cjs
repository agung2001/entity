const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  build,
  performPathAction,
  urlsIn,
  trimUrl,
} = require('../../electron/thread-metadata.cjs')

/* A tiny tree so every listed path is a real file or directory, which is the
   rule the panel relies on. */
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-meta-'))
  fs.mkdirSync(path.join(root, 'src', 'views'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'views', 'ChatView.vue'), '<script setup></script>\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# readme\n')
  fs.writeFileSync(path.join(root, 'out.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n')
  return root
}

const thread = (messages, extra = {}) => ({
  machine: 'local',
  messages,
  ...extra,
})

test('urls: bare links, markdown labels, trailing prose and duplicates', () => {
  const out = build({
    thread: thread([
      {
        who: 'agent',
        at: '2026-01-01T10:00:00.000Z',
        text:
          'See https://youtrack.example.com/issue/AC-12, and [the PR](https://github.com/acme/entity/pull/42). ' +
          'Also https://example.com/a_(b) and https://example.com/a_(b).',
      },
    ]),
  })

  assert.deepEqual(
    out.links.map((link) => link.url),
    [
      'https://youtrack.example.com/issue/AC-12',
      'https://github.com/acme/entity/pull/42',
      'https://example.com/a_(b)',
    ],
  )
  assert.equal(out.links[0].label, 'AC-12')
  assert.equal(out.links[1].label, 'the PR')
  assert.equal(out.links[2].count, 2)
  assert.equal(out.links[2].host, 'example.com')
})

test('urls: mention items carry their own label and URL', () => {
  const out = build({
    thread: thread([
      {
        who: 'me',
        at: '2026-01-01T10:00:00.000Z',
        text: 'look at this',
        mentions: [
          {
            kind: 'youtrack',
            items: [
              {
                label: 'AC-9 — login bug',
                url: 'https://youtrack.example.com/issue/AC-9',
              },
            ],
          },
        ],
      },
    ]),
  })
  assert.equal(out.links[0].label, 'AC-9 — login bug')
  assert.equal(out.links[0].source, 'mention')
})

test('paths: only real files and directories, relative to the turn cwd', () => {
  const root = tree()
  const out = build({
    workspacePath: root,
    entityDir: root,
    thread: thread([
      {
        who: 'agent',
        at: '2026-01-01T10:00:00.000Z',
        execution: { cwd: root },
        text: [
          'I changed src/views/ChatView.vue and opened `README.md`.',
          'The folder src/views/ is where it lives, and `Makefile` builds it.',
          'This is not a path: and/or, 2024/01/02, https://example.com/src/app.js',
          'Nor is Library/Caches relative to home.',
          'A missing file: src/views/Nope.vue',
        ].join(' '),
      },
    ]),
  })

  const found = out.paths.map((entry) => entry.display)
  assert.ok(found.includes(path.join(root, 'src', 'views', 'ChatView.vue')))
  assert.ok(found.includes(path.join(root, 'README.md')))
  assert.ok(found.includes(path.join(root, 'src', 'views')))
  assert.ok(found.includes(path.join(root, 'Makefile')))
  assert.ok(!found.some((entry) => entry.includes('Nope.vue')))
  assert.ok(!found.some((entry) => entry.includes('Library')))
  assert.ok(!found.some((entry) => entry.includes('and/or')))
  assert.ok(!found.some((entry) => entry.includes('example.com')))
  assert.equal(out.paths.find((entry) => entry.name === 'ChatView.vue').kind, 'file')
  assert.equal(out.paths.find((entry) => entry.name === 'views').kind, 'directory')
})

test('an @orca mention contributes its absolute label as a path', () => {
  const root = tree()
  const file = path.join(root, 'README.md')
  const out = build({
    workspacePath: root,
    entityDir: root,
    thread: thread([
      {
        who: 'me',
        at: '2026-01-01T10:00:00.000Z',
        text: 'look @orca:Proj:README.md',
        mentions: [{ kind: 'orca', items: [{ label: file, detail: 'Proj' }] }],
      },
    ]),
  })
  assert.equal(out.paths.find((entry) => entry.path === file)?.source, 'mention')
})

test('paths: tool calls, tool output, line numbers and attachments', () => {
  const root = tree()
  const file = path.join(root, 'src', 'views', 'ChatView.vue')
  const out = build({
    workspacePath: root,
    entityDir: root,
    thread: thread([
      {
        who: 'agent',
        at: '2026-01-01T10:01:00.000Z',
        text: 'Done.',
        attachments: [{ kind: 'file', path: file }],
        steps: [
          { type: 'tool_use', tool: 'Read', input: { file_path: file } },
          {
            type: 'tool_result',
            content: `wrote ${path.join(root, 'out.txt')}:12:3\n`,
          },
        ],
      },
    ]),
  })

  const found = out.paths.map((entry) => entry.path)
  assert.ok(found.includes(file))
  assert.ok(found.includes(path.join(root, 'out.txt')))
  assert.equal(out.paths.find((entry) => entry.path === file).source, 'attachment')
})

test('remote threads keep candidates but mark them unknown instead of stat-ing', () => {
  const out = build({
    machine: 'devbox',
    thread: thread(
      [
        {
          who: 'agent',
          at: '2026-01-01T10:00:00.000Z',
          text: 'Edited src/app.ts and /home/dev/app.ts. Not and/or, not v1.2.3.',
        },
      ],
      { machine: 'devbox' },
    ),
  })

  const found = out.paths.map((entry) => entry.path)
  assert.deepEqual(found.sort(), ['/home/dev/app.ts', 'src/app.ts'])
  for (const entry of out.paths) {
    assert.equal(entry.remote, true)
    assert.equal(entry.kind, 'unknown')
  }
  assert.equal(out.remote, true)
})

test('newest mentions sort first and duplicates collapse into a count', () => {
  const out = build({
    thread: thread([
      { who: 'agent', at: '2026-01-01T10:00:00.000Z', text: 'old https://example.com/old' },
      { who: 'agent', at: '2026-01-01T10:05:00.000Z', text: 'new https://example.com/new' },
      { who: 'agent', at: '2026-01-01T10:06:00.000Z', text: 'again https://example.com/old' },
    ]),
  })
  assert.deepEqual(
    out.links.map((link) => link.url),
    ['https://example.com/old', 'https://example.com/new'],
  )
  assert.equal(out.links[0].count, 2)
})

test('url helpers trim prose punctuation without eating balanced parens', () => {
  assert.equal(trimUrl('https://example.com/a).'), 'https://example.com/a')
  assert.equal(trimUrl('https://example.com/a_(b)).'), 'https://example.com/a_(b)')
  assert.deepEqual(
    urlsIn('[docs](https://example.com/docs) and https://example.com/x.') .map((entry) => entry.url),
    ['https://example.com/docs', 'https://example.com/x'],
  )
})

test('path actions only touch listed paths, and directories do not open in VS Code', async () => {
  const root = tree()
  const file = path.join(root, 'src', 'views', 'ChatView.vue')
  const dir = path.join(root, 'src', 'views')
  const calls = []
  const handlers = {
    reveal: async (value) => calls.push(['reveal', value]),
    openPath: async (value) => calls.push(['openPath', value]),
    openInEditor: async (value) => calls.push(['editor', value]),
  }
  const metadata = build({
    workspacePath: root,
    entityDir: root,
    thread: thread([
      {
        who: 'agent',
        at: '2026-01-01T10:00:00.000Z',
        text: `Changed src/views/ChatView.vue in src/views/.`,
      },
    ]),
  })

  assert.deepEqual(await performPathAction(metadata, { target: file, action: 'reveal', handlers }), {
    action: 'reveal',
    path: file,
    kind: 'file',
  })
  await performPathAction(metadata, { target: dir, action: 'reveal', handlers })
  await performPathAction(metadata, { target: file, action: 'editor', handlers })
  assert.deepEqual(calls, [
    ['reveal', file],
    ['openPath', dir],
    ['editor', file],
  ])

  await assert.rejects(
    () => performPathAction(metadata, { target: '/etc/passwd', action: 'reveal', handlers }),
    /not mentioned in this thread/,
  )
  await assert.rejects(
    () => performPathAction(metadata, { target: dir, action: 'editor', handlers }),
    /only open a file/,
  )
  await assert.rejects(
    () => performPathAction({ ...metadata, remote: true }, { target: file, action: 'reveal', handlers }),
    /remote machine/,
  )
})
