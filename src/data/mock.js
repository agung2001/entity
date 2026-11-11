/**
 * Sample workspace data.
 *
 * The mock-ups hard-code these records in the page; here they live in one
 * module so every view reads the same workspace. Nothing in this file talks
 * to a backend — see reports/unclear/hub-mockup-questions.md §1.
 */

export const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'opencode', label: 'opencode' },
  { id: 'pi', label: 'pi' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'gemini', label: 'Gemini CLI' },
]

export const BUILTIN_CMDS = [
  { name: '/write', desc: 'Draft a file into the working tree' },
  { name: '/review', desc: 'Read the diff and report problems' },
  { name: '/plan', desc: 'Write a plan before touching code' },
  { name: '/handoff', desc: 'Write the run summary to .entity/run.json' },
]

export const WORKSPACES = [
  { id: 'sundoro', label: 'sundoro', kind: 'self-hosted', entities: 6 },
  { id: 'nightshift', label: 'nightshift', kind: 'self-hosted', entities: 3 },
  { id: 'sandbox', label: 'sandbox', kind: 'local', entities: 1 },
]

export const AGENTS = [
  {
    id: 'py-agent',
    name: 'py-agent',
    runtime: 'python',
    status: 'running',
    desc: 'Repo work, tests and refactors. Reads ENTITY.md before every run.',
    skills: [
      'web-research',
      'pdf-ocr',
      'sql-analyst',
      'git-archaeology',
      'dataset-trim',
      'sheet-fill',
    ],
    machines: ['studio-mac', 'hetzner-prod'],
    last: '4m ago',
    size: '42.1 MB',
    model: 'claude-sonnet · local',
    start: '2 weeks ago',
  },
  {
    id: 'scout',
    name: 'research-scout',
    runtime: 'node',
    status: 'idle',
    desc: 'Crawls docs and papers, writes notes with citations.',
    skills: ['web-research', 'playwright-crawl', 'youtube-transcript'],
    machines: ['gpu-box'],
    last: '2h ago',
    size: '18.4 MB',
    model: 'gpt · api',
    start: '5 days ago',
  },
  {
    id: 'inbox-triage',
    name: 'inbox-triage',
    runtime: 'python',
    status: 'running',
    desc: 'Sorts the shared inbox, drafts replies, never sends.',
    skills: ['slack-digest', 'invoice-parse', 'sheet-fill'],
    machines: ['studio-mac'],
    last: '12m ago',
    size: '9.8 MB',
    model: 'local · ollama',
    start: '3 weeks ago',
  },
  {
    id: 'deploy-bot',
    name: 'deploy-bot',
    runtime: 'bash',
    status: 'idle',
    desc: 'Builds, tags and ships. Asks before it touches production.',
    skills: ['git-archaeology', 'changelog-writer'],
    machines: ['hetzner-prod'],
    last: '1d ago',
    size: '6.2 MB',
    model: 'claude-haiku · local',
    start: '1 week ago',
  },
  {
    id: 'docs-writer',
    name: 'docs-writer',
    runtime: 'node',
    status: 'sleep',
    desc: 'Turns merged PRs into documentation. Waiting for a target runtime.',
    skills: ['changelog-writer', 'web-research'],
    machines: [],
    last: '5d ago',
    size: '11.0 MB',
    model: 'gpt · api',
    start: '2 days ago',
  },
  {
    id: 'eval-runner',
    name: 'eval-runner',
    runtime: 'python',
    status: 'idle',
    desc: 'Runs golden-set evals before any skill ships.',
    skills: ['dataset-trim', 'sql-analyst', 'image-upscale'],
    machines: ['gpu-box'],
    last: '6h ago',
    size: '24.7 MB',
    model: 'gpu-box · vllm',
    start: '4 days ago',
  },
]

export const MACHINES = [
  {
    id: 'studio-mac',
    label: 'studio-mac',
    desc: 'MacBook Pro · M4 · 24 GB',
    state: 'online',
    thisMachine: true,
    ssh: 'ssh · ed25519',
  },
  {
    id: 'hetzner-prod',
    label: 'hetzner-prod',
    desc: 'Ubuntu 24.04 · 8 vCPU · 32 GB',
    state: 'online',
    thisMachine: false,
    ssh: 'ssh · ed25519',
  },
  {
    id: 'gpu-box',
    label: 'gpu-box',
    desc: 'Linux · RTX 4090 · asleep 3h',
    state: 'sleep',
    thisMachine: false,
    ssh: 'ssh · ed25519',
  },
]

