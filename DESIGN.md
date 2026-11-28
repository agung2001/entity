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

#### A capability read is two calls, and the cheap one paints first

Account → Integrations is three services, each answering "is this usable" by
spawning a binary or searching a remote server. One response carrying all of it
made the page paint nothing until the slowest probe answered.

- **Split the read by its cost.** `integrations.list` is the preference file and
  one `stat` per binary; `integrations.probe` is the status line, and it is the
  only call that spawns anything. The rows land from the first, each saying
  `not probed`, and the page is usable while the CLIs are still being asked.
- **Cache the expensive half, and say whose clock it is.** The probe is cached in
  main for minutes and in the store for the session; the bar prints `just now ·
  cached` so a stale line is never mistaken for a fresh one.
- **`Refresh` is the only thing that pays again.** One button, one call with
  `force: true`. Do not re-probe on mount, on every tab focus or on every write —
  a switch patches its own row and nothing else.
- **A status that could not be read is a sentence, not a zero.** "not probed" is
  a state; "not runnable · ENOENT" is the answer a person can act on.

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

## A selector is the app's picker

Every axis a person chooses — **entity, machine, harness** — is `PickMenu`, never a
native `<select>` and never a bespoke dropdown. The picker is one control with one
set of behaviours, and a `<select>` can carry none of them. `options` is
`[{ id, label, meta, glyph }]`:

```html
<PickMenu
  class="field-select"
  head="Entity"
  icons="entity"
  :options="entityOptions"
  :model-value="entity"
  @update:model-value="entity = $event"
/>
```

- **The mark is the identity.** `icons="entity"` paints the animated `EntityMark`
  plus `moodGlyph(markFor(workspace, id, mark).mood)` on the trigger and on every
  row; `machine` and `harness` use their own brand marks. A `<select>` can only
  print a name, so two entities read as two strings.
- **It is searchable, teleported and keyboard-complete.** The menu goes to
  `<body>` so a scrolling dialog cannot clip it, flips above the trigger when the
  bottom is near, filters on every axis, and closes with the shared `Esc` stack.
- **A locked axis says it is locked** (`disabled` → lock glyph, title with the
  reason). A disabled native select says nothing.
- Filter and sort strips may stay native selects where the value is a word with
  no identity; the rule is about **choosing an entity, a machine or a harness** —
  where a person is picking a thing that has a face.

The New-thread dialog and the chat's context row are the reference
(`NewThreadDialog.vue`, `ChatView.vue`), and `forms.css` owns `.field-select`
(100 % wide, 36 px, `--border-strong`). Reuse both; do not restyle a select to
look like them.

## A destination's mark is drawn once

The rail, the phone tab bar, an empty state and a note on a page all wear the
**same** drawing, and that drawing has one definition: `src/components/NavIcon.vue`
(or `HarnessIcon` / `MachineIcon` / `VoxelMark` for their own families).

```html
<NavIcon name="goal" />    <!-- rail, tab, empty state, note -->
```

- A page that copies the glyph's `<path>`/`<circle>` markup into its template has
  created a second mark that will drift the first time either changes — and the
  empty state was the copy that stopped matching its own rail.
- The shared component is sized by the context (`svg { width; height }` in the
  surrounding block), so reuse costs no CSS.
- Add a new destination by adding one `<svg v-else-if="name === '…'">` branch to
  `NavIcon.vue`; read it from `NAV` everywhere else.

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

### A page ornament is a voxel, not an icon

A cabinet needs a mark. The overview's was four stroked squares, the skills
shelf's a hand-traced 16-cell sword — two drawings in a language the character
does not speak, in two files, each with its own keyframes.

- **Draw it the way `entityMark.js` draws a character**: hand-written masks of
  square cells on an integer grid, one flat fill per light angle (`hi` / `fc` /
  `sh`), two extrusion steps behind the face, merged into runs. No path, no
  stroke, no request.
- **One module, one component.** `src/lib/voxel.js` holds the masks and the
  markup, `VoxelMark.vue` paints one by id (`station`, `drone`, `blade`, …). A
  page picks a shape; it never re-traces one.
- **The fill is the character's own recipe** (`--mk`, mixed toward white for the
  lit edge and toward `oklch(… var(--mk-h))` for the depth steps), never a page's
  second palette. A four-grey ornament beside a `--mk` character reads as two
  species on one paper.
- **Frame the painted cells, not the field.** A station is five rows tall in a
  nine-row box; a viewBox of the whole field leaves a third of the slot empty and
  every ornament arrives as the same small smudge at card size.
- **An ornament does not animate like a character.** One glint in two hard pixel
  steps, and nothing under `prefers-reduced-motion`. No gaze, no blink, no
  requestAnimationFrame loop for a 36px drawing.

### A scan result is a fact about a row, not a notification

Workspace → Machines was a three-up gallery of `.mcard`s — a roster drawn as a
gallery, which `DESIGN.md` names as a mistake two sections up. Each card owned five
buttons, and a scan's result arrived as a **toast**: red for eight seconds, then gone.
Two decisions the page made were therefore invisible — why a host is red, and which
machine runs the artifact sweep.

- **A row answers for itself.** Five cells, always in this order: the station's tile,
  the host, its state, its inventory, its actions. The grid depends on that order, so
  the row never reflows; assert `children.length === 5`.
- **The failure reason is a cell, not a toast.** `.mfcap .l1` carries ssh's own words
  with `data-fail="1"`, and `.l2` keeps the last known count (`kept from <date>`) so an
  unreachable host is never mistaken for an unscanned one. A toast may confirm; it may
  not be the record.
- **The control exists where the capability does.** The sweep lives on the two machines
  that can run a pass (`local`, the sync host) and reads `owner decides` on every ssh
  row — an ssh host is a run target, not a daemon. A member sees the same words as
  text, never a button that fails after a click.
- **A name wraps, a count ellipses.** An identifier clipped to `build-box-west…`
  cannot be told from `build-box-east…`, so the name track is sized by its content
  (`auto`) and wraps rather than truncating; the inventory track is the flexible one,
  because its whole string travels in `title`. Fixed tracks for the state and the
  actions, whose words are the app's own.
- **The page height is the hero plus the box.** One bounded scroller
  (`min(62vh, 620px)`), sticky desk, 60 px rows: fourteen hosts and two hundred hosts
  are the same page.
- **A gallery is not fixed by adding a column.** If a card grid cannot say what a row
  needs to say, the answer is the table, not a taller card.
- **A reading rail beside a five-column roster is a tax, not a service.** The entity
  page's rail earns its 306 px because the columns beside it are prose. A roster's
  columns are cells, and the rail took a third of the band to repeat what the hero and
  the rows already said — so its facts become a **row** above the table (`.mach-strip`,
  same `entp-facts` grammar, laid horizontally) and the table gets the whole measure.
  The rule is the shape of the neighbour: prose gets a rail, an inventory gets the band.
- **A custom property is not an inline style.** `.entp-hero` mixes its paper, its grid
  and its shadow from `--hero`; a page that renders the cabinet must publish it
  (`style="--hero: var(--accent)"`), or every `color-mix(in oklab, var(--hero) …)` is
  invalid and the hero falls back to `background: none` — a white rectangle with a
  `currentColor` border. `background: none` on a shared surface is the tell.
- **A roster with a glyph column folds the glyph into the row's first cell.** A
  30px track plus its 14px gutter is 44px of air before the name every row has to
  read; `.skt .nm` puts a skill's sigil inside the name cell for the same reason.
  Keep one flexible track that eats the spare width and three fixed ones, and let the
  last label right-align over its column — that is the grammar both rosters use.
- **A roster with a glyph column folds the glyph into the row's first cell.** A
  30px track plus its 14px gutter is 44px of air before the name every row has to
  read; `.skt .nm` puts a skill's sigil inside the name cell for the same reason.
  Keep one flexible track that eats the spare width and three fixed ones, a uniform
  14px everywhere, and let the last label right-align over its column — that is the
  grammar both rosters use.
- **A table's columns are the reader's.** One `FLEET_COLS` declares all four with
  `min`/`max`/`base`, and `fleetTracks` writes the single template the desk and the
  cells both take. A handle lives in the desk (the one row always fully visible), is a
  real `<button>` — focusable, arrow-nudgeable, double-click resets — and sits pinned to
  its own track, because a grid places in flow and unpinned absolute children all land
  in the first free cell.
- **No column takes the whole spare track.** A count needs a reading column, not the
  widest one: an inventory handed 420px beside a 292px name is a table that looks
  broken even though nothing overflows.
- **One drawing per fact per row.** The station's tile in the first column already
  draws a machine; a server glyph beside the name is the same claim twice, one row
  down from the first.
- **`auto` and `max-content` in a table's track list resolve per row.** The desk and the
  cells below it then get different columns and the header labels run together. Use
  lengths, and cap the track whose content is bounded rather than letting a fraction
  hand it dead space.
- **A page-wide verb belongs on the second row.** `.entp-bar` is the entity page's
  top edge — way back, where you are, and the actions that belong to the whole page.
  *Reload*, *Test every host* and *Forget every fact* act on the fleet, so they go
  there, not in a card above the roster that pushes the roster down.
- **A detail shell is the parent's, and it is not re-entrant.** `WorkspaceView` already
  renders `.view.detail-view` for this tab, so the embedded page's root must not bring
  another: two nested shells inset the hero by 56px instead of 28 and put the roster on
  a different measure from the bar above it. Assert one `.detail-view`, and one child.
- **The second row shares the top bar's gutter, not the reading measure.** `.entp-bar`
  pads `0 var(--view-pad)` and centres nothing, so it bleeds the whole window and its
  first item starts exactly where the top nav's does. A page that "helpfully" centres
  its own bar on the 1180px measure puts the crumb 28px right of the nav above it — the
  one thing a second row must not do.
- **A drawing means one thing.** The Machines page shipped a table grid for *forget
  every fact* and a smaller grid for *forget this host*, a pixel apart, and two broken
  arcs for *reload*. Use the vendored set (`src/components/icons/`, rendered by
  `UiIcon.vue`), and give a fleet-wide verb a different glyph from its single-host
  counterpart — sharing one makes the bar look like it does what a row does.
- **`directory.css` hides `.entp-bar .entp-actions .btn:first-child` below 760px.**
  That is right on the entity page, whose first action duplicates *Open chat* a few
  pixels below. A page whose first action is *Reload* must override it: a hidden
  reload is a page that cannot recover from a stale read.

### Two shelves, two jobs — one tab each, one URL

Artifacts became personal-first, and the settings card did not follow: a personal
file count sat beside a workspace-wide threshold, and the erase section offered
three buttons for two different populations stacked in one column.

- **A rule belongs to the population it governs.** ①/②, the cadence, the
  protections and the one machine that runs the pass are the **shared** shelf's —
  they are workspace configuration every clone reads. Your personal shelf has no
  rule at all: nothing sweeps it, nothing syncs it, and sharing a file is what
  hands it to the rule above. So the card answers one shelf at a time.
- **The tab is the page's own grammar.** The switch is `.sk-tabs` (the app's tab
  look), *inside* the card it belongs to — not a second page and not a second
  navigation.
- **One URL, two axes.** A link into this page keeps `?tab=artifacts`; the shelf
  is `&shelf=personal`, and the default (`shared`) drops the parameter instead of
  spelling out a default. `router.replace`, because a tab is a place — Back
  leaves the page rather than walking through every shelf someone tried.
- **The rule must not leak.** A chart, a threshold and a cadence over a shelf that
  has none is three lies in a row; the personal tab renders none of them and says
  in its own sentence why.
- **The destructive action follows the shelf too.** Shared shows *Erase shared*,
  personal shows *Erase personal*, and *Erase all* stays on both — it is the one
  button whose scope is both populations, and its copy says so.

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
- **A shared shelf has one sweeper, and the rule names it.** The artifact rule is workspace
  configuration in `workspace.json` (an owner or admin sets it once, the server refuses
  anyone else), and its `executor` says which machine runs the pass: the owner's machine
  by claim, the machine that was picked, or the sync host. Every other clone shows the
  thresholds and stands down — its tick and its "Archive due now" refuse. A per-machine
  schedule on a shared shelf is not a schedule, it is N machines deleting one file from
  each other's list.
- **A schedule belongs to the workspace, not to a card.** The Chats card and the Artifacts
  card read the same cadence and deadline (the artifact rule in `workspace.json` owns them;
  a chat-cadence edit writes there). The populations still differ: chats never sync, so
  every machine sweeps its own at that schedule, while the artifact sweep runs only on the
  machine that was picked.
- **The picker lives on the machine's own card.** Workspace → Machines shows one card per
  machine it can run on — this machine and the sync host — and the card carries the
  "run the sweep here" action; the top of the page carries a warning only while nothing has
  claimed the sweep. An ssh host is a run target, not a daemon: a sweep only runs where the
  workspace is, so ssh cards have no such action, and the machine inventory has a search
  field like every other list.
- **The rule travels; the facts do not.** Thresholds, cadences and the executor sync.
  The archive folder, the archive date per file, the opened map and the moment this
  machine took the sweep over stay local. A machine that takes an existing sweep over
  inherits no age — a file nobody opened counts from its mtime or the takeover, whichever
  is later — so a hand-over cannot archive a shelf that was healthy elsewhere.
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

### A deadline the person cannot move is a bug report

A turn is stopped by a wall clock, and that number used to be `ENTITY_TURN_TIMEOUT_MS` —
an environment variable nobody sets. The complaint was exact: "there are no options to
control the maximum chat timeout limit".

- **A clock is a setting, and it lives on the card it bounds.** Workspace → Chats carries
  *How long a turn may run* under the two retention thresholds: same card, because both are
  about threads; a separate block, because one counts *silence* and the other counts *wall
  time*. Never on the same list.
- **Read it when the turn starts.** A deadline resolved at `require` time cannot move until
  the app restarts, which is not a setting. `turnTimeoutMs()` is called at spawn, so the
  next message is the first one that gets the new clock.
- **The environment still wins, and the field goes read-only.** `ENTITY_TURN_TIMEOUT_MS`
  pins the number in the E2E suite; a page that silently ignores every edit is worse than
  one that says "this app was started with it". The row states its source: `this build's
  default` / `saved in ~/.entity/turn.json` / `set by ENTITY_TURN_TIMEOUT_MS`.
- **Refuse, do not clamp.** 7 minutes or 9 hours is an error the field can show; snapping it
  to the nearest legal step saves a number the person never chose.
- **Zero is not "no limit".** A turn is always bounded — an unbounded one is a leaked
  promise and a card that lies about still thinking.
- **Offer the steps, keep the field typeable.** A picker of 10 · 15 · 20 · 30 · 45 · 60 · 90 …
  for the common case, and 25 or 50 still works.
- **The silence timer is a different clock and says so.** Fifteen minutes with no output is
  not the same sentence as a whole turn's deadline, and the card must not blur them.

## A delegation is a session, and the session is not a row

Starting a second conversation from this one is not a button in the header and not a
panel above the composer — both were built, shipped and rejected on sight. It is what
the composer already does: mention another entity.

- **A mention is the trigger.** `@entity <job>` runs the job in the turn *and* files a
  session. No second verb, no prefilled dialog, no floating card: the thing you already
  type is the thing that spawns.
