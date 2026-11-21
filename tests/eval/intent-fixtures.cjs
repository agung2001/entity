/**
 * The classifier's fixture set: what each message should be read as.
 *
 * This is not `npm test`. The classifier is a model call, and a test suite that
 * depends on one is a suite that fails on a machine without a harness and
 * disagrees with itself tomorrow. So the prompt's quality is measured here,
 * offline, on messages written by hand — one per shape that has actually been
 * mistyped — and `npm run eval:intent` prints the score.
 *
 * The `why` on each row is the bug it would have caused. A row added here is a
 * shape someone actually sent, never a shape invented to make the score look
 * good.
 */

/* Every fixture is fictional, per AGENTS.md. */
const ENTITIES = ['coder', 'designer', 'secretary', 'reviewer']

const FIXTURES = [
  /* ── fan-outs: the shapes that used to show ONE card ─────────────── */
  {
    why: 'the ask inside a sentence — the prefix was anchored to ^',
    text: "By following the design of the settings pages.\n\nlet's spawn 4 @designer To work on the design of each pages.",
    expect: { spawn: true, runs: 4, entity: 'designer', job: 'work on the design of each pages' },
    /* a leading "To" or a trailing period is noise; what matters is that the job
       is the person's instruction and not the preamble */
    accept: (plan) =>
      plan !== null && plan.mode === 'repeat' && plan.runs === 4 && plan.entity === 'designer',
  },
  {
    why: 'the ask on its own line after a read — a mention swallowed the prefix',
    text: 'use this skill /skills/code-milestone\n\n' +
      "Let's work on this milestone @youtrack:ENTITY:ENTITY-37 Work on unresolved related issues.\n" +
      'Spawn 3 @coder To work on the issue. Each with its own orca child workspace.',
    expect: { spawn: true, runs: 3, entity: 'coder', job: 'To work on the issue. Each with its own orca child workspace.' },
    /* the second sentence is an instruction to the run, not context — losing it
       changes the work, so it is required even when the wording shifts */
    accept: (plan) =>
      plan !== null &&
      plan.mode === 'repeat' &&
      plan.runs === 3 &&
      plan.entity === 'coder' &&
      /orca child workspace/i.test(plan.job),
  },
  {
    why: 'the exact prefix the grammar reads — must never cost a model call',
    text: 'spawn 3 @secretary write a poem',
    expect: { spawn: true, runs: 3, entity: 'secretary', job: 'write a poem' },
  },
  {
    why: 'a count written as words',
    text: 'Give me three @reviewer passes over the diff, each independent.',
    expect: null,
    /* a model may read this as `runs: 3`; either answer is defensible, so the
       fixture only insists it is a fan-out if it names one */
    accept: (plan) => plan === null || (plan.mode === 'repeat' && plan.runs === 3),
  },
  {
    why: 'a list, not a count',
    text: 'spawn per @youtrack:ENTITY:relates to: ENTITY-21 #Unresolved @coder fix it',
    expect: {
      spawn: true,
      list: '@youtrack:ENTITY:relates to: ENTITY-21 #Unresolved',
      entity: 'coder',
      job: 'fix it',
    },
  },
  {
    why: 'a pasted issue URL is a list without a model',
    text: 'spawn @coder entity for each issue relates to : ' +
      'https://youtrack.example.test/issue/ENTITY-25/Entity-v0.0.7 #Unresolved only. let it work on the issue.',
    expect: {
      spawn: true,
      list: '@youtrack:ENTITY:relates to: ENTITY-25 #Unresolved',
      entity: 'coder',
      /* the deterministic reading keeps one more clause than a model; either is
         the person's words, so the fixture pins the shape, not the trimming */
      job: undefined,
    },
    /* "#Unresolved only." — carrying the trailing word into the filter is noise,
       not a different query, so the prefix is the bar, not the whole string */
    accept: (plan) =>
      plan !== null &&
      plan.mode === 'rows' &&
      plan.entity === 'coder' &&
      /^@youtrack:ENTITY:relates to: ENTITY-25 #Unresolved/.test(plan.list || ''),
  },
  {
    why: 'a bare spawn is a fan-out by definition',
    text: 'spawn @reviewer look at this from a few angles',
    expect: null,
    accept: (plan) => plan !== null,
  },

  {
    why: 'a count over a LIST — four agents on four pages, not four of one page',
    text: '@orca:entity\n' +
      'By following the design of :\n' +
      '- http://localhost:5183/artistudio/settings?tab=skills\n' +
      '- http://localhost:5183/artistudio/settings?tab=machines\n\n' +
      'I want to improve the design of these pages : \n' +
      '- http://localhost:5183/artistudio/settings?tab=mcp\n' +
      '- http://localhost:5183/artistudio/settings?tab=harnesses\n' +
      '- http://localhost:5183/artistudio/settings?tab=integrations\n' +
      '- http://localhost:5183/artistudio/settings?tab=account -> use the profile avatar, not an animation\n\n' +
      "let's spawn 4 @designer To work on the design of each pages.",
    expect: {
      spawn: true,
      /* the row IS the run: `runs: 4` would give four versions of one page */
      rows: [
        'http://localhost:5183/artistudio/settings?tab=mcp',
        'http://localhost:5183/artistudio/settings?tab=harnesses',
        'http://localhost:5183/artistudio/settings?tab=integrations',
        'http://localhost:5183/artistudio/settings?tab=account — use the profile avatar, not an animation',
      ],
      entity: 'designer',
      job: 'improve the design of this page',
    },
    /* the labels are the person's own words, so allow the wording to shift a
       little; what must not shift is that there are FOUR of them and they are
       the four pages listed */
    accept: (plan) =>
      plan !== null &&
      plan.mode === 'typed' &&
      plan.entity === 'designer' &&
      plan.rows.length === 4 &&
      /* a short label ("mcp") is a better session title than a URL, so the page
         is what must be there, not the exact string */
      plan.rows.every((row, i) => row.includes(['mcp', 'harnesses', 'integrations', 'account'][i])),
  },

  /* ── direct replies: the false positives that cost real agents ───── */
  {
    why: 'a question about work already done',
    text: '@coder why did the build fail?',
    expect: { spawn: false },
  },
  {
    why: 'naming an entity in passing is not delegating to it',
    text: 'Remove @designer from the reviewer list, it is a duplicate.',
    expect: { spawn: false },
  },
  {
    why: 'the word "spawn" in ordinary prose',
    text: 'spawn 3 tasks in the backlog please',
    expect: { spawn: false },
  },
  {
    why: 'a greeting has nothing to delegate to',
    text: 'thanks, that fixed it',
    expect: { spawn: false },
  },
  {
    why: 'one job for one agent is the path that already works',
    text: '@coder fix the failing test in runner-local',
    expect: null,
    accept: (plan) => plan === null || plan.spawn === false,
  },
  {
    why: 'asking what was decided, not asking for work',
    text: 'what did we decide about the retention window?',
    expect: { spawn: false },
  },
  {
    why: 'a single instruction with a count of one',
    text: '@secretary summarise this thread once',
    expect: { spawn: false },
  },
]

