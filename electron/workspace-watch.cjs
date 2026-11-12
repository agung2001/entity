/**
 * Watch `~/.entity/workspaces` so the window notices files it did not write.
 *
 * An agent rewriting its own instructions through the CLI is one writer; a
 * person with `$EDITOR` is another; `git checkout` is a third. The three-readers
 * promise in `entity-store.cjs` only holds if the window stops believing its
 * last read, and re-reading on a timer is both wasteful and laggy.
 *
 * Two filters keep this from becoming a load source:
 *   - only the paths that change what a run *is* — `entities/`, `skills/`,
 *     `workspace.json`, `mcp.json`. Run logs (`runs/*.jsonl`) are appended every
 *     50 ms during a run and must never wake the renderer.
 *   - one event per workspace per quiet period, because a single write is
 *     several filesystem events on macOS.
 */
const fs = require('node:fs')

const RELEVANT = [/^entities\/.+\.md$/, /^skills\//, /^workspace\.json$/, /^mcp\.json$/]

/** `<id>/entities/foo.md` → `{ id, rest }` */
function split(relative) {
  const normalised = String(relative || '').replace(/\\/g, '/')
  const at = normalised.indexOf('/')
  if (at < 0) return { id: normalised, rest: '' }
  return { id: normalised.slice(0, at), rest: normalised.slice(at + 1) }
}

function relevant(rest) {
  return RELEVANT.some((pattern) => pattern.test(rest))
}

function watchWorkspaces({ root, emit = () => {}, debounceMs = 250 } = {}) {
  let watcher = null
  let timer = null
  const pending = new Map()

  function flush() {
    timer = null
    const batch = [...pending.entries()]
    pending.clear()
    for (const [workspace, paths] of batch) {
      emit({ kind: 'workspace-changed', workspace, paths: [...paths].sort() })
    }
  }

  try {
    /* recursive is macOS/Windows only; elsewhere this throws and the window
       falls back to re-reading on navigation, which it already does. */
    watcher = fs.watch(root, { recursive: true }, (_event, file) => {
      const { id, rest } = split(file)
      if (!id || id.startsWith('.')) return
      if (!relevant(rest)) return
      if (!pending.has(id)) pending.set(id, new Set())
      pending.get(id).add(rest)
      if (timer) return
      timer = setTimeout(flush, debounceMs)
    })
    watcher.on('error', () => {
      /* a watcher that dies is not a reason to take the app down */
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
      watcher = null
    })
  } catch {
    watcher = null
  }

  return {
    close() {
      clearTimeout(timer)
      timer = null
      pending.clear()
      try {
        watcher?.close()
      } catch {
        /* nothing to close */
      }
      watcher = null
    },
    watching: () => Boolean(watcher),
  }
}

module.exports = { watchWorkspaces, split, relevant }
