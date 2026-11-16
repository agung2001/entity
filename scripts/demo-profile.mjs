#!/usr/bin/env node
/**
 * Seed a throwaway profile for recording the README demos.
 *
 * Everything here is invented: a letterpress studio, a bakery and a travel
 * notebook. No real account, workspace, path, host, token or conversation is
 * read from — or written to — the machine's own profile. The app is pointed at
 * this folder with `ENTITY_HOME`, so the recording cannot show a real name even
 * by accident.
 *
 *   node scripts/demo-profile.mjs [--home /tmp/entity-demo] [--force]
 *
 * The profile lives under that throwaway home, which the app is also given as
 * `HOME`: there is no `~/.ssh/config` there, so no real host can appear in a
 * screenshot, and every path the interface prints starts with `~`.
 *
 * Then:
 *   HOME=/tmp/entity-demo ENTITY_HOME=/tmp/entity-demo/.entity VITE_DEV_PORT=5299 npm run dev
 *
 * Sign in with the printed demo account. See `docs/assets/README.md`.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const homeAt = args.indexOf('--home')
/* A throwaway home, not the real one: no ssh config, no account, no data. */
const DEMO_HOME = path.resolve(homeAt >= 0 ? args[homeAt + 1] : '/tmp/entity-demo')
const HOME = path.join(DEMO_HOME, '.entity')

export const DEMO = {
  email: 'studio@northwind.example',
  password: 'demo-northwind-24',
  name: 'Sam Rivers',
  home: DEMO_HOME,
  /* A folder a demo thread can be started in; created below. */
  project: path.join(DEMO_HOME, 'Studio', 'spring-catalogue'),
}

if (existsSync(DEMO_HOME) && !args.includes('--force')) {
  console.log(`${DEMO_HOME} already exists. Pass --force to replace it.`)
  process.exit(1)
}
rmSync(DEMO_HOME, { recursive: true, force: true })
mkdirSync(path.join(DEMO_HOME, '.ssh'), { recursive: true })
for (const dir of ['Studio/campaigns', 'Studio/catalogue', 'Kitchen', 'Notes']) {
  mkdirSync(path.join(DEMO_HOME, dir), { recursive: true })
}
/* Two invented hosts. The machines page reads aliases from `~/.ssh/config`, so
   the demo home needs its own file — this is why the recording cannot show a
   real host: there is no other config on that home. */
writeFileSync(
  path.join(DEMO_HOME, '.ssh', 'config'),
  [
    '# Demo hosts. Not real machines, no keys, nothing to connect to.',
    'Host studio-nas',
    '  HostName studio-nas.local',
    '  User sam',
    '',
    'Host workshop-mini',
    '  HostName workshop-mini.local',
    '  User sam',
    '',
  ].join('\n'),
)
process.env.ENTITY_HOME = HOME

const require = createRequire(import.meta.url)
const workspaces = require('../electron/workspace-store.cjs')
const auth = require('../electron/auth-store.cjs')

const OWNER = { name: DEMO.name, email: DEMO.email }
const iso = (daysAgo, hour = 10) => {
  const day = new Date(Date.UTC(2026, 10, 16, hour, 0, 0))
  day.setUTCDate(day.getUTCDate() - daysAgo)
  return day.toISOString()
}

function entity(workspaceId, file, fm, body) {
  const record = workspaces.open(workspaceId)
  const dir = path.join(record.path, 'entities')
  mkdirSync(dir, { recursive: true })
  const front = Object.entries({ name: file, ...fm })
    .filter(([, value]) => value !== '' && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  writeFileSync(path.join(dir, `${file}.md`), `---\n${front}\n---\n${body.trim()}\n`)
}

function skill(workspaceId, name, description, body) {
  const record = workspaces.open(workspaceId)
  const dir = path.join(record.path, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body.trim()}\n`,
  )
}

function artifact(workspaceId, relative, text) {
  const record = workspaces.open(workspaceId)
  const file = path.join(record.path, 'artifacts', relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function thread(workspaceId, thread) {
  const record = workspaces.open(workspaceId)
  const dir = path.join(record.path, 'chats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${thread.id}.json`), `${JSON.stringify(thread, null, 2)}\n`)
}

