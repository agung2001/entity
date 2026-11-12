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
const { createRunner } = require('./runner-local.cjs')

function createRpc({ emit = () => {}, reveal = () => {} } = {}) {
  const runner = createRunner({ emit })

  const handlers = {
    /* workspace */
    'workspace.list': () => workspaces.list(),
    'workspace.needsSetup': () => workspaces.needsSetup(),
    'workspace.open': ({ id }) => workspaces.open(id),
    'workspace.create': (args) => workspaces.create(args),
    'workspace.update': (args) => workspaces.update(args),
    'workspace.samples': () => workspaces.samples(),
    'workspace.machines': ({ id }) => workspaces.machines(id),
    'workspace.attachMachine': (args) => workspaces.attachMachine(args),
    'workspace.detachMachine': (args) => workspaces.detachMachine(args),
    'workspace.skills': ({ id }) => workspaces.skills(id),
    'workspace.attachSkill': (args) => workspaces.attachSkill(args),
    'workspace.detachSkill': (args) => workspaces.detachSkill(args),
    'workspace.skillRead': (args) => workspaces.skillRead(args),
    'workspace.mcp': ({ id }) => workspaces.mcp(id),
    'workspace.writeMcp': (args) => workspaces.writeMcp(args),
    'workspace.library': () => localData.scanSkillLibrary(),
    'workspace.sources': () => localData.skillSources(),
    'workspace.home': () => ({ root: workspaces.ROOT, workspaces: workspaces.WORKSPACES_DIR }),
    'mcp.globals': () => mcpStore.globals(),

    /* entity files */
    'entity.list': ({ workspace }) => entities.list(workspace),
    'entity.read': ({ workspace, name }) => entities.read(workspace, name),
    'entity.write': ({ entity }) => entities.write(entity),
    'entity.scaffold': (args) => entities.scaffold(args),
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
    'chat.send': (args) => chats.send(args),
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
    closeAll: () => runner.closeAll(),
    activeCount: () => runner.activeCount(),
  }
}

module.exports = { createRpc }
