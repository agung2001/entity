[← Connectors](../connectors.md)

# Threads

The last 30 days of one Threads account: its posts, the counts beside them, and the
replies waiting underneath. A `rest` row with a **paste-once token** — no consent
screen, no account list, nothing to refresh — read through the Graph API, and read-only
in every direction.

## The mention

`@threads:[posts|replies|insights:]<query|post-id>`

| you write | you get |
| --- | --- |
| `@threads:posts` | the last 30 days of posts, each with its views, likes, replies and reposts |
| `@threads:insights` | the 30-day totals and the three rates |
| `@threads:replies` | the replies under the newest few posts |
| `@threads:replies:1789012345678901` | the replies under one post |
| `@threads:launch week` | the posts whose text holds both words |

Three readers, one read. The window is the last 30 days, filtered here rather than by
the endpoint, so a total about a month does not depend on a parameter every version of
the API honours. A first word that is not one of the three reader words is not an error
— it is a filter over the post text, because the likeliest thing to type after the
colon is a word from a post.

`replies` walks the reply tree to five levels, as the reference implementation does, and
caps its requests per call: the API allows roughly 250 an hour, and one busy thread must
not spend the whole hour. Without a post id it reads only the newest few posts for the
same reason.

A post whose counts could not be read is left out of the totals instead of counting as
zero, and a window where no post answered is a refusal with a sentence rather than an
empty table.

**Read-only.** Every call is a `GET`: nothing here posts, replies or deletes.

## The token

One **long-lived Threads access token**, pasted once on the connector's page. It is
proved there against `GET /me?fields=id,username` before it is written, so a token that
cannot name its own user never reaches the file, and no page ever reads it back — only
its last four characters are shown, which is enough to recognise which token is in place
and not enough to use it.

A long-lived token lasts about **60 days**. There is no refresh here: when it lapses,
paste a fresh one on the same page. The tab says the token is missing rather than
printing a month of zeroes.

The credential shape is the one Clockify established: `credential: 'token'`, no OAuth
provider row, no scope tier. There is no consent screen to run and no per-account row to
keep, because there is one Threads account per install.

## Where the credential lives

`~/.entity/connector-tokens.json`, written `0600` and atomically, beside
`oauth-secrets.json` in the same root. It is **never synced**: a teammate who opens the
same workspace sees the connector row, no token, and pastes their own. Only a hint is
read back.

→ [Connectors](../connectors.md) — the roster, the tiers and the consent round-trip
