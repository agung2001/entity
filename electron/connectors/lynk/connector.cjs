/**
 * The Lynk.id connector: the store’s sales, read out of one Drive folder of
 * spreadsheets.
 *
 * **This file is the connector's descriptor**: the row id, the mention head (none —
 * this is a report, not a lookup) and the catalog entry the roster and composer read,
 * in one place. The registry (`../registry.cjs`) derives its maps from here, and the
 * catalog assembles itself from the registry — so a connector is added by creating
 * this folder, not by editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its keys are already names here: `verify` on a catalog entry is the *command*
 * a page may print, while `verify` on a descriptor is the function a pasted key has to
 * pass.
 */

/**
 * The settings the read layer needs, translated rather than forwarded.
 *
 * The row stores `sheetSuffix` (what the settings form writes); the read layer
 * destructures `suffix`, and `tabOf()` matches a tab with `endsWith(suffix)` — an empty
 * string matches every tab, so a forwarded-but-renamed key would sum every tab in
 * every spreadsheet instead of one.
 */
function fields(args) {
  const row = require('../../connector-store.cjs').fieldsOf({
    workspace: args?.workspace,
    id: args?.id || 'lynk',
  })
  return { folderId: row.folderId, suffix: row.sheetSuffix }
}

module.exports = {
  id: 'lynk',
  account: false,
  dashboard: { call: 'connector.lynkDashboard', mode: 'oauth', kind: 'lynk' },

  entry: {
      label: 'Lynk.id',
      kind: 'rest',
      oauth: true,
      website: 'https://lynk.id',
      summary:
        'What the store sold, read from the Google Sheets in one Drive folder — one spreadsheet per product, one ` - Transactions` tab each.',
      verify: null,
      work: {
        resolves:
          'the store\u2019s sales, walked out of the spreadsheets in the Drive folder this workspace picked',
        returns:
          'revenue, orders, buyers and a product table, for a chosen window, plus the month-by-month series',
        needs: 'a signed-in Google account with drive.readonly, and one Drive folder full of Lynk.id spreadsheets',
        page: 'connectors.json',
        how: [
          'The folder is the only setting. It lives on this workspace\u2019s connector row, so two workspaces may point at two different folders and neither report is a constant in the code.',
          'One spreadsheet per product, and the rows are read from the tab named by the suffix \u2014 ` - Transactions` unless this workspace changed it.',
          'A spreadsheet without that tab is counted in the folder and not read: a product that never sold is a fact, not a zero.',
          'Free rows stay in the table with `Rp 0`, because a product that took 238 orders and no money is a real result. Free orders are counted as orders, never as revenue.',
          'Revenue is the sheet\u2019s own price column, summed in rupiah. Nothing is converted and no currency is guessed.',
          '`drive.readonly` is what lets the folder be listed and its children opened. A grant without it refuses the read rather than answering an empty table.',
          'The answer is cached on this machine for six hours; re-reading is a button, not a side effect of visiting the tab.',
        ],
        samples: [],
      },
  },


  /* Read from the Drive folder this workspace picked. The folder and the tab suffix are
     never constants: they are read off the connector row on every call, so two
     workspaces may point at two folders and neither report can be the other’s. */
  calls: {
    'connector.lynkFolders': (args) => require('./dashboard.cjs').folders(args),
    'connector.lynkTestFolder': async (args) =>
      require('./dashboard.cjs').testFolder(await fields(args)),
    'connector.lynkDashboard': async (args) =>
      require('./dashboard.cjs').dashboard({
        workspace: args?.workspace,
        id: args?.id,
        days: args?.days,
        force: args?.force === true,
        ...(await fields(args)),
      }),
    'connector.lynkForget': () => {
      require('./dashboard.cjs').forgetCache()
      return { ok: true }
    },
    /* How far the read has got. Asked once a second while a folder is open, so a
       seventy-spreadsheet folder can say `Reading 34 of 70` instead of nothing at all.
       It reads no folder and spends no request. */
    'connector.lynkProgress': () => require('./dashboard.cjs').progressOf(),
  },
}
