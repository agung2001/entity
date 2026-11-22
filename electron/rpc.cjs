/**
 * One call table for both transports.
 *
 * The Electron main process exposes it over `ipcMain.handle('entity:call')`; the
 * Vite dev server exposes the same table at `POST /__entity/call`. The renderer
 * therefore has exactly one client shape whether it runs in a window or a tab
 * (see src/composables/localBridge.js).
 *
 * Every call and every streamed run event carries `workspace`, so a run from the
 * workspace you just switched away from cannot be painted into the new one.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const localData = require('./local-data.cjs')
const mentionRef = require('./mention-ref.cjs')
const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const chats = require('./chat-store.cjs')
const sessions = require('./session-store.cjs')
const mcpStore = require('./mcp-store.cjs')
const mcpTools = require('./mcp-tools.cjs')
const mcpInterpret = require('./mcp-interpret.cjs')
const mcpServer = require('./mcp-server.cjs')
const auth = require('./auth-store.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const integrations = require('./integrations-store.cjs')
const turnTimeout = require('./turn-timeout-store.cjs')
const machineScan = require('./machine-scan.cjs')
const remoteRunner = require('./remote-runner.cjs')
const platform = require('./platform-core.cjs')
const pendingClones = require('./pending-clone.cjs')
const pendingWrites = require('./pending-write.cjs')
const { tilde } = require('./frontmatter.cjs')
const audit = require('./platform-audit.cjs')
const remoteSync = require('./remote-sync.cjs')
const threadMetadata = require('./thread-metadata.cjs')
const usage = require('./usage.cjs')
const learning = require('./learn.cjs')
const suggestions = require('./suggest.cjs')
const enhancement = require('./enhance.cjs')
const backups = require('./backup-store.cjs')
const retention = require('./retention-store.cjs')
const artifactRetention = require('./artifact-retention-store.cjs')
const voice = require('./voice.cjs')
const { createUpdateStore } = require('./update-store.cjs')
const { createTerminal } = require('./terminal-store.cjs')
const { createRunner } = require('./runner-local.cjs')

/**
 * The skills.sh boards, as URLs. One entry per board the page offers; a name
 * that is not here is refused rather than fetched, so the renderer cannot ask
 * this process to GET an address it chose.
 */
const BOARD_URLS = {
  all: 'https://www.skills.sh/',
  trending: 'https://www.skills.sh/trending',
  hot: 'https://www.skills.sh/hot',
}
const BOARD_TIMEOUT_MS = 20_000

/**
 * The files a live conversation still points at: `artifact://<id>` in a message, a
 * tool call's input, or a tool result. This lives here, not in the shelf's store,
 * because it reads the chat store's data — the shelf only receives the answer. A
 * reference is matched by its exact path; a folder reference (`artifact://design/`)
 * names no single file and protects none.
 */