export const ENTITY_MD = {
  'py-agent':
    '# py-agent\n\nYou are py-agent, a Python engineer. You work in a repo, not in a chat.\n\n## Rules\n- Run `uv run pytest -q` before claiming a task is done.\n- Never edit `migrations/` without a written plan.\n- Keep diffs under 200 lines; split anything larger.\n\n## Skills\n- web-research, pdf-ocr, sql-analyst, git-archaeology\n\n## Handoff\nWrite a summary to `.entity/run.json` when you stop.',
  scout:
    '# research-scout\n\nYou find primary sources and quote them exactly.\n\n## Rules\n- Every claim ships with a URL and a date.\n- Never summarise a paper you have not opened.\n- Cap each run at 40 pages.\n\n## Skills\n- web-research, playwright-crawl, youtube-transcript',
  'inbox-triage':
    '# inbox-triage\n\nYou triage mail into three buckets: now, later, never.\n\n## Rules\n- Drafts only. Never send.\n- Flag anything legal or financial.\n\n## Skills\n- slack-digest, invoice-parse, sheet-fill',
  'deploy-bot':
    '# deploy-bot\n\nYou ship code. You do not guess.\n\n## Rules\n- Green CI is required before a tag.\n- Ask for confirmation on any production write.\n\n## Skills\n- git-archaeology, changelog-writer',
  'docs-writer':
    '# docs-writer\n\nYou turn merged pull requests into documentation.\n\n## Rules\n- Link the PR in every paragraph you add.\n- Run the link checker before finishing.\n\n## Skills\n- changelog-writer, web-research',
  'eval-runner':
    '# eval-runner\n\nYou gate skills on the golden set.\n\n## Rules\n- No skill ships under 0.82 pass rate.\n- Record the diff of every failing case.\n\n## Skills\n- dataset-trim, sql-analyst, image-upscale',
}

export const ACTIVITY = [
  { t: '2m', who: 'py-agent', act: 'copied to hetzner-prod', where: '42.1 MB · ssh' },
  {
    t: '1h',
    who: 'research-scout',
    act: 'synced web-research to all 3 machines',
    where: 'skill',
  },
  { t: '3h', who: 'eval-runner', act: 'restarted on gpu-box', where: 'vllm' },
  { t: '1d', who: 'deploy-bot', act: 'tagged v2.4.1 on hetzner-prod', where: 'CI green' },
  { t: '2d', who: 'inbox-triage', act: 'ENTITY.md updated', where: '+18 lines' },
]

/**
 * Skills are one library copied to machines. Only `web-research` has a detail
 * page in the mock-up, so only it carries an entry file, file list and run
 * history here — the rest render an honest empty state instead of invented
 * content (see questions §6).
 */
export const SKILLS = [
  'web-research',
  'pdf-ocr',
  'youtube-transcript',
  'playwright-crawl',
  'sql-analyst',
  'slack-digest',
  'invoice-parse',
  'image-upscale',
  'git-archaeology',
  'dataset-trim',
  'changelog-writer',
  'sheet-fill',
].map((name) => ({ name, detailed: name === 'web-research' }))

