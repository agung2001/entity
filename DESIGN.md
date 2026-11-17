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
4. attachments hidden behind a mode switch instead of a direct button and a
   drop target, with no Composer-help entry;
5. keyboard movement that changes the selection without keeping the visible
   list in sync.

Read this before adding a surface or a key. When a new class of mistake is
found, add it to **Common mistakes** below — that is how this file stays
useful. The rules that can be checked mechanically are enforced by
`tests/unit/ui-contract.test.cjs` (`npm test`).

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
- When the desktop combo is something the browser already does — Ctrl/Cmd+Shift+V
  is paste-as-plain — the tab must *require* the browser variant:
  `matchesShortcut(id, event) && (isDesktopApp() || event.altKey)`. See `voice`.
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

- The composer dock accepts dropped files and has a paperclip/folder button
  immediately before send. The same attachment path works for local and remote
  runs; there is no attachment-mode tab or toggle.
- Files, MCP servers and mention attachments are chips below the prompt, not
  text inside it.
- Selecting `@file` or `@mcp` adds/removes a chip; removing the chip removes the
  attachment without rewriting the sentence.
- A dropped file is read into the attachment list; it is not pasted into the
  prompt.
- Skills are not attachments in the `@` language. They keep the slash forms
  from Composer help: `/workspace:<name>`, `/<harness>:<name>`, `/<name>`.
- A **single** slash resolves against the active execution context. On a remote
  thread that means the skill must already exist on the target, and the `/` menu
  lists that host's skills.
- **Double** slash (`//workspace:<name>`, `//<harness>:<name>`, `//<name>`) sends
  the local copy; on remote it installs there and backs up the previous skill.
  The `//` menu deliberately lists this machine's skills, not the remote host's.
- Double at (`@@<mention>`) marks a local mention. A single `@` belongs to the
  thread's execution context; a remote thread must not resolve it locally.
- Every attachment token shown in the UI must appear in **Composer help** in the
  same change. Do not invent a token that the help does not document.
- Remote `@file` uploads are temporary; remote `/workspace:` skills are
  persistent in the target harness and need a backup.
- **"Share" and "copy" say what they will actually do.** A browser tab can hand
  over a URL and has the Web Share API; the packaged app has neither, so it puts
  the *id* (rail) or the *link* (`entity://`, message) on the clipboard and the
  label says which. Never a quoted reference block — it pasted as prose wherever
  a link was wanted.
- **A dialog over a rendered page owes Escape twice.** The one dismiss stack
  covers every surface in the app window, but a click inside an iframe takes
  focus out of that window, so the key never arrives. A frame that hosts page
  content forwards Escape itself (`@escape`), and any picker inside it registers
  with `useDialogDismiss` so one Escape still closes one layer.
- **A draft belongs to the thread it was typed in.** The composer is one box for
  every conversation, so the text is keyed by thread in the store and persisted
  in `localStorage` (`src/lib/drafts.js`) — never in the workspace files, which
  the renderer only writes through the call table. Switching threads swaps the
  box; leaving and coming back restores it, and a reload does too. A send
  empties only its own thread, and a failed send puts the words back.

### 5. Keyboard movement follows the visible selection

- Arrow-key movement in a list must also move the scroll position. Use
  `scrollIntoView({ block: 'nearest' })` in a `nextTick` after changing the
  active index.
- A rail search shortcut targets the **active** rail, not a fixed panel. Query
  the visible second-tier search field instead of importing one component.
- Previous/next conversation shortcuts live in the shortcut catalog and wrap at
  the ends only if the rail wraps; they are not a hidden component handler.

## A roster is a table, and a copy is a decision

A seven-item roster used to be a three-up card grid: about 60% of the horizontal
band empty, and a two-line description given the height of a card. A roster is an
inventory, and this repo already owns the grammar for one.

- **Draw it as a table with one bounded scroll area** (`max-height:
  min(60vh, 560px)`, sticky header, 58 px rows). A 200-item roster keeps the page
  height fixed; the box scrolls, the page does not.
- **One separator system**: no `border-bottom` on the head, `border-top` on every
  data row, `:first-child` exempt. Never both.
- **The name is the link, the row is not.** `Copy…` and `Detach` live inside the
  row, so a row-wrapping `<a>` would nest interactive elements.
- **State the count once** ("7 of 7 · 10 entities can call them"), not in the page
  head, the tab and the bar. Three counts is three chances to disagree.
- **A search field is on the page, with its shortcut from the catalog.** `/`
  focuses it through `matchesShortcut('inventory-search')` and never fires while
  the caret is in a field (`isEditable`).
- **Draw every list state**: skeleton in the real grid, empty, no-results with the
  query echoed and a way to clear it, unreadable-directory error with the raw
  reason and a retry, and the row whose folder is gone. An inventory that reports
  "0 skills" for a directory it could not read is lying.
- **A copy is a sheet, and the clash is decided before a byte moves.** Destination,
  hand-off (from → to, with file counts) and — when the name exists — Replace or
  Keep both, with the primary disabled until that choice is made. The copy is
  staged in the destination and renamed into place, so a failure leaves nothing
  behind.
- **A renamed copy renames what the skill calls itself.** `x` that landed as `x-2`
  must declare `name: x-2`, or the roster shows two identical names and the slash
  reference resolves to neither.
- **Escape is guarded while the work is in flight** (`guard: () => busy`), and the
  X, Cancel and primary all agree with it.

## A retention rule is a chart, and a deadline the app can miss

Workspace settings → Chats decides when a silent thread archives itself and when an
archived one is removed. It is the artifacts shelf's shape (two thresholds, a
histogram, a forecast) applied to a different population, so the two pages read as one
system.