const ARTIFACT_REF = /artifact:\/\/([^\s)"'`<>]+)/g

function collectRefs(text, found) {
  for (const hit of String(text || '').matchAll(ARTIFACT_REF)) {
    found.add(hit[1].replace(/[.,;:]+$/, ''))
  }
}

function referencedArtifacts({ workspace } = {}) {
  const found = new Set()
  let threads = []
  try {
    threads = chats.list({ workspace })
  } catch {
    return found
  }
  for (const summary of threads) {
    if (summary.archived) continue
    let thread = null
    try {
      thread = chats.read({ workspace, id: summary.id })
    } catch {
      continue
    }
    for (const message of thread?.messages || []) {
      collectRefs(message?.text, found)
      for (const step of message?.steps || []) {
        collectRefs(step?.content, found)
        collectRefs(step?.output, found)
        if (step?.input && typeof step.input === 'object') collectRefs(JSON.stringify(step.input), found)
      }
    }
  }
  return found
}

/**
 * The OS Trash only exists in the desktop shell. In the Vite server (plain Node)
 * `require('electron')` is not the Electron API, so the pass falls back to the
 * workspace's own `.trash` folder and the card says which one it used.
 */
function systemTrash() {
  try {
    const electron = require('electron')
    const shell = electron && electron.shell
    if (shell && typeof shell.trashItem === 'function') {
      return (file) => shell.trashItem(file)
    }
  } catch {
    /* no Electron shell in this build */
  }
  return null
}

function createRpc({
  emit = () => {},
  reveal = null,
  openPath = null,
  openExternal = null,
  openInEditor = null,
  chooseDirectory = null,
  identity = null,
  /* A terminal is a shell on the host that runs this process. That is the point
     in the desktop app and on the dev server, and it is a remote-code-execution
     hole in the shared server, so it is opt-in and off unless asked for. */
  terminal = false,
  /* True when this process *is* the sync host (`server/index.cjs`). The shelf's
     sweep can be assigned to that host, and it is the only executor that never
     waits for a person, so it is the only one whose idle switch means nothing. */
  host = false,
  /* The main process owns the updater because it is the only place a timer and
     `app.isPackaged` mean anything. The dev server and the shared server get the
     inert one, so the page falls back to its `dev` state instead of inventing a
     version to install. */
  update = createUpdateStore(),
} = {}) {
  const runner = createRunner({ emit })
  /* A six-hour poll plus a debounce after the watcher reports a local edit.
     `start` is idempotent, so a dev-server reload does not stack timers. */
  remoteSync.start({ emit })
  /* Smart backups are a timer, not a request. It is unref'd, so it never keeps
     the process alive, and `closeAll` clears it before a reload. */
  backups.start({ log: (line) => console.log(`[entity] ${line}`) })
  /* Chat retention is the same shape of timer: one boot tick that catches a
     deadline missed while the app was shut, then a poll. A workspace with no
     `retention.json` is never touched. */
  retention.start({ log: (line) => console.log(`[entity] ${line}`) })
  /* The desktop app has one account in `~/.entity/auth.json`. The server build
     passes the signed-in server user instead, so the same call table writes the
     right owner without a second implementation. */
  const currentUser = () => (typeof identity === 'function' ? identity() : auth.get())
  /* The artifact shelf is the same rule again, applied to files. Its providers
     are wired here because none of them belongs to the store: `referenced` reads
     the live transcripts, `trash` is a promise only the desktop build can keep,
     `busy` is the quiet signal a desktop can actually see, and `identity` is the
     account the owner's machine claim is matched against. */
  artifactRetention.configure({
    referenced: referencedArtifacts,
    trash: systemTrash(),
    busy: () => chats.activeCount() + runner.activeCount(),
    identity: () => currentUser(),
    host,
  })
  artifactRetention.start({ log: (line) => console.log(`[entity] ${line}`) })
  /* One shell per panel, owned by this process. Absent in the server build. */
  const terminals = terminal ? createTerminal({ emit }) : null
  const shellOnly = () => {
    if (!terminals) {
      throw new Error('The terminal runs in the desktop app, not in a shared server.')
    }
    return terminals
  }
  /* Threads are private to their account; the server's per-request identity has
     to reach the chat store, not just the call table. */
  chats.setIdentityResolver(() => currentUser())

  const handlers = {
    /* workspace */
    'workspace.list': () => workspaces.list(),
    'workspace.needsSetup': () => workspaces.needsSetup(),
    'workspace.open': ({ id }) => workspaces.open(id),
    'workspace.create': (args) => {
      const user = currentUser()
      const owner = user
        ? { name: user.name || user.username, email: user.email }
        : args?.owner || null
      return workspaces.create({ ...args, owner })
    },
    'workspace.update': (args) => workspaces.update(args),
    'workspace.samples': () => workspaces.samples(),
    'workspace.export': (args) => workspaces.exportWorkspace(args),
    'workspace.import': (args) => workspaces.importWorkspace(args),
    'workspace.remove': (args) => workspaces.remove(args),
    'workspace.machines': () => workspaces.machines(),
    'workspace.machineFacts': ({ id }) => workspaces.machineFacts(id),
    'workspace.scanMachine': (args) => machineScan.scanAndSave(args),
    'workspace.forgetMachineFacts': (args) => workspaces.forgetMachineFacts(args),
    'workspace.skills': ({ id }) => workspaces.skills(id),
    'workspace.attachSkill': (args) => workspaces.attachSkill(args),
    'workspace.replaceSkill': (args) => workspaces.replaceSkill(args),
    'workspace.copySkill': (args) => workspaces.copySkill(args),
    'workspace.detachSkill': (args) => workspaces.detachSkill(args),
    'workspace.skillRead': (args) => workspaces.skillRead(args),
    'workspace.mcp': ({ id }) => workspaces.mcp(id),
    'workspace.writeMcp': (args) => workspaces.writeMcp(args),
    'workspace.setMcpEnabled': (args) => workspaces.setMcpEnabled(args),
    'workspace.context': ({ id }) => workspaces.open(id).context || '',
    'workspace.setContext': (args) => workspaces.setContext(args),
    'workspace.claimOwner': (args) => {
      const user = currentUser()
      const owner = user
        ? { name: user.name || user.username, email: user.email }
        : args?.owner || null
      return workspaces.claimOwner({ ...args, owner })
    },
    'workspace.library': ({ machine } = {}) => localData.scanSkillLibrary({ machine }),
    'skills.names': ({ machine } = {}) => localData.scanSkillNames({ machine }),
    /* project-level skills for a thread's base directory */
    'skills.scanDir': ({ dir } = {}) => localData.scanProjectSkills({ dir }),
    /* the native folder picker; null in a browser-only build */
    'dialog.chooseDirectory': async ({ title } = {}) => {
      if (typeof chooseDirectory !== 'function') {
        throw new Error('Choosing a folder needs the desktop app. Type the path instead.')
      }
      const directory = await chooseDirectory(String(title || 'Choose a folder') || 'Choose a folder')
      return directory ? { canceled: false, directory } : { canceled: true, directory: '' }
    },
    /* Orca project names for the composer's `@` menu; cached in main for a minute.
       The `gated` map rides along because the menu, not the resolver, is where an
       integration that is off stops being offered (see Account → Integrations). */
    'mention.sources': async () => ({
      ...(await mentionRef.sources()),
      integrations: await integrations.enabled(),
    }),
    /* the worktree a delegated row works in, *now* — the renderer sends a
       ticket key and the run's cwd, and only a path Orca itself returned is
       ever stat-ed. Read-only, and cached in main like the repo list. */
    'mention.worktree': ({ cwd, ticket } = {}) =>
      mentionRef.worktreeState({ cwd: String(cwd || ''), ticket: String(ticket || '') }),
    /* what the composer offers while an `@kind:` is being typed */
    'mention.search': ({ workspace, kind, fields, limit, offset, dir }) =>
      mentionRef.search({
        record: workspaces.open(workspace),
        kind: String(kind || ''),
        fields: Array.isArray(fields) ? fields : [],
        limit: Number.isFinite(limit) ? limit : 10,
        offset: Number.isFinite(offset) ? offset : 0,
        dir: String(dir || ''),
        /* `@thread:` offers this workspace's conversations, through the store
           that already enforces who may read them */
        deps: { threads: { list: () => chats.list({ workspace }) } },
      }),
    'workspace.sources': () => localData.skillSources(),
    'workspace.home': () => ({ root: workspaces.ROOT, workspaces: workspaces.WORKSPACES_DIR }),
    'mcp.globals': () => mcpStore.globals(),
    'mcpServer.status': () => mcpServer.status(),
    'mcpServer.save': (args) => mcpServer.save(args),
    'mcpServer.rotate': () => mcpServer.rotate(),
    'mcpServer.test': () => mcpServer.test(),
    'auth.status': () => auth.status(),
    /* The desktop and the dev server answer false; the shared server build
       intercepts this before the call table and answers true. */
    'server.mode': () => ({ server: false }),
    'auth.verify': (args) => auth.verify(args),
    'auth.register': (args) => auth.register(args),
    'auth.adopt': (args) => auth.adopt(args),
    'auth.importLegacy': (args) => auth.importLegacy(args),
    'auth.update': (args) => auth.update(args),
    'auth.setPassword': (args) => auth.setPassword(args),
    'auth.changePassword': (args) => auth.changePassword(args),
    'mcp.tools': (args) => mcpTools.tools(args),
    /* The fallback reader for a paste the deterministic one could not parse.
       One model call, only on a click, and the answer is whitelisted again. */
    'mcp.interpret': (args) => mcpInterpret.interpret(args),
    'harness.list': () => harnesses.list(),
    'harness.models': (args) => harnesses.models(args),
    'harness.resolvePiModel': (args) =>
      harnesses.resolvePiModel(String(args?.model || ''), {
        binaryPath: harnesses.resolvedPath('pi'),
      }),
    'harness.setPath': (args) => harnesses.setPath(args),
    'harness.setEnabled': (args) => harnesses.setEnabled(args),

    /* how long a turn may run: one machine-wide number, read when a turn starts */
    'turn.status': () => turnTimeout.status(),
    'turn.set': (args) => turnTimeout.set(args),

    /* account → integrations: the machine-wide switches the composer's `@` menu
       reads, plus the one credential that lives in the workspace pool. `list` is
       the switches alone and `probe` is the status line, so the page paints its
       rows before a binary is spawned. */
    'integrations.list': (args) => integrations.list(args),
    'integrations.probe': (args) => integrations.probe(args),
    'integrations.setEnabled': (args) => integrations.setEnabled(args),
    'integrations.saveCredential': (args) => integrations.saveCredential(args),
    'integrations.test': (args) => integrations.test(args),

    /* workspace artifacts: files beside the entities and chats */
    'artifact.list': (args) => artifacts.list(args),
    'artifact.share': (args) => artifacts.share(args),
    /* Take back the files nobody shared. Opening the shelf is the natural moment:
       it is where the person would notice them, and the tree heals without a
       migration pass that has to run before every other read. */
    'artifact.adopt': (args) => artifacts.adoptUnclaimed(workspaces.open(args.workspace)),
    'artifact.unshare': (args) => artifacts.unshare(args),
    'artifact.read': (args) => artifacts.read(args),
    'artifact.download': (args) => artifacts.download(args),
    'artifact.upload': (args) => artifacts.upload(args),
    'artifact.saveText': (args) => artifacts.saveText(args),
    'artifact.writeText': (args) => artifacts.writeText(args),
    'artifact.remove': (args) => artifacts.remove(args),
    /* settings → Artifacts → Erase all: one scope per button (`shared`,
       `personal`, `all`), answered with what was actually removed. */
    'artifact.eraseAll': (args) => artifacts.eraseAll(args),
    'artifact.root': (args) => artifacts.rootPath(args),
    'artifact.reveal': (args) => {
      const found = artifacts.locate(args)
      if (typeof reveal !== 'function') throw new Error('Revealing files is not available in this build.')
      reveal(found.file)
      return found
    },
    /**
     * Open an artifact the way its extension allows: the file manager, VS Code,
     * or whatever the OS opens `.html` / `.pdf` with. The renderer names an id
     * and a verb, never a path or a command, and the verb is checked against
     * the server's own capability list rather than trusted.
     */
    'artifact.open': async ({ workspace, id, how = 'reveal' } = {}) => {
      const found = artifacts.locate({ workspace, id })
      const allowed = found.meta.capabilities || []
      if (!allowed.includes(how)) {
        throw new Error(
          how === 'editor'
            ? 'This file is not text, so there is nothing to open in an editor.'
            : how === 'browser'
              ? 'That file has no rendered page to open in a browser.'
              : `This build cannot open an artifact that way (${how}).`,
        )
      }
      if (how === 'reveal') {
        if (typeof reveal !== 'function') {
          throw new Error('Revealing files is not available in this build.')
        }
        reveal(found.file)
        return { ...found.meta, how }
      }
      if (how === 'editor') {
        if (typeof openInEditor !== 'function') {
          throw new Error('Opening an editor is not available in this build.')
        }
        await openInEditor(found.file)
        return { ...found.meta, how }
      }
      /* A browser-open goes through the OS handler, so a multi-file HTML
         artifact keeps resolving its sibling files and assets. */
      if (typeof openPath !== 'function') {
        throw new Error('Opening files is not available in this build.')
      }
      await openPath(found.file)
      return { ...found.meta, how }
    },

    /* workspace backups: snapshots, retention and restore-as-a-copy */
    'backup.status': () => backups.status(),
    'backup.setMode': ({ id, mode } = {}) => backups.setMode({ id, mode }),
    'backup.setDirectory': ({ id, directory } = {}) => backups.setDirectory({ id, directory }),
    'backup.chooseFolder': async ({ id } = {}) => {
      if (typeof chooseDirectory !== 'function') {
        throw new Error(
          'The folder picker is only available in the desktop app. Type the path instead.',
        )
      }
      const directory = await chooseDirectory()
      if (!directory) return { canceled: true }
      return { canceled: false, entry: await backups.setDirectory({ id, directory }) }
    },
    'backup.run': ({ id } = {}) => backups.runNow(id),
    'backup.restore': ({ id, name } = {}) => backups.restore({ id, name }),
    'backup.remove': ({ id, name } = {}) => backups.removeSnapshot({ id, name }),
    'backup.reveal': ({ id, name } = {}) => backups.openFolder({ id, name, openPath }),

    /* auto-update: one updater in the main process, read and written here */
    'update.state': () => update.state(),
    'update.check': (args) => update.check(args),
    'update.download': () => update.download(),
    'update.install': () => update.install(),
    'update.setSettings': (patch) => update.setSettings(patch),

    /* thread metadata: links and paths mentioned in a conversation */
    'thread.metadata': (args) => threadMetadata.inspect(args),
    'thread.pathAction': async ({ workspace, id, path: target, action } = {}) => {
      /* Re-derive first: the renderer may only act on a path this thread
         actually mentions, not on one it made up. */
      const metadata = threadMetadata.inspect({ workspace, id })
      return threadMetadata.performPathAction(metadata, {
        target,
        action,
        handlers: { reveal, openPath, openInEditor },
      })
    },
    'link.open': ({ url } = {}) => threadMetadata.openLink(url, openExternal),

    /* entity files */
    'entity.list': ({ workspace }) => entities.list(workspace),
    'entity.read': ({ workspace, name }) => entities.read(workspace, name),
    'entity.write': ({ entity }) => entities.write(entity),
    'entity.scaffold': (args) => entities.scaffold(args),
    'entity.duplicate': (args) => entities.duplicate(args),
    'entity.clone': (args) => entities.cloneTo(args),
    'entity.remove': (args) => entities.remove(args),
    /* A cross-workspace copy proposed by a pinned run waits in the run's own
       workspace. The window is the person's own process, so approval can read
       the source again and compare the hash the run recorded. */
    'clone.pending': ({ workspace }) => pendingClones.read(workspaces.open(workspace)),
    'clone.approve': ({ workspace, id } = {}) => {
      const record = workspaces.open(workspace)
      const request = pendingClones.read(record)
      if (!request) throw new Error('There is no pending copy in this workspace.')
      if (id && request.id !== id) {
        throw new Error('That copy request is no longer current. Ask again.')
      }
      const sourceRecord = workspaces.open(request.from)
      const targetRecord = workspaces.open(request.to)
      const sourceFile = entities.locate({ workspace: request.from, name: request.name })
      platform.within(sourceRecord, sourceFile)
      const sha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(sourceFile))
        .digest('hex')
      if (sha256 !== request.sha256) {
        pendingClones.clear(record, request.id)
        throw new Error('The source entity changed since the request. Ask the run to prepare it again.')
      }
      const copy = entities.cloneTo({
        from: request.from,
        to: request.to,
        name: request.name,
        nextName: request.nextName || '',
        shape: request.mark?.shape || '',
        color: request.mark?.color || '',
        mood: request.mark?.mood || '',
      })
      pendingClones.clear(record, request.id)
      audit.append(targetRecord, {
        actor: 'user',
        verb: 'entity.clone',
        target: copy.name,
        from: request.from,
        bytes: Buffer.byteLength(copy.instructions || ''),
      })
      return copy
    },
    'clone.dismiss': ({ workspace, id } = {}) => {
      const record = workspaces.open(workspace)
      return { dismissed: pendingClones.clear(record, id) }
    },

    /* An instruction rewrite or a new entity a run proposed. `pending` carries
       metadata only — the bodies and the brief are read by `proposal`, when a
       card is actually on screen. */
    'write.pending': ({ workspace }) => {
      const request = pendingWrites.read(workspaces.open(workspace))
      if (!request) return null
      const { id, at, kind, name, requestedBy, bytes, previousBytes, stamp } = request
      /* the card names the file it will write, so the row carries the path */
      const file = entities.list(workspace).find((row) => row.name === name)
      const displayPath = file?.displayPath || tilde(entities.locate({ workspace, name }))
      return { id, at, kind, name, requestedBy, bytes, previousBytes, stamp, displayPath }
    },
    'write.proposal': ({ workspace, id } = {}) => {
      const request = pendingWrites.read(workspaces.open(workspace))
      if (!request) throw new Error('There is no pending write in this workspace.')
      if (id && request.id !== id) throw new Error('That write request is no longer current. Ask again.')
      /* The window renders a kind it knows and refuses the rest, rather than
         guessing what a newer producer meant. */
      if (request.kind === 'create') {
        const { harness, model, description, shape, color, mood, dir, body } = request
        return { id: request.id, kind: 'create', name: request.name, harness, model, description, shape, color, mood, dir, body }
      }
      if (request.kind !== 'write') throw new Error('That request is not one this window can show.')
      return {
        id: request.id,
        kind: 'write',
        name: request.name,
        previousBody: request.previousBody,
        body: request.body,
        stamp: request.stamp,
      }
    },
    'write.approve': ({ workspace, id } = {}) => {
      const record = workspaces.open(workspace)
      const request = pendingWrites.read(record)
      if (!request) throw new Error('There is no pending write in this workspace.')
      if (id && request.id !== id) throw new Error('That write request is no longer current. Ask again.')
      /* The window is nobody's run, so this takes the direct path; a create is
         checked again (`the name is taken now` is a conflict, not an overwrite)
         and a rewrite carries the stamp the proposal was read at. */
      const result =
        request.kind === 'create'
          ? platform.call('entity.create', {
              workspace,
              name: request.name,
              spec: {
                harness: request.harness,
                model: request.model,
                description: request.description,
                shape: request.shape,
                color: request.color,
                mood: request.mood,
                dir: request.dir,
                body: request.body,
              },
            })
          : platform.call('entity.setInstructions', {
              workspace,
              name: request.name,
              body: request.body,
              expect: request.stamp,
            })
      if (!result.ok) {
        const failure = new Error(result.error)
        failure.code = result.code
        throw failure
      }
      pendingWrites.clear(record, request.id)
      return result.data
    },
    'write.dismiss': ({ workspace, id } = {}) => {
      const record = workspaces.open(workspace)
      return { dismissed: pendingWrites.clear(record, id) }
    },

    'entity.learn': (args) => learning.review(args),
    'entity.learnApply': (args) => learning.apply(args),
    'entity.reveal': ({ workspace, name }) => {
      const file = entities.locate({ workspace, name })
      if (typeof reveal !== 'function') throw new Error('Revealing files is not available in this build.')
      reveal(file)
      return { file }
    },

    /* conversations */
    'chat.list': ({ workspace }) => chats.list({ workspace }),
    'chat.read': ({ workspace, id }) => chats.read({ workspace, id }),
    'chat.create': (args) => chats.create(args),
    'chat.update': (args) => chats.update(args),
    'chat.rename': (args) => chats.rename(args),
    'chat.pin': (args) => chats.pin(args),
    /* One reversible verb, two spellings: archiving and restoring are the same
       write, and the row menu reads better than `archived: false`. */
    'chat.archive': (args) => chats.archive({ ...args, archived: true }),
    'chat.restore': (args) => chats.archive({ ...args, archived: false }),
    'chat.tags': (args) => chats.tags(args),
    'chat.send': (args) => chats.send({ ...args, emit }),
    'chat.remove': (args) => chats.remove(args),
    /* The one button that empties the whole history, from settings → Chats. It
       is a call of its own so the destructive write stays one verb with one
       answer (`{ removed, bytes }`), not a loop in the renderer. */
    'chat.eraseAll': (args) => chats.eraseAll(args),
    /* retention: one rule per workspace, a forecast, and the pass itself */
    'chat.retention': (args) => retention.analyse(args),
    /* Saves as you change it: the answer is the whole card again, so the
       forecast under the field is always the one the new number produces. */
    'chat.setRetention': (args) => {
      retention.save(args)
      return retention.analyse(args)
    },
    'chat.runRetention': (args) => retention.run(args),
    /* the shelf's own rule: the same three calls, on files instead of threads */
    'artifact.retention': (args) => artifactRetention.analyse(args),
    'artifact.setRetention': (args) => {
      artifactRetention.save(args)
      return artifactRetention.analyse(args)
    },
    'artifact.runRetention': (args) => artifactRetention.run(args),
    'chat.cancel': (args) => chats.cancel(args),
    /* the plan gate's one answer: `run` starts the held runs, `cancel` starts
       nothing. A held turn is in memory, so a stale window gets `none` and the
       card stays as it was. */
    'chat.delegate': (args) => chats.decideHold(args),
    'chat.suggest': (args) => suggestions.suggest(args),
    /* A rewrite, not a turn: no chat write, no counter, nothing sent. */
    'chat.enhance': (args) => enhancement.enhance(args),

    /* spend and activity, folded from the thread files */
    'usage.summary': (args) => usage.summary(args),

    /* voice mode: which local transcriber this machine has, and one take. The
       renderer sends audio only — never a path or a command. */
    'voice.status': () => voice.status(),
    'voice.transcribe': (args) => voice.transcribe(args || {}),

    /* the chat terminal: one shell, on this machine or a fleet host */
    'terminal.available': () =>
      terminals
        ? terminals.available()
        : {
            ok: false,
            local: false,
            reason: 'The terminal runs in the desktop app, not in a shared server.',
          },
    'terminal.open': (args) => shellOnly().open(args),
    'terminal.write': (args) => shellOnly().write(args),
    'terminal.resize': (args) => shellOnly().resize(args),
    'terminal.read': (args) => shellOnly().read(args),
    'terminal.list': (args) => shellOnly().list(args),
    'terminal.close': ({ id } = {}) => shellOnly().close(id),

    /* harness sessions, read from each CLI's own store */
    'sessions.list': (args) => sessions.list(args),

    /* runs */
    'run.start': (args) => runner.start(args),
    'run.cancel': (args) => runner.cancel(args),
    'run.list': (args) => runner.list(args),
    'run.latest': (args) => runner.latest(args),

    /* the machine as it exists, not as this workspace intends it */
    'ssh.hosts': () => localData.readSshHosts(),
    'ssh.probe': ({ alias }) => localData.probeSshHost(String(alias || '')),
    'skills.scan': ({ machine, hash } = {}) =>
      localData.scanSkillLibrary({ machine, hash: Boolean(hash) }),
    'skills.remote': ({ machine } = {}) => remoteRunner.listSkills(machine),
    /* The skills.sh boards, read here because the site sends no CORS headers and
       the renderer therefore cannot fetch it. The URL is allowlisted, the parse
       stays in the renderer (`src/lib/skillsh.js`), and nothing is cached here. */
    'skills.board': async ({ board = 'all' } = {}) => {
      const url = BOARD_URLS[String(board)]
      if (!url) {
        throw new Error(`There is no skills.sh board called "${board}".`)
      }
      const response = await fetch(url, {
        headers: { accept: 'text/html', 'user-agent': 'entity' },
        signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
        redirect: 'follow',
      })
      if (!response.ok) {
        throw new Error(`skills.sh answered ${response.status} for ${board}.`)
      }
      return { board, url, html: await response.text() }
    },

    /* remote workspace sync: one connection per workspace, kept in
       <ws>/.remote.json and <ws>/.remote.token (0600) */
    'remote.discover': (args) => remoteSync.discover(args),
    'remote.connect': (args) => remoteSync.connect(args, { emit }),
    'remote.reconnect': (args) => remoteSync.reconnect(args, { emit }),
    'remote.sync': (args) => remoteSync.sync({ id: args?.id, reason: args?.reason || 'manual' }, { emit }),
    'remote.status': (args) => remoteSync.status(args),
    'remote.list': () => remoteSync.list(),
    'remote.disconnect': (args) => remoteSync.disconnect(args),
    'remote.approve': (args) => remoteSync.approve(args),
    'remote.setGuard': (args) => remoteSync.setGuard(args),
    'remote.noteLocalChange': ({ id } = {}) => {
      remoteSync.noteLocalChange(id)
      return { noted: true }
    },
    'skills.read': ({ harness, name }) =>
      localData.readSkillEntry(String(harness || ''), String(name || '')),

    /* The agent-facing verbs, reachable from the window too. One vocabulary for
       both: a feature added for an agent is a feature the UI can grow into, not
       a second implementation of the same write. */
    'platform.verbs': () => platform.verbsList(),
    'platform.call': ({ fn, args }) => {
      const result = platform.call(fn, args)
      if (!result.ok) throw new Error(result.error)
      return result.data
    },
  }

  async function call(fn, args) {
    const handler = handlers[String(fn || '')]
    if (!handler) return { ok: false, error: `Unknown call "${fn}".` }
    try {
      return { ok: true, data: await handler(args || {}) }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  return {
    call,
    runner,
    /* Both halves: a run and a chat answer each hold a harness process, and a
       quit that only stopped runs would leave the chat answering into a
       window that no longer exists. */
    closeAll: async () => {
      try {
        chats.closeAll()
      } catch {
        /* the runner still has children to stop */
      }
      runner.closeAll()
      try {
        terminals?.closeAll()
      } catch {
        /* a shell that already exited is not a failed shutdown */
      }
      remoteSync.stop()
      backups.stop()
      update.stop()
      await mcpServer.stop()
    },
    activeCount: () => runner.activeCount() + chats.activeCount(),
  }
}

module.exports = { createRpc }
