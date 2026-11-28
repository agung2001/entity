/**
 * `@pexels:[videos:|id:]<query>` — photos and video clips as files an agent can
 * use, from one pasted API key.
 *
 * The grammar is Open Design's with one addition: no reader word is a **photo
 * search**, and the two readers that exist change the endpoint rather than filter
 * it — `videos` asks the video index, `id` asks for one photo by the id its address
 * carries. So `@pexels:photo` and `@pexels:photos` are accepted and mean the
 * default, while a first word that is neither is part of the query, because
 * "videos of the sea" is a better search than a refusal.
 *
 * **`preview` never calls Pexels.** The composer asks on nearly every keystroke and
 * the key's whole budget is 200 requests an hour, so this menu is the two reader
 * words and nothing else. An empty menu is a cheaper failure than an exhausted key.
 */
const {
  ROW_CEILING,
  text,
  photoById,
  photoRow,
  searchPhotos,
  searchVideos,
  videoRow,
} = require('./api.cjs')

const tokenOf = () => require('../../connector-tokens.cjs').tokenFor('pexels')

/**
 * One answer: a photo search, a video search, or one photo by id.
 *
 * The query is required — a bare `@pexels:` would return whatever Pexels calls
 * popular, and rows nobody searched for read as an answer to the question that was
 * never asked.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  const reader = text(segment?.target, 20).toLowerCase()
  const query = text(segment?.query, 200)
  if (!query) {
    throw new Error('Pexels needs something to search for, e.g. @pexels:mountains or @pexels:videos:ocean')
  }
  const token = tokenOf()
  if (!token) {
    throw new Error('Pexels has no API key on this machine yet. Paste one on the connector’s page.')
  }

  if (reader === 'id') {
    const photo = await photoById(token, query)
    return photo ? [photoRow(photo)].slice(0, limit) : []
  }

  const perPage = Math.min(limit, ROW_CEILING)
  const rows =
    reader === 'videos' || reader === 'video'
      ? (await searchVideos(token, query, { perPage })).map(videoRow)
      : (await searchPhotos(token, query, { perPage })).map(photoRow)
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the two reader words, filtered by what has been
 * typed. Never throws, and never spends a request — a menu that costs API calls is
 * a menu that spends the hour, and a blank one under the cursor should be the worst
 * thing an expiring key does.
 */
async function preview(fields = [], { limit = 8 } = {}) {
  try {
    const said = String(fields?.[0] || '').trim().toLowerCase()
    const readers = [
      { word: 'videos', detail: 'video search — a direct file link per clip' },
      { word: 'id', detail: 'one photo, by the id in its address' },
    ]
    return readers
      .filter((reader) => !said || reader.word.startsWith(said))
      .slice(0, limit)
      .map((reader) => ({
        id: reader.word,
        label: `${reader.word}:`,
        detail: reader.detail,
        mention: `@pexels:${reader.word}:`,
      }))
  } catch {
    return []
  }
}

module.exports = { ROW_CEILING, resolve, preview }
