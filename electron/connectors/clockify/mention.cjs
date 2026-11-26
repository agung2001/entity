/**
 * `@clockify:<project|login>:<monday|this week>` — tracked hours, per project and
 * per person, for one week.
 *
 * Three things are unusual here, and each one is the reason a line of this file
 * exists:
 *
 *   1. **The credential is one pasted key**, not an account. It lives in
 *      `connector-tokens.cjs` (`0600`), and `verify()` is what a save calls before
 *      writing, so a key that cannot read this workspace never reaches the file.
 *   2. **The workspace id, the IANA timezone and the member map are workspace
 *      state**, stored on the connector's index row under `fields` — they are not
 *      a secret and they travel with the workspace. Nothing here invents one.
 *   3. **No email ever leaves.** A Clockify workspace user list would carry one,
 *      and this file does not call it: the rows hold a user id, a display name, a
 *      login a person chose locally, and hours.
 *
 * The read itself — the two `reports/summary` calls and the week arithmetic — is
 * `api.cjs`, shared with `dashboard.cjs` so the mention and the tab cannot print two
 * different totals for one week.
 */
const {
  ROW_CEILING,
  text,
  currentMonday,
  validWeek,
  duration,
  settingsFor,
  week,
} = require('./api.cjs')

/* ── the mention ────────────────────────────────────────────────────────── */

/**
 * `@clockify:<project|login>:<week>`.
 *
 * The target is required: `@clockify:` with no project would silently answer about
 * everybody, and a report about the wrong scope is worse than an error.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  /* Validation first, credentials second: a malformed week must be refused for
     being malformed on a machine that has no key yet, not excused by one. */
  const settings = settingsFor(ctx?.record)
  const wanted = text(segment?.target, 120)
  if (!wanted) {
    throw new Error(
      'Clockify needs a project name or a member login, e.g. @clockify:design-system:this week',
    )
  }
  const weekKey = validWeek(segment?.week, settings.timezone)
  const token = require('../../connector-tokens.cjs').tokenFor('clockify')
  if (!token) {
    throw new Error('Clockify has no API key on this machine yet. Paste one on the connector’s page.')
  }
  const report = await week(token, settings, weekKey)

  const rows = []
  const project = report.projects.find((entry) => entry.label.toLowerCase() === wanted.toLowerCase())
  const login = report.logins.find((entry) => entry.toLowerCase() === wanted.toLowerCase())

  if (project) {
    rows.push({
      id: project.label,
      label: project.label,
      detail: [duration(project.seconds), project.client || 'no client', report.label].join(' · '),
    })
    for (const member of project.members) {
      rows.push({
        id: member.login,
        label: `${member.name} · ${project.label}`,
        detail: `${duration(member.seconds)} · ${member.login}`,
      })
    }
  } else if (login) {
    for (const entry of report.projects) {
      const member = entry.members.find((child) => child.login === login)
      if (!member) continue
      rows.push({
        id: entry.label,
        label: entry.label,
        detail: `${duration(member.seconds)} · ${login}`,
      })
    }
  } else {
    const known = [
      ...report.projects.map((entry) => entry.label),
      ...report.logins,
    ].filter(Boolean)
    throw new Error(
      known.length
        ? `@clockify:${wanted}: is not a project or a member here. This workspace has: ${known.join(', ')}.`
        : `@clockify:${wanted}: matched no project or member in this week.`,
    )
  }

  const totalRow = {
    id: '',
    label: `${login ? login : project.label} · ${report.label}`,
    detail: `${duration(report.seconds)} across ${report.projects.length} projects`,
  }
  if (rows.length) rows.push(totalRow)
  for (const day of report.daily) {
    rows.push({ id: day.id, label: day.label, detail: `${day.detail}` })
  }
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the projects and member logins this week can see,
 * filtered by what has been typed. Never throws and answers `[]` on any failure —
 * a menu must not go blank under the cursor because a key expired.
 */
async function preview(fields = [], { record, limit = 8 } = {}) {
  try {
    const needle = String(fields?.[0] || '').trim().toLowerCase()
    const settings = settingsFor(record)
    const token = require('../../connector-tokens.cjs').tokenFor('clockify')
    if (!token) return []
    const report = await week(token, settings, currentMonday(settings.timezone))
    const targets = [
      ...report.projects.map((entry) => ({ name: entry.label, what: 'project' })),
      ...report.logins.map((login) => ({ name: login, what: 'member' })),
    ]
    return targets
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((entry) => ({
        id: entry.name,
        label: entry.name,
        detail: entry.what,
        mention: `@clockify:${entry.name}:`,
      }))
  } catch {
    return []
  }
}


module.exports = { ROW_CEILING, resolve, preview }