/** One answered turn: a question, a folded process, an answer, a price. */
function turn({
  id,
  entity: name,
  title,
  harness = 'claude',
  model = 'sonnet',
  at,
  question,
  steps = [],
  answer,
  artifacts = [],
  tokensIn = 3200,
  tokensOut = 780,
  costUsd = 0.061,
  ms = 24_000,
}) {
  const minutes = Math.round(ms / 1000)
  const messageAt = new Date(new Date(at).getTime() + ms + 4000).toISOString()
  return {
    schema: 1,
    id,
    entity: name,
    machine: 'local',
    harness,
    model,
    title,
    pinned: false,
    tags: [],
    createdAt: at,
    updatedAt: messageAt,
    messages: [
      { who: 'me', text: question, at },
      {
        who: 'agent',
        at: messageAt,
        text: answer,
        steps: [
          { seq: 1, type: 'thinking', at, content: `Reading the brief for ${title.toLowerCase()}.` },
          ...steps,
          { seq: steps.length + 2, type: 'text', at: messageAt, content: answer },
        ],
        execution: {
          id: `run_${id}`,
          harness,
          model,
          command: `${harness} --print`,
          cwd: '~/Studio/campaigns',
          startedAt: at,
          endedAt: messageAt,
          status: 'ok',
          ms,
          exitCode: 0,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut },
          costUsd,
        },
        ...(artifacts.length ? { artifacts } : {}),
      },
    ],
  }
}

/* ── the account ──────────────────────────────────────────────────── */
await auth.register({ email: DEMO.email, name: DEMO.name, password: DEMO.password })

/* ── 1. Northwind Studio — the workspace the README shows ─────────── */
const studio = workspaces.create({ label: 'Northwind Studio', owner: OWNER })
workspaces.setContext({
  id: studio.id,
  context:
    'A two-person letterpress studio. Everything here is written for people who buy\nby hand: warm, specific, never salesy. Prices are in euros, always with VAT noted.',
})

entity(studio.id, 'campaign-writer', {
  harness: 'claude', model: 'sonnet', shape: 'squircle', color: 'sun', mood: 'happy',
  skills: 'brand-voice, catalogue-structure', mcp: 'notes', dir: '~/Studio/campaigns'
}, `
# Campaign Writer

You write for the studio: launch notes, product pages, the seasonal email, the
occasional press release. Warm, plain, never salesy.

## Rules
- Lead with the reader's problem, not with us.
- One call to action per piece.
- Read it aloud; cut anything you would not say.
`)

entity(studio.id, 'line-editor', {
  harness: 'claude', model: 'sonnet', shape: 'blob', color: 'ember', mood: 'cool',
  skills: 'brand-voice', dir: '~/Studio/catalogue'
}, `
# Line Editor

You are the second pair of eyes. You cut, you tighten, you never rewrite the voice.

- Preserve the writer's rhythm; remove only what repeats.
- Flag a claim that needs a source instead of softening it.
- Return the edited text plus a short list of what changed and why.
`)

entity(studio.id, 'research-assistant', {
  harness: 'pi', model: 'sonnet', shape: 'pebble', color: 'sky', mood: 'focus',
  skills: 'research-brief', mcp: 'notes', dir: '~/Notes'
}, `
# Research Assistant

You gather what a decision needs: three good sources, a summary a person can read
on a phone, and the counter-argument nobody mentioned.

- Never invent a number. If the figure is missing, say what would settle it.
- Keep a running list of open questions at the end.
`)

entity(studio.id, 'studio-manager', {
  harness: 'claude', model: 'sonnet', shape: 'squircle', color: 'mint', mood: 'hype',
  skills: 'catalogue-structure', mcp: 'notes, calendar', dir: '~/Studio'
}, `
# Studio Manager

You keep the week honest: what ships, what waits, what costs money.

- A plan is one page. If it needs two, it is two weeks.
- Every commitment names the person and the day.
`)

