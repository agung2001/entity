/**
 * `npm run eval:intent` — score the classifier against the fixture set.
 *
 * Offline and on purpose: this calls a real harness, so it is not part of
 * `npm test` (a suite that needs a model fails on a machine without one, and
 * disagrees with itself tomorrow). Run it after changing `INSTRUCTION`, and read
 * the number instead of hoping.
 *
 *   npm run eval:intent                 # every fixture, one call each
 *   npm run eval:intent -- --harness pi # a different voice
 *   npm run eval:intent -- --verbose    # the plan it answered, per row
 *
 * Two scores, reported apart:
 *
 *   - **verdict** — spawn or direct, how many copies, which agent. A miss is a
 *     real bug: agents started that nobody asked for, or a fan-out collapsed to
 *     one run. This is the number that has to be 100%.
 *   - **job** — whether the words one run is handed are exactly the person's. A
 *     miss means a sentence of whole-message context rode along; the run reads
 *     slightly more than it needs and is not misled about what to do.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/* the app is CommonJS; this script only has to call into it */
const require = createRequire(import.meta.url)

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-eval-intent-'))
process.env.ENTITY_HOME = PROFILE

const { FIXTURES, ENTITIES, score } = require('../tests/eval/intent-fixtures.cjs')
const intent = require('../electron/intent-ref.cjs')

function flag(name, fallback = '') {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? String(process.argv[at + 1] || '') : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const harness = flag('harness', 'pi')
const model = flag('model', '')
const verbose = has('verbose')

const pct = (pass, total) => `${pass}/${total} — ${Math.round((pass / total) * 100)}%`

async function main() {
  const reader = intent.reader({ harness, model, entities: ENTITIES })
  if (!reader) {
    console.error(`No such harness: ${harness}. Nothing to score.`)
    process.exit(2)
  }
  const rows = []
  for (const fixture of FIXTURES) {
    let plan = null
    let note = ''
    try {
      plan = await reader(fixture.text)
    } catch (error) {
      note = String(error?.message || error).slice(0, 80)
    }
    const verdicts = note ? { verdict: 'fail', job: 'fail' } : score(fixture, plan)
    rows.push({ fixture, plan, note, ...verdicts })
    process.stderr.write(verdicts.verdict === 'pass' ? '.' : 'x')
  }
  process.stderr.write('\n')

  if (verbose) {
    for (const row of rows) {
      console.log(`\n[${row.verdict}] ${row.fixture.why}`)
      console.log(`  message : ${JSON.stringify(row.fixture.text.slice(0, 110))}`)
      console.log(`  answered: ${JSON.stringify(row.plan)}`)
      if (row.note) console.log(`  error   : ${row.note}`)
    }
  }

  /* Only rows with a single right job are counted in the job dimension: an
     `accept` predicate defines its own verdict, and a direct reply has no job. */
  const judged = rows.filter((row) => !row.fixture.accept && row.fixture.expect?.spawn !== false)
  const verdictPass = rows.filter((row) => row.verdict === 'pass').length
  const jobPass = judged.filter((row) => row.job === 'pass').length

  console.log(`\nverdict ${pct(verdictPass, rows.length)}`)
  console.log(`job     ${pct(jobPass, judged.length)}`)

  const bad = rows.filter((row) => row.verdict !== 'pass')
  for (const row of bad) {
    console.log(`\n  x ${row.fixture.why}`)
    console.log(`    wanted  : ${JSON.stringify(row.fixture.expect || 'a fan-out or nothing')}`)
    console.log(`    answered: ${JSON.stringify(row.plan)}`)
  }
  const loose = judged.filter((row) => row.job !== 'pass')
  for (const row of loose) {
    console.log(`\n  ~ job differs: ${row.fixture.why}`)
    console.log(`    wanted job: ${JSON.stringify(row.fixture.expect.job)}`)
    console.log(`    answered  : ${JSON.stringify(row.plan?.job)}`)
  }

  /* The verdict is the contract; the job is a quality bar. A wrong verdict is a
     bug in the prompt and must fail the run; a wordy job is worth seeing but is
     not a reason to block a release. */
  process.exit(bad.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
