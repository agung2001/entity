/**
 * The YouTube connector: one channel’s videos, read by `@youtube:<query>`.
 *
 * **This file is the connector's descriptor**: the row id, the resolver kind, the
 * mention head and the catalog entry the roster and composer read, in one place. The
 * registry (`../registry.cjs`) derives its maps from here, and the catalog assembles
 * itself from the registry — so a connector is added by creating this folder, not by
 * editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its keys are already names here: `verify` on a catalog entry is the *command*
 * a page may print, while `verify` on this descriptor is the function a pasted key has
 * to pass.
 */
module.exports = {
  id: 'youtube',
  resolver: 'youtube',
  mention: 'youtube',
  suffix: 'Youtube',
  account: true,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'YouTube',
      kind: 'rest',
      oauth: true,
      verify: null,
      summary: 'Channels and captions.',
      work: {
        mention: '@youtube:',
        resolves: 'videos in the account you name, or a search as every connected account with `all`',
        syntax: '@youtube:<account|all>:<query>',
        examples: ['@youtube:studio:captions', '@youtube:all:deploy pipeline'],
        returns: 'the matching videos — title, channel, published date, and a link',
        resolver: 'youtube',
        needs: 'one signed-in YouTube account on this machine',
        page: '',
        how: [
          'The scope comes first and is required, and decides whose grant the call runs as.',
          'That matters most for uploads and private videos, where the channel is part of the answer.',
          '`@youtube:all:` searches as every connected account in turn.',
          'A read tier lists videos; the write and full tiers are what allow uploading.',
        ],
        samples: [
          { code: '@youtube:studio:captions', then: 'that account\'s own channel data' },
          { code: '@youtube:studio:deploy pipeline', then: 'videos matching that phrase, as that account' },
        ],
  },
  },
}
