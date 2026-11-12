/**
 * The five harnesses this step can run, and the slash commands they all ship
 * with. Everything else the hub shows comes from the workspace on disk.
 */
export const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'opencode', label: 'opencode' },
  { id: 'pi', label: 'pi' },
  { id: 'gemini', label: 'Gemini CLI' },
]

export const BUILTIN_CMDS = [
  { name: '/write', desc: 'Draft a file into the working tree' },
  { name: '/review', desc: 'Read the diff and report problems' },
  { name: '/plan', desc: 'Write a plan before touching code' },
  { name: '/handoff', desc: 'Write the run summary to .entity/run.json' },
]
