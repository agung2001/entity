/**
 * Announce a published release in Discord.
 *
 * `.github/workflows/release.yml` runs this at the end of the `publish` job,
 * after `softprops/action-gh-release` has already created the release. The
 * message is a notification about something that exists, never the thing that
 * creates it — losing a broadcast is annoying, not fatal — so the workflow
 * marks the step `continue-on-error`.
 *
 * Everything comes from the environment. No webhook URL lives in this file: a
 * webhook is a live credential, and AGENTS.md is explicit that a URL taken out
 * of a real profile never reaches a tracked file. It is a repo secret instead.
 *
 *   DISCORD_WEBHOOK_URL  the channel webhook (repo secret). Unset = skip.
 *   DISCORD_MENTION      the ping to send, e.g. `@everyone`. Empty = no ping.
 *   GITHUB_REF_NAME      the tag being released, e.g. `v0.0.8`
 *   GITHUB_REPOSITORY    `owner/name`, used for the links
 *   GITHUB_SERVER_URL    defaults to https://github.com
 *   GH_TOKEN             optional — reads the notes GitHub generated
 *
 * `node scripts/broadcast-release.mjs --dry-run` prints the payload and sends
 * nothing. That is how you check a change to the embed without touching a
 * channel.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* Discord's own limits. Exceeding one is a 400 and the whole broadcast is lost,
   so the payload is trimmed here instead of hoping the notes stay short. */
const LIMIT = {
  content: 2000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
}

const COLOR = 0xf8b956 // tokens.css `--accent`, so the card matches the app

const USER_AGENT = 'entity-release-broadcast'
const MAX_ATTEMPTS = 4

/** Cut `text` to `max` characters, preferring a line break over a mid-word cut. */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const head = value.slice(0, max)
  const lineBreak = head.lastIndexOf('\n')
  const cut = lineBreak > max * 0.6 ? head.slice(0, lineBreak) : head
  return `${cut.trimEnd()}…`
}

/** `v0.0.8` → `0.0.8`, the version the installers and the image tag carry. */
export function bareVersion(tag) {
  return String(tag ?? '').trim().replace(/^v/i, '')
}

/** Strip the webhook's query string before it can reach a log line. */
function safeUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(unparseable webhook URL)'
  }
}