entity(studio.id, 'photo-notes', {
  harness: 'gemini', model: 'flash', shape: 'cloud', color: 'orchid', mood: 'happy', dir: '~/Studio'
}, `
# Photo Notes

You write alt text and captions for product photography: what is in the frame,
the material, the light — in one sentence a person could search for.
`)

entity(studio.id, 'inbox-triage', {
  harness: 'opencode', model: 'default', shape: 'capsule', color: 'lime', mood: 'sleepy', dir: '~/Studio'
}, `
# Inbox Triage

You read the studio inbox and sort it: order, press, stock, everything else. You
draft a reply for the first three and leave the rest as names, not essays.
`)

skill(studio.id, 'brand-voice', 'Plain, warm prose for a small studio', `
# Brand voice

Write as one person to another.

- Short sentences. One idea each.
- A material gets its name: cotton rag, brass type, warm grey ink.
- Never "leverage". Never "solutions".
- Prices with VAT noted; shipping stated in plain words.
`)

skill(studio.id, 'catalogue-structure', 'How a season is laid out', `
# Catalogue structure

One spread per collection: a photograph, a paragraph of 40 words, three facts.

1. Name the material first.
2. Say what it is for.
3. Close with the price and the lead time.
`)

skill(studio.id, 'research-brief', 'A decision-ready research brief', `
# Research brief

Three sources, one summary, one open question. No invented figures.

- Prefer a primary source over a summary of one.
- Say what would change the recommendation.
`)

thread(studio.id, turn({
  id: 't_demo_launch_note', entity: 'campaign-writer', title: 'Spring launch note',
  at: iso(1, 9), costUsd: 0.084, tokensIn: 4100, tokensOut: 920, ms: 31_000,
  question: 'Write the launch note for the spring papers. Six new sheets, the studio is in the title, and the pre-order closes on the 30th.',
  steps: [
    { seq: 2, type: 'tool_use', tool: 'Read', content: 'artifacts/spring-papers-brief.md', at: iso(1, 9) },
    { seq: 3, type: 'tool_result', tool: 'Read', output: 'Six sheets, 200 copies each, pre-order closes 30 March.', at: iso(1, 9) },
    { seq: 4, type: 'tool_use', tool: 'Write', content: 'artifacts/spring-launch-note.md', at: iso(1, 9) },
  ],
  answer: `Six new papers, printed by hand and pressed one sheet at a time.

Each is a 200-copy run: cotton rag, brass type, warm grey ink. When the run is gone,
it is gone — that is the point of a small press.

Pre-orders close on the 30th. If you want the set, say so this week and we will hold
one back for you.

— Northwind Studio`,
  artifacts: [{ id: 'spring-launch-note.md', name: 'spring-launch-note.md', kind: 'text', mime: 'text/markdown', size: 1840 }],
}))

thread(studio.id, turn({
  id: 't_demo_tighten', entity: 'line-editor', title: 'Winter email edit',
  at: iso(3, 15), harness: 'claude', costUsd: 0.052, tokensIn: 2600, tokensOut: 610, ms: 18_000,
  question: 'Tighten this. It reads like a newsletter, not like us.',
  steps: [{ seq: 2, type: 'tool_use', tool: 'Read', content: 'artifacts/winter-email.md', at: iso(3, 15) }],
  answer: `Cut 38 words, kept your closing line.

**Changed**
- Removed the second "we are delighted" — one is enough.
- "Seasonal offering" became "the winter set".
- Split the paragraph about lead time into two sentences.

The edited file is on the shelf as \`winter-email-edited.md\`.`,
}))