- **A read is an answer, not a prompt.** A message that is a connector mention and nothing
  else — no words outside it, nothing under it on its own line — is already answered: the
  rows resolve, and the app writes them into the transcript as the reply. Nothing is
  spawned, no model is called, no MCP tool is reachable. A harness handed that message has
  no instruction to follow, so it invents one — a mention-only YouTube Studio summary
  became a YouTrack search for "a board issue about this video", which is an expensive way
  to ignore the subscriber count that was already resolved. Words, a second line or an
  `@entity` make it an ordinary turn again, and the rows travel in that turn's `sent`, so a
  follow-up can read them (`mention-ref.cjs` `askedOnlyReads`/`answerFor`, `chat-store.cjs`
  `send`).
- **One optional field, on the child**: `spawnedFrom: { workspace, id }`. Both directions
  are derived from the list the window already has; a children array would be a second
  copy that can disagree. A link to a thread that is gone reads as "no link", never as an
  error.
- **The run is continued from where it happened.** The delegation card carries
  **Continue** at its top right, which opens the session that run created — the job, the
  answer, its steps and its timing are already in it. A card with no way out is a dead
  end someone will click twice.
- **A run knows where it came from.** A child session starts with a fresh transcript, so a job
  that says "implement A" has nothing to resolve it against. Every delegated run is handed the
  last exchange of the conversation that asked for it — the ask before this turn, and the answer
  to it — plus the real path of any `artifact://…` that exchange names, because the run has no
  mention layer to turn that notation into a file. It is a hand-off, not a transcript: bounded
  (400 + 2 000 chars, cut with `…`), never the current message repeated back, and labelled
  *background, not your task* so the run does not redo the work. It rides **after** the job and
  the share note, so the first line is still the instruction and the card still shows the job
  alone. A block that travels again is cut at its own marker first — a grandchild gets one
  block, never a block inside a block. The held card shows the block too (clamped, with
  **Read more**), because a prompt approved with half of itself hidden is approved
  blind.
- **A session is not a rail row.** The rail lists the conversations the person started;
  a busy thread can own a dozen sessions, and rows for them drown the list. The parent
  row carries `spawned N chats`, the count opens a tree (sessions of sessions included),
  and opening one marks the parent row active so the rail still says where you are.
- **A message is classified, not pattern-matched, into one of two answers.** Every message a
  person sends is one of two things — several parallel sessions, or one direct reply — and no
  regex can tell them apart. `intent-ref` asks the harness that is about to answer the turn and
  gets back **a list of runs** — `{spawn: true, runs: [{entity, job}, …]}`: one entry per run,
  each naming its agent and, in its own words, what that run must do. Two entries may name two
  agents and two different jobs. `rows`/`list` remains for one shared instruction over a list of
  *items* (one run per item), and `{spawn: false}` is a verdict: the message runs exactly as
  written. A plan is never re-read as mention syntax: its entries become the runs directly, so
  a job containing an `@`, a colon or a newline is prose (see `plannedSegments`).
- **A delegation is always classified; the grammar only decides whether there is one.** The
  grammar can split `@entity` from its job and nothing more: it cannot see that two lines order
  two different jobs, so `let's spawn 2 @coder:` over two bullets handed both runs the same
  paragraph — run 1 and run 2 each opened with the other's work. The one thing still decided
  without a call is a message that names no entity with a job: it has nothing to delegate.
  Everything else that delegates pays one call, including a message that writes its own `spawn
  N` and one that addresses two agents. Two guards keep a plan from lying about what was
  asked, and both fall back to the grammar, which read those mentions exactly: it may not name
  an agent the message never addressed, and it may not collapse two job-bearing mentions into
  fewer runs. This is not intent parsing — it is the difference between a job the grammar
  *split* and a job it *read*.
- **A plan is one entry per run, and every entry says what that run does.** The same words
  repeated N times is still N entries (collapsed to `repeat` here, because the card says "one
  instruction, N sessions" better); a different job per run is N entries with different words;
  two agents is N entries with different `entity`. The failure this shape exists to stop is one
  paragraph handed to every run — four agents then redesign one page, and two agents each open
  with the other's half of the work. A message that enumerates *items* (pages, files, URLs,
  issues) under one instruction is the `rows` reading instead: the item travels with the run.
- **A written count over bullets that are orders is read without a model.** When the number
  after `spawn` equals the bullet count and the bullets are prose orders (no URL, path or `@`
  reference — the thing that makes a bullet an item), `repairWithRuns()` turns them into one
  run per bullet. This is the narrow, provable half, and it exists for the turns with no
  classifier (the CLI, a spawned session): a plan the model did return is a reading of the
  message and is left alone, and concrete references stay rows.
- **A list on screen is read from the screen.** `intent-ref.listedItems()` takes the **last**
  run of bullets in the message — the work, not the material quoted at the top ("By following
  the design of:" … then "I want to improve these pages:") — and `repairWithList()` promotes a
  `repeat` plan over 2+ concrete bullets into one run per row. That is not a second guess at
  intent: it is reading what is literally written, and it removes the variance where a model
  read the count and ignored the list. A plan that already named its rows is left alone.
- **A row owns a line, never a comma.** `SPAWN_ROWS` splits on newlines when the list spans
  lines, and on commas only for the inline `[a, b, c]` form. A typed plan is therefore rendered
  one row per line, so a page whose title contains a comma ("use the avatar, not an animation")
  is one run, not two runs on half a sentence each.
- **The classifier copies words; it does not write them.** `job` is the person's own sentence
  with the count, the items and the whole-message context removed, because every run is told
  its own row separately. A rewritten job produced things like "work the issue relating to",
  which is worse than a leftover clause. Every instruction sentence must survive — dropping one
  silently changes the work. The prompt says so, and asks for `{"spawn": false}` whenever
  unsure: a missed fan-out costs one retype, a wrong one starts agents on work nobody asked for.
- **A fan-out may take its count from a list, and then the row is the run.**
  `spawn per @<list> @entity <job>` resolves the list first, copies the entity once per
  row, and titles each session with its row — seven issues read as seven sessions, not
  seven copies of one instruction. The cap is the reply's own row budget (eight): one run
  per row, one row per answer, no answer silently dropped. When no mention can enumerate the
  list, the rows are typed: `spawn per [a, b, c] @entity <job>` — one run per bracketed row, the
  same cap, and the row is still the session title. A list that resolves nothing
  runs nothing — a delegatee holding the instruction but no row would pick one.
- **A `/workspace:` at the front is carried onto every run.** That is what the person meant by
  it, and refusing it only taught them to retype a message the app could already read. A
  classified fan-out moves the composer's prologue onto each job (one skill per run, one
  worktree per run); a job with its own `/workspace:` keeps that one instead of two.
- **Silence is not a guess.** An explicit `{"spawn": false}` is respected. A pasted issue URL
  is authoritative for the **list** even when the model answered: `…/issue/ENTITY-25/…` →
  `relates to: ENTITY-25`, while the model's `entity` and `job` stay. A reader that says
  nothing — no JSON, a non-zero exit, a timeout — or returns a plan the app cannot resolve
  (not an explicit no) falls through to `derivePlan`, so a lost or prose answer costs a blunter
  job, never the fan-out.
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
- **The card is a glance; the session is the report.** The whole answer is stored per run
  and painted whole in the session **Continue** opens, so the card clamps its own copy at
  six lines — height removed, access untouched. A "Show more" on the card would be a
  second answer view competing with the one way out.
- **The reply above keeps both ends of a row.** A row's verdict (`still running: …`,
  `unverified: …`) is the last line it wrote, so the digest is head 240 + tail 160: a
  head-only cut showed seven setups and none of the seven endings.
- **A card may say where the worktree is, never guess.** One `mention.worktree` call on
  mount reads the run's **own** record first — every `…/orca/workspaces/<repo>/<name>` path
  it names, kept only where that exact path appears in `orca worktree list` — and matches the
  row's ticket key only as the fallback, because a fan-out shares one cwd and one key and the
  key alone paints N cards the same word. `git status` runs on a path Orca itself returned
  and nothing else; a cwd outside every checkout narrows nothing rather than hiding the chip.
  `gone` is the record naming a workspace Orca no longer lists, because Orca forgets a removed
  worktree and absence alone cannot tell "merged and removed" from "never created". The chip
  paints the workspace's own name (state dot in `data-state`), so three cards are three names.
- **The card is three bands, and the identity is the first one.** Kicker, name and the
  workspace chip share a single non-wrapping line whose name and chip shrink with an ellipsis
  rather than pushing a second row; the meta (`harness · model · duration`) and the one action
  take their own band, where the meta may wrap and the action keeps the right edge; the job is
  a full-width block whose row and text are blocks in every card, so the instruction is never
  clipped, wrapped into, or read as part of the head.
- **`run N/M` is a per-run label of its own.** It sits in the identity head as a quiet token
  beside the name — never a fragment of the meta string — because it says which of N this card
  is, and a reader who cannot find it treats the card as the whole fan-out.
- **Send is not the confirmation; the runs wait.** A message that plans a run is sent as
  always — its reads resolve, and only the runs hold — so `@coder <job>` goes from keystroke
  to running with one extra keystroke, and a seven-row fan-out is reviewed (count, target,
  folder) before anything starts. **Run** is the one action; the block is the live bubble,
  and it becomes the fan-out's own cards on Run. Never a modal, a second composer or a
  pre-send dialog.
- **The plan is a form, and Run sends what is on screen.** One **delegation instruction**
  band above the cards, one **child instruction** per card, a `−`/`+` stepper for the count,
  `⌥⇧R` to run it. The band is the message the person actually sent (`ctx.opening`), not the
  first child's job: the children are derived from it. A card's child instruction is what the
  classifier made of that message **plus the conversation block**, so the card shows what runs;
  it is clamped at four lines, and **Read more** opens `PromptDialog`: two fields, `Delegation
  instruction` and `Context from this conversation`, each on its own lines — a 2 000-character
  block is not one long paragraph to be scrolled. Editing there makes that card's prompt the
  whole prompt, and the engine does not append a second block.
- **Update re-derives the children; nothing else rewrites them.** Editing the band and pressing
  **Update** calls `chat.replan`: the same classifier reads the edited message and the cards are
  rebuilt from its runs, with the conversation block the plan already had. A read — the hold
  stays open, nothing is written to the thread, and Run still starts the cards as they are.
  Editing the band does **not** string-substitute into the cards, and there is no `Use the
  task`: a child instruction is independent once it stops following the band. "Follows the
  band" is explicit ownership (`own`), not `child !== band` — a child always differs because it
  carries the block, so a string comparison badged every card `edited`. The
  revision rides on the answer (`chat.delegate` gets `count`, `instruction`, `rows`) and is
  applied once, before the first harness exists — so there is no write in flight to debounce,
  no read-only state and no second round trip. A card the person did not touch follows the
  band; one they edited keeps its words and says `edited`. `Run all` refuses while a card is
  empty, and so does the key, because an empty run starts a session with no question. A plan
  whose runs have their own instructions is the case the band must not misdescribe: it names
  how many cards still read it, because "sent to both runs" is false when only one does.
- **A row that has a source is the way to it.** The row line on a card — the issue a fan-out
  resolved to — links to the URL the read recorded for that row (`rowUrl`, carried on the plan
  row and kept on the mention, so the card still links after the run lands). Only `http(s)`
  becomes a link: the shell opens the browser and nothing else, so any other scheme would be a
  link that does nothing. A row with no source stays text — the card names the issue either way.
- **The gate never opens behind a refusal.** An unknown name, a cap, an empty list or a
  skill in front of a fan-out throws before a plan exists, and a reference mention (`@coder`
  with no job) plans nothing. A confirmation asked after a refusal teaches people to click
  Run on what cannot run.
- **A run that delegates again cannot ask.** A spawned session is headless and told not to
  ask, so it starts immediately and inherits the answer it was given: one gate per turn, at
  the top — a hold inside a run is a hang nobody can see.
