/**
 * The release broadcast has one job that is easy to get wrong and impossible to
 * see from CI: build an embed Discord accepts. A payload over a limit is a 400,
 * a wrong webhook host is a 400, and in both cases the release still ships — the
 * announcement just never appears. These pin the parts the API would reject.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'broadcast-release.mjs')

/* The script is ESM (it is run by `node`, not by the app), so the suite imports
   it dynamically and shares one instance across the cases. */
let mod
test.before(async () => {
  mod = await import(pathToFileURL(SCRIPT).href)
})

const LIMIT = { description: 4096, fieldValue: 1024, title: 256 }

test('the embed quotes the notes and links the tag', async () => {
  const payload = await build({
    tag: 'v0.0.8',
    body: "## What's Changed\n\n- feat: pick the bookmark from either page\n",
    repo: 'agung2001/entity',
  })

  assert.equal(payload.embeds.length, 1)
  const [embed] = payload.embeds
  assert.match(embed.title, /v0\.0\.8/)
  assert.match(embed.description, /pick the bookmark from either page/)
  assert.doesNotMatch(embed.description, /What's Changed/)
  assert.equal(embed.url, 'https://github.com/agung2001/entity/releases/tag/v0.0.8')
})

test('the container image tag drops the leading v', async () => {
  const payload = await build({ tag: 'v0.0.8', repo: 'agung2001/entity' })
  const image = payload.embeds[0].fields.find((field) => field.name === 'Container image')
  assert.match(image.value, /ghcr\.io\/agung2001\/entity:0\.0\.8\]/)
  assert.doesNotMatch(image.value, /:v0\.0\.8\]/)
})

test('a long release body is trimmed to what Discord accepts', async () => {
  const body = Array.from({ length: 400 }, (_, index) => `- line ${index} ${'x'.repeat(60)}`).join('\n')
  const payload = await build({ tag: 'v0.0.8', body, repo: 'agung2001/entity' })

  const [embed] = payload.embeds
  assert.ok(embed.description.length <= LIMIT.description, 'description stays under 4096')
  assert.match(embed.description, /…/)
  assert.match(embed.description, /Full release notes/)
  for (const field of embed.fields) {
    assert.ok(field.value.length <= LIMIT.fieldValue, `${field.name} stays under 1024`)
    assert.ok(field.name.length <= 256)
  }
  assert.ok(embed.title.length <= LIMIT.title)
})

test('an empty body still produces a message worth reading', async () => {
  const payload = await build({ tag: 'v0.0.8', body: '   ', repo: 'agung2001/entity' })
  assert.match(payload.embeds[0].description, /Entity 0\.0\.8 is out/)
})

test('every release pings, and the payload opts in to being parsed', async () => {
  const quiet = await build({ tag: 'v0.0.8', repo: 'agung2001/entity' })
  assert.equal(quiet.content, undefined, 'no mention means no content line')

  const loud = await build({ tag: 'v0.0.8', repo: 'agung2001/entity', mention: '@everyone' })
  assert.equal(loud.content, '@everyone')
  /* Without `allowed_mentions`, Discord shows a literal `@everyone` and pings
     nobody — the failure is invisible in CI. */
  assert.deepEqual(loud.allowed_mentions, { parse: ['everyone', 'roles', 'users'] })
})

test('the workflow pings every release', () => {
  const workflow = require('node:fs').readFileSync(
    path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  assert.match(workflow, /DISCORD_MENTION: '@everyone'/)
})

test('the payload carries no hardcoded webhook', () => {
  const source = require('node:fs').readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(source, /discord(app)?\.com\/api\/webhooks\/\d+/, 'the URL is a secret, never a literal')
  assert.match(source, /DISCORD_WEBHOOK_URL/, 'the secret is what feeds it')
})

test('a webhook URL that is not a Discord webhook is refused before it is used', async () => {
  const { assertWebhook } = mod
  assert.throws(() => assertWebhook('http://discord.com/api/webhooks/1/x'), /https/)
  assert.throws(() => assertWebhook('https://example.test/api/webhooks/1/x'), /not a discord\.com host/)
  assert.throws(() => assertWebhook('https://discord.com/api/v10/channels'), /webhook path/)
  assert.match(assertWebhook('https://discord.com/api/webhooks/123/abc'), /^https:\/\/discord\.com\/api\/webhooks\//)
})

async function build(args) {
  assert.ok(mod, 'script loaded')
  return mod.buildPayload({ serverUrl: 'https://github.com', now: new Date('2026-01-01T00:00:00Z'), ...args })
}
