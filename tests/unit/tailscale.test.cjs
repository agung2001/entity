/* The daemon read: what `tailscale status --json` becomes, and what it never
   becomes. No daemon and no binary — `read()` takes an injected `exec`. */
const test = require('node:test')
const assert = require('node:assert/strict')
const { derive, addressOf, planOf, read } = require('../../electron/connectors/tailscale/dashboard.cjs')

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

/* The decision the packaged app got wrong: `spawn(npm, …, { cwd: …/app.asar })` is
   `ENOTDIR`, because an asar is a file. So a Start asks the filesystem what it has
   before it touches a child, and the answer is one of three words. */
const files = (...present) => (file) => present.some((entry) => file.endsWith(entry))

test('a checkout runs the repo\'s Vite, even with a stale `dist/` beside it', () => {
  const answer = planOf({
    root: '/repo',
    dist: '/repo/dist',
    attached: true,
    isFile: files('node_modules/vite/package.json', 'dist/index.html'),
  })
  assert.equal(answer, 'checkout')
})

test('a packaged app has no Vite and serves its own build', () => {
  const asar = '/Applications/Entity.app/Contents/Resources/app.asar'
  const answer = planOf({
    root: asar,
    dist: `${asar}/dist`,
    attached: true,
    isFile: files('dist/index.html'),
  })
  assert.equal(answer, 'build')
})

test('a build with no call table behind it is `none`, and so is an empty bundle', () => {
  /* `dist/` without the table is a page that paints and answers nothing, which is
     why the shared server — which never attaches — reports `none`. */
  assert.equal(planOf({ root: '/repo', dist: '/repo/dist', attached: false, isFile: files('dist/index.html') }), 'none')
  assert.equal(planOf({ root: '/repo', dist: '/repo/dist', attached: true, isFile: () => false }), 'none')
})

test('the plan is part of the read, so the page never guesses it', async () => {
  const answer = await read({ exec: fake(RUNNING), plan: () => 'build' })
  assert.equal(answer.mode, 'build')
  const absent = await read({
    exec: async () => ({ stdout: '', stderr: '', error: Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }) }),
    plan: () => 'checkout',
  })
  assert.equal(absent.mode, 'checkout')
})