export const SKILL_DETAIL = {
  'web-research': {
    version: '1.4.2',
    runtime: 'node ≥ 20',
    lede: 'Fetches a page or a paper, keeps its structure, and returns claims with a URL and a date attached. No browser, so it runs anywhere node runs.',
    what:
      'One job: turn a URL into notes you can check later. It reads the document, not the chrome around it, and it never paraphrases a source it could quote.',
    behaviours: [
      {
        k: 'Fetch',
        d: 'Reads a URL, follows up to three redirects, and keeps headings, lists, tables and code blocks as structure.',
      },
      {
        k: 'Cite',
        d: 'Every claim comes back with its source URL and publication date, so a reader can open the original.',
      },
      {
        k: 'Bound',
        d: 'Stops at 40 pages or 90 seconds per run, whichever comes first. No silent truncation — the run says where it stopped.',
      },
    ],
    invoke: {
      cmd: '/web-research "compare bun and deno cold starts"',
      out: '→ 6 sources · 12 claims · 4.1 s\n  every claim carries { source, published, quote }',
    },
    manifest: {
      entry: 'SKILL.md',
      files: '5 · 8.8 KB',
      license: 'MIT',
      source: 'github.com/entity-skills/web-research',
    },
    requires: {
      runtime: 'node ≥ 20',
      network: 'https, outbound',
      browser: 'not needed',
      memory: '< 180 MB',
    },
    related: ['playwright-crawl', 'youtube-transcript', 'pdf-ocr', 'changelog-writer'],
    /** version per machine — one is behind, which is what the copy flow fixes */
    coverage: {
      'studio-mac': { version: '1.4.2', state: 'sync', last: '4m ago' },
      'hetzner-prod': { version: '1.4.2', state: 'sync', last: '4m ago' },
      'gpu-box': { version: '1.4.0', state: 'behind', last: '2h ago' },
    },
    md: `---
name: web-research
version: 1.4.2
entry: SKILL.md
runtime: node>=20
---

# web-research

Fetch a page, keep its structure, and return claims that can be checked.

## When to use
- A question needs a primary source, not a memory.
- A claim in a draft has no citation yet.
- Two sources disagree and someone has to read both.

## How it runs
1. Resolve the URL and follow up to three redirects.
2. Strip scripts, navigation, cookie walls and footers.
3. Keep headings, lists, tables and code blocks as structure.
4. Record title, author, published date and final URL.

## Rules
- Never quote more than 25 words from one source.
- Never summarise a page that returned no readable body.
- Stop at 40 pages or 90 seconds per run, whichever comes first.
- Write the run to ~/.entity/runs/web-research.jsonl before returning.

## Output
{ claims: [{ text, source, published, quote }], pages, stopped_at }`,
    files: [
      {
        name: 'SKILL.md',
        size: '2.4 KB',
        body: `# web-research

Fetch a page, keep its structure, and return claims that can be checked.

## When to use
- A question needs a primary source, not a memory.
- A claim in a draft has no citation yet.`,
      },
      {
        name: 'manifest.json',
        size: '0.6 KB',
        body: `{
  "name": "web-research",
  "version": "1.4.2",
  "entry": "SKILL.md",
  "runtime": "node>=20",
  "files": ["SKILL.md", "references/output-format.md",
            "references/sources.md", "scripts/fetch.mjs"],
  "license": "MIT"
}`,
      },
      {
        name: 'references/output-format.md',
        size: '1.1 KB',
        body: `# Output format

\`\`\`json
{
  "claims": [
    { "text": "...", "source": "https://...",
      "published": "2025-03-11", "quote": "..." }
  ],
  "pages": 6,
  "stopped_at": null
}
\`\`\`

\`stopped_at\` is a page number, never a silent cut.`,
      },
      {
        name: 'references/sources.md',
        size: '0.9 KB',
        body: `# Sources

Allowed
- html, pdf (text layer), plain text
- public docs, papers, changelogs

Refused
- pages behind a login or a paywall
- results that are only a JavaScript shell
- anything that returns < 200 words of body text`,
      },
      {
        name: 'scripts/fetch.mjs',
        size: '3.8 KB',
        body: `import { read, extract } from "./lib/read.mjs";

export async function run(url, opts = {}) {
  const cap = opts.pages ?? 40;
  const pages = [];
  const doc = await read(url, { redirects: 3 });
  pages.push(extract(doc));
  return { pages, claims: claim(pages), stopped_at: null };
}`,
      },
    ],
    runs: [
      { t: '1h ago', who: 'research-scout', mach: 'gpu-box', har: 'Claude Code', dur: '4.1 s', res: 'ok' },
      { t: '2h ago', who: 'py-agent', mach: 'hetzner-prod', har: 'Codex CLI', dur: '3.2 s', res: 'ok' },
      { t: 'yesterday', who: 'py-agent', mach: 'studio-mac', har: 'opencode', dur: '90.0 s', res: 'fail' },
      { t: '2d ago', who: 'docs-writer', mach: '—', har: 'pi', dur: '—', res: 'unplaced' },
      { t: '3d ago', who: 'research-scout', mach: 'gpu-box', har: 'Claude Code', dur: '6.8 s', res: 'ok' },
      { t: '4d ago', who: 'py-agent', mach: 'studio-mac', har: 'Claude Code', dur: '2.9 s', res: 'ok' },
    ],
    runTotal: 148,
  },
}

/** Seeded chat history — every reply is generated by the same engine the console uses. */
export const CHAT_SEED = [
  {
    id: 't1',
    entity: 'py-agent',
    machine: 'studio-mac',
    harness: 'claude',
    when: '2m',
    asks: ['/write add a retry to the fetch helper', 'Where do you run?'],
  },
  {
    id: 't2',
    entity: 'scout',
    machine: 'gpu-box',
    harness: 'codex',
    when: '38m',
    asks: ['What do you carry?', 'Where do you run?'],
  },
  {
    id: 't3',
    entity: 'inbox-triage',
    machine: 'studio-mac',
    harness: 'opencode',
    when: '1h',
    asks: ['/slack-digest summarise #support today'],
  },
  {
    id: 't4',
    entity: 'deploy-bot',
    machine: 'hetzner-prod',
    harness: 'pi',
    when: '3h',
    asks: ['Show ENTITY.md', 'Tell me your model and runtime'],
  },
  {
    id: 't5',
    entity: 'py-agent',
    machine: 'hetzner-prod',
    harness: 'claude',
    when: 'yesterday',
    asks: ['Tell me your model and runtime', 'What do you carry?'],
  },
  {
    id: 't6',
    entity: 'eval-runner',
    machine: 'gpu-box',
    harness: 'opencode',
    when: '2d',
    asks: ['/dataset-trim keep only the failing rows', 'Where do you run?'],
  },
]
