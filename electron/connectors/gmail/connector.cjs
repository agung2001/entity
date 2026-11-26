/**
 * The Gmail connector: one mailbox, read by `@gmail:<query>`.
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
  id: 'gmail',
  resolver: 'gmail',
  mention: 'gmail',
  suffix: 'Gmail',
  account: true,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Gmail',
      kind: 'rest',
      oauth: true,
      verify: null,
      summary: 'Mail an agent may read.',
      work: {
        mention: '@gmail:',
        resolves: 'messages in the mailbox you name, or in every connected mailbox with `all`',
        syntax: '@gmail:<account|all>:<query>',
        examples: ['@gmail:all:from:stripe', '@gmail:work:invoice march'],
        returns: 'the matching messages — subject, sender, date, and which mailbox they came from',
        resolver: 'gmail',
        needs: 'one signed-in Gmail account on this machine',
        page: '',
        how: [
          'The scope comes first, and it is required: `@gmail:work:` is one mailbox, `@gmail:all:` is every usable one.',
          'The account is the localpart of the address, as the card shows it — `@gmail:avery:` for `avery@example.test`.',
          'There is no implicit “no scope means all”: that is what made the first word ambiguous. Write `all` and mean it.',
          'The query is the rest of that line, so it may hold spaces and Gmail\'s own operators (`from:`, `has:attachment`).',
          'Wrap words in quotes to search them as one phrase — `"invoice march"` instead of two loose words. Picking a result inserts the phrase for you.',
          'Put the instruction on the next line — the query stops at the newline, so it is not sent to Google as search text.',
          'A word that is not one of your accounts is an error, not a search — so a typo cannot quietly read the wrong mailbox.',
          'An account whose sign-in expired is skipped, not failed — the note names it.',
        ],
        samples: [
          { code: '@gmail:avery:from:stripe', then: 'Stripe mail in that one mailbox' },
          { code: '@gmail:all:invoice march', then: 'every connected mailbox, and the note says how many answered' },
        ],
  },
  },
}
