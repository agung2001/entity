/**
 * Reddit, as one subreddit publishes it.
 *
 * A subreddit is not a setting, it is the address: every listing on Reddit answers
 * `.rss`, so `https://www.reddit.com/r/<name>/hot.rss` is the whole of it. `r/indonesia`
 * is where this ships, not what it is — `/r/worldnews/`, `/r/technology/`, a small
 * local subreddit: the same feed, another address, edited on the connector page.
 *
 * Whatever the name, this row fills **General**: `www.reddit.com` is not
 * `trends.google.com`, so `news-store`'s `isTrends()` sends its rows to the news tab.
 * Nothing about it is special-cased in the fetcher — it goes through the same 8 s /
 * 512 kB / HTML-refused path as a feed somebody pasted.
 */
module.exports = {
  id: 'reddit',

  entry: {
    label: 'Reddit',
    kind: 'rss',
    url: 'https://www.reddit.com/r/indonesia/hot.rss',
    website: 'https://www.reddit.com/r/indonesia',
    verify: null,
    summary: 'One subreddit’s front page. Starts on r/indonesia; the `/r/` in its address is the subreddit.',
  },
}
