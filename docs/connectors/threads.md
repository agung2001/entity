[← Connectors](../connectors.md)

# Threads

The last 30 days of a Threads account — its posts, the counts beside them, and the
replies waiting underneath. **One account per row, several rows per connector**, the
same shape `@x:` and `@fitbit:` take; the credential is **pasted** rather than
consented, and every read is a GET.

## The mention

`@threads:<account|all>:[posts|replies|insights:]<query|post-id>`

| you write | you get |
| --- | --- |
| `@threads:all:posts` | the last 30 days of every account, each post with its views, likes, replies and reposts |
| `@threads:avery:insights` | one account's 30-day totals and the three rates |
| `@threads:all:replies` | the replies under each account's newest few posts |
| `@threads:avery:replies:1789012345678901` | the replies under one post |
| `@threads:all:launch week` | the posts whose text holds both words |

The scope is first and **required**: `all`, or a username. A word that is not an
account here is an error that names the accounts that exist, so a typo cannot quietly
read the wrong audience.

A reader word picks the shape — `posts` (the default), `insights` or `replies` — and a
first word that is not one of the three is a filter over the post text, because the
likeliest thing to type there is a word from a post.

`insights` groups by metric, not by account: `@threads:all:insights` is eight lines
with each account's own figure beside the number, not twenty-four lines that spend the
row ceiling on the first account.

`replies` walks the reply tree to five levels, as the reference implementation does,
and caps its requests per post: the API allows roughly 250 calls an hour, and one busy
thread must not spend the whole hour. Without a post id it reads only the newest few
posts per account, for the same reason.

A post whose counts could not be read is left out of the totals instead of counting as
zero, and a window where no post answered is a refusal with a sentence rather than an
empty table.

**Read-only.** Every call is a `GET`: nothing here posts, replies or deletes.

## The token

Threads is the one provider whose account is added by **pasting a token**, not by a
consent screen: Meta's Threads API has no per-install loopback redirect this app can
register, and the token a person already holds — the one their own cron keeps
refreshed — is a long-lived one. So the accounts card asks for it directly.

It is proved against `GET /me?fields=id,username` before anything is written. The
username that comes back names the row (`<username>@threads`), so a mistyped name
cannot point two rows at one account, and no page ever reads the token back.

There are two ways in:

- **A long-lived token** (about 60 days) — paste it and nothing else. This is what an
  existing cron setup holds.
- **A short-lived token** plus the **app secret** — the secret upgrades it to 60 days
  with `?grant_type=th_exchange_token`. The secret is used once and **not stored**:
  a long-lived token renews itself with the token alone, so a second secret on this
  machine would be one more thing to leak for no gain.

Refreshing is a GET with the token alone (`?grant_type=th_refresh_token`) and needs no
app id, no app secret and no browser. The app does it before a read when the stored
deadline has passed, which both extends the grant and keeps the token from lapsing.
An **app id is not used anywhere**: the short→long exchange takes the app secret only,
and the refresh takes neither.

Each account keeps its own token, so refreshing one account never touches another —
and a token refreshed here is independent of the one a cron keeps in its own env file.
Re-paste if Threads refuses a token.

## Where the credential lives

`~/.entity/oauth-accounts.json` for the rows a page reads (name, username, status,
when it last answered), and `oauth-secrets.json` beside it, `0600`, for the token.
Neither is synced: a teammate who opens the same workspace sees the connector row, no
accounts, and pastes their own. Only a hint is ever read back.

→ [Connectors](../connectors.md) — the roster, the tiers and the consent round-trip
