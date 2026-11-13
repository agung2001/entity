# DESIGN.md — interface rules

This is the reference for anything that touches the interface: dialogs,
popovers, keyboard handling, the top bar, the composer. It exists because the
same two mistakes kept coming back:

1. a modal that only closes with the X button or the scrim, so `Esc` does
   nothing when focus is anywhere else;
2. a shortcut typed into a component instead of registered once, so the hint
   drifts from the handler and never appears in the guide.

Read this before adding a surface or a key. When a new class of mistake is
found, add it to **Common mistakes** below — that is how this file stays
useful. The rules that can be checked mechanically are enforced by
`electron/ui-contract.test.cjs` (`npm test`).

## Two non-negotiables

### 1. Every dismissible surface closes on `Esc`

A modal, a drawer, a popover, a zoom overlay, a jump card, the keyboard guide —
if a person can dismiss it, `Esc` must do the same thing the scrim or the X
button does. Not a different thing: the *same close function*, so both paths
reset the same state.

Use the shared stack, never a local key listener:

```js
import { useDialogDismiss } from '@/composables/useDialog'

useDialogDismiss({
  active: () => open.value,   // a ref or a getter
  close: () => emit('close'), // same function the scrim calls
  guard: () => busy.value,    // optional: ignore Esc while a request is in flight
})
```

`src/composables/useDialog.js` keeps **one** window keydown listener and a
stack of open surfaces. Whatever opened last closes first: a picker inside a
dialog closes before the dialog; a dialog closes before the page behind it.
Every surface registers itself — dialogs, `PickMenu`, `ModelInput`,
`MarkPicker`, the artifact zoom, the thread minimap card. Components that
render a popover *inside* a dialog must register, or the dialog will close
under the popover.

**Do not** put `@keydown.esc` on the modal element. It only fires while focus is
inside that element, which is exactly the bug this file was written for.
**Do not** add a per-component `document.addEventListener('keydown')` for
Escape; two layers then fight, or close together.

### 2. Every shortcut lives in one catalog

`src/lib/shortcuts.js` is the single source. It holds the action id, the label,
the description, and the two combo variants (desktop app / browser tab). The
top-bar guide (`ShortcutsDialog.vue`) renders this list and nothing else.

```js
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'

if (matchesShortcut('rail', event)) { /* ... */ }   // handler
const hint = shortcutLabel('rail')                  // tooltip / <kbd>
```

- Never write a combo into a template or a handler. `⌘N`, `Ctrl+Shift+L`,
  `⌘⇧E` and friends must not appear outside `shortcuts.js`.
- A browser tab cannot use several Cmd/Ctrl combos its chrome owns; the catalog
  carries a `browser` variant (`Alt/Option+Shift`) and matching accepts either.
- Adding a shortcut is two edits: an item in `SHORTCUT_GROUPS` and a
  `matchesShortcut('<id>', event)` branch in the handler. The guide updates
  itself; no second list to keep in sync.
- If an action gets a shortcut, it belongs in the guide. A shortcut nobody can
  discover is a private joke.

## Common mistakes

| Symptom | Rule | Where it is enforced |
| --- | --- | --- |
| A dialog closes with the X and the scrim, but not `Esc` | Register the dialog with `useDialogDismiss` | `npm test` (every `.modal` must import it) |
| `Esc` works only after clicking inside the dialog | Never use `@keydown.esc`; use the document-level stack | `npm test` (forbids `@keydown.esc`) |
| `Esc` closes the dialog *and* the picker behind it | Register popovers (`PickMenu`, `ModelInput`, …) too, so the stack closes one layer at a time | `useDialog.js` stack order |
| `Esc` closes a dialog mid-save and leaves a spinner | Pass `guard: () => busy.value` | Each dialog's `useDialogDismiss` |
| The scrim and `Esc` leave different state behind | One close function for every path | Review |
| A dialog has no dimmed backdrop / cannot be clicked away | A modal is scrim + dialog + close button + `Esc` | `RemoteConnectDialog`, `RemoteSyncPanel` for the pattern |
| A tooltip says `⌘K` but the handler was changed | Combo comes from `shortcutLabel(id)` | `npm test` (forbids `⌘` / `Ctrl+` in `.vue`) |
| Typing `?` in the composer opens the help guide | Check `isEditable(event.target)` before a bare-key shortcut | `HubLayout.onKey` |
| A new page has a key handler that fires while typing | Guard `INPUT`, `TEXTAREA`, `SELECT`, `contentEditable` | `AppRail`, `HubLayout` |
| Two surfaces open and both close on one `Esc` | One stack entry per surface, last opened is top | `useDialog.js` |
| A new shortcut exists but is not in `?` | Add it to `SHORTCUT_GROUPS`; render the guide from the catalog | Review + guide |
| Escape handlers on elements that never receive focus | The listener belongs on the window; the surface registers its close | `useDialog.js` |

