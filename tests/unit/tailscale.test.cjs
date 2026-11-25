/* The daemon read: what `tailscale status --json` becomes, and what it never
   becomes. No daemon and no binary — `read()` takes an injected `exec`. */
const test = require('node:test')
const assert = require('node:assert/strict')
const { derive, addressOf, read } = require('../../electron/tailscale.cjs')

const RUNNING = {
  BackendState: 'Running',
  CurrentTailnet: { Name: 'user@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
  Self: { HostName: 'Avery', DNSName: 'avery.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.7'] },
}
const fake = (status, version = '1.104.4\n  tailscale commit: t938213198\n') => async (bin, argv) =>
  argv[0] === 'version'
    ? { stdout: version, stderr: '', error: null }
    : { stdout: typeof status === 'string' ? status : JSON.stringify(status), stderr: '', error: null }

test('a running tailnet gives a stripped name, the IPv4 and the version', async () => {
  const answer = await read({ exec: fake(RUNNING) })
  assert.equal(answer.state, 'running')
  assert.equal(answer.dnsName, 'avery.tail1234.ts.net')
  assert.equal(answer.ipv4, '100.64.0.7')
  assert.equal(answer.version, '1.104.4')
  assert.equal(answer.magicdnsSuffix, 'tail1234.ts.net')
})

test('the account label never reaches the answer', async () => {
  const answer = await read({ exec: fake(RUNNING) })
  assert.ok(!JSON.stringify(answer).includes('user@example.com'))
})

test('MagicDNS off means no name at all, and the IPv4 answers', () => {
  const answer = derive({ ...RUNNING, CurrentTailnet: { ...RUNNING.CurrentTailnet, MagicDNSEnabled: false } }, '')
  assert.equal(answer.dnsName, '')
  assert.deepEqual(addressOf(answer, 5183), { url: 'http://100.64.0.7:5183', kind: 'ip' })
})

test('the address is the MagicDNS name, and empty when there is no address', () => {
  assert.deepEqual(addressOf(derive(RUNNING, ''), 5183), { url: 'http://avery.tail1234.ts.net:5183', kind: 'magicdns' })
  assert.deepEqual(addressOf({ dnsName: '', ipv4: '' }, 5183), { url: '', kind: 'ip' })
})

test('backend states map onto the five words the page speaks', () => {
  assert.equal(derive({ BackendState: 'Stopped' }, '').state, 'stopped')
  assert.equal(derive({ BackendState: 'NoState' }, '').state, 'stopped')
  assert.equal(derive({ BackendState: 'NeedsLogin' }, '').state, 'signed-out')
  assert.equal(derive({ BackendState: 'Starting' }, '').state, 'starting')
  assert.equal(derive({ BackendState: 'WhoKnows' }, '').state, 'unreadable')
})

test('a missing binary is `absent`, and bad JSON is one sentence', async () => {
  const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })
  assert.equal((await read({ exec: async () => ({ stdout: '', stderr: '', error: missing }) })).state, 'absent')
  const broken = await read({ exec: fake('not json') })
  assert.equal(broken.state, 'unreadable')
  assert.match(broken.error, /JSON/)
})
