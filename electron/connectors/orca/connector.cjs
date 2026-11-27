/**
 * The Orca connector: the projects and worktrees Orca already manages on this
 * machine, as real paths.
 *
 * **This file is the connector's descriptor**: the row id, the resolver kind, the
 * mention head and the catalog entry the roster and composer read, in one place.
 * The registry (`../registry.cjs`) derives its maps from here, and the catalog
 * assembles itself from the registry — so a connector is added by creating this
 * folder, not by editing four tables.
 *
 * `path.cjs` beside this file is the CLI's resolution (app bundle, `~/.local/bin`,
 * `ENTITY_ORCA_BIN`), and `mention.cjs` is everything that spawns it. All three
 * live here because they are one fact: where Orca is, what it says, and what a
 * person may type to read that.
 *
 * There is no dashboard tab and no call of its own. The switch, the probe and the
 * row live on the Connectors page, which already reads the three machine-wide
 * integrations — a second surface would be a second answer to the same question.
 */
module.exports = {
  id: 'orca',
  resolver: 'orca',
  mention: 'orca',
  suffix: 'Orca',
  account: false,

  mentionModule: () => require('./mention.cjs'),

  /* The binary's own two verbs, in `dashboard.cjs` because that is where the
     registry's contract puts a connector's calls (there is no tab here — the
     connector's page draws its own card). `rpc.cjs` spreads this table, so neither
     the call table nor the page has to know Orca's name. */
  calls: {
    'orca.path': () => require('./dashboard.cjs').path(),
    'orca.setPath': (args) => require('./dashboard.cjs').setPath(args),
  },

  entry: {
    label: 'Orca',
    kind: 'cli',
    binary: 'orca',
    summary: 'Projects and worktrees Orca already manages on this machine.',
    /* what `Test connection` runs, and what makes the row say `found` */
    verify: { argv: ['--version'], okExit: 0, then: ['repo', 'list', '--json'] },
    work: {
      mention: '@orca:',
      resolves: 'a project on this machine, and optionally one file inside it',
      syntax: '@orca:<project>[:<path>]',
      examples: ['@orca:entity', '@orca:entity:src/main.js'],
      returns: 'the project’s real path, or one file inside it — so the entity reads the file, not a guess',
      resolver: 'orca',
      needs: 'the Orca CLI on this machine — found automatically, or named on this page',
      page: '',
      /* The long form: what to type, what it becomes, and why that is useful.
         Rendered on the page, so a person learns the syntax without reading code. */
      how: [
        'Orca keeps a project for every repository it manages, with a real path on this machine.',
        'Naming a project puts that path in the prompt, so the entity opens the right folder instead of guessing one.',
        'Naming a file inside it narrows the turn to that one file — useful when you already know where the bug is.',
        'The entity then reads the file with its own tools; Entity only tells it where the file is.',
        'While the connector is off nothing here runs — no project list, no worktree read — and an `@orca:` line is refused rather than sent without it.',
        'A binary that is not in the usual place is named on this page instead of being exported into the app\'s environment.',
      ],
      samples: [
        { code: '@orca:entity', then: 'the entity project’s path goes into the prompt' },
        { code: '@orca:entity:src/main.js', then: 'that one file, so the turn starts at the bug' },
      ],
    },
  },
}
