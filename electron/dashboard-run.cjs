/**
 * The one pass a dashboard can run.
 *
 * `DashboardView`'s `Refresh now`, the band's `Retry`, and the scheduler's tick
 * all ask the same question: run the producer entity once, and put what it wrote
 * on the dashboard's file. Three call sites, one function — the price is named
 * before the run, the leadership rule is checked before anything is spent, and a
 * refusal is a sentence rather than a silent no-op.
 *
 * A pass is a real harness turn (`runner.start`) with a prompt that names the
 * file it must write. Entity does not parse a producer's answer: the producer is
 * an entity whose brief says what to fetch and what schema to write, and the main
 * process only re-reads the file afterwards. That is the whole architecture — a
 * dashboard costs a file edit to change, not a release.
 */
const workspaces = require('./workspace-store.cjs')
const dashboardStore = require('./dashboard-store.cjs')

/* A pass is one turn, so its ceiling is the turn ceiling: `turn-timeout-store`
   owns the number the runner enforces, and this file never invents a second. */
const PROMPT = (id) =>
  `Produce the dashboard at artifacts/${dashboard.id} now.

Write one JSON document with kind "entity.dashboard", v 2, the layout already in
artifacts/${id}, and a fresh "snapshot" whose "at" is this run's start. Every panel must
carry evidence[] naming where its number came from. If a source fails, put that
source's own error sentence in snapshot.sources[].error and keep its panel — do
not invent a number and do not omit the panel. Leave "history" alone: the app
appends this pass to the ring.

Do not summarise this in your reply. The file is the answer, and it is read back
before anything is reported.`

/**
 * Run one producer pass and read the file back.
 *
 * Returns `{ cost, durationMs, doc }`, or throws with the producer's own reason.
 * The file is NOT written here unless the producer did not: a producer that wrote
 * its own snapshot is the author of that snapshot, and this function would
 * otherwise overwrite a better document with the one it started from.
 */
async function runPass({ runner, workspace, id, doc } = {}) {
  const record = workspaces.open(workspace)
  const dashboard = dashboardStore.read({ workspace, id }).doc
  const producer = String(dashboard?.producer?.entity || dashboard?.producer || '').trim()
  if (!producer) throw new Error('This dashboard does not name a producer entity, so no pass can run.')
  const before = String(dashboard?.snapshot?.at || '')
  const startedAt = Date.now()
  const started = await runner.start({ workspace, name: producer, prompt: PROMPT(dashboardStore.idOf(id)) })
  const finishedAt = await waitForRun({ record, runId: started.runId })
  const after = dashboardStore.read({ workspace, id })
  const changed = String(after.doc?.snapshot?.at || '') !== before
  if (!changed) {
    /* The run answered and the file did not move: the honest report is that the
       pass produced nothing, not a toast that claims a fresh snapshot. */
    throw new Error(
      `The ${producer} pass finished but did not write a new snapshot to ${id}. The panels still show the last good values.`,
    )
  }
  /* Cost and wall time come from the run record, never from the producer's own
     arithmetic — that is what the ring's cost column means. */
  return {
    doc: after.doc,
    durationMs: finishedAt.ms,
    cost: costOf(finishedAt),
    startedAt,
  }
}

/** The run's exit record, from the JSONL it streams. */
function waitForRun({ record, runId, timeoutMs = 10 * 60_000 } = {}) {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(record.path, 'runs', `${runId}.jsonl`)
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const read = () => {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        text = ''
      }
      let exit = null
      let lastError = ''
      let usage = {}
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.kind === 'exit') exit = event.data
        if (event.kind === 'state' && event.data?.error) lastError = event.data.error
        /* a harness that reports its own spend puts it here */
        if (event.kind === 'usage' && event.data) usage = event.data
      }
      if (exit) {
        if (exit.canceled) return reject(new Error('The pass was cancelled; the last snapshot is unchanged.'))
        if (exit.code !== 0) return reject(new Error(lastError || `The pass exited with code ${exit.code}.`))
        return resolve({ ...exit, usage })
      }
      if (Date.now() > deadline) return reject(new Error('The pass did not finish in time; nothing was written.'))
      setTimeout(read, 700)
    }
    read()
  })
}

function costOf(exit) {
  const direct = Number(exit?.usage?.costUsd ?? exit?.usage?.cost)
  if (Number.isFinite(direct) && direct >= 0) return direct
  /* A provider that reports tokens and not money leaves the price unknown; the
     ring keeps the previous entry's cost rather than inventing one. */
  return undefined
}

module.exports = { runPass, PROMPT }