thread(studio.id, turn({
  id: 't_demo_suppliers', entity: 'research-assistant', title: 'Cotton rag suppliers',
  at: iso(5, 11), harness: 'pi', costUsd: 0.121, tokensIn: 6200, tokensOut: 1180, ms: 47_000,
  question: 'Find two suppliers of cotton rag we could use for the autumn run, and tell me what would make you choose one.',
  steps: [
    { seq: 2, type: 'tool_use', tool: 'Search', content: 'cotton rag paper 250gsm small mill', at: iso(5, 11) },
    { seq: 3, type: 'tool_result', tool: 'Search', output: 'Two mills within a day of the studio.', at: iso(5, 11) },
  ],
  answer: `Two that fit: a mill in the valley that presses 250 gsm in three tones, and a
family run further north that will cut to our size but needs eight weeks.

I would choose the valley mill. Shorter lead time, and we can order 200 sheets
instead of a pallet.

**Open question:** neither lists the deckle edge — worth one call before we commit.`,
}))

thread(studio.id, turn({
  id: 't_demo_week', entity: 'studio-manager', title: 'Week before the fair',
  at: iso(8, 8), costUsd: 0.038, tokensIn: 1900, tokensOut: 420, ms: 12_000,
  question: 'Plan the last week before the spring fair. Two people, one press, and the catalogue is not printed yet.',
  answer: `One page, two people:

- **Mon** — catalogue to the printer by noon. Sam packs the small frames.
- **Tue** — press the autumn cards; Ada finishes the price list.
- **Wed** — nothing. Leave it empty for the thing that goes wrong.
- **Thu** — pack, label, weigh. No new work.
- **Fri** — load the van by 9, fair opens at 11.`,
}))

thread(studio.id, turn({
  id: 't_demo_captions', entity: 'photo-notes', title: 'Alt text, spring set',
  at: iso(12, 14), harness: 'gemini', costUsd: 0.019, tokensIn: 1500, tokensOut: 380, ms: 9_000,
  question: 'Write alt text for the six spring photographs. One sentence each.',
  answer: `1. A sheet of warm grey cotton rag, deckle edge, lying on a brass plate.
2. Two hands lifting a fresh print from the press, ink still dark.
3. A row of six finished papers pinned to a studio wall.
4. A stack of 200 copies, tied with linen thread.
5. The type locked in the chase, ready for the first run.
6. A close crop of the pressed texture, 250 gsm, soft and matte.`,
}))

/* a thread with a base directory, for the /project: demo */
mkdirSync(path.join(DEMO.project, '.claude', 'skills', 'press-proof'), { recursive: true })
writeFileSync(
  path.join(DEMO.project, '.claude', 'skills', 'press-proof', 'SKILL.md'),
  '# Press proof\n\nCheck a proof before a run: colour, registration, trim size.\n',
)
writeFileSync(
  path.join(DEMO.project, 'catalogue-draft.md'),
  '# Spring catalogue — draft\n\nSix sheets, 200 copies each.\n',
)
thread(studio.id, {
  schema: 1,
  id: 't_demo_catalogue',
  entity: 'line-editor',
  harness: 'claude',
  model: '',
  dir: DEMO.project,
  title: 'Proof the catalogue',
  pinned: true,
  tags: [],
  createdAt: iso(2, 16),
  updatedAt: iso(2, 16),
  messages: [
    { who: 'me', at: iso(2, 16), text: 'Proof it before we send the file to the printer.' },
    {
      who: 'agent',
      at: iso(2, 16),
      text: 'Proofed. Two things to fix before this goes out: the price on page 4 still says 18 € and the trim size is 2 mm off on the last spread. Everything else is clean.',
      steps: [
        { seq: 1, type: 'thinking', at: iso(2, 16), content: 'Checking colour, registration and trim size.' },
        { seq: 2, type: 'tool_use', tool: 'Read', at: iso(2, 16), content: 'catalogue-draft.md' },
        { seq: 3, type: 'text', at: iso(2, 16), content: 'Two things to fix before this goes out.' },
      ],
      execution: {
        id: 'run_catalogue', harness: 'claude', model: 'sonnet',
        command: 'claude --print', cwd: '~/Studio/catalogue',
        startedAt: iso(2, 16), endedAt: iso(2, 16), status: 'ok',
        ms: 16_400, exitCode: 0, usage: { input_tokens: 2400, output_tokens: 520 }, costUsd: 0.047,
      },
    },
  ],
})

