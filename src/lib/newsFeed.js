/**
 * Which mark a feed wears, and which hue its card takes.
 *
 * The one place both news screens ask: a Google Trends feed is the `gt` family,
 * a Reddit feed the `rd`, and every other RSS or Atom URL is a plain feed with no
 * family of its own. `FeedMark.vue` turns the answer into a drawing and `news.css`
 * into a tint, so a name that is not here stays a plain feed in both.
 */
export const feedFamily = (feed) => {
  if (!feed) return undefined
  if (feed.trend) return 'gt'
  return /reddit/i.test(`${feed.label} ${feed.url}`) ? 'rd' : undefined
}
