/**
 * A remote turn is told which connectors the workspace has, and why it cannot
 * reach them.
 *
 * A staged workspace carries entities, skills and artifacts — not `mcp.json`.
 * So the `maka` skill used to arrive while the `maka_*` tools did not, and the
 * agent reported a working connector as "not connected". The note is the fix:
 * it names the connector, the host the turn runs on, and the reason it cannot
 * answer here.
 *
 * It must never carry a credential: a header, an env value, an argv token or a
 * `?token=` query would be copied into a prompt file on another machine.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { brief, targetOf, safeUrl, safeCommand } = require('../../electron/remote-connectors.cjs')

const pool = (servers) => ({ schema: 1, servers, disabled: {} })

test('a loopback server is named, with the reason it cannot answer', () => {
  const text = brief({
    alias: 'root-ubuntu',
    pool: pool({
      maka: {
        url: 'http://127.0.0.1:4780/mcp',
        headers: { Authorization: 'Bearer super-secret-token' },
      },
    }),
  })
  assert.match(text, /maka/)
  assert.match(text, /http:\/\/127\.0\.0\.1:4780\/mcp/)
  assert.match(text, /loopback/)
  assert.match(text, /root-ubuntu/)
  /* the instruction the old answer got wrong */
  assert.match(text, /Do not call a delivered connector "not connected"/)
  assert.equal(text.includes('super-secret-token'), false)
})

test('a home-directory command is machine-bound too, and its arguments are not printed', () => {
  const text = brief({
    alias: 'box',
    pool: pool({
      opendesign: {
        command: '/Users/someone/.entity/workspaces/team/skills/opendesign/bin/opendesign-mcp.sh',
        args: ['--token', 'arg-secret'],
      },
    }),
  })
  assert.match(text, /opendesign/)
  assert.match(text, /home directory/)
  assert.equal(text.includes('/Users/someone'), false)
  assert.equal(text.includes('arg-secret'), false)
})

test('a portable URL keeps its host and path, and drops the query string', () => {
  assert.equal(safeUrl('https://mcp.example.test/mcp?token=secret'), 'https://mcp.example.test/mcp')
  assert.equal(safeUrl('http://127.0.0.1:4780/mcp'), 'http://127.0.0.1:4780/mcp')
  assert.equal(safeCommand('/opt/homebrew/bin/mcp-server'), 'mcp-server')
  assert.equal(targetOf({ url: 'https://mcp.notion.com/mcp' }), 'https://mcp.notion.com/mcp')
  assert.equal(targetOf({ command: 'npx', args: ['-y', 'search-mcp'] }), 'npx')
})

test('a delivered connector is named as reachable through the tunnel', () => {
  const text = brief({
    alias: 'box',
    pool: pool({
      maka: { url: 'http://127.0.0.1:4780/mcp' },
      opendesign: { command: '/Users/someone/opendesign-mcp.sh' },
    }),
    delivered: ['maka'],
  })
  assert.match(text, /maka.*delivered to this run/s)
  assert.match(text, /opendesign.*home directory/s)
  assert.doesNotMatch(text, /opendesign.*delivered/s)
})

test('an empty pool adds nothing, and a disabled one is not offered', () => {
  assert.equal(brief({ alias: 'box', pool: pool({}) }), '')
  assert.equal(brief({ pool: undefined }), '')
  assert.equal(brief({ alias: 'box', pool: { schema: 1, servers: {}, disabled: { maka: {} } } }), '')
})

test('a missing alias still reads as a sentence rather than a blank', () => {
  const text = brief({ pool: pool({ notion: { url: 'https://mcp.example.test/mcp' } }) })
  assert.match(text, /another machine/)
})
