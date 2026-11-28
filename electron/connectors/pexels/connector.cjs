/**
 * The Pexels connector: free photos and video clips, as files an agent can use.
 *
 * **This file is the connector's descriptor**: the row id, the resolver kind, the
 * mention head, the catalog entry the roster and composer read, and the save-time
 * check a pasted key has to pass. The registry (`../registry.cjs`) derives its maps
 * from here, and the catalog assembles itself from the registry — so a connector is
 * added by creating this folder, not by editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its names are already used here: `verify` on a catalog entry is the
 * *command* a page may print, while `verify` on this descriptor is the function a
 * key must pass.
 *
 * Two things are unusual, and each one is why a line of the folder exists:
 *
 *   1. **The credential is one pasted key**, like Clockify's — `connector-tokens.cjs`
 *      (`0600`), checked on save so a key Pexels refuses never reaches the file.
 *      There is no account, so there is no per-account row and no dashboard tab.
 *   2. **A row is a file URL, not a page URL.** `src.large2x` for a photo and one
 *      `video_files` link for a clip, because an agent's prompt needs the picture.
 *      `detail` carries the page address for the person reading the card.
 */
const { text, searchPhotos } = require('./api.cjs')

module.exports = {
  id: 'pexels',
  resolver: 'pexels',
  mention: 'pexels',
  suffix: 'Pexels',
  account: false,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Pexels',
      kind: 'rest',
      credential: 'token',
      website: 'https://www.pexels.com',
      summary: 'Free photos and video clips, as files an agent can use.',
      verify: null,
      work: {
        mention: '@pexels:',
        resolves: 'photos and video clips for a search, or one photo by its id',
        syntax: '@pexels:[videos:]<query>',
        examples: ['@pexels:mountains at sunrise', '@pexels:videos:ocean waves'],
        returns: 'the matching photos or clips — a label, who shot it, its size, and a direct file URL an agent can read or download',
        resolver: 'pexels',
        needs: 'an API key on this machine',
        page: 'connectors.json',
        how: [
          'The whole line is the search: `@pexels:mountains` or `@pexels:mountains at sunrise`, spaces included.',
          'A first word of `videos` (or `video`) asks the video index; `photos` and `photo` mean the default, so a word typed out of habit is not searched for.',
          '`id` takes one photo by the id in its own address — `@pexels:id:1234567` — and any line that is not a number there is read as a search instead.',
          'Each row’s URL is the file itself, not `pexels.com/photo/…`: an agent that is handed a page link fetches HTML and guesses, and one handed `src.large2x` can see the picture.',
          'The key is pasted once on the connector’s page and checked there before it is saved. It never refreshes, and no page ever reads it back.',
          'Pexels allows 200 requests an hour and 20 000 a month for one key, so the composer’s suggestion menu offers the two reader words and never spends a request.',
        ],
        samples: [
          { code: '@pexels:mountains at sunrise', then: 'the matching photos, each with its own file URL' },
          { code: '@pexels:videos:ocean waves', then: 'the matching clips, each with the best file link' },
        ],
      },
  },

  /**
   * The save-time check: one real search, one result.
   *
   * A search rather than anything heavier because it is the call every mention
   * makes — a key that passes here is a key that answers a search, which is the
   * only thing this connector does.
   */
  async verify({ token } = {}) {
    const key = text(token, 400)
    if (!key) throw new Error('Paste a Pexels API key first.')
    await searchPhotos(key, 'nature', { perPage: 1 })
    return { ok: true }
  },
}
