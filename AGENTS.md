# AGENTS.md

Working notes for anyone — human or agent — changing this repository.

## Read `DESIGN.md` first

[`DESIGN.md`](DESIGN.md) is the interface contract: how dialogs are dismissed,
where keyboard shortcuts live, which mistakes have already been paid for, and
the checklist for adding a surface or a key. **Read it before any UI change**,
and update it when you find a new class of bug.

The two rules that come up most often:

1. **`Esc` closes every dismissible surface.** Use
   `useDialogDismiss()` from `src/composables/useDialog.js`; never
   `@keydown.esc`, never a per-component window listener.
2. **Shortcuts live in `src/lib/shortcuts.js`.** Render hints with
   `shortcutLabel()`, match with `matchesShortcut()`, and the top-bar guide
   updates itself. No literal `⌘…` / `Ctrl…` in a component.

`npm test` runs those two rules as a static contract
(`tests/unit/ui-contract.test.cjs`) in addition to the unit tests.

## The app in one paragraph

Entity is a Vue 3 + Vite renderer inside an Electron shell. An **entity** is a
Markdown file in a workspace; a **workspace** is a directory under
`~/.entity/workspaces/<id>/`; a turn is a real harness process (`claude`,
`codex`, `gemini`, `opencode`, `pi`) started by the main process. The renderer
never touches `fs`: every local read and write goes through the one call table
in `electron/rpc.cjs` (IPC in Electron, `POST /__entity/call` in the dev
server). Keep it that way when adding a feature.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Renderer only, in a browser at http://localhost:5183 |
| `npm run dev:desktop` | Vite + Electron with HMR |
| `npm test` | Unit tests + the UI contract above (`tests/unit/`) |
| `npm run test:smoke` | Playwright smoke pack, including real `opencode` and `pi` turns |
| `npm run test:regression` | Playwright regression pack |
| `npm run test:e2e` | Both Playwright packs |
| `npm run test:gate` | Unit + smoke — the release gate |
| `npm run build` | Renderer build into `dist/` |
| `npm run package` | electron-builder distributable |

Use `ENTITY_HOME=/tmp/…` for a scratch profile when testing, so real workspaces
are never touched.

## Do not commit or push without an explicit go-ahead

An implementation request is **not** permission to publish it.

1. Make the change locally, run the relevant tests/build, and stop.
2. Do **not** `git commit`, `git push`, amend, rebase, tag, or trigger a deploy
   until the user explicitly says to do so **after testing it manually**.
3. Report the changed files, what was tested, and the exact manual-test steps.
4. Wait for the user's approval before any git or deployment action.

If a previous instruction said "commit and push", a later instruction to test
manually first wins.