export function assertWebhook(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('DISCORD_WEBHOOK_URL is not a URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('DISCORD_WEBHOOK_URL must be https')
  if (!/(^|\.)discord(app)?\.com$/.test(parsed.hostname)) {
    throw new Error(`DISCORD_WEBHOOK_URL is not a discord.com host (${parsed.hostname})`)
  }
  if (!parsed.pathname.startsWith('/api/webhooks/')) {
    throw new Error('DISCORD_WEBHOOK_URL is not a webhook path')
  }
  return parsed.toString()
}

/**
 * The embed for one release. Pure, so `tests/unit/discord-broadcast.test.cjs`
 * can pin the parts that Discord silently rejects.
 */
export function buildPayload({ tag, body = '', repo, serverUrl = 'https://github.com', mention = '', now = new Date() }) {
  const version = bareVersion(tag)
  const releaseUrl = `${serverUrl}/${repo}/releases/tag/${tag}`
  const imageUrl = `https://github.com/${repo}/pkgs/container/entity`

  const notes = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*##\s*What's Changed\s*$/im, '')
    .trim()

  const description = notes
    ? truncate(notes, LIMIT.description - 120) + `\n\n[Full release notes](${releaseUrl})`
    : `Entity ${version} is out — installers for macOS and Windows, plus a container image.\n\n[Full release notes](${releaseUrl})`

  const payload = {
    embeds: [
      {
        title: truncate(`Entity ${tag} is available`, LIMIT.title),
        description,
        url: releaseUrl,
        color: COLOR,
        fields: [
          {
            name: 'Installers',
            value: `[macOS DMG · Windows installer](${releaseUrl})`,
            inline: true,
          },
          {
            name: 'Container image',
            value: truncate(`[ghcr.io/${repo.toLowerCase()}:${version}](${imageUrl})`, LIMIT.fieldValue),
            inline: true,
          },
        ],
        footer: { text: truncate(`Entity ${version}`, LIMIT.footer) },
        timestamp: new Date(now).toISOString(),
      },
    ],
  }

  /* Every release announces itself, so the channel knows a build landed. The
     mention is dropped when the caller asks for a quiet message (the script's
     own default), and `allowed_mentions` is explicit: Discord does not parse
     `@everyone` from a webhook payload by default, so leaving it out silently
     turns the ping into plain text. */
  const ping = String(mention ?? '').trim()
  if (ping) {
    payload.content = truncate(ping, LIMIT.content)
    payload.allowed_mentions = { parse: ['everyone', 'roles', 'users'] }
  }
  return payload
}

/**
 * The notes GitHub generated for this tag. They live on the release, not in a
 * file — `generate_release_notes: true` writes them server-side — so the only
 * way to quote them is to read them back. Anonymous for a public repo; the
 * token (when present) only lifts the rate limit.
 */
export async function fetchReleaseBody({ tag, repo, token, serverUrl = 'https://github.com' }) {
  if (!repo || !tag) return ''
  const api = serverUrl.replace(/^https?:\/\/github\.com/, 'https://api.github.com')
  const url = `${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const headers = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }
  if (token) headers.authorization = `Bearer ${token}`

  try {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      console.warn(`no release notes: ${response.status} ${response.statusText}`)
      return ''
    }
    const release = await response.json()
    return typeof release.body === 'string' ? release.body : ''
  } catch (error) {
    console.warn(`no release notes: ${error.message}`)
    return ''
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One webhook POST, with the retries Discord actually asks for: 429 carries a
 * `retry_after` in seconds, 5xx is worth another try, everything else 4xx is our
 * own mistake and retrying only wastes the rate limit.
 */
async function send(webhookUrl, payload) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(payload),
    })

    if (response.ok) {
      console.log(`broadcast sent to ${safeUrl(webhookUrl)}`)
      return
    }

    const text = await response.text().catch(() => '')
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`Discord refused the payload: ${response.status} ${response.statusText} ${text}`.trim())
    }

    let waitMs = attempt * 2000
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after')) || Number((JSON.parse(text || '{}').retry_after ?? 0))
      if (retryAfter > 0) waitMs = Math.ceil(retryAfter * 1000)
    }
    console.warn(`attempt ${attempt} failed (${response.status}); retrying in ${waitMs}ms`)
    await sleep(waitMs)
  }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : (process.argv[index + 1] ?? '')
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DISCORD_DRY_RUN === '1'
  const tag = arg('--tag') || process.env.GITHUB_REF_NAME || ''
  if (!tag) throw new Error('no tag: pass --tag or set GITHUB_REF_NAME')

  const repo = process.env.GITHUB_REPOSITORY || 'agung2001/entity'
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'

  /* Locally the notes may sit next to package.json (a hand-written draft);
     in CI they are read back from the release. */
  const localNotes = path.resolve(process.cwd(), 'release_notes.md')
  let body = fs.existsSync(localNotes) ? fs.readFileSync(localNotes, 'utf8') : ''
  if (!body) body = await fetchReleaseBody({ tag, repo, token: process.env.GH_TOKEN, serverUrl })

  const payload = buildPayload({
    tag,
    body,
    repo,
    serverUrl,
    mention: process.env.DISCORD_MENTION ?? '',
  })

  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL ?? '').trim()
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  if (!webhookUrl) {
    console.log('DISCORD_WEBHOOK_URL is not set — nothing to announce, skipping')
    return
  }

  await send(assertWebhook(webhookUrl), payload)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`broadcast failed: ${error.message}`)
    process.exitCode = 1
  })
}