/* one synthetic image artifact: a typographic poster, no photograph, no real work */
const posterPath = path.join(workspaces.open(studio.id).path, 'artifacts', 'spring-poster.png')
mkdirSync(path.dirname(posterPath), { recursive: true })
try {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })
  await page.setContent(`
    <body style="margin:0;width:1200px;height:800px;background:#f3e7d3;
      font-family:'Helvetica Neue',Arial,sans-serif;color:#3a2c21;
      display:flex;flex-direction:column;justify-content:center;align-items:center;gap:18px">
      <div style="width:1200px;height:800px;position:absolute;inset:0;
        background:linear-gradient(180deg,#f7efe2 0%,#f3e7d3 58%,#8a6a4f 58%,#6f5340 100%)"></div>
      <div style="position:relative;text-align:center;margin-top:-120px">
        <div style="font-size:54px;letter-spacing:.14em;font-weight:600">NORTHWIND STUDIO</div>
        <div style="font-size:28px;letter-spacing:.28em;color:#6b5340;margin-top:10px">SPRING PAPERS</div>
      </div>
      <div style="position:absolute;bottom:64px;color:#f3e7d3;font-size:20px;letter-spacing:.2em">
        SIX SHEETS · TWO HUNDRED COPIES
      </div>
    </body>`)
  await page.screenshot({ path: posterPath })
  await browser.close()
} catch (error) {
  console.log(`  · poster skipped: ${error.message.split('\n')[0]}`)
}

/* artifacts */
artifact(studio.id, 'spring-launch-note.md', `# Six new papers\n\nPre-orders close on the 30th.\n`)
artifact(studio.id, 'spring-papers-brief.md', `# Spring papers\n\nSix sheets, 200 copies each. Pre-order closes 30 March.\n`)
artifact(studio.id, 'winter-email.md', `# The winter set\n\nWe are delighted to share our seasonal offering.\n`)
artifact(studio.id, 'price-list.csv', `collection,sheets,copies,price_eur\nSpring,6,200,148\nAutumn,4,150,96\nCards,,600,42\n`)

/* MCP: three that work anywhere, one parked because it points at a laptop */
writeFileSync(
  path.join(workspaces.open(studio.id).path, 'mcp.json'),
  `${JSON.stringify({
    schema: 1,
    servers: {
      notes: { url: 'https://notes.northwind.example/mcp', headers: { Authorization: '***' } },
      calendar: { command: 'npx', args: ['-y', 'calendar-connector'] },
      files: { command: 'npx', args: ['-y', 'studio-files'] },
    },
    disabled: {
      'local-scanner': {
        command: '/Users/ada/bin/scan-notes',
        __remote: true,
        __unavailable: 'its command is a path inside a home directory on the machine that shared it',
      },
    },
  }, null, 2)}\n`,
)

writeFileSync(
  path.join(workspaces.open(studio.id).path, 'machine-facts.json'),
  `${JSON.stringify({
    schema: 1,
    hosts: {
      'studio-nas': {
        alias: 'studio-nas', label: 'studio-nas', spec: 'sam@studio-nas.local', status: 'ok',
        source: 'ssh', hostname: 'studio-nas',
        platform: 'Linux', arch: 'x64', checkedAt: iso(2, 9),
        harnesses: [
          { id: 'claude', label: 'Claude Code', path: '/usr/local/bin/claude', models: ['sonnet', 'opus'], default: 'sonnet' },
          { id: 'pi', label: 'pi', path: '/usr/local/bin/pi', models: ['sonnet'], default: 'sonnet' },
        ],
      },
      'workshop-mini': {
        alias: 'workshop-mini', label: 'workshop-mini', spec: 'sam@workshop-mini.local', status: 'ok',
        source: 'ssh', hostname: 'workshop-mini',
        platform: 'macOS', arch: 'arm64', checkedAt: iso(6, 12),
        harnesses: [
          { id: 'claude', label: 'Claude Code', path: '/opt/homebrew/bin/claude', models: ['sonnet'], default: 'sonnet' },
          { id: 'gemini', label: 'Gemini CLI', path: '/opt/homebrew/bin/gemini', models: ['flash'], default: 'flash' },
        ],
      },
    },
  }, null, 2)}\n`,
)