- **A failed session is retried where it happened.** The question lives in the session,
  so `Retry` re-runs *that* thread: the card keeps the history it painted, and the answer
  lands where `Continue` already points. Every surface that can show the failure carries
  the action — the card retries its own run, the fan-out's own line (`7 of 10 sessions
  failed`) retries them all, and the tree's footer does the same for every session it
  lists. A bulk retry is the fix, not the reason a dialog exists, so it is not the yellow
  primary.
- **A failure outlives its turn, so the row is the truth.** The mention stored in the
  message records what that turn did; the session row records what is true since. A card
  whose session has answered says `retried` and drops its red border, and the fan-out's
  line goes with the last one — a count that keeps counting a fixed failure teaches
  people to ignore the count. The rail's `spawned N · M failed` is how a person finds out
  about a fan-out they left behind, and it opens the tree where the retry is.
- **A settled plan is still a row.** Cancel, Stop and the ten-minute expiry land in one
  grammar — `Nothing started`, the rows that never ran, the app's own **Retry** — and the
  question stays in the transcript. A hold is in memory, so a reload reads `Interrupted`
  and nothing was ever started.
- **Retrying a prompt is a turn, so it is confirmed at the question.** `Retry` sits in the
  prompt's own actions row, after copy and share, and the failure row keeps its own button;
  both open the same `PromptRetryDialog`, because a second copy of the retry path is how the
  two drift. The dialog says which of the two things will happen, read from the transcript
  rather than remembered: while the only rows under a question are its failed turn, the
  retry replaces that error in place and the question is never duplicated; once an answer
  (or a newer question) sits below it, the retry is another turn and the earlier answer
  stays. Opening the dialog sends nothing — the confirmation is the click.
- **A count of one is still a delegation.** The parent prompt swaps the raw sentence for
  "that run already happened" whenever the message delegated anything — `spawn 1`
  included. Gating that on `count > 1` read one requested run as an ordinary message, so
  the child answered and the parent then did the same work a second time as its own job.
  The sentence that delegated work is never the parent's task, whatever the count.
- **A job the grammar cannot read is a reason to classify, not to run.** The grammar
  always *splits* `@entity` from its job, so it never demoted itself — but a split can
  throw the instruction away: `@designer on @orca:entity <the real ask>` yields the job
  `"on"`, because a delegated job ends at the next `@` and the person's sentence
  continues past it. Every delegation is classified now, so this message is read like
  any other: the model hands back `spawn 1 @entity <the whole instruction>` — including
  the repo named in words — and the ordinary card confirms it.
  `openingProseHasUnreadableJob` survives as the fallback that refuses a preposition when
  no classifier is there (CLI, a spawned session). **A plan of one run is a real plan**:
  `usable()` used to drop `runs: 1` on the ground that "the grammar already delegates
  that", which was only true when the grammar could read the job. The refusal is the
  no-classifier fallback, never the answer itself.
- **A stopped turn still filed its sessions.** `chat.send` writes one per entity mention
  before the harness answers, and Stop does not take them back. The delegation card used
  to render only on an `agent` row, so a turn that ended as `Stopped by you.` showed no
  card and read as "nothing was spawned" — while the session sat in the rail under its
  parent. The card belongs to any row that carries mentions, `sys` included.

## An erase-all is a dialog, and the scope is the button

Workspace settings → Chats and → Artifacts each carry the one control on the page
that is not a threshold: it removes the whole population. The retention sweep has
an undo (a number), this does not, so its shape is stricter than everything around
it.

- **The card says the scope, the dialog says the count.** Artifacts has three
  populations on screen — the shared shelf (`artifacts/` with its `.archive/` and
  `.trash/`), the personal shelf (`.personal/<account>/artifacts/`), and both — so
  it gets three buttons. One "Erase all" that removed all three could not say
  which half a person meant, and a scope the store does not know is an error, never
  a silent `all`. Chats has one population (every thread, archived included) and
  therefore one button.
- **The erase is one call, not a loop in the window.** `chat.eraseAll` and
  `artifact.eraseAll` are verbs in the call table with a `{ removed, bytes }`
  answer; the renderer never walks files, and the effect on screen (rail rows,
  drafts, the shelf's counts, an open artifact preview) is dropped by the store
  that owns it.
- **A half-truth is the bug.** The archived and trashed files are dot folders the
  shelf walk skips, so "erase the shelf" has to walk them as their own
  populations; an erase that leaves `.archive/` behind is the failure this button
  exists to avoid. A personal shelf is the account's own, so `shared` never
  touches it and `personal` never touches a colleague's folder.
- **A turn in flight refuses the whole erase, before the first file.** A thread's
  final write would put one row back, and a history that is empty except for a
  resurrected row is worse than one that was never erased. The verb throws; the
  dialog shows the reason.
- **The word is a guard, not a ceremony.** The primary stays disabled until
  `ERASE` is typed exactly (case-sensitive — a typo is not consent), the field is
  focused on open, and `Esc` and the scrim are guarded while the write is in
  flight. The primary names the population it removes (`Erase shared`, `Erase
  personal`, `Erase everything`), because three buttons open one dialog.
- **The counts come from the card's own store.** The dialog is handed `{ count,
  bytes, extra }` computed from the retention `meta` the page already draws, so
  the number in the confirmation and the number on the badge beside it cannot
  disagree. The workspace itself, its entities and its rule are stated as staying.

## A dialog reads as a dialog, and its scrim is not a drawer's

`.modal` is 520 px and a drawer is 430 px; both sat behind the same 24% scrim, so
"a place you must answer" and "a second view of this row" looked the same. And one
surface took a width class nobody had written a rule for, which is how a dialog
became a 1080 px slab.

- **A dialog is `min(px, vw)`, and the ceiling is a reading decision.** 520 px is
  the default; a surface that shows a two-column diff may ask for ~860 px, and
  beyond that the extra width buys nothing but a slab. Never a bare width, and
  never a class with no rule behind it (`modal-wide` had none for two releases).
- **One padding scale per dialog.** Declare it on the surface's own selector
  (`.learn-modal { --learn-pad: 20px }`) and spend it on `.mo-head`, `.mo-body`
  and `.mo-foot`, so all three bands line up on one left edge. `.mo-head` owes
  the body a bottom gap; a head with `padding-bottom: 0` butts a scrolling body.
- **The two-column diff is a wide-window luxury.** Below **760px** it stacks into
  one labelled column and gives the body its only scroller; `min-width: 0` and
  `overflow-wrap: anywhere` stay on every cell. A second scrollbar at 390 px is
  the failure, not a clipped line.
- **`scrim-dialog` is the one dialog variant**, next to `.scrim` in
  `surfaces.css`: deeper (42%) and blurred. Drawers keep the base scrim. Do not
  fork one variant per dialog — `EntityLearnDialog` is the surface that paid for
  the rule, and a second dialog that needs a third darkness is a third mistake.

### A review is bought once, with its scope on screen

Learning used to open, spend a harness turn, and only then say how much it had
read. The scope is the thing a person is paying for, so it is chosen first.

- **Opening a dialog is not running it.** `EntityLearnDialog` shows its scope
  form with one primary in the *body*; the footer keeps its three verbs. The
  clock starts when that primary is pressed, not on open.
- **The count, the dates and the ceiling are named.** A number field capped at
  the entity's own conversation count, presets (`5 / 10 / 25 / All`), a `since` /
  `until` pair where empty means no bound, and a busy line that says `Reading 12
  of 34 conversations, since 2026-11-01` beside a ticking `mm:ss`.
- **The renderer proposes, the main process validates.** `limit`, `since`,
  `until` and `ids` are re-read at the trust boundary (`electron/learn.cjs`
  `scopeOf`): a non-integer, a `0`, an unparseable day or an empty id list throws
  with a sentence — never a silent fall back to the ten most recent.
- **A scope is filtered before it is counted.** Dates and ids narrow the set,
  then the limit cuts it, so "3 of 5 asked" means five matching threads existed
  and three were read — not three inside a scan of three.
- **A ceiling nobody can move is stated.** The wait names its limit
  (`gives up after 5 minutes`) from a constant that mirrors `TIMEOUT_MS`; there
  is no streaming for `entity.learn`, so a clock is what the wait has.

### A write is confirmed on the form that owns it

`Create goal` used to store on click, from a button that showed a count. The
confirmation is not a second dialog with a summary of a summary: it is the goal's
own five fields, reopened over the plan.

- **One form, two mounts.** The fields live in `components/goal/GoalFields.vue`;
  step 1 renders it inline and the review renders the same component inside the
  modal. A copied form is the version that drifts — the review would keep asking
  for a field the page had dropped.
- **The confirmation names what it will write.** `5 tasks · 2 critical · 4
  entities · due 12 Dec 2026` above the fields, and `Nothing is written until you
  create it` beside the scrim. The primary says the verb, not "OK".
- **Refusals land in the dialog.** A `save` that throws prints in the surface
  that asked; closing it to read the error moves the person away from the fix.
- **A review is dismissible like any surface.** `useDialogDismiss`, the
  `scrim-dialog` variant, and the footer's `Back to tasks` — the same three
  exits a dialog already owes (see above).

### A planned list is re-planned, not spliced

A drafted plan is dates, entities and efforts the planner reasoned about
together. Adding a row by hand makes every later date a lie, so the edit is a
turn:

- **`goals.draft` plans; `goals.revise` adjusts.** Revise is handed the current
  plan as JSON and returns the whole list, not a diff; its instruction says
  *keep titles the change does not touch* and *a removed task must not come
  back*. Two prompts exist because a model told to "plan again" quietly rewrites
  rows it was not asked about.
- **The row can appear at once, the dates may not.** An added task shows
  immediately (that is what you asked for) and the table is read-only while the
  turn runs; a failed turn keeps the row and says the plan was not re-balanced.
  Never re-date locally as a fallback.
- **The turn is visible.** `re-planning with {entity}` with the same `m:ss`
  clock as the draft, and after it lands, one line: `Re-planned · 6 tasks`.
- **`+ Task` opens a composer, not a form.** Title, priority, entity, effort and
  date are the planner's answer; a modal that asks for them first asks the person
  to do the planning. The dialog says what it will do (`Add and re-plan`) before
  it does it.

## Common mistakes

| Symptom | Rule | Where it is enforced |
| --- | --- | --- |
| A dialog closes with the X and the scrim, but not `Esc` | Register the dialog with `useDialogDismiss` | `npm test` (every `.modal` must import it) |
| The launcher shows a generic mark instead of Entity | A Linux icon is a hicolor ladder, not one 1024 px PNG, and Electron's `app_id` must match the desktop file: `desktopName` + `linux.syncDesktopName` in `package.json`, `build/icons/*.png`, then refresh the host icon cache | `npm test` (`desktop-shell`) |
| A browser install falls back to a generic app icon | A manifest needs PNG marks at 192 and 512 beside the scalable SVG; many installers ignore an SVG-only list | `npm test` (`desktop-shell`) |
| `Esc` works only after clicking inside the dialog | Never use `@keydown.esc`; use the document-level stack | `npm test` (forbids `@keydown.esc`) |
| `Esc` closes the dialog *and* the picker behind it | Register popovers (`PickMenu`, `ModelInput`, …) too, so the stack closes one layer at a time | `useDialog.js` stack order |
| `Esc` closes a dialog mid-save and leaves a spinner | Pass `guard: () => busy.value` | Each dialog's `useDialogDismiss` |
| The scrim and `Esc` leave different state behind | One close function for every path | Review |
| A dialog has no dimmed backdrop / cannot be clicked away | A modal is scrim + dialog + close button + `Esc` | `RemoteConnectDialog`, `RemoteSyncPanel` for the pattern |
| "Erase all" leaves `.archive/` or a personal shelf on the disk | The dot folders the shelf walk skips are walked as their own populations, and one scope per button | `npm test` (`erase-all`) |
| A destructive dialog's primary fires on one click | Type the word, case-sensitive, primary disabled until it matches | `tests/e2e/full/21-erase-all.spec.js` |
| A tooltip says `⌘K` but the handler was changed | Combo comes from `shortcutLabel(id)` | `npm test` (forbids `⌘` / `Ctrl+` in `.vue`) |
| A header button says "Timeline" and nothing about `⌥⇧T` | The chip is the only place a combo is written before a hover, so the bar gives up the label before it gives up the chip — and the header answers to its own column, never to a `@media` width | `ChatView` header (`@container cphead`) |
| A thread can only be renamed with the mouse | The title is a surface too: a catalog key puts the caret in it with the old name selected | `src/lib/shortcuts.js` (`thread-title`) |
| Clicking a thread leaves the page blank (or on the one you left) with no sign of work | The read is flagged in the store and the view paints the transcript's own shape, one beat late so a fast read does not flash | `ChatView` (`.chat-opening`), `npm test` (`ui-contract`) |
| Typing `?` in the composer opens the help guide | Check `isEditable(event.target)` before a bare-key shortcut | `HubLayout.onKey` |
| A bare-key shortcut fires while someone is typing a URL or a path | A `search`/`focus` key carries a modifier (`⌘/`), or guards `isEditable` | `src/lib/shortcuts.js` |
| A detail page wraps its breadcrumb row in a card, or sizes it to the reading measure | The bar is the page's top edge: sticky, glass, spanning the content area (`.detail-view` + `.entp-bar`) | `npm run build` + the entity page at two widths |
| A rail's search has no hint while the chat rail does | `.search-kbd` with `shortcutLabel('inventory-search')`, one class for every searchable list | `DESIGN.md` → *Every searchable list says ⌘/* |
| Two surfaces invent a second key for the same "search this list" | One id (`inventory-search`), one meaning per surface | `src/lib/shortcuts.js` |
| A digit shortcut never fires, though the handler looks right | Match digits by `event.code` (`Digit1`), not by `event.key`: Option+Shift+1 is `!` | `matchesShortcut` |
| A new page has a key handler that fires while typing | Guard `INPUT`, `TEXTAREA`, `SELECT`, `contentEditable` | `AppRail`, `HubLayout` |
| Two surfaces open and both close on one `Esc` | One stack entry per surface, last opened is top | `useDialog.js` |
| A new shortcut exists but is not in `?` | Add it to `SHORTCUT_GROUPS`; render the guide from the catalog | Review + guide |
| Escape handlers on elements that never receive focus | The listener belongs on the window; the surface registers its close | `useDialog.js` |
| "Copy" does nothing and the toast blames the content | `navigator.clipboard` rejects in the packaged app; go through `src/lib/clipboard.js` (clipboard API → selection fallback → `false`) and let the toast say which happened | `npm test` (`clipboard`) |
| Escape does nothing while an artifact preview has focus | A frame never receives the window's keydown: forward it from the frame's own document | `tests/e2e/full/16-artifact-scope.spec.js` |
| A dialog opens with focus still on the page behind it | Focus the first control on open, and give the dialog its confirm combo | `tests/e2e/full/01-thread-lifecycle.spec.js` |
| A scan result is announced only by a toast, so a red row explains nothing afterwards | The reason is a cell on the row (`data-fail="1"`), with the last known count beside it | `npm test` (`ui-contract`), `tests/e2e/full/24-machines-fleet.spec.js` |
| A table hands one column the whole spare track | Size every track to its content and let the reader drag: a 420px inventory beside a 292px name is what "the table width is weird" means | `tests/e2e/full/24-machines-fleet.spec.js` |
| A resizable column has no floor, so its header truncates | Each track carries `min`/`max` in one declaration, and the desk's label is what sets the floor | `npm test` (`ui-contract`) |
| A grid's resize handles all resolve against the row | Name each handle's track (`grid-column`), or every absolute child lands in the first free cell and one drag moves the wrong column | `tests/e2e/full/24-machines-fleet.spec.js` |
| A bound `grid-template-columns` wins over the mobile container query | Apply the template only in the band that uses it (`null` below 460) | `tests/e2e/full/24-machines-fleet.spec.js` |
| Two glyphs on one row say the same thing | The station's tile already draws a machine; a server icon beside the name is the second one | `tests/e2e/full/24-machines-fleet.spec.js` |
| A field's bottom border touches the table's top border | Two hairlines a pixel apart read as one thick rule: the field wants a gap *below*, even when it wants none above | `tests/e2e/full/24-machines-fleet.spec.js` |
| A dashboard re-reads on every visit, or its `cached 15 min` label outlives the constant | One read a day into `<ENTITY_HOME>/github-dashboard.json`, refreshed only by the explicit verb or the expiry, and the label reads `cacheTtlMs` from the payload instead of typing the number | `electron/connectors/github/dashboard.cjs`, `connectors/github/GithubDashboard.vue` (see *A dashboard caches for a day, in a file*) |
| A right-aligned column has a left-aligned header | Align the desk's label to the cell's own `justify-content`, or it reads as a different column | `tests/e2e/full/24-machines-fleet.spec.js` |
| A field's glyph reads as glued to the first letter | `.wsl-search` is a 32px box around a 20px input; give the input `height: 100%` and the field the app's other field's gap (9px) | `tests/e2e/full/24-machines-fleet.spec.js` |
| A labelled control renders as a box inside a box, with the input hanging out of the bottom | A layout wrapper is not a primitive: `.field` is a *boxed control* on the connector page (`connector-page.css:3979`), so a panel that borrows the name draws that border and 34px height around its own label too. Name the wrapper (`ts-port-field`) and its parts (`ts-port-lbl` / `ts-port-input` / `ts-port-hint`); reach for `.field`/`.input` only when the box is what you want | `src/styles/tailscale.css`, the connector page at two widths |
| The packaged app throws `spawn ENOTDIR` where the checkout works | `app.asar` is a *file*, so spawning with it as `cwd` fails before the command is read — and there is no `npm` or `node_modules` in a packaged build at all. Ask the filesystem what a Start can do (`planOf`) and serve `dist/` from this process when there is no checkout | `npm test` (`tailscale`, `lan-server`) |
| A host name is plain text while a tiny arrow beside it goes somewhere | The name is the link, the row is not: the alias carries the route, the arrow is its shortcut, the address is text | `npm test` (`ui-contract`) |
| A second row is inset 28px from the nav above it | `.entp-bar` shares `.topbar`'s gutter; it bleeds the window and pads its own contents | `tests/e2e/full/24-machines-fleet.spec.js` |
| Two different actions share (or nearly share) one drawing | Vendored iconoir glyphs, one meaning each; a fleet verb never reuses a row verb's shape | `npm test` (`ui-contract`) |
| A section head repeats a count the hero already states | Drop it, and let the field open the table with no gap | `tests/e2e/full/24-machines-fleet.spec.js` |
| A page-wide verb sits in a card above the roster | `.entp-bar`: back-crumb, where you are, and the page's own actions | `npm test` (`ui-contract`), `tests/e2e/full/24-machines-fleet.spec.js` |
| The page is inset by 56px and the bar is on a different measure than the table | One `.detail-view`, owned by the parent; an embedded page brings no shell of its own | `tests/e2e/full/24-machines-fleet.spec.js` |
| A bar action vanishes below 760px | `directory.css` hides the first `.entp-actions` button; a page whose first action is not a duplicate must override it | `tests/e2e/full/24-machines-fleet.spec.js` |
| The hero is a white rectangle with a `currentColor` border | A page rendering `.entp-hero` must publish `--hero`; a missing custom property invalidates every `color-mix()` inside it | `tests/e2e/full/24-machines-fleet.spec.js` |
| A page title wears a trace row's flex layout | `.tr-*` belongs to `TraceTimeline` (`workspaces.css`); a page that also starts its blocks with `tr-` inherits them. Page classes take their own prefix, and a page's title is the banner (`.sk-hero`) rather than bare text | Review, `src/styles/transfer.css` |
| A dialog's list prints `[ "a", "b" ]` | The store answered the two columns nested (`travels: { travels, stays }`) while the sheet read them flat, so `v-for` walked the object and Vue rendered the arrays themselves. One shape for both ends, and the view checks `Array.isArray` before it draws a store answer | `npm test` (`transfer-store`) |
| A passphrase is asked for over a file with no credential in it | The seal is the whole cost of the feature, so only the path that can carry one asks: the sender refuses `includeToken` when the definition holds no real value, and the receiver's `***` never counts as one | `npm test` (`transfer-store`) |
| A connector file promises a client id, a client secret or a token that is not in it | An OAuth client and its refresh token are this machine's (`docs/connectors.md` — one app-wide client per machine), so a sign-in connector's file carries its row and its link code and says so in the sheet. The two columns are the literal file content, never a flattering paragraph | Review, `electron/transfer-store.cjs` |
| A pill describes a file the page has not read yet | Before the first read answers, the extension still does: a `.entity.zip` is sealed whatever it carries, so the pill must not read `readable` while the passphrase field is asking for one | Browser pass, `src/views/WorkspaceTransferView.vue` |
| A disabled control fades instead of flattening | `context.css`'s `.btn[disabled] { opacity: 0.5 }` is app-wide and turns a `--danger` outline into "still a red button, just dim" — a surface whose disabled state is the whole message overrides it with `--surface-2` + `--muted` | Browser pass, `src/styles/transfer.css` |
| The desk's labels do not line up with the cells below | `auto` / `max-content` in a grid's tracks resolve per row; use lengths | `tests/e2e/full/24-machines-fleet.spec.js` |
| A reading rail squeezes a five-column roster into a third of the band | Prose gets a rail, an inventory gets the band: the facts become a row above the table | `npm test` (`ui-contract`), `tests/e2e/full/24-machines-fleet.spec.js` |
| A page nobody gave a rail arrives with a list of ssh hosts beside it | A route with no section draws **no** second tier: `section` returns `null`, the `<aside>` is `v-if`, and `meta.rail: false` tells the phone not to offer a drawer. Never a fall-through to Overview — a default section means every unlisted route inherits another page's list | `npm test` (`artifacts-index`: *a route with no rail specification gets no rail*), `src/components/RailContext.vue` |
| A long harness call on a page is a bare spinner | Stream its phases over `emit` (`goals.draft` → `goal.draft`) and draw the steps plus a local elapsed clock on the page; a spinner says nothing about whether the child is working or stuck | `npm test` (`ui-contract`: the planning turn is streamed) / browser pass |
| A half-written form is lost when the person looks at another page | A multi-step page keeps its draft in the tab: `src/lib/draftCache.js` (sessionStorage, per workspace, 24 h expiry), a restore banner with **Start over**, and a clear on save and on cancel | `npm test` (`ui-contract`: the draft cache is bounded and expiring) / browser pass |
| A page docks the composer and hides its rail, or leaves a "send" the page does not have | Attach and enhance are part of the input: keep `v-model:attachments` bound, and a page whose real action is its own button passes `:show-send="false"` — never `display: none` on `.slash-actions`, which also hides the attachment chips' only path | `src/components/goal/GoalCreate.vue` (attach, enhance, harness; the page's own `Draft tasks`) |
| A surface picks an entity/machine/harness from a native `<select>` | It is `PickMenu`: `<PickMenu class="field-select" icons="entity" :options="…" />` — the mark, the search, the teleported menu and the locked state are the control's, not the page's | `npm test` (`ui-contract`: *a goal's selector and mark*) |
| The same destination has three drawings for one icon | One definition in `NavIcon.vue`; the empty state and notes render `<NavIcon name="…" />` instead of copying the path | `npm test` (`ui-contract`: *a goal's selector and mark*) |
| A roster is drawn as a three-up card gallery | A table with one bounded scroller, 60 px rows and five fixed cells | `npm test` (`ui-contract`) |
| A sweep control appears on a machine that cannot run a pass | The button only where the capability is; a word (`owner decides`) everywhere else | `tests/e2e/full/24-machines-fleet.spec.js` |
| A settings card mixes two populations that have different rules | One shelf per tab, in the URL as a second axis (`?tab=artifacts&shelf=personal`), and the rule renders only on the shelf it governs | `npm test` (`ui-contract`), `tests/e2e/full/23-artifact-shelves.spec.js` |
| An artifact reaches a teammate although nobody shared it | A path is not consent: the scope is the index entry, and the sync manifest carries only what `.scope.json` claims. Files found in the shared tree with no entry are `unclaimed` — personal, and taken back on the shelf's next read | `npm test` (`artifact-scope`) |
| The shared count is 577 on a workspace where nothing was shared | Those were written by hand, by an agent, or by a render; `adoptUnclaimed` moves them to the personal root and `conflicts/` stops being a shelf row | `npm test` (`artifact-scope`) |
| A turn's deadline is a constant, so only an environment variable can change it | A clock is a setting on the card it bounds; read per turn, environment wins and the field goes read-only | `npm test` (`turn-timeout`) |
| A settings field silently snaps an out-of-range value to the nearest step | Refuse it and show why — a clamped number is one nobody chose | `turn-timeout-store.cjs` (`set`) |
| A new harness id is added to `META` and nowhere else | The list is one, but the transcript reader, the remote run, the skill roots and the brand mark each need their own entry — a row whose switch spawns nothing is the bug | `runner-local.cjs`, `chat-transcript.cjs` |
| A cabinet mark is a stroked icon beside a voxel character | Draw it from `src/lib/voxel.js` via `VoxelMark` — masks on the mark's own grid, one flat fill per light angle | `VoxelMark.vue`, `voxel.js` |
| An ornament recolours with the page, or brings its own four greys | Fills come from `--mk` and `--mk-h`, the character's recipe; only the tile behind it follows the paper | `brand.css` (`.vx-*`) |
| A roster of seven items is drawn as a card grid | Inventories are tables: bounded scroll area, one row per item, name as the only link | `tests/e2e/full/18-skills-copy.spec.js` |
| An unreadable directory is reported as "0 skills" | A read that failed is an error note with the reason and a retry; only a missing directory is an empty list | `electron/workspace-store.cjs` (`skills`) |
| A copy lands as `x-2` but still declares `name: x` | Rewrite the declared name, or the roster shows two identical rows and the slash reference resolves to neither | `npm test` (`workspace-skills`) |
| A sheet's footer scrolls out of reach with its body | The footer is a sibling of the scrolling body, not a child of it | `SkillCopyDialog` |
| A whole table row is a link with buttons inside it | Make the name the link and keep the row a container | Review |
| A settings card overflows a phone and the page does not scroll | The grid track is `1fr` (which is `minmax(auto, 1fr)`) and grows to the card's min-content; use `minmax(0, 1fr)` | `responsive.css` (`.acct-page` ≤980) |
| A retention legend and the rule effects disagree | Both read one `region` object; the forecast reads `outcome`, and only it describes the pass | `npm test` (`retention`) |
| The shelf rule never archives anything twice, and never deletes at all | The archive is a folder the shelf walk skips: analyse `artifacts/.archive/` as its own population, and stamp the archive date once on the way in | `npm test` (`artifact-retention`) |
| A per-machine schedule on a shared shelf archives files out of every teammate's list on the next sync | The rule is workspace configuration and exactly one machine executes it; the archive is local, so a second sweeper reads as "the file was deleted" | `npm test` (`artifact-retention`) |
| A scheduled pass re-stamps the date it counts from | The state write is idempotent and stamps only on the transition | `npm test` (`chat-archive`) |
| A rename writes `archived: false` into a thread that never had it | Reads answer true/false; `writeThread` strips the pair when it is false | `npm test` (`chat-archive`) |
| A reply leaves the thread in the archive | Un-archive as its own write, before the turn's metadata baseline | `tests/e2e/full/19-retention.spec.js` |
| A recursive copy of an unreadable directory kills the process | `fs.cpSync({ recursive })` aborts on a permission error instead of throwing; walk the tree with `readdirSync` first and fail with a message | `npm test` (`workspace-skills`) |
| A menu item is disabled but looks and behaves like an enabled one | Style `[disabled]` (`opacity: .42`, `cursor: not-allowed`) in the same change that disables it | `chat-rail-rows.css` (`.rchat-menu-item[disabled]`) |
| A disabled button carries `aria-describedby` that a screen reader can never read | `disabled` removes the button from the tab order, so the sentence it points at is unreachable: use `aria-disabled="true"` and refuse the click in the handler (`verbDisabled`), then style `[aria-disabled='true']` as well as `[disabled]` | `TailscalePanel.vue` (the LAN verb), `tailscale.css` |
| A popover floats off screen because its height was hardcoded | Measure `offsetHeight` after render and flip from the measurement | `ChatHistoryRail.openRowMenu` |
| Unsent text disappears when you switch threads (or reload) | Drafts are per thread in the store, persisted through `src/lib/drafts.js`; the composer reports every change and adopts the new thread's text | `tests/e2e/full/15-drafts.spec.js` |
| A finished turn switches the conversation you are reading | Store the result and update the rail row; `active` moves only from a click, a deep link, a new thread or a delete | `tests/e2e/full/14-turn-settles.spec.js` |
| Scrolling up during a turn snaps back to the newest chunk | A programmatic scroll to the bottom arms the follow flag; the live watchers are not exempt | `tests/e2e/full/13-scroll-follow.spec.js` |
| The "jump to newest" pill sits under the composer and eats the click | Position floating transcript controls with `--dock-space` + `--term-space`, the same numbers the list pads with | `chat-minimap.css` (`.jump-live`) |
| `Failed` is painted on a card with no way to fix it | A failure carries its own action: retry the session it left behind, and put the count on the surface that holds the whole fan-out | `npm test` (delegation retry contract) |
| A retry becomes one-click again as soon as the failure row is gone | The prompt carries the action in its own foot and both routes open one confirmation that says whether the error is replaced or a turn is added | `npm test` (prompt retry contract) |
| A harness/model is rendered as bare text | Use `HarnessIcon` for the harness mark, then the label | `npm test` (MachineDetailView contract) |
| A card about an entity names it only in text | The entity that asked wears its own mark (`EntityMark`, its shape/colour/mood badge): the character is how a person knows *who* is on screen before reading the name | `DefinitionWriteCard`, `DelegationCard` |
| An agent rewrites an entity's standing instructions and the person finds out from the file's mtime | A run's `set-instructions` parks a request in `pending-write.json` and throws `needs_consent`; the card on the composer shows the diff and only `Apply` writes, conditional on the stamp the proposal was read at | `tests/unit/pending-write.test.cjs` |
| An agent adds an entity to the roster unasked | `entity.create` is the same consent path: a run parks the brief and the card shows the file it would add. A name taken between the ask and the click is a `conflict`, never a second file | `tests/unit/pending-write.test.cjs` |
| A consent card offers `Apply` for a proposal that is identical to the file, or for a rewrite too large to review | Apply is **absent, not disabled** where pressing it would be a lie (`identical`, `denied`, `large`); the banner states the cause and the one action | `DefinitionWriteCard.vue` (`applyHidden`) |
| The composer's card answers to the window instead of its own column | `.cp-dockwrap` is a size container (`container-name: cpdock`); the unified diff is `@container cpdock (max-width: 560px)` | `chat.css`, `definition-write.css` |
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
| After switching threads, the first and last message are both unreadable — one under the bar, one behind the composer — and a resize does not fix it | The observers follow the **elements**, not `thread`. A swap replaces the section, and a `ResizeObserver` bound to a removed node delivers `0 × 0` once and then goes quiet, so the reserve collapsed to `14px` / `28px`. Re-attach on the refs (`flush: 'post'`), and never write a non-positive measurement | `ChatView` — `watch([headRef, dockWrap])` |
| Thread tags only exist on the open conversation | Tags are thread metadata: the header shows and edits them, the rail shows them on every row and filters by them | `ChatView`, `ChatHistoryRail`, `ThreadTagsDialog` |
| Two counters take a header track from the title and search, or float over the answer | Conversation totals close the composer's context row, before voice and help | `.cp-stats` |
| The shelf is a wall of file names, so finding "the mockup from yesterday" means remembering the png's name | A shelf is drawn as **works**: the folders that wrote a document or a batch of images, with a ranked cover shot, one card each — derived from the rows the store already returned, never a second store | `src/lib/artifact-works.js`, `npm test` (`artifacts-index`) |
| The count in the toolbar and the list under it disagree | Every number on the shelf comes from one `groupWorks()` pass, and a type pill's count and its filter are the same `typeOf` | `npm test` (`artifacts-index`, "every bucket adds up to itself") |
| The rail beside a page lists another section entirely | `RailContext.section` is a route map with an `overview` fallback, so a route it does not name gets Overview's panel. Every route in a section goes in the map (`artifact` and `artifacts`), and `AppRail`'s `SECTION_TITLES` gets the label | `npm test` (`artifacts-index`, "the shelf page arrives with the shelf rail") |
| A page's own top bar is drawn inside the reading measure | `.ash-bar` sat inside `.ash-band`, so its hairline stopped at 1180 and its crumb began where the column began — 28px right of the crumb on the page above. A bar is the page's top edge: its content box equals the scroll area's, `padding: 0 var(--view-pad)`, `width: 100%`, and the column below pays the inset (`width: min(100% - 2 * var(--view-pad), 1180px); margin: 20px auto 0`) — `.detail-view`'s split. Compare `.ash-bar` with `.entp-bar` x/width at 1440 (both 300 / 1140 with the rail open) | `npm test` (`artifacts-index`, "the shelf's bar is the page's top edge, not the column's") |
| A section heading names a page nobody can open | A section that has a page carries `to`, and its `h2` wraps a `.rail-t2-title` button — the heading is the link, the type and the ellipsis stay the bar's. Every section with a page uses it: `artifacts`, and `entities` | `npm test` (`artifacts-index`, "the section heading is the way to a section that has a page"; `entities-page`, "the rail heading is the way to the roster") |
| A rail beside an inventory repeats the inventory | A route whose page *is* the list gets the band, not a second tier: the `skills` roster has no `section` branch and the route carries `meta.rail: false` so the phone draws no drawer. Its *detail* page is a detail page and keeps the workspace settings rail, with the way back to the roster in the header | `npm test` (`ui-contract`, "the skills roster is the band, and a skill keeps the settings rail"), `src/components/RailContext.vue` |
| A "reveal this folder" button throws `That artifact is not a file.` | `artifact.reveal` is a file verb and there is no directory reveal in the call table: reveal the deepest row whose `dirname` is the work, fall back to its cover, and omit the button when neither exists | `ArtifactsIndexView` |
| A lazy cover reflows the grid as it arrives | The preview keeps a fixed `aspect-ratio` before the image exists, and the grid is one `auto-fill` declaration | `artifacts-index.css` |
| A Markdown or code artifact is dumped as raw text in a bordered box | Documents use the chat glass bar and open in MarkdownEditor / CodeEditor, full-bleed under it; Save writes back to the same file, never a copy | `ArtifactDetailView`, `artifact.writeText` |
| A members list is a row of unlabeled name/email/role fields | Each member is a card led by their Gravatar (initials when there is no email), with labelled inputs and an icon remove button; the owner row is marked | `WorkspaceView` |
| A media artifact is a small image in a bordered box | Images, audio and video get the full-bleed grid stage: details and file actions in a floating top bar, zoom in a vertical rail, wheel/button zoom, drag to pan at any scale, Fit to reset; documents keep the plain preview | `ArtifactDetailView` |
| Search only looks at harness names, not models | Match id, label, path, default and every model id | Review |
| A detail page dumps hundreds of model ids into the page flow | Put them in a bounded scroll area and keep a result count/empty state | Review |
| A summary row inherits the card heading size | Set label/meta sizes explicitly: 12px label, 10px count | Review |
| A settings page paints nothing until the slowest CLI answers | Split the read: the switches paint first, the status line lands second and is cached; `Refresh` is the only re-probe | `AccountIntegrationsView`, `integrations-store.cjs` |
| A capability row whose status reads `not probed` looks broken | The copy is a state, like `off` or `not signed in`; a skeleton is for "nothing is known", not for "the probe is late" | `AccountIntegrationsView` |
| A roster of three services is drawn as a card grid, with no search | A roster is a table on every page: `.skt` tracks, a bounded scroll area, a visible search with `inventory-search`, and the count in the bar | `tests/e2e/full/22-integrations.spec.js` |
| An inventory hides a parked or disabled row, so synced data looks absent | List the row with its state and show the parked count; a disabled remote MCP server is present, not missing | `McpView` |
| A remote MCP server or skill needs a second setup step on every clone | Definitions travel enabled; attached skills are copied into the workspace, never linked; only a change to an existing server's command/url is held local and reported | `workspace-store.cjs`, `remote-sync.cjs` |
| A sub-page opened from the rail has no way back to where it came from | Every non-root section carries `section.back`, and it goes up **one level** — `machine → machines`, `machines → workspace settings` — not always to the workspace picker. The button's title names the destination | `RailContext` |
| The action that copies an MCP server into the workspace is called "Add to pool" while skills say attach | One verb per action: **Attach** / **Detach** / **Parked**, and "attached" is also the state word in the table and the server page. The pool is the file on disk, not the word in the UI | `McpView`, `McpServerView` |
| A workspace card reports a number nobody can act on ("3 scanned") | Counts are the things the workspace owns and a person can open: entities, skills, MCP servers (parked included). A machine count belongs to the Machines page | `ManageWorkspacesView` |
| A card's `⋯` menu opens but its last items cannot be clicked | A card is its own paint layer (the hover lift is a `transform`), so an absolutely positioned dropdown inside it is covered by the next card. A row or card menu is a **teleported, measured `position: fixed` layer** with a flip above the trigger, `useDialogDismiss` for Escape and a document click to close — never a native `<details>` popping out of its own box | `ManageWorkspacesView`, `SkillsView`, `ChatHistoryRail` |
| A read-only JSON or command block is dumped as a bare `<pre>` in browser monospace | Code gets `.codebox` (border, surface, scroll cap) and a command line gets `.mcpp-cmd`, which wraps; never the prose description slot | `McpServerView` |
| A synced MCP server is enabled on a host where it cannot possibly answer (`127.0.0.1` in a container, a command under `/Users/…`), so every entity naming it fails | A machine-bound definition (loopback URL or a home-directory path) is shared but lands **parked** with the reason: `sanitizeMcp` marks it `machineLocal`, both apply paths write it into `disabled` with `__unavailable`, and the server's `parkMachineBound` repairs pools an older build enabled. Enabling it by hand pins it (`__pinned`) so no later pass parks it again | `remote-manifest.cjs`, `server/sync.cjs`, `McpView`, `McpServerView` |
| An `artifact://` reference in a code span becomes a broken image, because the token ends with the closing backtick | Strip the wrapper (`backtick`, quote, angle brackets) and trailing punctuation before resolving an id, and keep a reference ending in `/` as text — a folder is not a preview | `MessageBody` |
| Review controls take a toolbar row from the content they review | Annotations float: a bottom-right pill with the shortcut, the notes stacked above it, both over the page and never in the document's flow | `ArtifactHtmlPreview` |
| A screenshot opens a lightbox, a document opens another page, a page opens nothing | One surface: the artifact page as a dialog over the conversation (full width, one X, Esc), reached from the card's thumbnail or name, and its notes go to the open thread's composer | `ArtifactDialog`, `ChatArtifacts`, `MessageBody` |
| An HTML artifact can only be read as source, so judging a design means opening another app | The page is the default: Preview / Source in the bar, the document in a same-origin frame (a `data:`/`srcdoc` frame inherits our CSP and would refuse an injected picker; a shadow root parses away `<body>` and the page's own styles stop matching), scripts stripped, a warning when sibling files are referenced. **Annotate** picks an element and posts the notes to the chat as a draft | `ArtifactHtmlPreview`, `annotate.js` |
| Every artifact card offers Download only, whatever the file is | The row comes from one capability list on the server (reveal always; editor for text; browser for `.html`/`.pdf`), and the RPC re-checks the verb, so a card cannot offer what the backend refuses. Icon buttons with `title` + `aria-label`, labels kept to the detail page | `ChatArtifacts`, `artifact-store.cjs` |
| A turn renames the thread it answered, so a title someone wrote disappears | The first message names a thread only while the person has not: `titleSource` records who set it (`auto` / `user`, including a deliberate clear), and a turn merges only the metadata the file actually changed since it started — title, pin, tags, base directory, attachment switch | `chat-store.cjs` (`saveTurn`) |
| A refresh makes a running turn look idle: no bubble, no Stop, and the composer will start a second turn on one file | `isSending` is the union of this window's `sending` memory and the summary's `working` field, and `settled` overrules a stale summary | `npm test` (`ui-contract`, "a turn that is still running survives a refresh") |
| A delegated run answers, then the parent does the same work again in the same thread | The prompt swaps the raw sentence for "that run already happened" for **any** delegated run — `spawn 1` included, not only `count > 1` | `npm test` (`mention-ref`, "spawn 1 does not hand the parent its own job back") |
| A mention-only read (`@youtube-studio:avery:summary`) opens the thread's agent, which goes looking for a YouTrack issue about the video | The rows *are* the answer: a message with no words outside its mentions and nothing under them is settled in the app (`readsOnly`/`answer`) with no harness, no model and no MCP tool. A second line or any prose makes it an ordinary turn again, with the rows in `sent` | `npm test` (`chat-reads`), `mention-ref.cjs` (`askedOnlyReads`, `answerFor`), `chat-store.cjs` (`send`) |
| A typed plan's job is cut at the next `@`, and the turn rolls back to an empty transcript | `planSentence` puts the person's words **last**, so `delegatePlan` hands `parse` the offset where the job starts (`literalAt`) and everything from there is prose, not mention syntax. Without it `@coder … project @orca:entity, … one app : @orca:One` gave every run the job "For project", resolved `@orca:entity,` as a *read*, and threw before the hold card could be drawn | `npm test` (`mention-ref`, "a typed plan keeps its job past the `@` its words contain") |
| `@orca:entity, is not a project Orca knows` — a message that reads perfectly, refused by punctuation | A namespaced name takes the sentence's trailing punctuation off the **name** exactly as a plain entity name does; `after` still starts where the token does, so `@orca:One:src/App.vue` keeps its colon | `npm test` (`mention-ref`, "a namespaced name keeps the sentence’s punctuation out of the project") |
| `spawn per [@scope/pkg, b] @coder …` is refused as `@scope/pkg is not an entity` | A row list is data: a `@` inside the span `SPAWN_ROWS` matches is a row, not a mention. The older `openingProse` already halted there, so only `parse` had to agree — and the span is that regex's, never "any bracket", or a stray `[` in prose would swallow what follows | `npm test` (`mention-ref`, "a bracket row list holds rows, not mentions") |
| A child session is titled `on` and asks the person for a brief | A job the grammar cut off at the next `@` is a **third reason to classify**, not a silent run: the model returns `spawn 1 @entity <the whole instruction>` and the ordinary card confirms it. The preposition refusal is only the no-classifier fallback | `npm test` (`mention-ref`, "a cut-off job asks the classifier") |
| A stopped turn shows no delegation card, so it reads as "nothing was spawned" | The card renders on any row that carries mentions — the sessions a turn filed survive the Stop | `npm test` (`ui-contract`, "a session a stopped turn filed is still reachable") |
| A thread reads empty, with no working flag and no way to stop it, while its mention is still running | The question is written **before** anything slow starts, not after it. Resolving an `@…` mention runs every delegated harness inside `send`, so an "append the question at the end" order leaves the file empty for the turn's longest phase; `sending` is taken at the same moment so Stop reaches the children. A refusal takes the row back | `npm test` (`chat-spawn`, "the question is on disk while its mention is still resolving") |
| A conversation lists files another conversation wrote, because they were saved while it ran | Attribution needs a writer, not a clock. A file belongs to a turn when the turn **names it** (`artifact://` in the answer, a write tool's path, a shell write operator — never a bare basename), when it lands in a **folder the turn wrote into** during the window (a render batch), or when it sits at the **shelf root** and the turn ran alone. "Only one turn ran in those minutes" is never sufficient: the shelf is shared with this machine, other apps and the person's own scripts | `chat-store.cjs` (`claimsFor`) |
| A card shows another design's screenshots because a background render finished during the turn | Time is a filter, not a reason. Require evidence before attaching, and let the folder carry the rest of one deliverable | `npm test` (`chat-artifacts`) + `tests/e2e/full/16-artifact-scope.spec.js` |
| A screenshot from one conversation still appears under another, and no second turn was even running | Inference is a guess even with one candidate. When a turn ends the store **stamps** the files it produced (`.origin.json`, `<id> → threadId`); a stamp outranks the clock, the folder and the shelf root, and a file stamped to another session is never reachable by inference. A stamp is authorship, not custody: a turn that *names* a file it revised still shows it | `npm test` (`chat-artifacts`), `artifact-store.cjs` (`stampOrigins`) |
| An artifact preview, or notes written on it, survives a thread switch and lands in the next conversation | A preview is a view of one turn, so the dialog closes on every thread change; a handed-over draft carries `chat.draftThread` and is refused (to the clipboard, with a toast) when the reader has moved on. Per-conversation state is keyed by the conversation — including the terminal, whose reattach key is workspace + host + directory **+ thread** | `ChatView`, `ArtifactDetailView`, `terminal-store.cjs` |
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
| A fan-out message led by `/workspace:skill` routes the parent and leaves N agents in one checkout | The prologue is carried onto every run instead of refused: a classified fan-out gives each job its own skill | `npm test` (`intent-ref`), `mention-ref.cjs` (`delegatePlan`) |
| `spawn @coder …`, `let's spawn 4 @designer …`, or `Spawn 3` on its own line after a read — each showed ONE card | Every one of those was a regex being asked to read intent, and each shape was patched in turn while the next kept failing. The message is classified once instead: `{spawn: true, runs|list, entity, job}` or `{spawn: false}`, rendered as the sentence the grammar already reads. Never add a fourth prefix — a plan goes through `planSentence` | `npm test` (`intent-ref`, `mention-ref`), `electron/intent-ref.cjs` |
| The classifier runs on every message, so "thanks" waits on a model | Only two answers are provable without one: no entity with a job addressed, and two different agents (a plan is one agent's plan). Every actual delegation pays one call — that is the trade for reading the job instead of splitting it | `npm test` (`intent-ref`, `mention-ref`), `mention-ref.cjs` (`rewrite`), `intent-ref.cjs` (`namesEntity`) |
| Four cards, one prompt — four agents redesign the same page | A plan is one entry per run; an enumerated list of *items* under one instruction is `rows`/`typed`, one run per item. A message that enumerates is never a repeat even with a number written, and a bullet list is repaired to one run per item rather than trusted to the model | `npm test` (`intent-ref`), `intent-ref.cjs` (`repairWithList`) |
| Run 1 and run 2 open with each other's instructions | A message that orders a different job per run is a list of runs — one instruction per card and per session, never the whole message copied N times. The bullet-repair reads it without a model when the count matches the list, and `shareNote` says "this instruction is yours alone" instead of "of this same instruction" | `npm test` (`intent-ref`, `mention-ref`), `intent-ref.cjs` (`usable`, `repairWithRuns`), `mention-ref.cjs` (`plannedSegments`) |
| A pasted issue URL shows no confirmation card, because the model wrote `@youtrack:MAKA-359:relates to: unresolved` and the list resolved zero rows | The URL is authoritative for the list: `derivePlan` replaces a model's tracker query while keeping its entity and job, so the card lists the real rows. A model answer the app cannot turn into a plan (prose instead of an `@youtrack:` token) is not `{"spawn": false}` — it also falls through to the URL reading | `npm test` (`intent-ref`), `intent-ref.cjs` (`repairWithIssue`, `choosePlan`) |
| A page title containing a comma becomes two runs | A row owns a line: typed plans render one row per line, and `SPAWN_ROWS` splits on newlines when there are any | `npm test` (`intent-ref`), `mention-ref.cjs` (`planSentence`, `spawnPrefix`) |
| Three runs of one instruction are three identical cards, or two identical session titles | The share (`1/3`) goes on the mention, the session title and the block the reply reads; the card key includes it | `npm test` (`mention-ref`, `chat-spawn`) |
| A delegated run is a dead end | The card carries **Continue** at its top right, opening the session the run wrote | `tests/e2e/full/20-spawn-session.spec.js` |
| A thread that delegates a few jobs puts rows for them in the rail | Sessions are not rows: the parent carries `spawned N chats` and the count opens a tree | `npm test` (`chat-spawn`) |
| The delegation band shows the first child's job instead of what the person wrote | The band is the turn's own message; the child instructions are derived from it, and **Update** (`chat.replan`) re-derives them from an edited band | `npm test` (`intent-ref`, `chat-spawn` "a held plan is read again") |
| Every card is badged `edited` the moment a plan is drawn | Ownership is explicit (`own`), set by a hand edit and cleared by a re-plan — never `child !== band`, which is true by construction | `npm test` (`mention-ref`), `DelegationHold.vue` |
| A plan card shows only the instruction and hides the context the run will receive | The row carries both (`job` and `context`); the card composes and clamps the prompt, and `Read more` opens `PromptDialog` with the two as separate multi-line fields. A card's field is the whole prompt, so the engine never appends the block twice (`prompted`) | `npm test` (`mention-ref`, "the card carries the whole prompt") |
| A delegated run guesses, because "implement A" was defined in a thread it cannot see | The last exchange travels with the run — bounded, labelled background, and with `artifact://` names resolved to real paths — so the run can open the plan it was given | `npm test` (`mention-ref`, "a delegated run is handed the conversation it came from") |
| A count says 4 and the rail paints 2 | Counts, filters and groups all exclude sessions; only the tree shows them | `hub.activeSummaryCount` |
| "Save definition" shows `afterScopeWrite is not defined`, and the page keeps its old copy until a manual refresh | A store may not call what it does not define: a refactor deleted the helper and left three call sites, so the write landed and the **refresh** threw — a success reported as a failure. The refresh is restored as one function with one job (re-read what a scope write can move, never `applyScope`, which would drop the open conversations), and `npm test` now demands a definition for every bare call in `src/stores/` | `npm test` (`ui-contract`), `workspaces.js` (`afterScopeWrite`) |
| A card says a worktree is gone, or clean, when nobody said so | A state read from absence is not a state: require evidence from the row's own record, and let the tooltip hedge what cannot be known | `DelegationCard.vue` (`hadWorktree`), `mention-ref.cjs` (`worktreeState`) |
| Delegated runs start before the person can see them | The message is sent, the reads resolve, and the runs wait: one hold per turn with Run/Cancel, and Stop, Esc and the expiry settle it the same way | `DelegationHold.vue`, `mention-ref.cjs` (`hold`), `npm test` (`chat-cancel`) |
| A held plan can only be approved or thrown away, so a wrong count costs the whole message | The plan is a form and the revision travels on the Run: `chat.delegate` accepts `{ action: 'run', count, instruction, rows }`, and `applyPlanRevision` applies it once before any harness exists (`ponytail:` names the per-keystroke write as the upgrade path). The shortcut is the form's own window listener, not a second one in `ChatView` | `DelegationHold.vue`, `mention-ref.cjs` (`applyPlanRevision`), `npm test` (`mention-ref`, "Run starts the words and the count the card showed") |
| A cancelled plan paints the thread as failed | A settled plan is not a harness failure: keep the Retry row, and keep `failed` off the summary | `chat-store.cjs` (`summarise`) |
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
| One MCP server page states the same definition three times (hero chips, a key/value table, its JSON) and then dumps 23 tool names as an unsearchable list | A fact is stated once, in the block that owns it — the rail holds the definition, the paths and the verbs; the column holds what it can do. A tool inventory is rows the server reported (name, description, a derived group, `read`/`write`) behind a search and a filter, with the reason drawn when there are none | `McpServerView` |
| A dialog is drawn at 1080px and reads as a slab | `min(860px, 94vw)` for a two-column diff, `min(520px, 94vw)` for the rest; one padding scale on `.mo-head` / `.mo-body` / `.mo-foot` | `EntityLearnDialog` (`.learn-modal`) |
| A dialog inside `.detail-view` silently takes the 1180px reading measure, and so does its scrim | `:not(.entp-bar)` counts as a class, so `(0,2,0)` beats the width, the centring margin and even `position: fixed; inset: 0`: the dialog measured 1180 and the backdrop 1180 with a 130px margin, leaving the rail and every outer edge undimmed and unclickable. The measure excludes fixed surfaces: `.detail-view > :not(.entp-bar):not(.modal):not(.scrim)` | `src/styles/directory.css` (`.detail-view`) |
| A dialog and a drawer share one backdrop | `scrim-dialog` is the dialog variant next to `.scrim`; the drawers keep the base | `surfaces.css` |
| A long wait is a static "this can take a minute" | Tick a clock beside the spinner and name the ceiling (`gives up after 5 minutes`); one measured span feeds both the wait and the result line | `EntityLearnDialog`, `PromptEnhanceDialog` |
| A two-minute ceiling on a review whose answer is a whole instructions file | The cost is generating the replacement, not reading the transcripts: a 27 KB `coder.md` took 148s at the smallest scope, so `TIMEOUT_MS` is 5 minutes and the busy copy names it | `electron/learn.cjs` (`TIMEOUT_MS`), `EntityLearnDialog` (`LIMIT_MINUTES`) |
| A review runs on open, so the scope arrives after it was paid for | Choose the count and the dates first; the primary that starts the run lives in the body | `EntityLearnDialog` |
| "3 conversations" after the run while five were asked for | Read the count from `result.sources` and say `3 of 5 asked`; the scope is filtered before it is counted | `electron/learn.cjs` (`recentFor`) |

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
| Entity / MCP detail toolbar (`.detail-view` + `.entp-bar`) | `EntityDetailView.vue`, `McpServerView.vue` | Sticky glass in the thread header's material — not a card: spans the content area, flush under the top bar, page scrolls beneath it |
| Entity learning review | `src/components/EntityLearnDialog.vue` | Esc, scrim, Cancel (guarded while applying); the scope is chosen in the body, the footer keeps Cancel / Copy / Apply; `entity.learn` writes nothing |
| Mark picker, pick menus, model suggestions, zoom, minimap card | `MarkPicker.vue`, `PickMenu.vue`, `ModelInput.vue`, `ChatArtifacts.vue`, `ThreadMinimap.vue` | Esc via the same stack |
| Thread tags | `src/components/ThreadTagsDialog.vue` | Esc, scrim, Cancel (guarded while saving) |
| Artifact document editor | `src/views/ArtifactDetailView.vue` | page surface; Save button and the catalog `save` shortcut |
| Artifact shelf (works, not rows) | `src/views/ArtifactsIndexView.vue` | page surface; `.ash-bar` is the page's top edge (`.entp-bar`'s geometry, full-bleed, 56px, sticky glass); `Esc` closes the opened work before it leaves the page |
| Thread metadata | `src/components/ThreadMetadataPanel.vue` | Esc (an open path row folds first), close button; chat-header toggle + shortcut |
| Delegation hold (a plan waiting for you) | `src/components/DelegationHold.vue` | Esc cancels (not while Run is in flight); Cancel, Stop and expiry settle it |
| Definition write (a rewrite waiting for you) | `src/components/DefinitionWriteCard.vue` | Esc = `Not now` (not while Apply is in flight); Apply is the only other answer |
| Transfer sheets (send one connector out, a connector file in, where a workspace lands) | `src/components/ConnectorShareDialog.vue`, `ConnectorAlreadyHereDialog.vue`, `TransferPlacementDialog.vue` | Esc, scrim, Cancel (guarded while a file is being written); the passphrase question comes before the arrival choice |
| Voice mode | `src/components/VoiceChatDialog.vue` | Esc, scrim, close button; composer microphone + shortcut |
| Composer failure band | `src/components/SlashComposer.vue` | Esc (the same `dismiss` emit as its `×`; an open attach menu closes first, it is its own stack entry); `Try again` re-sends the preserved draft; it also clears when another thread is opened |

## Every searchable list says ⌘/ (⌥/ in a tab), in the same pill

A rail or a roster that can be searched carries the key in the field itself:
`<kbd class="search-kbd">{{ shortcutLabel('inventory-search') }}</kbd>`, one class,
one look (control border, mono, micro type), hidden on `:focus-within` because the
key has done its job by then. The conversations rail set the pattern; the artifact
rail, the entity rail, the skills roster and an MCP server's tool list all wear it.

One key, one meaning, whichever list is on screen — the **conversations rail**, a
second-tier **rail**, the **skills roster**, the **tool list**. The id is always
`inventory-search`; a surface owns the handler only if it owns the field:

| surface | handler | target |
| --- | --- | --- |
| conversations rail | `ChatHistoryRail` | `.rchat-search input` |
| second-tier rails (artifacts, entities, …) | `HubLayout` | `.rail-t2 input[type="search"]` |
| skills roster | `SkillsView` | the roster's search |
| MCP server tools | `McpServerView` | the tool list's search |

**A search key carries a modifier, never a bare character.** It began as a bare
`/` and that was wrong in the only way that matters: a bare key fires wherever the
caret is, so typing `http://…` into *any* field jumped to the rail and ate the
slash. `⌘/` (Option+/ in a browser tab) cannot be typed by accident, which also
means the handlers no longer needs an `isEditable` guard — a `/` inside the
composer is still the skill menu, a `/` in a path still types.
`metadata` moved to `⌘⇧/` because one combo may not answer two questions.

The other two keys that name a *place* rather than a list: `thread-search`
(Option+Shift+F) puts the caret in **this thread's** search, `entity-chat`
(Option+Shift+N) opens a chat with the entity whose page you are on. A digit
combo is matched by its **physical key** (`event.code`), because Option+Shift+1
produces `!` on a Mac — the character never survives the modifier.

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
- **The question is on disk before the turn does any work.** `chat.send` resolves
  mentions (and, before them, classifies the message) inside the same call that
  starts the turn, and a fan-out is minutes of that. Writing the question
  afterwards left the thread empty on disk for the whole of it: a reload, a
  second window, or the next boot — a delegated child can outlive the app — read
  a conversation with no question, `working: false` and no Stop to reach the run
  that was still going. So the row and the `sending` lock are written first, the
  mention fills the row in when it resolves, and a refusal takes it back off.
  The file is the transcript; a transcript that is empty while the turn is alive
  is a lie the next reader has no way to catch.
- **A refresh is not a cancel.** The window's `sending` map is memory, so after a
  reload only the summary carries the truth. `isSending(id)` is therefore the
  **union** of that memory and the summary's `working` field, which the main
  process writes from its own live map. Reading memory alone made a genuinely
  running turn — a delegated child can outlive the window that started it — look
  idle: no live bubble, no Stop, and a composer that would start a second turn
  racing the first on one file. The other direction needs `settled`: a summary
  read before the turn finished still says `working`, so the one place that learns
  it first-hand (the `done` event) records that it settled, and only a new send
  clears it.
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
- **Observe the elements, not the thread.** Both the bar and the composer are
  replaced with the thread's section — the skeleton is a different section — and
  a `ResizeObserver` bound to a node that left the document reports `0 × 0` once
  and is never heard from again. Re-attach on the refs and ignore a zero: a
  reserve of `14px`/`28px` puts the first message under the glass and the last
  behind the composer, and no later resize corrects it.
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
- **The bar is a size container.** Below 1000px of column the tag chips go;
  below 760px the search goes; below 600px the button labels. The shortcut
  chips never go — they are the only place the combo is written before a
  hover, and an icon beside its chip still fits one row. Container queries, not
  media queries: the rail takes 300px, so the column and not the window is what
  runs out of room.
- **Search is a jump, not a filter.** `cp-search` counts the messages that
  contain the text, highlights each row, and Enter / Shift+Enter move through
  them. It never rewrites the Markdown or hides context.
- The tint is roughly two-thirds of `--bg` over `blur(16px) saturate(1.8)`. Keep
  it light enough that a line of text under the bar stays readable as a smudge.

### A thread that is not in memory yet says it is opening

Clicking a rail row whose conversation is not loaded is a disk read. Until it
lands there is nothing honest to paint: the transcript is either the thread you
just left or — on the first open — an empty page that reads as “no thread”.
That is the moment the app looked frozen, so the store records the read
(`chat.opening`, one wrapper around `chat.read` so no call site can skip it) and
the chat page draws the shape of what is coming.

- **The skeleton is the transcript's shape**, not a spinner over white: a short
  question on the right, answers on the left, swept once per second
  (`.og-line`), with the row's title under it so the wait names the thread.
- **It waits a beat (140ms) before showing.** A local read finishes inside that
  beat, and a skeleton that flashes on every switch is worse than none.
- **The flag belongs to the newest read.** A second click must not be
  un-flagged by the first read's slower answer, so the wrapper counts and only
  the last one clears it; a failure clears it too, and the caller's catch turns
  that into a toast rather than a stranded skeleton.
- **The list read counts as opening.** Before `chat.list` answers there is no
  thread either, so `chat.loading` shows the same surface instead of claiming
  “No thread open” for the few hundred milliseconds it takes to find out — and
  the rail says “Reading your conversations…” rather than “No chats yet”.
- **A thread already in memory never shows it.** It paints from memory and
  refreshes underneath — that rule predates the skeleton and still wins.
`
### Any page with its own top bar reuses the thread's header, material and all

`.entp-bar` (entity and MCP detail pages) is not a container: it is the page's
own top edge, the same 56px sticky pane of frosted glass as `.cp-head` — the
same tint, the same `blur(16px) saturate(1.8)`, the same hairline. The page
scrolls *beneath* it, which is what proves it is glass.

**A back button has two shapes, and a size rule names the one it means.** The bar's
back control is either a bare chevron (`Entities` index: a 30 px square, 44 px on a
phone) or a glyph with its label (`Connectors`, `MCP`, `Entities`, `Skills`). A
page-scoped `width: 30px` written for the first shape silently squeezed the second:
flex gave up the 12 px glyph to fit the label, so four pages rendered their label
with no arrow at all — a zero-width `<svg>` is invisible but still in the DOM, which
is why it read as "missing icon". `entities-page.css` now sizes `.back-icon`, the
marker the bare button carries, and `tests/unit/ui-contract.test.cjs` fails if the
square is keyed on `.back` again or if a labelled back button loses its glyph.

**This is the app's navigation standard, not a detail-page detail.** Every page
that draws its own *sticky* bar — `.entp-bar` on the entity and MCP pages,
`.ash-bar` on the artifact shelf — is the same 56px surface at the same x, and
each one is verified that way: compare the bar's `x`/`width` with `.entp-bar`'s
at 1440, not by eye. (`.ovc-bar` on the overview is a different object: a 58px
row inside that page's column, not a sticky pane, and it is not what the rule
is about.) Three numbers must agree: the bar's content box equals the
scroll area's (rail open, folded, or 1920), its padding is `0 var(--view-pad)`,
and the column below is inset by that same pad. Position the column instead —
wrap the bar *inside* the `min(100% - 2 * var(--view-pad), 1180px)` measure —
and the hairline stops ~60px short of both window edges and the crumb sits right
of the one above it, which is exactly what "containerised" means.

- **`position: sticky; top: 0`** on the bar, `z-index: 3`; nothing else needs to
  know its height, because it is in the flow and the page's own scroll container
  starts after it.
- **The top bar's geometry, exactly.** Same 56px, same `padding: 0 var(--view-pad)`,
  no margin, no measure of its own. A bar that centres its contents to the 1180px
  reading column puts the breadcrumb 192px to the right of the crumb directly
  above it on a 1920px screen — that is what makes it read as a separate
  container instead of the page's top edge. Verify by comparing
  `.entp-bar .back` with `.topbar .crumbs` x at **1920**, not just at 1280: they
  coincide at 1280 by accident.
- **Percentages, never `100vw`.** The page starts after the rail: `100vw` is the
  window, and a bar built from it overlaps the rail by its width.
- **The crumb is one object on every second row.** Mono, `--fs-micro`, `0.09em`,
  uppercase, `--muted`, with the value one rung stronger — `.entp-crumb`,
  `.ovc-barcrumb` and `.ash-crumb` are the same style, because a breadcrumb that
  changes its type on every page is three bars, not one.
- **The body keeps its measure.** Only the bar is full-bleed; `.detail-view > :not(.entp-bar)`
  is `min(100% - 2 * var(--view-pad), 1180px)`, centred, with the bar's height as
  its only top gap.
- Never a card. A bordered box around a breadcrumb and a button is furniture the
  top bar already provides.

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

## The shelf is a page of folders, and the rail is still the list

The artifact rail answers *which file*. It cannot answer *which folder*, and that
is the question somebody who just finished a mockup actually has: they remember
the shot, not the name of the png inside it. `/w/:workspace/artifacts` is that
page, and it is a second view of the same rows rather than a second store.

- **A work is derived, never stored.** `src/lib/artifact-works.js` groups the
  rows `artifact.list` already returns, by the folders their ids sit in. A folder
  is a work when it holds a document (`.md`, `.html`, `.htm`, `.mjs`, `.cjs`,
  `.css`) or, with no children, a batch of images; a qualifying ancestor takes
  the folder below it, and every remaining row is a *loose* file. It is pure ESM
  with no Vue, no DOM and no imports, so `tests/unit/artifacts-index.test.cjs`
  holds the rule and the page cannot drift from it. Nothing is written to make a
  card, so an upload is a card after one read and a migration is never needed.
- **A cover is a real file, ranked, and never invented.** `cover.png` beats
  `preview.png` beats a numbered shot beats any other image; only rasters under
  900 KB qualify, because a 4 MB screenshot is a card that stutters the grid. A
  work with no shot draws its dominant extension instead of a grey rectangle —
  an absence drawn as an absence.
- **The counts are one partition, and they add up.** `Files`, `Works`, `Loose`,
  the meter's `73 / 94` and every type pill come from the same pass, so the
  pills always sum to the file count. A bucket's count and the filter it runs are
  the same function (`typeOf`), or the number and the list disagree in the one
  place a person is checking.
- **The cards are why this page exists, so the shot is the card.** A 16:10 crop,
  `object-fit: cover` with `object-position: top left` — every capture's identity
  is its top-left corner (breadcrumb, title, first row). One
  `repeat(auto-fill, minmax(298px, 1fr))` at a 14px gap, and the aspect ratio is
  fixed before the image arrives, so a lazy cover never reflows the grid.
- **`Esc` closes the opened work before it leaves the page.** One window listener
  owns the two keys this page has (`inventory-search` from the catalog, and
  `Escape`), and it defers to `dialogDepth()` so a dialog's Escape is still the
  dialog's.
- **The page arrives with the shelf beside it, and the heading opens the page.**
  `RailContext`'s `section` is a route→section map with an `overview` default,
  so a *page* route it does not name silently falls through: `/w/:ws/artifacts`
  listed the machines next to the shelf. Any route that belongs to a section
  goes in that map (`artifact` **and** `artifacts`), and a section that has a
  page carries `to` — its `h2` wraps a `.rail-t2-title` button, so the heading
  that names the page is the way to it instead of a dead end. `AppRail`'s
  `SECTION_TITLES` gets the same name, or the collapsed rail calls the page
  *Configurations*.
- **Reveal is a file verb, so it lives on the opened work.** `artifact.reveal`
  refuses a directory (`That artifact is not a file.`) and there is no directory
  reveal in the call table. The button reveals the deepest row whose own
  `dirname` is the work, falls back to the work's cover, and is omitted entirely
  when the work has neither — a disabled button for a thing that cannot happen is
  furniture.

## An artifact is a file with the chat's bar, not a card in a page

The artifact detail page is a full-height surface with its own scroll. It uses
the chat header recipe rather than a floating rounded card.

- `.artifact-bar` is absolute glass over `.artifact-scroll`. The bar carries
  three text lines and is taller than 56px, so the view measures its **border
  box** into `--abar-h`; the scroll and the media stage reserve that, never a
  hard-coded number.
- A **Markdown** artifact opens in `MarkdownEditor` (Write / Review, word count)
  as the surface itself: `.artifact-scroll--editor` removes the side gutters, the
  frame and the bottom padding, and the editor flexes to the full width and
  height under the bar. A short document must not leave a white strip below the
  editor. Save writes back to the same id through `artifact.writeText` —
  `saveText` allocates a new name and is only for derived exports. `save` is in
  the shortcut catalog.
- **The Write surface is a Tiptap editor over the same Markdown the file holds**
  (`MarkdownEditor` shell, lazy `MarkdownRichText`). The artifact document and
  the entity Instructions field mount the same shell, so both get the same
  document, the same find and the same formatting. `Review` is still the renderer
  this app already had, and the two read one string, so they cannot disagree.
  The roundtrip is `@tiptap/markdown` in both directions — `contentType:
  'markdown'` in, `getMarkdown()` out — never an HTML detour and never a
  hand-written serialiser. The editor is the heavy chunk (Tiptap + ProseMirror);
  the shell that draws the bar and the find UI is a few kB, so a page that only
  reviews a document never downloads an editor.
- **Formatting is a pill over the selection, not a permanent tool strip.** The
  shape is Multica's issue editor: `md-pill` teleported to `body`, drawn at the
  selection's own coordinates (flipped above the range near the bottom edge),
  carrying bold / italic / strike / inline code / link, a separator, then the
  heading cycle, bullet list and quote. Link swaps the pill for one address
  field rather than inserting a placeholder to hunt down. It appears when a range
  is picked and goes when it collapses, because a bar that is always there costs
  the document a row and acts on a caret it is not describing. The prose tier
  follows the same benchmark: a 14.5px body at 1.625 leading over 10px paragraph
  spacing and 20px of list indent, so Write and Review are one measure and the
  text does not shift sideways when the tab changes.
- **Find is the page's, not the editor's.** `PageFind` is the app's counterpart
  of a browser's find bar: one field, mounted once in `HubLayout`, that walks
  every text node on screen. The Markdown document is searched with everything
  else, because by the time you search it, what you wrote is ordinary text in the
  DOM — so an entity's Instructions and an artifact's prose need no find of their
  own, and no surface may grow one. `find` in the shortcut catalog opens it,
  Escape closes it through `useDialogDismiss`, Enter and Shift+Enter step, and
  the bar reports `3 / 17` or `no matches` with `aria-live="polite"`. It skips
  itself (`[data-find-skip]`) and anything `aria-hidden`, so the field cannot
  match its own placeholder.
- **The highlight is the Custom Highlight API, never a wrapper element.** Painting
  a match by wrapping it in a `<mark>` would rewrite the nodes ProseMirror
  derives its document from — the next `setContent` would have to explain a
  `<mark>` it never wrote. `::highlight(page-find)` and
  `::highlight(page-find-on)` in `page-find.css` paint the ranges instead, so
  finding text inside the editor is the same operation as finding it anywhere
  else.
- Other text artifacts keep a plain scrollable preview; PDFs keep the iframe;
  binaries keep Download. Editing is not offered where it would corrupt the
  file.

## A turn's files are one grid, and the tile is the file

The chat card that lists what a turn saved used to be `display: flex;
flex-wrap: wrap` around a 440 px centred column: a 440 px screenshot, then a pair
of 215 px ones, then five chips of three different widths, some centred and some
not, with the file cards a second row taller than the image cards because their
actions had a line of their own. Twelve files came out **2698 px tall and ragged**.
That is not a density problem, it is a missing unit.

- **One cell shape, whatever the file is.** A 16:10 tile over a one-line caption
  (name, then size). A screenshot's tile is the shot (`object-fit: cover`,
  `object-position: top left`, because a page capture's identity is its top
  left); a file's tile is its extension and its kind. No hatch behind a name that
  pretends to be a preview.
- **The tile is the link; the actions ride over it.** At 150–180 px a caption
  cannot hold a name, a size and four icon buttons without overflowing, so the
  action row is an overlay that fades in on `:hover` and `:focus-within`, and is
  always visible under `@media (hover: none)`. It is positioned out of the grid's
  rhythm, so it never changes a cell's height.
- **The count decides the columns, not the content.** One file takes the width,
  two split it, three or more auto-fill at 150 px. `data-alone` keeps a lone
  `.md` from becoming a 560 px hatch behind one name — a lone screenshot may be
  large, a lone note is a chip.
- **The shared selectors are the contract.** `.msg-attach`, `.msg-attach-copy`,
  `.msg-attach-img`, `.msg-attach-acts`, `.msg-act` all survive the layout, the
  artifact page's own click path goes through them, and the e2e specs read
  `.msg-attach`'s text — so the file name stays in the DOM, never only in a
  `title`.

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

## A dashboard caches for a day, in a file

A dashboard is a handful of requests against somebody else's rate limit, and its
numbers move over days, not seconds. So the default for **any** dashboard in this
app is: **one read a day, stored on disk, refreshed only when someone asks.**
`electron/connectors/github/dashboard.cjs` is the reference implementation.

- **The cache is a file, not a variable.** `<ENTITY_HOME>/github-dashboard.json`
  (falling back to `~/.entity/`) holds `{ schema, key, at, value }`: the payload
  verbatim, the clock of the read, and the key it was read for. A restart must not
  spend the budget again, and `ENTITY_HOME` is honoured so a test or a demo never
  writes a developer's real home.
- **The TTL is a day, and it is one constant.** A shorter one buys nothing: a
  number that changed twice in fifteen minutes was never the number somebody asked
  about, and what a dashboard costs is requests, not milliseconds.
- **Only two things read again: the explicit verb and the expiry.** Opening the
  tab, leaving and coming back, reloading the window — all serve the stored
  answer. The Refresh button sends `force: true` and is the only way to read
  sooner than a day.
- **The key makes stale answers impossible to serve by accident.** It is the
  readable logins plus the window start, so signing in, signing out, switching the
  active login, or the day rolling over misses the cache instead of drawing
  somebody else's numbers.
- **A failed or rate-limited read is never cached.** Storing a refusal would
  re-serve it for a day. The tab keeps the last good numbers, stamps them with
  their `readAt`, and says what happened in its own banner.
- **The page prints the rule it follows.** The main process sends `cacheTtlMs` with
  every payload; the header stamp reads `read 3 h ago · cached until 18 Sep 09:40`
  and the card foot says `served from the 1-day cache` or `cached for 1 day`.
  **Never hardcode the duration in copy** — a `cached 15 min` label that outlives
  the constant is a lie about the app's own behaviour, and it was paid for once.
- **A cache the app cannot write is a miss, never an error.** Reads and writes are
  wrapped; a read-only home means the next visit asks the service again instead of
  failing the page.

### A read-only dashboard still spends somebody's budget

Fitbit's dashboard (`electron/connectors/fitbit/dashboard.cjs`) is the second implementation,
and it adds the rules a limit *per hour* needs — the file cache above is a day's
worth and does not help a person flipping between yesterday and Tuesday.

- **Count the calls, and refuse before spending.** Every request is charged
  *before* its answer is judged, including a `429` and a `500`: those were calls.
  A day costs five, so an hour with four left is an hour that cannot answer, and
  the app says so without touching the network.
- **The reset time is quoted, never computed.** A `429` carries
  `fitbit-rate-limit-reset`; that number is the one on screen. Deriving a minute
  from our own clock would send someone back to a wall that is still there.
- **The timezone comes from the account, not the machine.** `user.timezone` is read
  with the device list, once an hour, and every day boundary is computed in it. A
  profile with no zone falls back to UTC and the page says so (`noTimezone`) — the
  OS zone is never a stand-in for somebody's account.
- **A `null` is not a zero.** A grant without the heart-rate scope answers `403` on
  two of the five reads; the day is still real, so the numbers are `—` with the
  reason beside them, and no cell prints `0 bpm`.
- **Read-only means no verb at all.** The tab has one control — Re-read — and there
  is no code path in the module that could write to the account. A button that
  implied one would be a promise about somebody else's data.
- **The gate is the account list, not a read.** The second tab is offered only when
  a `connected` account exists on the row; a locked tab keeps its place in the tab
  order, is `aria-disabled`, and states the reason underneath — never `disabled`,
  which would make that reason unreachable by keyboard.
- **A locked pane is absent, not empty.** `lock` is part of the pane's `v-if`, not
  only of the click handler: a mounted dashboard reads on mount, so a locked tab
  that still rendered its pane would spend an account's budget and show a day it has
  no grant for. Locked, the chain falls through to the overview pane, and
  `aria-controls` points at that pane's id because it is the one in the document.
- **The day is in the address.** `?tab=dashboard&day=YYYY-MM-DD` reopens the same
  day tomorrow; `today` is the absence of the parameter, `yesterday` is a word (it
  must still mean yesterday next week), and a value the app did not define is
  dropped on load rather than sent to the service.

### A week's shape is a union of intervals, and a column per local day

Google Calendar's dashboard (`electron/connectors/google-calendar/dashboard.cjs`) is the third, and
it adds the rules a *grid* needs. The reference diagnosis is One's calendar plugin;
the rules here are the ones that were wrong on the first attempt.

- **Busy minutes are a union of intervals, computed once.** Two invitations for the
  same hour are one hour of somebody's day. `unionMinutes()` is the only arithmetic
  for busy, per-kind and the meeting share — a per-event `sum` beside it lets the
  KPI say 23 h while the legend above it adds to 31 h.
- **A seven-day window is not seven columns.** It starts at the current minute, so
  it lands on eight local days and its last column stops mid-day. A grid that hard
  codes seven draws 23 of the 28 events while the totals count all of them; the
  track count comes from the columns (`--dcols`) and the partial column says so.
- **Columns are local days, never UTC ones.** A UTC day boundary is wrong for seven
  hours of every WIB day, and an event at 08:00 local would file itself under the
  previous column.
- **A chip is a legend, not a filter.** "Meetings · 16 h 30 · 52 %" names what the
  week was made of and has no press state; the calendar chips that *do* filter are
  a separate row, and when one is pressed the page says in one sentence which
  figures are whole-grant and which follow the chip.
- **Every bar, block and row carries the word, not only the colour** — `meeting` /
  `focus` / `personal` plus a tinted edge, so kind survives a colour-blind reader.
- **A kind never divides by a union it does not own.** The kind budget's percentage
  is against the minutes the chips name, so the row adds to 100 %; the meeting
  share is against busy minutes and says so in its own hint.

### One page, one connector, one folder

A connector is **a folder on each side of the bridge**, and everything about it lives
in that folder:

```
electron/connectors/<id>/      src/connectors/<id>/
  connector.cjs  descriptor      <Name>Dashboard.vue   the tab's body
  mention.cjs    resolve/preview use<Name>.js          the renderer's read state
  dashboard.cjs  the read        <Name>Card.vue        its Overview card(s)
```

`electron/connectors/registry.cjs` lists those folders and derives the mention map,
the account heads and the call table from them; `connector-catalog.cjs` assembles its
connector half from the same descriptors, so a `work` block is written where the code
is. `src/connectors/dashboards.js` is the renderer's table of the same connectors
(hint, gate, answer, read), and `src/connectors/ConnectorDashboardPane.vue` maps a
kind to its body.

- **Adding a connector is creating a folder, not editing four tables.** The row id,
  the resolver kind and the mention head were three hand-kept maps in three files;
  they are now one descriptor, and a test (`tests/unit/connector-registry.test.cjs`)
  reads it. A descriptor also carries `dashboard { call, mode, kind }`, so the tab, its
  call and the renderer body cannot drift apart.
- **The page asks "may this tab open?"; it does not know the answer.**
  `src/connectors/dashboards.js` holds one entry per shipped dashboard —
  `dashboardKind()`, `dashboardHint()`, `gateFor()`, `answerGate()`, `readPane()`,
  and `paneShown()` for the two whose lock gates their render. Adding a dashboard is
  one entry there plus one pane body, not a seventh `if` in the page. It used to be
  seven: six copies of "which account list locks this tab" and six watchers that each
  re-checked one of them.
- **The body is one component, not a chain in the template.**
  `src/connectors/ConnectorDashboardPane.vue` maps `kind` to its body and wears the
  page's `$attrs` (`id`, `role`, `aria-labelledby`) so a body cannot name itself a
  different pane. A body that swapped its own id would make the strip's
  `aria-controls` per-connector.
- **A shared card names no connector.** `ConnectorAccountsCard` is drawn by every
  account-bearing connector, so its per-connector extras come from a table
  (`src/connectors/accountColumns.js`): today only Google Calendar has a column, and
  the card asks `accountColumn(id)` instead of testing the id itself. A new column is
  one entry there, not an `if` in shared UI.
- **Connector state lives in that connector's composable.** Clockify's key and the
  workspace it reads are `src/connectors/clockify/useClockify.js` and draw in
  `src/connectors/clockify/WorkspaceCard.vue`; Lynk.id's folder and the three verbs
  beside it are `src/connectors/lynk/useReportCard.js` and
  `src/connectors/lynk/ReportCard.vue`; GitHub, calendar, studio, Habitify, Fitbit and
  YouTrack keep theirs the same way. The page imports state, it never owns it — a
  `ref` on the page is one a child can only change by emit, which is the shape that
  produced the bug below.
- **One read envelope, not eight.** `src/connectors/parts/readClock.js` owns
  `ttlWords()`, `cachedUntil()` and `cacheNote()` — and **imports nothing**, so
  `tests/unit/read-clock.test.cjs` pins the rule instead of trusting eight reviewers.
  `parts/readStamp.js` adds the line that also prints *when* something was read, which
  needs `ago()`. The contract test fails a dashboard that types a unit (`'1 day'`) or
  formats a duration by itself.
- **The stylesheet stays one file, and that is a decision.** `styles/connector-page.css`
  is shared material: seven connectors draw the same `.dsh-*` band, KPI row and table,
  and splitting the file per folder would make every shared rule one that four folders
  could change without seeing each other. A connector's *own* rules live in a
  delimited block under its heading comment, which is the compromise the layout makes
  deliberately.
- **A gate made of two lists waits for both.** Lynk.id's lock is the folder *and* the
  accounts, and the accounts live on the connector row. A deep link that arrived before
  the roster did read an empty account list as "needs a Google account" and normalised
  `?tab=dashboard` to Overview — silently, because by the time anyone looked the gate was
  open again. `connectors.loaded` is now part of that gate's answer, exactly as it is for
  Fitbit's.
- **A gate has three states, not two.** Unread answers *not locked*, so a deep link is
  never refused before the read that would allow it lands. A gate that defaults to
  locked flashes a refusal at every reload.
- **A table lookup that can miss is answered before it is dereferenced.** The table's
  entries are `DASHBOARDS[kind]`, and `kind` is empty on every connector page with no
  tab (Tailscale, an MCP row, a custom connector). `DASHBOARDS[kind]?.gate(entry)`
  therefore yields `undefined`, and reading `.why` off it crashed every one of those
  pages. `src/connectors/gate.js` owns the shape (`UNREAD`, `OPEN_GATE`, `toGate()`)
  and is import-free so `tests/unit/connector-gate.test.cjs` can hold all three
  answers plus the `undefined` case. **Optional chaining is not a guard** — it moves
  the crash one line later.
- **A gate is answered again, not once.** The accounts card emits `changed` after a
  sign-in, a reauthorize or a removal, and the page re-asks with `force: true`, then
  re-reads the open pane. Answering it only on mount is a bug that has been paid for
  once: authentication succeeded, and the tab stayed locked until an F5. Nothing in
  this app may require a reload to show a grant that already landed.
- **A lock is made of one state, and the write updates that state.** Lynk.id's lock
  reads `lynkConfig.folderId` in the store; its settings card used to write through
  the read layer instead, so a folder picked on the page left the lock pointing at
  the folder that was there before and the tab stayed shut until a reload. One write
  now updates the state the lock is made of, then mirrors it into the read layer.
  Same failure, second time: *the thing you changed and the thing that is read must
  be the same object.*
- **The transition, not the value, closes a tab.** One watcher on `gate.locked`
  replaced the six per-connector ones: locked closes the open pane, unlocked
  re-reads it. Both directions are the same sentence — "the answer on screen is not
  the one this tab would produce now".
- **A locked tab is not a place.** A deep link into a locked dashboard is normalised
  to Overview, so the address and the pane in the document cannot disagree, and
  `aria-controls` always names a pane that exists.

### A 1 px label can add 900 px of page

`.sr-only` is `position: absolute; width: 1px`. Put it inside a table — as a
`<caption class="sr-only">` or a hidden cell label — and it has **no positioned
ancestor**, so its containing block is the initial one: it escapes the scroll box
that clips its table and its layout position extends the *document's* scrollable
area. Measured on the Clockify dashboard: three captions put the document at
1822 px in a 900 px window, so the page grew a second (browser) scrollbar and
~900 px of blank space under the content — while every dashboard without a caption
was fine.

- **The scroll box is the containing block.** `.dsh-tblscroll` carries
  `position: relative` for exactly this reason: the caption is then contained by the
  box it belongs to and clipped by the box's own `overflow`. The rule looks like
  decoration and is not; `tests/unit/connector-registry.test.cjs` fails if it is
  removed or if a dashboard gains an `sr-only` element without a positioned box
  around its table.
- **Two scrollbars is a bug, not a preference.** The app has exactly one page
  scroller (`.main-scroll`); anything that makes `document.scrollHeight` exceed the
  window is an element that escaped a clip. Check it by measuring, not by eye.
- **The two columns must end together.** `.dsh` is `align-items: start`, so the
  shorter column simply stops — and a rail that ends 269 px above the main column
  reads as a hole. Content order is the fix, not `stretch`: on the Clockify tab the
  week summary is the lead card of the wide column (it is the paragraph the rest of
  the page repeats) and the individual card is a rail card (one subject, three
  facts). Under 900 px the rail is two up, and its **last card spans both columns**,
  because the last rail card is the footnote and a footnote paired with a two-line
  card leaves a hole as tall as the footnote — 594 px on that tab.

### A folder of spreadsheets is copied, not queried

The Lynk.id dashboard reads a Drive folder of **seventy** spreadsheets. It used to read
them through the Sheets API — two requests each, one for the tabs and one for the values
— against a quota of **60 reads a minute for one person**. 140 reads for one dashboard
means the tab either crawled under a self-imposed pace or answered `429
RESOURCE_EXHAUSTED`, and `Refresh` asked for all of them again. The numbers below are
measured on the real folder, not estimated.

- **One request per file, against a quota that does not run out.** Drive's export
  endpoint hands over the whole workbook (`…/files/<id>/export?mimeType=…sheet`), and
  `electron/connectors/lynk/xlsx.cjs` reads it here. No dependency: an `.xlsx` is a ZIP
  of XML, so `node:zlib` inflates it and three parts are parsed — the workbook, its
  relationships, and one worksheet with the shared-string table.
- **The copy is a file, and it is the cache.** `<ENTITY_HOME>/lynk-sheets/<folder>/<file>.xlsx`
  plus `index.json` of the `modifiedTime` each copy was taken at. A second visit reads
  the folder listing (one request), sees nothing changed and opens the local files:
  measured **485 ms and zero per-file requests**, against 18 s and 140 reads before.
  A file that changed in Drive is the only one downloaded again.
- **`Refresh` is the only path that empties the copies.** `dashboard({ force })` throws
  the folder's copies away and takes them all again (measured: 11 s, 70 exports) — a
  person pressing it is saying "I do not believe what is on disk". `Forget folder` is
  the other question: it deletes the whole tree, because the folder id is the key.
  They are not the same button and must not become one.
- **The export renames tabs.** Excel's rules are applied to sheet names: 31 characters,
  and `:` becomes a space. So `Viral Hook Architect - Transactions` arrives as
  `Viral Hook Architect - Transact`, and `ClipMotive: AI-Powered …` loses the colon *and*
  the suffix. A tab is therefore matched by name **and**, when the name was cut, by its
  header — a date column beside a price column. Name-only matching read 11 of the 18
  tabs; name-then-header read all 18.
- **A serial's integer part is the day.** A `Tanggal` cell holds 46286.95 — the 21st at
  22:53 — so the day is `floor`, never `round`: rounding files the sale on the 22nd and
  the report disagrees with the sheet it came from. With that, the local path produced
  the API path's numbers exactly: 73 orders, Rp 3.038.000, 17 products, 12 months.
- **A file that cannot be copied is a sentence, not a zero.** It is counted apart from
  an unreadable header (`sheets.failed`), named in the payload, and the page says
  "Refresh takes them again". If *every* file fails, the read throws — an empty folder
  and a dead token are not the same answer.

### A connector is one row in one registry, not a name in seven maps

A connector has **three names**, and every mistake in this area has been one of them
drifting from another: the **row id** (`google-calendar` — the roster, the address),
the **resolver kind** (`calendar` — `connectorOfKind`, the module basename) and the
**mention head** (`gcal` — what a person actually types).

`electron/connectors/registry.cjs` declares all three once, per connector, and
`index.cjs`, `rpc.cjs` and `mention-ref.cjs` derive from it. Before it, the same
connector was mapped by a 12-case `switch`, a `SUFFIX` table, an `ACCOUNT_KIND` map
and a block of the call table — four hand-kept copies, which is how `@gcal:` came to
be a special case in three of them.

- **A connector's calls live beside the connector.** `calls` is `name → handler` in
  its registry entry, and `rpc.cjs` spreads `connectorRegistry.calls()` into the table
  without naming a module path. A call the renderer asks for is a call the main
  process has, because both come from one declaration.
- **Nothing here loads at startup.** Every `require` sits inside a function, so a
  dashboard a person never opens is never parsed. The seven dashboard modules are
  about five thousand lines; `rpc.cjs` used to require them at boot.
- **The registry is data, so a test can read it.**
  `tests/unit/connector-registry.test.cjs` asserts unique ids, kinds and heads; every
  head resolves to a module; `calls()` equals what the entries declare; `rpc.cjs`
  requires no connector module; every dashboard kind has a pane body and a table
  entry; and a catalog row that advertises a resolver is the row the registry names.
  That test replaces the fifteen-file folklore a person used to hold in their head.
- **A connector that needs the process asks for it, not for `rpc.cjs`.** Three
  optional hooks on a descriptor are the whole surface: `attach(call)` (the call
  table, for something that serves this app over HTTP), `fanout(event)` (the event
  stream, mirrored) and `shutdown()` (stop what it started, on quit). The registry
  aggregates them (`attachAll` / `fanoutAll` / `shutdownAll`), so `rpc.cjs` and
  `main.cjs` call the registry and never a connector's path. Tailscale is the one
  connector that uses all three; it is also the one with a *server* rather than a
  remote service, which is why the hooks exist at all.
- **Main answers facts; the renderer answers words.** The lock's *state* is read in
  the main process (a token exists, a grant holds a scope); the sentence a person
  reads is in the renderer's connector entry, so a wording change is not a
  main-process release. Entity is where the copy lives, because a dashboard is a
  screen and `electron/` has no screens.

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

## Stylesheets are split by surface

`src/styles/app.css` is a list of `@import`s and nothing else, and **that list is
the cascade order**. Each sheet beside it owns one area of the interface. The
split is order-preserving by construction: the sheets in import order rebuild the
single file this used to be, so a rule may move between them without changing
what wins.

| Sheet | Owns |
| --- | --- |
| `tokens.css` | `:root` — the palette, the type stacks, the corner and type ladders — and the dark override |
| `brand.css` | the character's mark and the mark picker |
| `rail.css`, `chat-rail.css`, `chat-rail-rows.css`, `rail-two-tier.css` | the rails, in the order they were built |
| `chat.css`, `chat-thread.css`, `chat-history.css`, `chat-minimap.css` | the thread: page, turns, history, jump pill |
| `surfaces.css`, `responsive.css` | dialogs, palette, toast, and every breakpoint |
| `messages.css`, `context.css`, `inventory.css`, `cards.css` | the primitives a page is assembled from |
| everything else | one screen family each: `directory.css`, `dashboard.css`, `wizards.css`, `forms.css`, `backdrops.css`, `account-*.css`, … |

Rules that keep it that way:

1. **A rule lives with the surface it paints**, not with the screen that happened
   to add it. A new sheet means a new `@import` in `app.css`, in the place that
   matches where its rules sit in the cascade.
2. **`border-radius` and `font-size` are steps on a ladder**, never a number:
   corners `--r-2xs` 2px → `--r-xl` 20px → `--r-pill` 999px; type `--fs-micro`
   9px, `--fs-meta` 10px, `--fs-label` 11px, `--fs-secondary` 12px, `--fs-small`
   13px, `--fs-body` 14.5px, then `--fs-h6` 16px → `--fs-h1` 30px. Two values stay
   literal on purpose because they are not steps: `50%` (a circle, not a corner)
   and any relative size (`em`, `%`, `clamp()`, `inherit`) — those are meant to
   follow their context. `npm test` fails on a raw number or a `var(--r-…)` /
   `var(--fs-…)` that is not declared; a typo in a step name would silently fall
   back to a square corner or an inherited size.
3. **Find a selector with `grep`, not by guessing the sheet**: rule names are the
   stable thing, file names are the map.

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
12. If the page reads a remote service into numbers, it is a dashboard: cache it
   for a day in a JSON file under `~/.entity/`, re-read only on an explicit verb
   or the expiry, and print the rule from `cacheTtlMs` (see *A dashboard caches
   for a day, in a file*). If the service also limits by the hour, count the calls
   and refuse before spending them (see *A read-only dashboard still spends
   somebody's budget*).
13. A dashboard tab with more than one view keeps its view in the address —
   `?tab=dashboard`, and any filter that is a place a person would want to reopen.
   Validate what came in the URL against a closed set and drop the rest; never
   resolve "today" in the renderer, and never send a value the main process did
   not define back to it.
14. Styles go in the sheet for the surface (see **Stylesheets are split by
   surface**), and a corner and a type size come from the ladders in
   `tokens.css`.