- **Two thresholds, two clocks.** ① counts silence since the thread's last message;
  ② counts days *in the archive*. A thread that goes silent today dies at
  `archiveAfter + deleteAfter` days of silence, and moving ① moves both lines. Copy that
  says "delete after 180 days" while the line sits at 210 is the bug to avoid.
- **The chart is the control, not a picture of it.** The dashed lines *are* the
  thresholds; the rows underneath move them. A member who cannot say what "30 days"
  costs tonight has been given a number field, not a setting.
- **The legend describes the axis, the forecast describes the pass.** One object
  (`rowFor`) answers two questions: `region` ignores the protections (where a thread
  sits relative to the two lines — what the legend, the bars and the two effect counts
  show) and `outcome` applies them (what tonight's pass will actually do). Computing
  the legend from the pass would make "Archived 26" disagree with the bars; computing
  the pass from the region would delete threads a protection was holding.
- **`Never` is a unit, not a switch.** Both rules on `Never` is retention off, and the
  card says exactly that instead of leaving two dead rows.
- **A cadence plus a deadline, never a bare hour.** The app is open all day and shut at
  night, so an appointment is a time nothing runs at. `every day by 03:00` means "at most
  a day behind, and not before 03:00"; the boot tick catches a deadline that passed
  while the app was closed, which is why the copy says "or at the next launch".
- **Only an opted-in workspace is swept.** The rule lives in `<workspace>/retention.json`
  and the first read of the tab creates it. No file, no pass: installing the app never
  archives a history nobody has looked at.
- **A pass is idempotent and its archive date is stamped once.** A scheduler that runs
  every thirty minutes must not reset the clock a "days in the archive" rule counts.
- **A disabled or absent control states its own state.** `only when I ask` removes the
  `by` word and the time field from the row rather than leaving them contradicted.
- **② at ≤ 7 days is a stated consequence, never a modal.** The value is legal, the field
  that caused it is on screen, and the banner outlives the click.
- **The archive is a place, not a lock.** Answering an archived thread brings it back
  (and stops its delete clock) — written as its own write, before the turn's metadata
  baseline, so the turn's later save cannot adopt the archive straight back.
- **Grid tracks that hold cards are `minmax(0, 1fr)`.** A bare `1fr` is
  `minmax(auto, 1fr)`: the track grows to the card's min-content and the shell hides the
  overflow, so a phone silently loses 45 px of every settings card.

## A delegation is a session, and the session is not a row

Starting a second conversation from this one is not a button in the header and not a
panel above the composer — both were built, shipped and rejected on sight. It is what
the composer already does: mention another entity.

- **A mention is the trigger.** `@entity <job>` runs the job in the turn *and* files a
  session. No second verb, no prefilled dialog, no floating card: the thing you already
  type is the thing that spawns.
- **One optional field, on the child**: `spawnedFrom: { workspace, id }`. Both directions
  are derived from the list the window already has; a children array would be a second
  copy that can disagree. A link to a thread that is gone reads as "no link", never as an
  error.
- **The run is continued from where it happened.** The delegation card carries
  **Continue** at its top right, which opens the session that run created — the job, the
  answer, its steps and its timing are already in it. A card with no way out is a dead
  end someone will click twice.
- **A session is not a rail row.** The rail lists the conversations the person started;
  a busy thread can own a dozen sessions, and rows for them drown the list. The parent
  row carries `spawned N chats`, the count opens a tree (sessions of sessions included),
  and opening one marks the parent row active so the rail still says where you are.
- **Fan-out is asked for, never inferred.** `spawn N @entity <job>` at the start of the
  message runs the same instruction N times in parallel, one session each — capped at
  five, and only when a mention follows the number, so "spawn 3 tasks in the backlog" is
  prose. Every run is told which one it is (that is the only reason three answers to one
  sentence differ), the session titles carry the share (`· 2/3`), and the reply above sees
  all of them.
- **A fan-out may take its count from a list, and then the row is the run.**
  `spawn per @<list> @entity <job>` resolves the list first, copies the entity once per
  row, and titles each session with its row — seven issues read as seven sessions, not
  seven copies of one instruction. The cap is the reply's own row budget (eight): one run
  per row, one row per answer, no answer silently dropped. A list that resolves nothing
  runs nothing — a delegatee holding the instruction but no row would pick one.
- **In a fan-out the skill belongs to each run, not to the message.** `/workspace:…` goes
  after the entity, so every run is routed; a skill at the front is a hard error that says
  exactly that.
- **A long turn shows its work, in the shape the answer will have.** A fan-out paints one
  delegation card per run inside the live bubble — queued, `Working…`, then that run's answer —
  and the foot carries `N of M done · elapsed`. No second panel, no spinner-only wait: the
  cards appear where the results will be, so nothing changes shape when the turn lands.
- **Stop must reach whatever the turn actually is.** During a fan-out there is no parent
  harness yet; the delegated runs are the turn, so `chat.cancel` kills them, keeps the runs
  that already answered, and the queued ones never start. A stop that leaves seven agents
  running is worse than no stop button.
- **The child says where it came from.** A `↳ from #<parent>` line above its title, and
  the whole parent title in `title` — the header's meta line is too narrow for a crumb.
- **The count and the rows must agree.** `activeSummaryCount`, the rail's rows, its
  status counts and its filters all exclude sessions; a count that includes an invisible
  row lies in the one number people compare against the list.

## Common mistakes## Common mistakes

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
| "Copy" does nothing and the toast blames the content | `navigator.clipboard` rejects in the packaged app; go through `src/lib/clipboard.js` (clipboard API → selection fallback → `false`) and let the toast say which happened | `npm test` (`clipboard`) |
| Escape does nothing while an artifact preview has focus | A frame never receives the window's keydown: forward it from the frame's own document | `tests/e2e/full/16-artifact-scope.spec.js` |
| A dialog opens with focus still on the page behind it | Focus the first control on open, and give the dialog its confirm combo | `tests/e2e/full/01-thread-lifecycle.spec.js` |
| A roster of seven items is drawn as a card grid | Inventories are tables: bounded scroll area, one row per item, name as the only link | `tests/e2e/full/18-skills-copy.spec.js` |
| An unreadable directory is reported as "0 skills" | A read that failed is an error note with the reason and a retry; only a missing directory is an empty list | `electron/workspace-store.cjs` (`skills`) |
| A copy lands as `x-2` but still declares `name: x` | Rewrite the declared name, or the roster shows two identical rows and the slash reference resolves to neither | `npm test` (`workspace-skills`) |
| A sheet's footer scrolls out of reach with its body | The footer is a sibling of the scrolling body, not a child of it | `SkillCopyDialog` |
| A whole table row is a link with buttons inside it | Make the name the link and keep the row a container | Review |
| A settings card overflows a phone and the page does not scroll | The grid track is `1fr` (which is `minmax(auto, 1fr)`) and grows to the card's min-content; use `minmax(0, 1fr)` | `app.css` (`.acct-page` ≤980) |
| A retention legend and the rule effects disagree | Both read one `region` object; the forecast reads `outcome`, and only it describes the pass | `npm test` (`retention`) |
| The shelf rule never archives anything twice, and never deletes at all | The archive is a folder the shelf walk skips: analyse `artifacts/.archive/` as its own population, and stamp the archive date once on the way in | `npm test` (`artifact-retention`) |
| A scheduled pass re-stamps the date it counts from | The state write is idempotent and stamps only on the transition | `npm test` (`chat-archive`) |
| A rename writes `archived: false` into a thread that never had it | Reads answer true/false; `writeThread` strips the pair when it is false | `npm test` (`chat-archive`) |
| A reply leaves the thread in the archive | Un-archive as its own write, before the turn's metadata baseline | `tests/e2e/full/19-retention.spec.js` |
| A recursive copy of an unreadable directory kills the process | `fs.cpSync({ recursive })` aborts on a permission error instead of throwing; walk the tree with `readdirSync` first and fail with a message | `npm test` (`workspace-skills`) |
| A menu item is disabled but looks and behaves like an enabled one | Style `[disabled]` (`opacity: .42`, `cursor: not-allowed`) in the same change that disables it | `app.css` (`.rchat-menu-item[disabled]`) |
| A popover floats off screen because its height was hardcoded | Measure `offsetHeight` after render and flip from the measurement | `ChatHistoryRail.openRowMenu` |
| Unsent text disappears when you switch threads (or reload) | Drafts are per thread in the store, persisted through `src/lib/drafts.js`; the composer reports every change and adopts the new thread's text | `tests/e2e/full/15-drafts.spec.js` |
| A finished turn switches the conversation you are reading | Store the result and update the rail row; `active` moves only from a click, a deep link, a new thread or a delete | `tests/e2e/full/14-turn-settles.spec.js` |
| Scrolling up during a turn snaps back to the newest chunk | A programmatic scroll to the bottom arms the follow flag; the live watchers are not exempt | `tests/e2e/full/13-scroll-follow.spec.js` |
| The "jump to newest" pill sits under the composer and eats the click | Position floating transcript controls with `--dock-space` + `--term-space`, the same numbers the list pads with | `app.css` (`.jump-live`) |
| A harness/model is rendered as bare text | Use `HarnessIcon` for the harness mark, then the label | `npm test` (MachineDetailView contract) |
| A capability list has no search input | Every inventory that can exceed a screen gets a visible, case-insensitive filter over harnesses and models | `npm test` (MachineDetailView contract) |
| An attachment is typed into the prompt instead of the chip row | Prompts stay prompts; file/MCP attachments live in chips below | Review |
| Attachments require a mode switch or hidden toggle | Use the direct clip/folder button and drop target | Review |
| `@skill:` is introduced beside `/workspace:` | Skills have one syntax: the slash reference; no `@skill` | Review |
| A single slash silently overwrites a remote skill | Single slash expects the target to have it; `//` opts into sending the local copy | Review |
| A new attachment token is not in Composer help | Parser, UI and Composer help change together | Review |
| Arrow keys move the highlight but the list does not scroll | Scroll the active row into view with `block: 'nearest'` | Review |
| A rail shortcut assumes one panel | Target the search field of the currently visible rail | Review |
| Conversation shortcuts exist only in a view | Add them to `SHORTCUT_GROUPS` so the guide and handler agree | Review |
| A chart canvas paints over a card's popup, so its controls cannot be clicked | A card with a popup needs its own stacking order above the charts that follow it (`isolation: isolate` alone is not enough) | `EntityDetailView` — `.entp-hero` |
| A picker inside a scrolling dialog is cut off at the dialog edge | Teleport the popover to `<body>` with fixed coordinates; measure and flip on open, reposition on scroll/resize, cap the height and let it scroll | `PickMenu`, `ModelInput` |
| The model suggestions scroll inside a 280px box clipped by the dialog | The layer measures the viewport, not a fixed `max-height`; it grows to the room that exists and flips above when the field sits low | `ModelInput` |
| A one-line title leaves an empty gap and the bar is taller than the top bar | A heading with a decorative icon is a flex row: the text is its own span and the icon never wraps to a second line. A block `h2` rule must not win over `.cp-title` | `.cp-head h2.cp-title` |
| The first line of the thread slides under the glass bar | The measured header height is its border box, not `contentRect` (which excludes padding) | `ChatView.watchHead` |
| Thread tags only exist on the open conversation | Tags are thread metadata: the header shows and edits them, the rail shows them on every row and filters by them | `ChatView`, `ChatHistoryRail`, `ThreadTagsDialog` |
| Two counters take a header track from the title and search, or float over the answer | Conversation totals close the composer's context row, before voice and help | `.cp-stats` |
| A Markdown or code artifact is dumped as raw text in a bordered box | Documents use the chat glass bar and open in MarkdownEditor / CodeEditor, full-bleed under it; Save writes back to the same file, never a copy | `ArtifactDetailView`, `artifact.writeText` |
| A members list is a row of unlabeled name/email/role fields | Each member is a card led by their Gravatar (initials when there is no email), with labelled inputs and an icon remove button; the owner row is marked | `WorkspaceView` |
| A media artifact is a small image in a bordered box | Images, audio and video get the full-bleed grid stage: details and file actions in a floating top bar, zoom in a vertical rail, wheel/button zoom, drag to pan at any scale, Fit to reset; documents keep the plain preview | `ArtifactDetailView` |
| Search only looks at harness names, not models | Match id, label, path, default and every model id | Review |
| A detail page dumps hundreds of model ids into the page flow | Put them in a bounded scroll area and keep a result count/empty state | Review |
| A summary row inherits the card heading size | Set label/meta sizes explicitly: 12px label, 10px count | Review |
| An inventory hides a parked or disabled row, so synced data looks absent | List the row with its state and show the parked count; a disabled remote MCP server is present, not missing | `McpView` |
| A remote MCP server or skill needs a second setup step on every clone | Definitions travel enabled; attached skills are copied into the workspace, never linked; only a change to an existing server's command/url is held local and reported | `workspace-store.cjs`, `remote-sync.cjs` |
| A sub-page opened from the rail has no way back to where it came from | Every non-root section carries `section.back`, and it goes up **one level** — `machine → machines`, `machines → workspace settings` — not always to the workspace picker. The button's title names the destination | `RailContext` |
| The action that copies an MCP server into the workspace is called "Add to pool" while skills say attach | One verb per action: **Attach** / **Detach** / **Parked**, and "attached" is also the state word in the table and the server page. The pool is the file on disk, not the word in the UI | `McpView`, `McpServerView` |
| A workspace card reports a number nobody can act on ("3 scanned") | Counts are the things the workspace owns and a person can open: entities, skills, MCP servers (parked included). A machine count belongs to the Machines page | `ManageWorkspacesView` |
| A read-only JSON or command block is dumped as a bare `<pre>` in browser monospace | Code gets `.codebox` (border, surface, scroll cap) and a command line gets `.mcpp-cmd`, which wraps; never the prose description slot | `McpServerView` |
| A synced MCP server is enabled on a host where it cannot possibly answer (`127.0.0.1` in a container, a command under `/Users/…`), so every entity naming it fails | A machine-bound definition (loopback URL or a home-directory path) is shared but lands **parked** with the reason: `sanitizeMcp` marks it `machineLocal`, both apply paths write it into `disabled` with `__unavailable`, and the server's `parkMachineBound` repairs pools an older build enabled. Enabling it by hand pins it (`__pinned`) so no later pass parks it again | `remote-manifest.cjs`, `server/sync.cjs`, `McpView`, `McpServerView` |
| An `artifact://` reference in a code span becomes a broken image, because the token ends with the closing backtick | Strip the wrapper (`backtick`, quote, angle brackets) and trailing punctuation before resolving an id, and keep a reference ending in `/` as text — a folder is not a preview | `MessageBody` |
| Review controls take a toolbar row from the content they review | Annotations float: a bottom-right pill with the shortcut, the notes stacked above it, both over the page and never in the document's flow | `ArtifactHtmlPreview` |
| A screenshot opens a lightbox, a document opens another page, a page opens nothing | One surface: the artifact page as a dialog over the conversation (full width, one X, Esc), reached from the card's thumbnail or name, and its notes go to the open thread's composer | `ArtifactDialog`, `ChatArtifacts`, `MessageBody` |
| An HTML artifact can only be read as source, so judging a design means opening another app | The page is the default: Preview / Source in the bar, the document in a same-origin frame (a `data:`/`srcdoc` frame inherits our CSP and would refuse an injected picker; a shadow root parses away `<body>` and the page's own styles stop matching), scripts stripped, a warning when sibling files are referenced. **Annotate** picks an element and posts the notes to the chat as a draft | `ArtifactHtmlPreview`, `annotate.js` |
| Every artifact card offers Download only, whatever the file is | The row comes from one capability list on the server (reveal always; editor for text; browser for `.html`/`.pdf`), and the RPC re-checks the verb, so a card cannot offer what the backend refuses. Icon buttons with `title` + `aria-label`, labels kept to the detail page | `ChatArtifacts`, `artifact-store.cjs` |
| A turn renames the thread it answered, so a title someone wrote disappears | The first message names a thread only while the person has not: `titleSource` records who set it (`auto` / `user`, including a deliberate clear), and a turn merges only the metadata the file actually changed since it started — title, pin, tags, base directory, attachment switch | `chat-store.cjs` (`saveTurn`) |
| A conversation lists files another conversation wrote, because they were saved while it ran | Attribution needs a writer, not a clock. A file belongs to a turn when the turn **names it** (`artifact://` in the answer, a write tool's path, a shell write operator — never a bare basename), when it lands in a **folder the turn wrote into** during the window (a render batch), or when it sits at the **shelf root** and the turn ran alone. "Only one turn ran in those minutes" is never sufficient: the shelf is shared with this machine, other apps and the person's own scripts | `chat-store.cjs` (`claimsFor`) |
| A card shows another design's screenshots because a background render finished during the turn | Time is a filter, not a reason. Require evidence before attaching, and let the folder carry the rest of one deliverable | `npm test` (`chat-artifacts`) + `tests/e2e/full/16-artifact-scope.spec.js` |
| A rail with more rows than fit squeezes them until a two-line title paints over the row below | Rows inside a scrolling flex column are `flex: none` with a `min-height`; the list scrolls, the rows never shrink below their content | `ChatHistoryRail` (`.rchat-row`) |
| The first inventory row has a double border | Use one separator system: no container top border plus row borders | Review |
| “No models” is repeated in the summary and the body | Keep the summary to `0 models`; explain once in the body/tooltip | Review |
| An inventory row is taller than a normal list row | Keep 8px vertical padding and details behind the disclosure | Review |
| One long skill description makes the whole grid scroll sideways | `1fr` tracks need `minmax(0, 1fr)`, cards need `min-width: 0`, and clamped text needs `overflow-wrap: anywhere` | `SkillsView` / `.grid3` |
| A metadata row lists a path that cannot be opened | Only list paths that `fs.statSync` found, and re-check before acting | `thread-metadata.cjs` |
| Spawning needs its own button, dialog and card next to the composer | A mention *is* the spawn: `@entity <job>` files a session and the transcript's delegation card continues into it | `tests/e2e/full/20-spawn-session.spec.js` |
| A 20-minute fan-out shows only "Waiting for coder…" | The runs announce themselves: cards in the live bubble, per-row status, count and clock in the foot |
| A remote or delegated turn cannot be stopped | Whatever is running is reachable by `chat.cancel`: the parent harness *or* the delegated children, and queued runs never start |
| Seven runs of a list all carry the shared instruction as their title | The row (issue id + title) is the mention's label and the session's title, and the block names each run by it |
| A fan-out message led by `/workspace:skill` routes the parent and leaves N agents in one checkout | Refused before anything runs: the skill goes inside the job, one route per run |
| Three runs of one instruction are three identical cards, or two identical session titles | The share (`1/3`) goes on the mention, the session title and the block the reply reads; the card key includes it | `npm test` (`mention-ref`, `chat-spawn`) |
| A delegated run is a dead end | The card carries **Continue** at its top right, opening the session the run wrote | `tests/e2e/full/20-spawn-session.spec.js` |
| A thread that delegates a few jobs puts rows for them in the rail | Sessions are not rows: the parent carries `spawned N chats` and the count opens a tree | `npm test` (`chat-spawn`) |
| A count says 4 and the rail paints 2 | Counts, filters and groups all exclude sessions; only the tree shows them | `hub.activeSummaryCount` |
| A breadcrumb in the meta line renders zero-width | The header's meta track is ~157px; put the crumb on its own line above the title and clip it | `tests/e2e/full/20-spawn-session.spec.js` |
| A thread title is one character per line on a phone | A hidden grid item keeps its track's `minmax` floor: size the middle track from the box (`auto` + `width: clamp()`), not from a fixed minimum | `ChatView` header |
| The renderer names the path the main process opens | `thread.pathAction` re-derives the metadata and accepts only a member of it | `electron/rpc.cjs` |
| A dialog's close X floats over the page's own toolbar, in a box with a shadow | When the surface inside the dialog has an action row, the X is the last control **in that row** (`class="x"`), so the bar's flex aligns it; no offsets, no shadow | `ArtifactDetailView` (`modal`) |
| A drawer is only closable by its X button | Register it with `useDialogDismiss`, like a modal | `npm test` (drawer contract) |
| Metadata repeats a second store that can disagree with the chat | Derive it from the transcript; do not persist a copy | Review |
| A remote thread offers "Reveal in Finder" for a path on another machine | Mark the thread remote, keep copy, and hide local open actions | `ThreadMetadataPanel.vue` |
| A successful remote connect reports "22 problems need a look" | A dependency the workspace owns — a parked MCP server, an unattached remote skill — is a workspace-level note in the remote panel, never a problem on an entity. An entity's problems are about itself: an unknown harness, a `dir` that is not there. | `entity-store.cjs` (`problemsFor`), `RemoteSyncPanel.vue` |
| An entity page shows a skill or MCP count that can differ from its siblings | Skills and MCP servers belong to the workspace: every entity gets all of them. Never store a per-entity list, and never render one as a choice — the only per-entity knobs are `harness`, `model`, `dir`. | `tests/unit/entity-problems.test.cjs`, `tests/unit/mcp-runtime.test.cjs` |
| A remote sync is blocked by an "invisible unicode" finding on an emoji | U+200C/U+200D are ordinary text: they build a compound emoji (🧑‍🏫, 👨‍💻) and join letters in Persian, Arabic and Indic. Flag a joiner only inside a word, between two non-emoji characters; the bidi and zero-width-space controls (U+200B/200E/200F/202A-202E/2060-2064/FEFF) stay high. | `remote-guard.cjs` (`firstHidden`) |
| A backup reuses the export bundle and loses the workspace context | Snapshot the workspace into a ZIP; keep `workspace.json` intact | `backup-store.cjs` |
| A backup folder can be set inside the workspace | Reject any target whose workspace subfolder is inside the workspace | `backup-store.cjs` |
| Changing the folder strands the old ZIPs | Move them to the new folder, roll back on a failed move | `backup-store.cjs` |
| A restore overwrites the workspace in use | Restore into a new workspace id and label | `backup-store.cjs` |
| A snapshot carries `.remote.token` or harness logs | Exclude secrets and `runs/`; document it on the page | `backup-store.cjs` |
| The backup timer only runs when the settings page is open | Start one unref'd timer with the call table | `electron/rpc.cjs` |

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
| Entity learning review | `src/components/EntityLearnDialog.vue` | Esc, scrim, Cancel (guarded while applying); `entity.learn` writes nothing |
| Mark picker, pick menus, model suggestions, zoom, minimap card | `MarkPicker.vue`, `PickMenu.vue`, `ModelInput.vue`, `ChatArtifacts.vue`, `ThreadMinimap.vue` | Esc via the same stack |
| Thread tags | `src/components/ThreadTagsDialog.vue` | Esc, scrim, Cancel (guarded while saving) |
| Artifact document editor | `src/views/ArtifactDetailView.vue` | page surface; Save button and the catalog `save` shortcut |
| Thread metadata | `src/components/ThreadMetadataPanel.vue` | Esc (an open path row folds first), close button; chat-header toggle + shortcut |
| Voice mode | `src/components/VoiceChatDialog.vue` | Esc, scrim, close button; composer microphone + shortcut |

## The guide in the top bar

The small keyboard button sits next to **Search** in the app top bar and opens
the same dialog from every hub page. `?` opens it when focus is not in a field;
`Esc` closes it. It is generated from `shortcutGroups()` — there is no content
to hand-edit when a combo changes.

`Composer help` (the `?` inside the message box) is separate on purpose: it
documents everything the composer itself understands — `/` skills, `@` mentions,
arrow keys, `Tab`, Enter/Shift+Enter and sending — not app-wide navigation.

## Chat turns show progress while they run

A harness turn, a tool loop and a remote run can take minutes. Silence is not a
loading state.

- Paint partial assistant text in the live bubble as it streams. The final
  message replaces it and gets the Markdown renderer; the live bubble stays
  plain text so parsing does not run on every token.
- Show elapsed time and the current tool, not only `Working…`.
- Stream text and thinking updates as deltas. Do not resend an accumulated
  answer on every tick, and do not drop a pending delta when throttling.
- Keep first-step and first-text timings on the execution record
  (`ttfbMs`, `firstTextMs`) so a slow turn can be separated from a slow model.
- A live turn owns the loading bubble; do not add a second `Waiting for…` row.
- **A turn that settles never moves the reader.** Finishing is an event about a
  thread, not about the person: store the new content, update the rail row and
  let the notification policy speak — never assign the active thread from a
  send, a retry or a failure handler. The chat route follows `hub.chat.active`,
  so one stray assignment is a navigation the reader did not ask for.
- **Following the stream is a state, not a default.** A reader who scrolls up
  mid-turn stays where they are; every scroll-to-newest — the watchers on live
  text and tool steps included — arms the follow flag first. Detaching shows one
  pill above the composer that puts them back on the live turn in a click, and
  reaching the bottom resumes following by itself. A streamed chunk must never
  move the viewport: that is the one case the flag exists for.
- An `@entity` mention is a sub-run, not the outer thread. Show the delegated
  entity, its answer and its trace separately from the outer entity's reply; the
  outer entity must not appear to have run the child's tools.

## Thread metadata shows what the chat left behind

A long thread's useful residue — the YouTrack issue, the PR, the files it read,
the folder it worked in — is spread across answers, tool calls and tool output.
The drawer in the chat header is a second view of that same transcript, not a
second store.

- It is **derived** by `electron/thread-metadata.cjs` from the thread's text, tool
  `input`/`output`, resolved mentions and attachments. Do not persist a parallel
  list that can drift from the messages.
- **URLs** are rows you click to open in the browser; each has a copy button.
  Markdown labels are kept, otherwise a YouTrack id or `repo#42` names the row.
- **Paths** are only listed when they exist on this machine. A row opens a
  reveal/open action set: a file reveals in Finder/Explorer and can open in VS
  Code; a folder opens in Finder/Explorer. Every row also copies its absolute
  path.
- A **remote** thread cannot be stat'ed from here: keep the path candidates, mark
  them `remote`, and offer copy only. Never show a local action that would look
  at the wrong filesystem.
- The list is newest-first, capped, and has a visible filter. Empty, loading,
  filtered-empty and error states each say something; do not render a blank panel.
- The drawer is closed by default. Its toggle is a header button and a catalog
  shortcut; `Esc` folds an expanded path row first, then closes the drawer.

## The chat header is glass over the thread, in three zones

The bar above a thread is a pane of frosted glass, and the thread scrolls
*beneath* it. That is not decoration: a 16px blur over an empty strip is
indistinguishable from white paper, so the bar only reads as glass because body
text passes under it.

- **Out of the flow, on purpose.** `.cp-head` is `position: absolute`, and the
  list pays for it with `padding-top: calc(var(--cp-head-h) + …)`. One variable
  (`--cp-head-h`, declared on `.cpanel`) feeds both, so the bar's height can
  never disagree with the reserve — a first line born under the glass is a line
  nobody can read.
- **Measure the border box.** The `ResizeObserver` reads `borderBoxSize`, not
  `contentRect`: the content box drops the bar's own padding and the transcript
  then reserves ~16px less than the glass actually covers.
- **One row, the top bar's height.** The bar is 56px, the same as `.topbar`. It
  grows only when a long title wraps to a second line. Nothing else in the bar
  may make it taller: tag chips clip, counters hide, the search stays 30px.
- **No decorative second line.** The title is `display: flex` with the text in
  `.cp-title-text` and the pencil as a sibling. A `display: block` heading put
  the pencil on its own line and left an empty gap under every short title.
- **Three zones: identity · search · actions.** The thread search is a header
  child of its own (`cp-mid`), not part of the button cluster, and the middle
  track is the only one that flexes, so the bar reads as three groups instead of
  two clumps pressed against the edges with a hole down the centre.
- **The query/response totals close the composer's context row.** They describe
  the conversation, so `cp-stats` sits immediately before voice and Composer
  help with `margin-left: auto`. They do not take a header track from the title
  and search, and they do not float over the transcript where they would cover
  a line of the answer.
- **The bar is a size container.** Below 840px of column the shortcut chips and
  tag chips go; below 760px the search goes; below 600px the button labels.
  Container queries, not media queries: the rail takes 300px, so the column and
  not the window is what runs out of room.
- **Search is a jump, not a filter.** `cp-search` counts the messages that
  contain the text, highlights each row, and Enter / Shift+Enter move through
  them. It never rewrites the Markdown or hides context.
- The tint is roughly two-thirds of `--bg` over `blur(16px) saturate(1.8)`. Keep
  it light enough that a line of text under the bar stays readable as a smudge.

## Thread tags are metadata, not a second title

A long history is navigated by what a conversation was *about*, not only by
remembering its opening sentence.

- Tags live on the thread (`tags: []` in the thread JSON), like the title and
  the pin. `chat.tags` normalises them: trimmed, case-insensitively deduped,
  capped at 12 tags of 32 characters. The dialog previews exactly what will be
  saved.
- The header shows the chips in the meta line and opens `ThreadTagsDialog` on
  click. It is a comma-separated field, because the file is hand-editable and one
  syntax must serve both. Every preview chip carries its own `×`; removing it
  rewrites the same field.
- The history rail shows every row's tags and filters by tag alongside time and
  status. A tag chip in a row is a filter button, not decoration.
- Tags belong in the rail search text too: a person searching `billing` should
  find the thread even when the title never says it.

## A thread has three lifetimes, and archive is the middle one

Delete is the only exit a thread had, so every finished conversation either
stayed in the list forever or was destroyed. Archive is the honest middle.

- **Archive is one click with an Undo; Delete keeps its two-click guard.** A
  confirm on a reversible action makes it as expensive as the irreversible one
  and teaches that both are dangerous. The undo *is* the confirmation.
- **The state is one field on the record** (`archived`, `archivedAt`), mirroring
  `pinned`. Restoring **deletes** both keys rather than writing `false`, so a
  thread that came back is byte-identical to one that never left.
- **`archivedAt` is stamped once, on the false→true transition, and the write is
  idempotent.** A click survives re-stamping; a rule that runs on every boot does
  not — anything that counts *days in the archive* would have its clock reset each
  tick. The same function is the one a scheduled pass calls, so it takes a state
  (`{ archived }`), never a verb, and writes nothing when the state already
  matches.
- **One list, one collapsed group at the foot.** No second page and no scope
  switch: a route change unmounts the open thread and resets every filter.
  The group is collapsed by default and **force-opens under any query**, with
  its count switched to matches — an empty result while an archived thread
  matches would be a lie.
- **The header counts the working list only.** A count that includes the
  archive can disagree with the rows above the divider, so it never does.
- **The archived row is the active row.** No `ARCHIVED` chip and no pin glyph
  (the archive sort ignores the pin, so the glyph would claim an order the list
  is not in). One hover-revealed `Restore` where the pin used to be, and the
  menu offers Restore in place of Pin.
- **The menu measures itself.** It used to assume 152 px to flip above the row;
  a five-item menu is 170 px. Read `offsetHeight` after render instead of adding
  a second constant.
- **A disabled menu item must look disabled.** Nothing styled `[disabled]` on
  `.rchat-menu-item`, so a mid-turn action was pixel-identical to an enabled one.
- **Escape closes the row menu** and returns focus to the ⋯ that opened it:
  `useDialogDismiss`, like every other dismissible surface.

## An artifact is a file with the chat's bar, not a card in a page

The artifact detail page is a full-height surface with its own scroll. It uses
the chat header recipe rather than a floating rounded card.

- `.artifact-bar` is absolute glass over `.artifact-scroll`. The bar carries
  three text lines and is taller than 56px, so the view measures its **border
  box** into `--abar-h`; the scroll and the media stage reserve that, never a
  hard-coded number.
- A **Markdown** artifact opens in `MarkdownEditor` (Write / Review, word count,
  formatting tools) as the surface itself: `.artifact-scroll--editor` removes
  the side gutters, the frame and the bottom padding, and the editor flexes to
  the full width and height under the bar. A short document must not leave a
  white strip below the textarea. Save writes back to the same id through
  `artifact.writeText` — `saveText` allocates a new name and is only for derived
  exports. `save` is in the shortcut catalog.
- Other text artifacts keep a plain scrollable preview; PDFs keep the iframe;
  binaries keep Download. Editing is not offered where it would corrupt the
  file.

## Backups are copies, not exports

The backups page (Account → Backups) owns a schedule and a shelf; it is not a
one-off export button. One main-process timer, one retention policy, one snapshot
format — do not add a second backup path that writes somewhere else.

- A snapshot is **one ZIP** under `<target>/<workspace-id>/<timestamp>.zip`, with a
  `backup.json` manifest. The workspace is at the archive root. Do not reuse the
  export bundle: it is a portable hand-off, not a backup, and it omits the
  workspace context and run state.
- The **target folder** is per workspace, defaults to `~/.entity/backups`, and must
  be outside the workspace (otherwise the archive tries to contain itself). It is
  stored in `backups/settings.json`, not in the target, so moving the folder keeps
  the schedule. Changing it moves the existing ZIPs and rolls back if a move fails.
- The desktop uses `dialog.showOpenDialog`; a browser build types the path. Both
  reach the same `backup.setDirectory` validation.
- Leave secrets and transient state out: `.remote.token`, `.remote.json`,
  `.remote-trash/`, `.bin/` and `runs/`. A backup that carries a token is a leak
  with a schedule.
- **Restore creates a new workspace** from the snapshot; it never overwrites the
  live one. Drop skill links whose target is gone and say so.
- Retention is one union of calendar buckets (daily / this month's weeks / this
  year's months); prune after every run, not on a separate timer.
- **Smart is the default**, and an unset config must mean smart, not off.
- The scheduler is an unref'd timer in the main process, started and stopped with
  the call table. Opening the settings page must not be what makes a backup happen.

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
- **Charts are a chunk of their own.** `EChart.vue` imports
  `src/lib/echarts-core.js` with `import()`. Views import formatting from
  `src/lib/chart-math.js`, never the renderer, or the library lands in a route
  chunk.
- **The code editor is a chunk until a code artifact is opened.** `CodeEditor.vue`
  imports `codemirror` and `@codemirror/lang-python` with `import()` inside
  `onMounted`, so the artifact route does not pay for an editor a reader never
  opens.
- **The terminal is a chunk until it is opened.** `@xterm/xterm` (287 kB) and its
  fit addon are imported by `src/lib/terminal.js` on first open, behind a cached
  promise that retries after a failure. A conversation that never opens a shell
  never downloads an emulator.
- **Read locally, in parallel.** Independent reads go out together
  (`loadScope`), and nothing is awaited that the first paint does not need.
- **Long lists mount from the end.** A thread paints its newest rows first and
  fills older ones on the next frames or when someone scrolls back into them
  (`MessageList`). Do not measure every row on scroll — `ThreadMinimap` tracks
  the reading position with an IntersectionObserver, not a per-row rect loop.

`npm test` fails if a view is imported statically, if the entry reaches for a
screen, or if `marked`/`dompurify` appear outside the prose engine. `npm run
build` prints the chunk list — the entry chunk should not grow without a reason.

## Voice mode opens a microphone

The microphone is the one control in the composer that reaches a device. It sits
in the context row immediately **before Composer help**, and it opens a full
dialog: the animated entity mark, its mood emoji at full size, the live
transcript, and a typed field for when speech is not there.

- **The engine is chosen, not assumed.** `src/lib/voice.js` runs an engine ladder:
  the browser's `SpeechRecognition` when it can start, a local whisper CLI through
  `voice.transcribe` when it cannot, and typing when neither exists. Electron
  exposes the constructor but has no recognition service behind it — it answers
  `network` — so the desktop app uses whisper, and the dialog names whichever
  engine is in use. A listening button that cannot listen is not a state.
- **One microphone, owned by the dialog.** The stream opens with the dialog and is
  released by `teardown()`: recognizer stopped, tracks stopped, audio context
  closed. A closed dialog with a hot microphone, or a recorder that survives a
  thread switch, is a bug.
- **Talking wins.** A finished utterance while a turn runs interrupts it: cancel
  the turn, wait for `waitForTurn` to report the thread idle, then send the new
  words as the next message. Never start a parallel turn, which `chatSend`
  refuses anyway, and never drop the new context.
- **An interrupt is a turn handover, and it races.** The cancelled call settles
  *after* the next turn started: its snapshot predates the new question and its
  `finally` must not clear the flag the new turn owns. `hub.chat` gives each send
  a per-thread turn token — only the current owner applies a snapshot or clears
  `sending` / `live`, and a stale `chat.turn` event may append its own row but
  never paints steps or takes down the live bubble. Without this the new
  question appears and then vanishes.
- **The voice must not cut itself off.** While the entity speaks, the local
  segmenter is *held*: the microphone stays open for barge-in but records
  nothing, so the entity's own voice is never transcribed and never trips
  barge-in. Taking the floor needs a sustained signal above both `bargeThreshold`
  (2.4× the room's speech floor) and 1.7× the level the entity's own output
  measures at the microphone, for 300 ms; the first 600 ms are ignored. The
  gate adapts to the speaker volume, so a loud laptop cannot cut itself off.
  On the browser engine, which has no microphone handle, barge-in needs a
  partial of two or more words that is *not* an echo (`echoOverlap`). A reply is
  only ever stopped by a person, never by its own speaker.
- **`stop` is an instruction, not a message.** `isStopPhrase` matches short
  commands only, and is checked **before** the echo test — a spoken "stop" is
  short enough to look like an echo. Those cancel a turn locally and are never
  sent to a model.
- **The entity must not hear itself.** Echo cancellation is on, and two tests
  keep the loop closed: `echoLikely` (a *prefix* of the sentence being read,
  used for finals) and `echoOverlap` (word overlap with the last two sentences,
  used for streaming partials). Prefix, not containment: "run the tests" is
  contained in "I'll run the tests now" but is a real thing a person says.
- **A take is a temp file with one owner.** The renderer records 16 kHz mono WAV
  and sends bytes, never a path or a command. `electron/voice.cjs` writes it to a
  `mkdtemp` directory, runs the probed binary and model, and removes the directory
  in a `finally` — a recording must not outlive the call that made it.
- **The model is discovered, not downloaded.** `ENTITY_WHISPER_MODEL`,
  `~/.entity/models`, `~/.cache/whisper.cpp`, the Python cache, and the Homebrew
  share directory. The smallest model wins; latency is the feature.
- **A blocked engine says why.** Unsigned/permission-denied/service-less all get
  a sentence and a Retry, and the typed field stays usable. Silence is not an
  error message.
- **The spoken words are also written.** The dialog shows the reply text and
  highlights the sentence being read (`onChunk`). Speech synthesis has odd
  accents and no subtitle track; a person must be able to read what they hear.
  The same text is available afterwards: every agent message has a read-aloud
  action beside copy, share and save.

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
7. If the page has a composer, put a direct attachment button before send, accept
   drops on the dock, and document every token in Composer help.
8. If arrow keys move a selection, scroll the active row into view. If a shortcut
   targets a rail, resolve the active rail instead of a fixed component.
9. For inventory rows, test zero data, hundreds of items, one separator system,
   and a compact summary. Details belong in the expanded body.
10. If the page lists links or paths, derive them from the transcript, stat every
    local path, and validate membership again in the main process before acting.
11. If the change taught you a new failure mode, add a row to **Common
   mistakes**. If it introduced a new kind of surface, add it to **Surfaces**
   above.
