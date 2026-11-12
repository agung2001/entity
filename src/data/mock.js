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

/* Model names are a hint, not a whitelist: the composer accepts free text so a
   harness that ships a new model is usable without a release. */
export const MODELS = {
  claude: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  codex: ['gpt-5-codex', 'gpt-5'],
  opencode: ['anthropic/claude-sonnet-4', 'openai/gpt-5'],
  pi: ['claude-sonnet-4-5', 'gpt-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
}
