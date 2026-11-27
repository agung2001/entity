/**
 * Google Trends, as the feed Google publishes.
 *
 * The feed the News page's **Trends** tab reads, and the only source in this
 * product that prints a volume. Two facts make that true:
 *
 *   - the host is `trends.google.com`, which is what `news-store`'s `isTrends()`
 *     matches to split the Trends tab from General — so a workspace that installs
 *     this row gets a Trends tab, and one that does not gets the tab's empty state
 *     instead of somebody else's feed;
 *   - the country is the `geo=` in the address. `ID` is where this ships, not what
 *     it is: `?geo=US`, `?geo=GB`, `?geo=BR` are the same feed for another country,
 *     edited on the connector page's Feed card. Trends is not an Indonesian service,
 *     and a shipped row is a starting address rather than the only one.
 *
 * No resolver, no mention, no call, no account: a feed is a URL, and `news-store`
 * fetches it credentialless in the main process. The row is here so a workspace has
 * something to read on its first visit instead of an empty page that says where a
 * feed comes from.
 */
module.exports = {
  id: 'google-trends',

  entry: {
    label: 'Google Trends',
    kind: 'rss',
    url: 'https://trends.google.com/trending/rss?geo=ID',
    website: 'https://trends.google.com/trending?geo=ID',
    verify: null,
    summary: 'What one country is searching right now. Starts on Indonesia; the `geo=` in its address is the country.',
  },
}
