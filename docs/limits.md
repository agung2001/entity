[← README](../README.md)

# Ceilings — stated, not hidden

What Entity does not do is part of the interface. If a limit is here, you can
plan around it; if it were hidden, you would find out mid-task.

## Runtime

- **A run dies with the app.** There is no daemon; nothing keeps working while the
  window is closed. The archive sweep is a timer in the main process, so it also stops
  with the window and catches up within a minute of the next launch.
- **Remote chat is one ssh turn at a time.** A thread pinned to a machine stages a
  temporary workspace, runs the installed harness there and streams the answer
  back. The remote directory is deleted after the turn; entity *runs* still execute
  on the machine whose window started them. The server image has no harness
  binaries, so remote chat is a desktop feature.

## Sync

- **File-level, not a CRDT.** Simultaneous edits keep both bytes as a conflict copy,
  but they are not merged line by line.
- **The guard is a scan, not a sandbox.** It catches the obvious payloads before they
  reach a harness; it cannot prove a file is benign.
- **Secrets do not travel.** An MCP definition is shared with `***` in place of every
  env and header value. Each machine supplies its own.

## Skills and machines

- **Skills are not sandboxed per workspace at execution time**; a harness loads its
  own user-level library. Only this machine's libraries can be read, so a thread
  pinned to an ssh host offers none rather than a path the far side cannot see.
- **A base directory is local-only.** A thread pinned to another machine cannot read
  this disk, so the field is hidden there and `/project:` is refused rather than
  resolved to a path the far side cannot see.
- **`machine-facts.json` is local to this copy of the workspace.** Host aliases and
  installed CLIs describe this user's machines, not a shared project file.

## Terminal

- **A shell, not a sandbox, and it cannot be resized.** It runs as you, on the host
  that owns the thread, with no approval step — it is your own window, not an
  entity's.
- The pty belongs to the relay (or to ssh's far side), so the shell is told its size
  once at open: widening the panel reflows the text the emulator already has, but a
  full-screen program keeps the columns it started with until a new shell is opened.
- On Windows a local shell needs a POSIX pty this build does not have, so only
  remote machines work there; on a Mac without `python3` the panel says so instead
  of pretending to start.
- **Not in the server build.** A shell is code execution on the host that serves the
  page.

## Numbers

- **Spend is only what the harness reports.** A turn without a price still counts as
  a turn and as tokens, but contributes nothing to the dollar total; the charts never
  estimate a price.
- **`audit.jsonl` has no window yet.** It is written and readable from the CLI.
- **Export** carries entities, chats, **shared** artifacts, copied skills and the MCP
  pool. A personal shelf (`.personal/`), workspace metadata, machine capability facts
  and run logs are deliberately left out. A local ZIP backup is a snapshot of the
  whole folder, so it does carry `.personal/` and `workspace.json`.

## Voice

- **Desktop voice needs a local transcriber.** The desktop shell has no
  speech-recognition service, so voice records with the microphone and runs a whisper
  CLI you installed plus a model you provided. Without one the dialog says so and
  offers typing; the entity still speaks. A Chrome/Edge tab can use the browser's
  recognition service instead.

## Related

- [Architecture](architecture.md)
- [Security](security.md)
- [Status](status.md)
