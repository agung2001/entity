[← README](../../README.md)

# README media

Every demo in the README and in `docs/` is one **animated WebP** plus a **poster
JPEG** beside it. The animation shows the real interface moving; the poster is the
still a client falls back to when it cannot play it.

A still screenshot has nothing to fall back from, so it ships as the **`.webp` alone** —
no poster, no `<picture>`, just an `<img>` pointing at the file.

```
docs/assets/
  readme-hero.webp           readme-hero.poster.jpg
  entity-logo.webp           entity-logo.poster.jpg
  icon.svg                   the still mark, when an SVG is wanted
  readme-features/
    chat.webp                chat.poster.jpg
    entity.webp              entity.poster.jpg
    …
  onboarding/
    step-1-name.webp         stills: the webp alone
  connectors/
    gmail.webp               one still per connector page, beside its svg
    gmail.svg
```

## The markup

For an animation, always ship the pair, and let `<picture>` pick the animation. A bare
`<img>` pointing at the `.webp` works in most browsers but shows nothing at all where
animated WebP is not supported, which is why the poster is the `img` and the animation
is the `source`.

```html
<picture>
  <source srcset="docs/assets/readme-features/chat.webp" type="image/webp" />
  <img src="docs/assets/readme-features/chat.poster.jpg" alt="A launch note answer
  with an attached brief and three follow-ups" width="820" />
</picture>
```

A still is a plain `<img>`, and the alt text carries the whole description:

```html
<img src="assets/onboarding/step-1-name.webp" alt="Step 1 of the wizard: a Workspace
name field with the live folder preview under it" width="820" />
```

The title mark follows the same rule at 64 px. It is small enough that the hop is a
detail, not a performance:

```html
<picture>
  <source srcset="docs/assets/entity-logo.webp" type="image/webp" />
  <img src="docs/assets/entity-logo.poster.jpg" alt="Entity" width="64" />
</picture>
```

In the README each demo is also a link to the page that explains it:

```html
<a href="docs/conversations.md"><picture>…</picture></a>
```

Alt text describes **what the animation shows**, not "screenshot of the app" — it is
the only version a screen reader gets.

## Recording one

Every demo in this repository was recorded from a **throwaway profile**, not from a
real one. `npm run demo` seeds it with invented content — a letterpress studio, a
bakery, a travel notebook — under its own `HOME` and serves the app against it: no
account, no `~/.ssh/config`, no token and no real path on screen even by accident.
It writes an invented `~/.ssh/config` into that scratch home, because the machines
page reads aliases from there, and it names the machine itself, so no frame carries
the recorder's hostname.

One terminal serves, the other records:

```bash
npm run demo                                     # seeds .tmp/demo/ and serves it
npm run media:record [--only chat,mcp]           # → .tmp/demo-clips/<name>.webm
```

`npm run demo` prints the profile, the URL and the credentials as `[demo]` lines, and
stays in the foreground until Ctrl-C. `record-demos.mjs` drives the real interface
with Playwright (hover, open, fold — one interaction per clip, ~6 s each). Then:

```bash
npm run media:encode -- .tmp/demo-clips/chat.webm chat
```

`record-demos.mjs` signs in with the demo account `studio@northwind.example`, or with
the **Continue as owner** button when the profile already finished first run.

For a still, no browser window needed: `npm run demo -- --screenshot machines` writes
one settled `.tmp/demo-shots/machines.png` and exits. To drive the interface yourself,
point Playwright at the printed `[demo] url` — it is already signed-in ready, and the
`[demo] email` / `[demo] password` lines are the account it holds.

### Recording by hand

Record the window, not the whole screen: no cursor jitter, no desktop, no second app.
6–10 seconds is a demo; 30 seconds is a video, and a README is not a video.

macOS, built in:

```bash
screencapture -v -k -o recording.mov     # ⌘⇧5 also works, "Record Selected Portion"
```

Rules that keep the loop readable:

- one interaction per clip — open a room, send a prompt, open a panel;
- start on a settled frame, end on the result, and trim the first and last 300 ms;
- 1440 px wide at most; the encoder scales down and never up;
- no audio (there is none in these assets by contract);
- no real credentials, tokens, customer names or personal paths on screen — use the
  demo profile, which is seeded for exactly this.

## Encoding

```bash
ffmpeg -i recording.mov \
  -vf "fps=12,scale='min(1440,iw)':-2:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -q:v 72 -loop 0 -an -f webp \
  docs/assets/readme-features/chat.webp
```

One command does the same thing, and writes the poster from a settled frame halfway
through the clip:

```bash
npm run media:encode -- recording.mov chat             # → features/chat.webp + poster
npm run media:encode -- recording.mov readme-hero --hero  # → assets/readme-hero.webp
```

A screenshot takes the same verb and produces a still instead, because the input is a
PNG: no poster and no `libwebp_anim`, so `media:check` never asks for a pair it should not
have. This is how the per-connector pages get their picture:

```bash
npm run demo -- --port 5299 --screenshot connector-gmail
npm run media:encode -- .tmp/demo-shots/connector-gmail.png connectors/gmail
```

A connector still is captured **to the page's own height**, not to the 1440 × 1000 frame
the README clips use: the page is the subject, so cutting the card off at the fold would
hide the half the document explains.

A clip whose middle is still moving — the hero scrolls — can name its poster frame
instead, so the fallback is the frame you meant:

```bash
npm run media:encode -- .tmp/demo-clips/readme-hero.webm readme-hero --hero --poster 1.2
```

A clip longer than twelve seconds is trimmed to twelve, so a stalled interaction
cannot turn into a 6 MB loop.

`ffmpeg` needs the `libwebp_anim` encoder (Homebrew's build has it). If a recording is
replaced, re-run the encoder; if only the poster is missing, `npm run media:posters`.

## The logo

The mark at the top of the README is not a screen recording and not `icon.svg` wearing
a CSS class. `scripts/logo-animation.mjs` draws the same 9 × 9 squircle as
`icon.svg`, wraps it in the app's own brand motion — a breath, a hard two-step blink
and a squash-and-stretch hop — and steps that timeline one frame at a time in Chrome,
so the loop is deterministic instead of whatever the recorder caught.

```bash
npm run media:logo        # → assets/entity-logo.webp + poster (6 s, 12 fps)
```

`icon.svg` stays the still: the same drawing without motion, and the file to reach for
when an SVG is wanted (the app's own favicon is a copy in `public/`). The poster is the
first frame on the tile's own cream, so the rounded corners do not turn black in a JPEG.

## Budgets and the check

| asset | budget | why |
| --- | --- | --- |
| animated `.webp` | ~2 MB, aim for 400 KB | a README can load a dozen of them |
| `.poster.jpg` | 220 KB | it is a fallback, not the feature |

```bash
npm run media:posters     # build any missing poster for an animated webp
npm run media:check       # every referenced asset exists, is paired when animated, fits the budget
```

`media:check` also prints `is a still — record it for a demo` for every screenshot that
has not been recorded yet. That line is the to-do list, not an error.

## Related

- [Credits](../credits.md)
- [`DESIGN.md`](../../DESIGN.md) — the interface the recordings show