/* ── 2. Copper Lane — a bakery, for the second room ───────────────── */
const bakery = workspaces.create({ label: 'Copper Lane', owner: OWNER })
workspaces.setContext({
  id: bakery.id,
  context: 'A neighbourhood bakery. Recipe notes are in grams; menu copy is written for the window.',
})
entity(bakery.id, 'recipe-tester', {
  harness: 'claude', model: 'sonnet', shape: 'bowl', color: 'ember', mood: 'happy',
  skills: 'recipe-cards', dir: '~/Kitchen'
}, `
# Recipe Tester

You read a recipe the way a baker does: what will go wrong, at which step, and
what to write in the margin before the next bake.
`)
entity(bakery.id, 'menu-writer', {
  harness: 'claude', model: 'sonnet', shape: 'tag', color: 'sun', mood: 'cool', dir: '~/Kitchen'
}, `
# Menu Writer

You write what the window says: six lines, three ingredients each, no adjectives
that a customer cannot taste.
`)
entity(bakery.id, 'supplier-scout', {
  harness: 'pi', model: 'sonnet', shape: 'leaf', color: 'lime', mood: 'focus', dir: '~/Kitchen'
}, `
# Supplier Scout

You compare flour, butter and fruit suppliers on price per kilo, distance and
whether they will deliver on a Tuesday.
`)
skill(bakery.id, 'recipe-cards', 'House format for a recipe card', `
# Recipe card

Title, yield, time, then a list in grams. Steps in the order the baker does them,
including the waits. One note at the end: what to change next time.
`)
thread(bakery.id, turn({
  id: 't_demo_sourdough', entity: 'recipe-tester', title: 'Sourdough, attempt 2',
  at: iso(4, 7), costUsd: 0.043, tokensIn: 2100, tokensOut: 540, ms: 15_000,
  question: 'The crumb was tight again. Here is what I did — what should I change?',
  answer: `The dough was under-proofed, not under-kneaded: 40 minutes more in the basket.

- Keep the water at 24 °C, not 28 °C. It was warm in the kitchen.
- Bake the first 20 minutes with the lid on; you lost the steam at 12.
- The tight crumb at the bottom is your shaping, not the flour.

Next bake: same flour, same starter, 40 minutes more proof. Write it in the margin.`,
}))
artifact(bakery.id, 'menu-window.md', `# Copper Lane — this week\n\n- Country loaf — wheat, water, salt\n- Rye and caraway — rye, caraway, salt\n- Morning bun — butter, sugar, cinnamon\n`)
artifact(bakery.id, 'flour-prices.csv', `supplier,flour,price_eur_per_kg,delivery\nValley Mill,wheat,1.40,Tuesday\nNorth Mill,wheat,1.55,Friday\n`)

writeFileSync(
  path.join(workspaces.open(bakery.id).path, 'mcp.json'),
  `${JSON.stringify({
    schema: 1,
    servers: {
      recipes: { command: 'npx', args: ['-y', 'kitchen-notes'] },
      calendar: { url: 'https://calendar.northwind.example/mcp', headers: { Authorization: '***' } },
    },
    disabled: {},
  }, null, 2)}\n`,
)

