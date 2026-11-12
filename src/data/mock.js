/**
 * The five harnesses this step can run. Everything else the hub shows comes from
 * the workspace on disk; there are no built-in commands, because every command
 * this app used to advertise was a skill reference or a harness-owned token.
 */
export const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'opencode', label: 'opencode' },
  { id: 'pi', label: 'pi' },
  { id: 'gemini', label: 'Gemini CLI' },
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
