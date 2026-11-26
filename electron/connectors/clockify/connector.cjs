/**
 * The Clockify connector: tracked hours per project and per person, for one week.
 *
 * **This file is the connector's descriptor**: the row id, the mention head, the
 * catalog entry the roster and composer read, the two verbs the Dashboard tab asks
 * for, and the save-time check a pasted key has to pass. The registry
 * (`../registry.cjs`) derives its maps from here, and the catalog assembles itself
 * from the registry — so a connector is added by creating this folder, not by
 * editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its names are already used here: `verify` on a catalog entry is the *command*
 * a page may print, while `verify` on this descriptor is the function a key must pass.
 *
 * Three things are unusual about this connector, and each one is why a line of the
 * folder exists:
 *
 *   1. **The credential is one pasted key**, not an account. It lives in
 *      `connector-tokens.cjs` (`0600`), and `verify()` is what a save calls before
 *      writing, so a key that cannot read this workspace never reaches the file.
 *   2. **The workspace id, the IANA timezone and the member map are workspace
 *      state**, stored on the connector's index row under `fields` — they are not a
 *      secret and they travel with the workspace. Nothing here invents one.
 *   3. **No email ever leaves.** A Clockify workspace user list would carry one, and
 *      nothing in this folder calls it: the rows hold a user id, a display name, a
 *      login a person chose locally, and hours.
 */
const { text, addDays, summary, workspaceList } = require('./api.cjs')

module.exports = {
  id: 'clockify',
  resolver: 'clockify',
  mention: 'clockify',
  suffix: 'Clockify',
  account: false,
  dashboard: { call: 'connector.dashboard', mode: 'token', kind: 'clockify' },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Clockify',
      kind: 'rest',
      credential: 'token',
      website: 'https://clockify.me',
      summary: 'Tracked hours per project and per person.',
      verify: null,
      work: {
        mention: '@clockify:',
        resolves: 'the hours one project or one person logged in a week',
        syntax: '@clockify:<project|login>:<monday|this week>',
        examples: ['@clockify:design-system:this week', '@clockify:avery:2026-03-02'],
        returns: 'the week’s hours — the project and its members, or one member across every project, then the total and a day-by-day series',
        resolver: 'clockify',
        needs: 'an API key on this machine, and this workspace’s Clockify workspace id',
        page: 'connectors.json',
        how: [
          'The first segment is a project name or a member login — one of the two, never both. A word that is neither is an error, so a typo cannot quietly report on the wrong thing.',
          'The second segment is the week: a Monday written `YYYY-MM-DD`, or `this week`. Leave it out and this week is read, in the workspace’s own timezone.',
          'A week that is not a real Monday, is in the future, or is older than 2020-01-06 is refused — a silently corrected range would answer about a week nobody asked for.',
          'The key is pasted once on the connector’s page and checked there against this workspace before it is saved. It never refreshes, and no page ever reads it back.',
          'Clockify answers 401 for both a bad key and an unknown workspace id, so a rejection names both possibilities rather than blaming the key.',
          'Only the reports API is read: no user list is fetched, so no email address ever reaches a turn.',
        ],
        samples: [
          { code: '@clockify:design-system:this week', then: 'that project’s hours, its members, and the week total' },
          { code: '@clockify:avery:2026-03-02', then: 'one member’s week, split by project' },
        ],
      },
  },

  /* The two verbs the tab and the Overview selector read, both read-only and both
     keeping the key on this side of the bridge. `connector.dashboard` keeps its
     historical name — Clockify was the first connector with a dashboard tab. */
  calls: {
    'connector.workspaces': ({ workspace } = {}) =>
      require('./dashboard.cjs').workspaces(require('../../workspace-store.cjs').open(workspace)),
    'connector.dashboard': ({ workspace, ...rest } = {}) =>
      require('./dashboard.cjs').dashboard(require('../../workspace-store.cjs').open(workspace), rest),
  },

  /**
   * The save-time check: one real one-day summary for today.
   *
   * `POST /reports/summary` and not `/user`, because `/user` ignores the workspace id
   * and would pass for a key pointed at the wrong workspace — the exact mistake this
   * check exists to catch.
   */
  async verify({ token, workspaceId } = {}) {
    const key = text(token, 400)
    const workspace = text(workspaceId, 60)
    if (!key) throw new Error('Paste a Clockify API key first.')
    if (!workspace) {
      /* An empty id is the state a fresh install is in, and it is the state the
         Overview selector exists to leave — so it is checked against the list that
         selector reads, not refused: a refusal here would need the list to prove the
         key, and the list to have a key. */
      await workspaceList(key)
      return { ok: true }
    }
    const day = new Date().toISOString().slice(0, 10)
    await summary(key, workspace, {
      dateRangeStart: `${day}T00:00:00.000Z`,
      dateRangeEnd: `${addDays(day, 1)}T00:00:00.000Z`,
      summaryFilter: { groups: ['PROJECT'] },
      pageSize: 1,
    })
    return { ok: true }
  },
}
