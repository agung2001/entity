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
  readme-features/
    chat.webp                chat.poster.jpg
    entity.webp              entity.poster.jpg
    …
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

In the README each demo is also a link to the page that explains it:

```html
<a href="docs/conversations.md"><picture>…</picture></a>
```

Alt text describes **what the animation shows**, not "screenshot of the app" — it is
the only version a screen reader gets.

## Recording one

Every demo in this repository was recorded from a **throwaway profile**, not from a
real one. `scripts/demo-profile.mjs` seeds it with invented content — a letterpress
studio, a bakery, a travel notebook — under its own `HOME`, so there is no account,
no `~/.ssh/config`, no token and no real path on screen even by accident. It also
writes a two-line `~/.ssh/config` with fake hosts, because the machines page reads
aliases from there.

```bash
node scripts/demo-profile.mjs --force            # → /tmp/entity-demo
HOME=/tmp/entity-demo ENTITY_HOME=/tmp/entity-demo/.entity \
  VITE_DEV_PORT=5299 npm run dev                 # sign in: studio@northwind.example
node scripts/record-demos.mjs --url http://localhost:5299 [--only chat,mcp]
```

`record-demos.mjs` drives the real interface with Playwright (hover, open, fold — one
interaction per clip, ~6 s each) and writes `.tmp/demo-clips/<name>.webm`. Then:

```bash
npm run media:encode -- .tmp/demo-clips/chat.webm chat
```

The interface prints `os.hostname()` in the composer and on the machines page. The
recorder is started with a tiny `NODE_OPTIONS=--require …` stub that answers
`studio-mini`, which is why those screenshots show a demo machine rather than the
recorder's laptop.

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

One command does the same thing, and writes the poster from a settled frame:

```bash
npm run media:encode -- recording.mov chat             # → features/chat.webp + poster
npm run media:encode -- recording.mov readme-hero --hero  # → assets/readme-hero.webp
```

A clip longer than twelve seconds is trimmed to twelve, so a stalled interaction
cannot turn into a 6 MB loop.

`ffmpeg` needs the `libwebp_anim` encoder (Homebrew's build has it). If a recording is
replaced, re-run the encoder; if only the poster is missing, `npm run media:posters`.

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
