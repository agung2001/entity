# DESIGN.md — interface rules

This is the reference for anything that touches the interface: dialogs,
popovers, keyboard handling, the top bar, the composer. It exists because the
same mistakes kept coming back:

1. a modal that only closes with the X button or the scrim, so `Esc` does
   nothing when focus is anywhere else;
2. a shortcut typed into a component instead of registered once, so the hint
   drifts from the handler and never appears in the guide;
3. a harness/model inventory rendered as bare text with no search, so a long
   list is unusable and the brand mark is missing;
4. attachments typed into the prompt instead of sitting in the tray below it,
   with no off-by-default gate and no Composer-help entry;
5. keyboard movement that changes the selection without keeping the visible
   list in sync.

Read this before adding a surface or a key. When a new class of mistake is
found, add it to **Common mistakes** below — that is how this file stays
useful. The rules that can be checked mechanically are enforced by
`electron/ui-contract.test.cjs` (`npm test`).

## Five non-negotiables

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

### 3. Inventories are searchable and carry their brand marks

A machine's harness/model inventory is a list, not a paragraph. It can hold
hundreds of model ids, so the page must let a person narrow it without relying
on the browser's Find.

- Every harness id/name shown in a list, card, detail row or picker uses
  `<HarnessIcon :name="id" />` from `src/components/HarnessIcon.vue` next to the
  label. The icon is the `thesvg.org` mark for that harness, not a generic dot.
- A harness/model list (machine detail, capability panel, future runtime picker)
  has a visible search input. It filters case-insensitively over the harness id,
  label, path, default model and model ids.
- Show the result count and an empty state ("No harness or model matches …").
  Do not render an empty panel with no explanation.
- Keep the search input on the page; do not hide it behind a menu or require
  `Ctrl/Cmd+F`.
- Long model lists stay inside a bounded scroll area; do not let the page grow
  by hundreds of rows.

#### Inventory row density

A capability row is a compact control, not a card heading.

- Keep three visual levels in the summary: `HarnessIcon` (12px), the label
  (12px / 600), and one muted count (10px). Do not let the row inherit the
  page's heading or body size.
- Use **one separator system**. Put a top border on rows after the first
  (`border-top` + `:first-child { border-top: 0 }`), or a bottom border on all
  but the last. Never add a container top border *and* a row bottom border —
  the first row then reads as a double border.
- Do not repeat a state that the count already implies. “0 models” is enough in
  the summary; put “no model list reported” in a tooltip or the expanded body.
- Keep model/ID chips at 9.5–10px, and their container scrollable.
- Check at least one zero-model harness and one harness with hundreds of models
  before calling the row finished.
- The expanded body is where the path, default model, source note and model
  list belong. The summary stays one line.

### 4. The composer separates prompts from attachments

The message box is for the prompt. Attachments belong in a tray below it.

- A visible **Local attachment** toggle sits below the prompt **only on a remote
  thread**. It is off by default and is per thread. A local thread has no tray.
- Files and MCP servers are attachment chips in that tray, not text inside the
  prompt.
- Selecting `@file` or `@mcp` adds/removes a chip; removing the chip removes the
  attachment without rewriting the sentence.
- With the toggle off, attachment kinds are absent from the `@` menu and are
  not resolved.
- Skills are not attachments in the `@` language. They keep the slash forms
  from Composer help: `/workspace:<name>`, `/<harness>:<name>`, `/<name>`.
- Every attachment token shown in the UI must appear in **Composer help** in the
  same change. Do not invent a token that the help does not document.
- Remote `@file` uploads are temporary; remote `/workspace:` skills are
  persistent in the target harness and need a backup.

### 5. Keyboard movement follows the visible selection

- Arrow-key movement in a list must also move the scroll position. Use
  `scrollIntoView({ block: 'nearest' })` in a `nextTick` after changing the
  active index.
- A rail search shortcut targets the **active** rail, not a fixed panel. Query
  the visible second-tier search field instead of importing one component.
- Previous/next conversation shortcuts live in the shortcut catalog and wrap at
  the ends only if the rail wraps; they are not a hidden component handler.

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
| A harness/model is rendered as bare text | Use `HarnessIcon` for the harness mark, then the label | `npm test` (MachineDetailView contract) |
| A capability list has no search input | Every inventory that can exceed a screen gets a visible, case-insensitive filter over harnesses and models | `npm test` (MachineDetailView contract) |
| An attachment is typed into the prompt instead of the tray | Prompts stay prompts; file/MCP attachments live in the tray below | Review |
| Attachment controls are always visible | Gate them behind the Local attachment toggle, off by default | Review |
| `@skill:` is introduced beside `/workspace:` | Skills have one syntax: the slash reference; no `@skill` | Review |
| A new attachment token is not in Composer help | Parser, UI and Composer help change together | Review |
| Arrow keys move the highlight but the list does not scroll | Scroll the active row into view with `block: 'nearest'` | Review |
| A rail shortcut assumes one panel | Target the search field of the currently visible rail | Review |
| Conversation shortcuts exist only in a view | Add them to `SHORTCUT_GROUPS` so the guide and handler agree | Review |
| Search only looks at harness names, not models | Match id, label, path, default and every model id | Review |
| A detail page dumps hundreds of model ids into the page flow | Put them in a bounded scroll area and keep a result count/empty state | Review |
| A summary row inherits the card heading size | Set label/meta sizes explicitly: 12px label, 10px count | Review |
| The first inventory row has a double border | Use one separator system: no container top border plus row borders | Review |
| “No models” is repeated in the summary and the body | Keep the summary to `0 models`; explain once in the body/tooltip | Review |
| An inventory row is taller than a normal list row | Keep 8px vertical padding and details behind the disclosure | Review |

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
- **Long lists mount from the end.** A thread paints its newest rows first and
  fills older ones on the next frames or when someone scrolls back into them
  (`MessageList`). Do not measure every row on scroll — `ThreadMinimap` tracks
  the reading position with an IntersectionObserver, not a per-row rect loop.

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
5. If the page renders harnesses, use `HarnessIcon` beside every label.
6. If the page renders an inventory (harnesses, models, MCP tools, files), add
   a search input unless it is guaranteed to stay shorter than one screen.
7. If the page has a composer, put attachments below the prompt, gate them with
   an off-by-default toggle on remote threads, and document every token in Composer help.
8. If arrow keys move a selection, scroll the active row into view. If a shortcut
   targets a rail, resolve the active rail instead of a fixed component.
9. For inventory rows, test zero data, hundreds of items, one separator system,
   and a compact summary. Details belong in the expanded body.
10. If the change taught you a new failure mode, add a row to **Common
   mistakes**. If it introduced a new kind of surface, add it to **Surfaces**
   above.
