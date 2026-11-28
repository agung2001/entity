[← Connectors](../connectors.md)

# Pexels

Free photos and video clips, as **files an agent can use**. Pexels is a library rather
than an account: nothing is configured beyond one pasted API key, there is no dashboard
tab, and a mention answers a search rather than a report.

## The mention

`@pexels:[videos:|id:]<query>`

| you write | you get |
| --- | --- |
| `@pexels:mountains at sunrise` | the matching photos, each with a direct image URL |
| `@pexels:videos:ocean waves` | the matching clips, each with the best file link |

The whole line is the search, spaces included.

`videos` (or `video`) asks the video index. `photos` and `photo` are accepted and mean the
default, so a word typed out of habit is not searched for as text. `id` takes one photo by
the id in its own address — `@pexels:id:1234567` — and a line that is not a number is read
as a search instead, because a request for a photo called "white sand" answers 404 and
reads as a bug.

Each row's **URL is the file**, not `pexels.com/photo/…`: `src.large2x` for a photo, and
the widest `video_files` link no wider than 1920 px for a clip. An agent handed a page link
fetches HTML and guesses; one handed the file URL can look at the picture. The page address
rides in the row's detail line, for the person reading the card.

## Where the credential lives

One API key, pasted once on the connector's page and **checked there** before it is saved:
the check is a real search (`?query=nature&per_page=1`), so a key Pexels refuses never
reaches the file. It lives in `~/.entity/connector-tokens.json`, `0600`, atomic, beside
`oauth-secrets.json` — the vault for the credentials that never refresh. A page learns
`{ configured, hint }` and the hint is the last four characters; the key itself travels in
`Authorization` (no `Bearer`) and appears in no row, note, error or log line.

## The limits, and what a rejection looks like

One key gets **200 requests an hour and 20 000 a month**, and that is the whole budget — so
the composer's suggestion menu offers the two reader words and never spends a request. A
search that runs out says so rather than retrying:

> Pexels has spent this key's rate limit — 200 requests an hour and 20 000 a month are the
> whole budget. Try again later.

A key Pexels will not accept is refused in one sentence, on save and in a turn alike:

> Pexels rejected the API key — paste a fresh one on the connector's page.

→ [Connectors](../connectors.md) — the roster, the tiers and the two vaults
→ [Security](../security.md) — the trust boundary, and where a credential may sit
