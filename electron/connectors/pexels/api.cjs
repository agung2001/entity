/**
 * The Pexels connector's HTTP half: three reads, the row each answer becomes, and
 * the two refusals worth naming.
 *
 * Pexels is a library, not an account: one opaque key is pasted once
 * (`connector-tokens.cjs`) and every read is a GET with that key in
 * `Authorization` — no `Bearer`, the key alone, which is the shape its docs use and
 * the one thing everybody gets wrong first.
 *
 * A row carries a **file URL**, not the page the photo sits on: a prompt that holds
 * `pexels.com/photo/…` makes the agent fetch HTML and guess, and `src.large2x` is
 * the picture itself. `detail` keeps the page address for the person reading the
 * card.
 *
 * The budget is why nothing here is reachable from `preview`: 200 requests an hour
 * and 20 000 a month are spent by the whole key, and a composer that resolved a
 * suggestion per keystroke would spend an hour's worth in a sentence.
 */
const BASE = 'https://api.pexels.com'
const TIMEOUT_MS = 20_000
/* The house number: a mention answers at most a screenful, whatever the reader. */
const ROW_CEILING = 12
/* A clip wider than this is a download, not a shot in a prompt. */
const VIDEO_MAX_WIDTH = 1920

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Pexels' own words for a failed request, when it sent any: `{ error, status, code }`. */
function saidOf(raw) {
  try {
    const said = JSON.parse(raw)?.error
    if (said) return text(said, 200)
  } catch {
    /* an error page that is not JSON has no message to quote */
  }
  return ''
}

function upstreamError(status, said) {
  if (status === 401 || status === 403) {
    return coded('pexels-401', 'Pexels rejected the API key — paste a fresh one on the connector’s page.')
  }
  if (status === 429) {
    return coded(
      'pexels-429',
      'Pexels has spent this key’s rate limit — 200 requests an hour and 20 000 a month are the whole budget. Try again later.',
    )
  }
  return new Error(`Pexels answered ${status}${said ? `: ${said}` : ''}.`)
}

/**
 * One GET, with the key in `Authorization` and nowhere else.
 *
 * A thrown fetch and a refused request are different sentences on purpose: "did not
 * answer" is a network that dropped, "rejected" is a key a person can replace.
 */
async function get(token, path, params = {}) {
  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  let response
  try {
    response = await fetch(url, {
      headers: { Authorization: String(token || ''), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw coded('pexels-timeout', 'Pexels did not answer within 20 seconds.')
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) throw upstreamError(response.status, saidOf(raw))
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('Pexels returned an unreadable payload.')
  }
}

const listOf = (value) => (Array.isArray(value) ? value : []).filter((row) => row && typeof row === 'object')
const size = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/* ── the three reads ─────────────────────────────────────────────────────── */

async function searchPhotos(token, query, { perPage = ROW_CEILING, page = 1 } = {}) {
  const body = await get(token, '/v1/search', { query, per_page: perPage, page })
  return listOf(body.photos)
}

async function searchVideos(token, query, { perPage = ROW_CEILING, page = 1 } = {}) {
  const body = await get(token, '/v1/videos/search', { query, per_page: perPage, page })
  return listOf(body.videos)
}

/** One photo, by the id its own address carries — the "picked" form. */
async function photoById(token, id) {
  const body = await get(token, `/v1/photos/${encodeURIComponent(id)}`)
  return body.id ? body : null
}

/* ── the rows ─────────────────────────────────────────────────────────────
   The label is what a person recognises, the detail is where it came from, and
   the url is what an agent can actually use. */

/** The widest link that still fits in a prompt; the first when nothing fits. */
function bestVideoFile(files) {
  const usable = listOf(files).filter((file) => text(file.link, 400))
  const fit = usable.filter((file) => size(file.width) && size(file.width) <= VIDEO_MAX_WIDTH)
  const widest = fit.sort((a, b) => size(b.width) - size(a.width))[0]
  return text((widest || usable[0])?.link, 400)
}

function photoRow(photo) {
  const id = text(photo?.id, 40)
  const who = text(photo?.photographer, 80) || 'an unnamed photographer'
  return {
    id,
    label: text(photo?.alt, 120) || `Photo by ${who}`,
    detail: [who, `${size(photo?.width)}×${size(photo?.height)}`, `pexels.com/photo/${id}`].join(' · '),
    url: text(photo?.src?.large2x || photo?.src?.original || photo?.url, 400),
  }
}

function videoRow(video) {
  const id = text(video?.id, 40)
  const who = text(video?.user?.name, 80) || 'an unnamed user'
  const page = text(video?.url, 400)
  /* A video whose page address is all Pexels gave us is still one row: the label
     says whose it is, and the tail of the address is the only title there is. */
  const name = text(page.split('/').filter(Boolean).pop(), 120)
  const duration = size(video?.duration)
  const detail = [who, `${size(video?.width)}×${size(video?.height)}`]
  if (duration) detail.push(`${duration}s`)
  if (page) detail.push(page)
  return {
    id,
    label: video?.user?.name ? `Video by ${who}` : name || `Video ${id}`,
    detail: detail.join(' · '),
    url: bestVideoFile(video?.video_files),
  }
}

module.exports = {
  ROW_CEILING,
  text,
  bestVideoFile,
  photoById,
  photoRow,
  searchPhotos,
  searchVideos,
  videoRow,
}
