/**
 * The Google Drive connector: one account’s files, read by `@drive:<query>`.
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
  id: 'google-drive',
  resolver: 'drive',
  mention: 'drive',
  suffix: 'Drive',
  account: true,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Google Drive',
      kind: 'rest',
      oauth: true,
      verify: null,
      summary: 'Files an agent may open.',
      work: {
        mention: '@drive:',
        resolves: 'files in the Drive you name, or in every connected Drive with `all`',
        syntax: '@drive:<account|all>:<query>',
        examples: ['@drive:all:Q3 report', '@drive:work:budget'],
        returns: 'the matching files — name, type, modified date, and a link',
        resolver: 'drive',
        needs: 'one signed-in Drive account on this machine',
        page: '',
        how: [
          'The scope comes first and is required: `@drive:work:` is that account\'s Drive, `@drive:all:` is every connected one.',
          'The query is the rest of the line, so it may hold spaces; the instruction goes on the next line.',
          'Quotes make a phrase: `"Q3 report"` searches that sequence rather than the words separately.',
          'Plain words are ANDed across file names and contents — `Q3 report bergstrom` needs all three.',
          'A quoted phrase stays a phrase: `"Q3 report"` searches that sequence, not the two words separately.',
          'Drive\'s own query language also works: `mimeType = \'application/pdf\'`, `modifiedTime > 2025-01-01`, `trashed = false`.',
          'Folder names are matched as part of a file\'s path, not searched on their own.',
          'A word that is not one of your accounts is an error, not a search.',
          'A read scope only reaches files this app created; full access reaches the whole Drive.',
        ],
        samples: [
          { code: '@drive:work:Q3 report', then: 'files needing all three words, in that one Drive' },
          { code: '@drive:all:"Q3 report"', then: 'every connected Drive, matching that exact phrase' },
        ],
  },
  },
}