## Surfaces and where they live

| Surface | File | Dismissal |
| --- | --- | --- |
| Keyboard guide | `src/components/ShortcutsDialog.vue` | Esc, scrim, Done; top-bar button, `?` |
| Command palette | `src/components/CommandPalette.vue` | Esc, `⌘K` |
| New thread | `src/components/NewThreadDialog.vue` | Esc, scrim, Cancel (guarded while saving) |
| Harness & MCP dialogs | `src/components/ChatHarnessDialog.vue`, `ChatMcpDialog.vue` | Esc, scrim, X |
| Execution timeline | `src/components/TimelineDialog.vue` | Esc, scrim, Done (arrows step) |
| Entity create / clone / configuration | `EntityCreateDialog.vue`, `EntityCloneDialog.vue`, `views/EntityDetailView.vue` | Esc, scrim, X (guarded while saving) |
| MCP add / pool JSON | `src/views/McpView.vue` | Esc, scrim, Cancel (guarded while saving) |
| Remote connect / status | `RemoteConnectDialog.vue`, `RemoteSyncPanel.vue` | Esc, scrim, X (connect guarded while busy) |
| Workspace wizard | `src/layouts/HubLayout.vue` + `WorkspaceWizard.vue` | Esc, scrim |
| Mark picker, pick menus, model suggestions, zoom, minimap card | `MarkPicker.vue`, `PickMenu.vue`, `ModelInput.vue`, `ChatArtifacts.vue`, `ThreadMinimap.vue` | Esc via the same stack |

## The guide in the top bar

The small keyboard button sits next to **Search** in the app top bar and opens
the same dialog from every hub page. `?` opens it when focus is not in a field;
`Esc` closes it. It is generated from `shortcutGroups()` — there is no content
to hand-edit when a combo changes.

`Composer help` (the `?` inside the message box) is separate on purpose: it
documents everything the composer itself understands — `/` skills, `@` mentions,
arrow keys, `Tab`, Enter/Shift+Enter and sending — not app-wide navigation.

## Loading budget

The renderer starts as a shell and fetches a screen only when it is opened. The
sign-in page must not download the chat, the chat must not download the MCP
inventory, and Markdown parsing must not happen until a reply needs it.

- **Screens are chunks.** Every `component:` in `src/router.js` is a
  `() => import(...)`. The entry (`main.js`, stores, `App.vue`) imports no view,
  no layout and no component.
- **The parser is a chunk.** `marked` and `dompurify` are imported only by
  `src/lib/prose-engine.js`; components call `renderProse()` / `proseReady`
  from `src/lib/prose.js`, which loads the engine on first use and renders
  escaped text until it arrives.
- **Heavy overlays are async.** The command palette uses
  `defineAsyncComponent`; the workspace wizard is `v-if`-mounted. A dialog that
  is only opened from an already-loaded screen does not need its own chunk.
- **Prefetch on intent.** The sign-in form warms the hub shell when a field is
  focused or the submit button is hovered; nothing is fetched for a visitor who
  never reaches for it. Never prefetch on the critical path.
- **Read locally, in parallel.** Independent reads go out together
  (`loadScope`), and nothing is awaited that the first paint does not need.

`npm test` fails if a view is imported statically, if the entry reaches for a
screen, or if `marked`/`dompurify` appear outside the prose engine. `npm run
build` prints the chunk list — the entry chunk should not grow without a reason.

## When you add a surface or a key

1. New dialog/drawer/popover: add the close button, the scrim, and
   `useDialogDismiss({ active, close, guard })`.
2. New shortcut: add it to `SHORTCUT_GROUPS` in `src/lib/shortcuts.js`, then
   match it in the handler with `matchesShortcut`.
3. Render every hint through `shortcutLabel` — never a literal.
4. Run `npm test` (static contract) and open the guide with `?` to confirm the
   new row appears and closes the surface it belongs to.
5. If the change taught you a new failure mode, add a row to **Common
   mistakes**. If it introduced a new kind of surface, add it to **Surfaces**
   above.

## Log

- **2026-11-13** — renderer split into per-screen chunks; the Markdown parser
  moved behind a lazy prose engine; the palette became an async component; the
  entity mark loop skips hidden frames and halves the rate for mini marks; the
  workspace scope reads its six stores in one parallel pass.
- **2026-11-13** — Escape handling moved to one window-level stack
  (`useDialogDismiss`); every modal and popover migrated. Top-bar keyboard
  guide added (`ShortcutsDialog` + `src/lib/shortcuts.js`); hard-coded combos
  removed from `AppRail`, `ChatView`, `SlashComposer` and `RailContext`. Static
  contract test added in `electron/ui-contract.test.cjs`.
