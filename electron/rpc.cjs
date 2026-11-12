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
const localData = require('./local-data.cjs')
const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const chats = require('./chat-store.cjs')
const sessions = require('./session-store.cjs')
const mcpStore = require('./mcp-store.cjs')
const mcpTools = require('./mcp-tools.cjs')
const auth = require('./auth-store.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const platform = require('./platform-core.cjs')
const { createRunner } = require('./runner-local.cjs')

function createRpc({ emit = () => {}, reveal = () => {} } = {}) {
  const runner = createRunner({ emit })

  const handlers = {
    /* workspace */
    'workspace.list': () => workspaces.list(),
    'workspace.needsSetup': () => workspaces.needsSetup(),
    'workspace.open': ({ id }) => workspaces.open(id),
    'workspace.create': (args) => {
      const user = auth.get()
      const owner = user ? { name: user.username, email: user.email } : args?.owner || null
      return workspaces.create({ ...args, owner })
    },
    'workspace.update': (args) => workspaces.update(args),
    'workspace.samples': () => workspaces.samples(),
    'workspace.export': (args) => workspaces.exportWorkspace(args),
    'workspace.import': (args) => workspaces.importWorkspace(args),
    'workspace.remove': (args) => workspaces.remove(args),
    'workspace.machines': ({ id }) => workspaces.machines(id),
    'workspace.attachMachine': (args) => workspaces.attachMachine(args),
    'workspace.detachMachine': (args) => workspaces.detachMachine(args),
    'workspace.skills': ({ id }) => workspaces.skills(id),
    'workspace.attachSkill': (args) => workspaces.attachSkill(args),
    'workspace.detachSkill': (args) => workspaces.detachSkill(args),
    'workspace.skillRead': (args) => workspaces.skillRead(args),
    'workspace.mcp': ({ id }) => workspaces.mcp(id),
    'workspace.writeMcp': (args) => workspaces.writeMcp(args),
    'workspace.setMcpEnabled': (args) => workspaces.setMcpEnabled(args),
    'workspace.context': ({ id }) => workspaces.open(id).context || '',
    'workspace.setContext': (args) => workspaces.setContext(args),
    'workspace.claimOwner': (args) => {
      const user = auth.get()
      const owner = user ? { name: user.username, email: user.email } : args?.owner || null
      return workspaces.claimOwner({ ...args, owner })
    },
    'workspace.library': () => localData.scanSkillLibrary(),
    'skills.names': () => localData.scanSkillNames(),
    'workspace.sources': () => localData.skillSources(),
    'workspace.home': () => ({ root: workspaces.ROOT, workspaces: workspaces.WORKSPACES_DIR }),
    'mcp.globals': () => mcpStore.globals(),
    'auth.status': () => auth.status(),
    'auth.verify': (args) => auth.verify(args),
    'auth.register': (args) => auth.register(args),
    'auth.adopt': (args) => auth.adopt(args),
    'auth.importLegacy': (args) => auth.importLegacy(args),
    'auth.update': (args) => auth.update(args),
    'auth.setPassword': (args) => auth.setPassword(args),
    'auth.changePassword': (args) => auth.changePassword(args),
    'mcp.tools': (args) => mcpTools.tools(args),
    'harness.list': () => harnesses.list(),
    'harness.models': (args) => harnesses.models(args),
    'harness.setPath': (args) => harnesses.setPath(args),

    /* workspace artifacts: files beside the entities and chats */
    'artifact.list': (args) => artifacts.list(args),
    'artifact.read': (args) => artifacts.read(args),
    'artifact.download': (args) => artifacts.download(args),
    'artifact.upload': (args) => artifacts.upload(args),
    'artifact.saveText': (args) => artifacts.saveText(args),
    'artifact.remove': (args) => artifacts.remove(args),
    'artifact.root': (args) => artifacts.rootPath(args),
    'artifact.reveal': (args) => {
      const found = artifacts.locate(args)
      reveal(found.file)
      return found
    },

    /* entity files */
    'entity.list': ({ workspace }) => entities.list(workspace),
    'entity.read': ({ workspace, name }) => entities.read(workspace, name),
    'entity.write': ({ entity }) => entities.write(entity),
    'entity.scaffold': (args) => entities.scaffold(args),
    'entity.duplicate': (args) => entities.duplicate(args),
    'entity.remove': (args) => entities.remove(args),
    'entity.reveal': ({ workspace, name }) => {
      const file = entities.locate({ workspace, name })
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
    'chat.send': (args) => chats.send({ ...args, emit }),
    'chat.remove': (args) => chats.remove(args),

    /* harness sessions, read from each CLI's own store */
    'sessions.list': (args) => sessions.list(args),

    /* runs */
    'run.start': (args) => runner.start(args),
    'run.cancel': (args) => runner.cancel(args),
    'run.list': (args) => runner.list(args),
    'run.latest': (args) => runner.latest(args),

    /* the machine as it exists, not as this workspace intends it */
    'ssh.hosts': () => localData.readSshHosts(),
    'ssh.probe': ({ alias, workspace }) => {
      /* An attached host is tested through the workspace's own machines/CONFIG
         (and the key copy beside it) — that is the file that matters.
         An unattached host is tested through ~/.ssh/config, because a probe is
         how the user decides whether attaching is worth it, and a config that
         does not mention the host yet would answer the wrong question. */
      const target = String(alias || '')
      let configFile = ''
      if (workspace) {
        try {
          const attached = workspaces
            .machines(workspace)
            .some((machine) => machine.id === target && !machine.missing)
          if (attached) configFile = workspaces.machinesConfigPath(workspaces.open(workspace))
        } catch {
          configFile = ''
        }
      }
      return localData.probeSshHost(target, { configFile })
    },
    'skills.scan': () => localData.scanSkillLibrary(),
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
    closeAll: () => {
      try {
        chats.closeAll()
      } catch {
        /* the runner still has children to stop */
      }
      runner.closeAll()
    },
    activeCount: () => runner.activeCount() + chats.activeCount(),
  }
}

module.exports = { createRpc }