/* ── 3. Field Notes — travel and reading ─────────────────────────── */
const field = workspaces.create({ label: 'Field Notes', owner: OWNER })
workspaces.setContext({
  id: field.id,
  context: 'A reading and travel notebook. Expenses are personal; nothing here is invoiced.',
})
entity(field.id, 'trip-planner', {
  harness: 'claude', model: 'sonnet', shape: 'cloud', color: 'sky', mood: 'hype', dir: '~/Notes'
}, `
# Trip Planner

You plan ten days a person can actually walk: one anchor a day, two backups,
nothing booked before the route holds together.
`)
entity(field.id, 'reading-notes', {
  harness: 'pi', model: 'sonnet', shape: 'tablet', color: 'mint', mood: 'focus', dir: '~/Notes'
}, `
# Reading Notes

You keep a note per book: the argument in three sentences, one passage worth
copying out, and who should read it.
`)
thread(field.id, turn({
  id: 't_demo_lisbon', entity: 'trip-planner', title: 'Ten days in Lisbon',
  at: iso(9, 10), costUsd: 0.035, tokensIn: 1800, tokensOut: 460, ms: 11_000,
  question: 'Ten days in Lisbon in April. I want to walk, eat, and not queue.',
  answer: `Ten days, one anchor each:

- **Alfama** on the first morning, before nine, when the trams are empty.
- **Graça** for the view and the cheaper lunch, not the miradouro queue.
- **Belém** on a Tuesday: the museum opens at ten, the pastry queue peaks at noon.
- **Sintra** as a day trip, first train, back before dark.
- Two empty afternoons on purpose — Lisbon rewards going back.

April is showers, not rain. One jacket, one pair of shoes you have already walked
twelve kilometres in.`,
}))
artifact(field.id, 'lisbon-plan.md', `# Lisbon — ten days\n\nAnchor a day.\n\n1. Alfama, early\n2. Graça\n3. Belém\n4. Sintra\n`)

writeFileSync(
  path.join(workspaces.open(field.id).path, 'mcp.json'),
  `${JSON.stringify({
    schema: 1,
    servers: { notes: { url: 'https://notes.northwind.example/mcp', headers: { Authorization: '***' } } },
    disabled: {},
  }, null, 2)}\n`,
)

/* ── a year of quiet activity, so the charts are not one lonely bar ─ */
const BEATS = [
  { entity: 'campaign-writer', title: 'A line for the window card' },
  { entity: 'line-editor', title: 'Tighten the autumn note' },
  { entity: 'research-assistant', title: 'Two suppliers, compared' },
  { entity: 'studio-manager', title: 'Plan the week' },
  { entity: 'reading-notes', title: 'Notes on a chapter' },
  { entity: 'recipe-tester', title: 'Second bake, same flour' },
  { entity: 'trip-planner', title: 'Four days, one bag' },
  { entity: 'menu-writer', title: 'Six lines for the window' },
  { entity: 'photo-notes', title: 'Alt text for three frames' },
]
const HOMES = [studio.id, studio.id, studio.id, bakery.id, field.id]
for (let i = 0; i < 46; i += 1) {
  const beat = BEATS[i % BEATS.length]
  const daysAgo = 2 + ((i * 7) % 320)
  const at = iso(daysAgo, 9 + (i % 7))
  const tokensIn = 1400 + ((i * 317) % 5200)
  const tokensOut = 260 + ((i * 173) % 900)
  thread(HOMES[i % HOMES.length], turn({
    id: `t_beat_${String(i).padStart(2, '0')}`,
    entity: beat.entity,
    title: beat.title,
    at,
    harness: i % 3 === 0 ? 'pi' : 'claude',
    model: 'sonnet',
    tokensIn,
    tokensOut,
    costUsd: Number((0.012 + (tokensIn + tokensOut) / 180_000).toFixed(3)),
    ms: 9000 + ((i * 1300) % 30_000),
    question: `${beat.title}. Keep it short.`,
    answer: 'Done — one page, no loose ends. The note is on the shelf.',
  }))
}

/* ── finish ───────────────────────────────────────────────────────── */
console.log(`home      ${DEMO_HOME}`)
console.log(`profile   ${HOME}`)
console.log(`sign in   ${DEMO.email}  /  ${DEMO.password}`)
console.log(`workspaces ${workspaces.list().map((record) => record.label).join(' · ')}`)