/**
 * Score one plan against a fixture.
 *
 * Two dimensions, because they fail differently and only one of them is a bug:
 *
 *   - **verdict** — spawn or direct, how many copies, which entity, which list.
 *     A miss here means agents started that nobody asked for, or a fan-out that
 *     became one run. Never acceptable.
 *   - **job** — the exact words one run is handed. A miss here means the job
 *     repeats a sentence of context the person wrote for the whole message
 *     ("By following the design of these pages."). The run gets slightly more to
 *     read than it needs; nobody is misled about *what* to do.
 *
 * They are counted apart so the second one cannot hide inside the first, and the
 * first one cannot be excused by the second. A fixture with `accept` defines its
 * own verdict predicate, for rows where two readings are both correct.
 */
function score(fixture, plan) {
  if (fixture.accept) return { verdict: fixture.accept(plan) ? 'pass' : 'fail', job: 'n/a' }
  const expected = fixture.expect
  if (expected.spawn === false) {
    /* a direct reply has no job to compare: answering at all is the whole test */
    return { verdict: plan === null ? 'pass' : 'fail', job: 'n/a' }
  }
  if (!plan) return { verdict: 'fail', job: 'fail' }
  const shape = plan.mode === 'rows' ? plan.list === expected.list : plan.runs === expected.runs
  const verdict = shape && plan.entity === expected.entity ? 'pass' : 'fail'
  /* The job is judged only once the shape is right, so a wrong plan is not
     counted twice. Exact words are the bar when the fixture states them; where it
     does not, a job that still carries the run's own instruction is accepted —
     a trailing context clause is noise, a missing instruction is not. */
  const job = !expected.job
    ? plan.job === undefined
      ? 'n/a'
      : 'pass'
    : plan.job === expected.job
      ? 'pass'
      : 'fail'
  return { verdict, job }
}

module.exports = { FIXTURES, ENTITIES, score }
