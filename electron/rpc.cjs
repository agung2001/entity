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
const { createRunner } = require('./runner-local.cjs')

function createRpc({ emit = () => {}, reveal = () => {} } = {}) {
  const runner = createRunner({ emit })

  const handlers = {
    /* workspace */
    'workspace.list': () => workspaces.list(),
    'workspace.needsSetup': () => workspaces.needsSetup(),
    'workspace.open': ({ id }) => workspaces.open(id),
    'workspace.create': (args) => workspaces.create(args),
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

    /* runs */
    'run.start': (args) => runner.start(args),
    'run.cancel': (args) => runner.cancel(args),
    'run.list': (args) => runner.list(args),
    'run.latest': (args) => runner.latest(args),

    /* the machine as it exists, not as this workspace intends it */
    'ssh.hosts': () => localData.readSshHosts(),
    'ssh.probe': ({ alias }) => localData.probeSshHost(String(alias || '')),
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
