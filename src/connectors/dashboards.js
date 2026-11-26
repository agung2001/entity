/**
 * The dashboard table: which dashboards this app ships, what each tab offers, whether
 * it may open, and the reads that answer both questions.
 *
 * **One object per connector, and every object answers the same four questions** —
 * `hint` (what the tab offers), `gate` (may it open), `answer` (the read that
 * answers the gate) and `read` (the numbers). Adding a dashboard is one entry here
 * plus one body in `components/connectors/ConnectorDashboardPane.vue`; before this
 * table it was four functions in four places, which is how a seventh connector came
 * to mean editing the page in six spots.
 *
 * Three rules hold the shape together:
 *
 * 1. **A gate has three answers, not two.** `UNREAD` is not `OPEN`: a state nobody
 *    has read yet answers *not locked* so a deep link is not refused before its
 *    roster arrives, but it is a different fact from "this connector is set up".
 *    Conflating them was a real bug — a reload straight into `?tab=dashboard`
 *    flashed a lock before the accounts had answered.
 * 2. **The call that returns the gate is the call that refreshes it.** `answer` takes
 *    `force`, so the accounts card's `changed` event re-asks instead of waiting for
 *    an F5. A completed authentication that needs a reload is the bug this is for.
 * 3. **The lock's sentence lives beside the lock.** Main answers the *fact* (a token
 *    exists, a grant holds a scope); the words a person reads are this app's own,
 *    so a phrasing change never needs a main-process release.
 */
import { lynkConfig, loadLynkConfig } from '@/stores/connectors'
import { github, readDashboard as readGithubDashboard, readLogins } from '@/connectors/github/useGithub'
import {
  canRead as calendarCanRead,
  googleCalendar,
  readAccounts as readCalendarAccounts,
  readDashboard as readCalendarDashboard,
} from '@/connectors/google-calendar/useCalendar'
import {
  habitify,
  connected as habitifyConnected,
  readAccounts as readHabitifyAccounts,
  readDashboard as readHabitifyDashboard,
} from '@/connectors/habitify/useHabitify'
import { adoptLynkConfig, lynk, readDashboard as readLynkDashboard } from '@/connectors/lynk/useLynk'
import {
  readDashboard as readStudioDashboard,
  readRoster,
  studio,
  studioUsable,
} from '@/connectors/youtube-studio/useStudio'
import { clockify, readState as readClockifyState } from '@/connectors/clockify/useClockify'
import { connectors, loadConnectors } from '@/stores/connectors'
import { OPEN, OPEN_GATE, UNREAD, toGate } from '@/connectors/gate'



/**
 * Which dashboard this page is, if any.
 *
 * Named rather than boolean because every one has a different lock, a different
 * read and a different pane body. Lynk.id ships no `work.samples`, so the row
 * itself is the test that it has a report to draw; the others need their catalog
 * row's `work` block, because a custom `cli` row that happens to be called `github`
 * is not GitHub.
 */
export function dashboardKind(entry, rows) {
  const builtIn = String(entry?.builtIn || '')
  const shipped = (name) => Boolean(rows.find((row) => row.builtIn === name)?.work)
  if (builtIn === 'github' && shipped('github')) return 'github'
  if (builtIn === 'google-calendar' && shipped('google-calendar')) return 'calendar'
  if (builtIn === 'youtube-studio' && shipped('youtube-studio')) return 'studio'
  if (builtIn === 'clockify' && entry?.work) return 'clockify'
  /* Habitify's reader lives in this app, so its own `work` block is the whole
     gate — there is no roster to look up beside the row. */
  if (builtIn === 'habitify' && entry?.work) return 'habitify'
  if (builtIn === 'fitbit' && entry?.work) return 'fitbit'
  if (builtIn === 'lynk') return 'lynk'
  return ''
}

const DASHBOARDS = {
  github: {
    hint: 'What moved in the last 90 days',
    /* No binary, then no login. Both sentences are fixed copy — a computed reason
       would drift from the state it describes — and `code`/`after` are split so the
       two `gh` mentions stay mono. */
    gate() {
      if (!github.loaded) return UNREAD
      if (!github.binary?.found) {
        return {
          why: {
            before: 'Dashboard needs the ',
            code: 'gh',
            after: " binary. It is not on this machine's PATH.",
            title: 'Needs the gh binary on this machine',
          },
        }
      }
      if (!github.logins.length) {
        return {
          why: {
            before: 'Dashboard needs a signed-in ',
            code: 'gh',
            after: ' account. ',
            code2: 'gh auth status',
            after2: ' found none on this machine.',
            title: 'Needs a signed-in gh account on this machine',
          },
        }
      }
      return OPEN
    },
    /* `gh`'s own sign-ins: nothing is stored here, so the gate is a read of the CLI. */
    answer({ force }) {
      if (force || !github.loaded) return readLogins()
    },
    read({ force }) {
      if (force || !github.readAt) return readGithubDashboard({ force })
    },
  },

  calendar: {
    hint: 'What is next, and where the gaps are',
    /* In the order a person meets them: the API off, then no account, then a grant
       without the scope. Three states, three sentences, because they are three
       different fixes. Nothing is pressed here — the accounts card already reads the
       roster, so the lock exists before the tab does. */
    gate() {
      if (!googleCalendar.loaded) return UNREAD
      if (googleCalendar.apiOff) {
        return {
          why: {
            before: "Dashboard needs the Calendar API enabled on Entity's OAuth client.",
            title: 'Needs the Calendar API enabled in the Google Cloud project',
          },
        }
      }
      const rows = googleCalendar.accounts
      if (!rows.length) {
        return {
          why: {
            before: 'Dashboard needs a connected Google account. Overview has the only Connect button on this page.',
            title: 'Needs a connected Google account',
          },
        }
      }
      if (!rows.some(calendarCanRead)) {
        return {
          why: {
            before: 'Dashboard needs ',
            code: 'calendar.readonly',
            after: ". This account's grant does not include it.",
            title: 'Needs the calendar.readonly scope',
          },
        }
      }
      return OPEN
    },
    answer({ force }) {
      if (force || !googleCalendar.loaded) return readCalendarAccounts()
    },
    read({ force }) {
      if (force || !googleCalendar.readAt) return readCalendarDashboard({ force })
    },
  },

  studio: {
    hint: 'What moved in the last 28 days',
    /* Nothing signed in, then a row that signed in and got no channel back. **A grant
       without analytics is not a lock** — the Data API still lists the videos, so that
       tab opens and prints dashes; locking it would hide the half a person came for. */
    gate() {
      if (!studio.loaded) return UNREAD
      if (!studio.accounts.length) {
        return {
          why: {
            before: 'Dashboard needs a signed-in channel owner. No YouTube Studio account on this machine is answering — ',
            code: 'youtube.readonly',
            after: ' is what separates an account that can list videos from one that can measure them.',
            title: 'Needs a signed-in channel owner',
          },
        }
      }
      if (!studioUsable()) {
        const who = studio.accounts.find((entry) => !entry.error) || studio.accounts[0]
        return {
          why: {
            before: 'Dashboard needs a channel this account manages. ',
            code: String(who.email || who.localpart),
            after: ' signed in, but Google returned no channel for it — a personal account that owns none is refused, not saved.',
            title: 'Needs a channel this account manages',
          },
        }
      }
      return OPEN
    },
    answer({ force }) {
      if (force || !studio.loaded) return readRoster()
    },
    read({ force }) {
      if (force || !studio.readAt) return readStudioDashboard({ force })
    },
  },

  clockify: {
    hint: 'Where the team’s week went, read from Clockify',
    /* No key, then no workspace: the two halves of this connector's setup, in the
       order a person meets them, each with the control that fixes it. */
    gate() {
      if (!clockify.loaded) return UNREAD
      if (!clockify.configured) {
        return {
          why: {
            before: 'Connect Clockify first — the tab needs a verified key.',
            title: 'Needs a Clockify API key on this machine',
          },
        }
      }
      if (!clockify.workspaceId) {
        return {
          why: {
            before: 'Pick a workspace on Overview — every read happens inside one.',
            title: 'Needs a Clockify workspace chosen for this workspace',
          },
        }
      }
      return OPEN
    },
    answer({ force }) {
      if (force || !clockify.loaded) return readClockifyState()
    },
    /* The pane reads itself on mount: its band owns the workspace line, so a read
       here would be a second read of the same thing. */
    read: null,
  },

  habitify: {
    hint: 'What a day was scheduled with, and the week around it',
    /* One lock: no account whose grant this machine holds. Read from the account
       card's own call rather than re-derived here. */
    gate() {
      if (!habitify.loaded) return UNREAD
      if (!habitifyConnected()) {
        return {
          why: {
            before: 'Dashboard needs a signed-in ',
            code: 'Habitify',
            after: ' account on this machine. Connect one above.',
            title: 'Needs a signed-in Habitify account on this machine',
          },
        }
      }
      return OPEN
    },
    answer({ force }) {
      if (force || !habitify.loaded) return readHabitifyAccounts()
    },
    /* The day is the read's own key, so the page asks for this one by day. */
    read({ day, force }) {
      if (force || !habitify.readAt) return readHabitifyDashboard({ day, force })
    },
  },

  fitbit: {
    hint: 'One day in steps, sleep and heart rate',
    /* The roster *is* the connector list, so this gate cannot be answered before the
       roster lands — and `loaded` is part of the answer: a roster that has not
       arrived would lock every Fitbit page, which is how a deep link used to lose its
       address. */
    gate(entry) {
      if (!connectors.loaded) return UNREAD
      const accounts = Array.isArray(entry?.accounts) ? entry.accounts : []
      if (accounts.some((account) => account.status === 'connected')) return OPEN
      return {
        why: {
          before: 'Dashboard needs a signed-in Fitbit account — the accounts card above connects one.',
          title: 'Needs a signed-in Fitbit account',
        },
      }
    },
    answer({ force }) {
      if (force || !connectors.loaded) return loadConnectors()
    },
    /* Its band reads the day itself, like Clockify's: one read, not two. */
    read: null,
  },

  lynk: {
    hint: 'What the store sold, read from a Drive folder',
    /* In the order Lynk.id meets them: a grant, a grant that was revoked, then a
       folder to read. An account that exists but is not `connected` is not "no
       account" — it is the refusal, and the fix is a reauthorize rather than a fresh
       consent. The folder is the only lock whose fix is a control on this page, which
       is why it names `opens`. */
    gate(entry) {
      if (!lynkConfig.loaded) return UNREAD
      const accounts = Array.isArray(entry?.accounts) ? entry.accounts : []
      if (!accounts.length) {
        return {
          opens: 'overview',
          why: {
            before: 'Dashboard needs a Google account — ',
            code: 'drive.readonly',
            after: '',
            title: 'Needs a Google account on this machine',
          },
        }
      }
      if (!accounts.some((account) => account.status === 'connected')) {
        return {
          opens: 'overview',
          why: {
            before: 'Google refused the grant — reauthorize on Overview',
            code: '',
            after: '',
            title: 'The Google grant was refused',
          },
        }
      }
      if (!lynkConfig.folderId) {
        return {
          opens: 'picker',
          why: {
            before: 'Dashboard needs a Drive folder — pick one on Overview',
            code: '',
            after: '',
            title: 'Needs a Drive folder',
          },
        }
      }
      return OPEN
    },
    answer({ id, force }) {
      if (force || !lynkConfig.loaded) {
        return loadLynkConfig({ id }).then((config) => {
          adoptLynkConfig(config)
        })
      }
    },
    read({ force }) {
      if (force || needsLynkRead()) return readLynkDashboard({ force })
    },
  },
}

/* The kinds whose lock is part of their render rather than only of their click: a
   dashboard reads on mount, so a body that is there while its lock is shut would
   spend an account's budget it has no grant for. */
const RENDER_LOCKED = new Set(['fitbit', 'lynk'])

/** What the tab offers, in the connector's own words. */
export function dashboardHint(kind) {
  return DASHBOARDS[kind]?.hint || 'What moved in the last 90 days'
}

/**
 * The gate for one dashboard, in the one shape the strip reads.
 *
 * **A kind with no dashboard answers open, and it is answered before the table is
 * dereferenced.** `DASHBOARDS[kind]?.gate(entry)` yields `undefined` for a page that
 * has no tab at all — Tailscale, an MCP row, a custom connector — and reading `.why`
 * off that threw on every such page. Two guards, because they are two different
 * facts: no kind (nothing to gate) and a gate that returned nothing (unread).
 */
export function gateFor(kind, entry) {
  const descriptor = DASHBOARDS[kind]
  if (!descriptor) return OPEN_GATE
  return toGate(descriptor.gate(entry))
}

/**
 * The read that answers the gate — and, with `force`, the read that answers it again
 * after something changed the answer.
 *
 * `force` is the difference between "the first paint" and "an account was just
 * connected": without it a state that is already `loaded` is kept, which is right on
 * mount and wrong the moment a card underneath the tab signs somebody in.
 */
export async function answerGate(kind, { id = '', force = false } = {}) {
  return DASHBOARDS[kind]?.answer({ id, force }) || null
}

/**
 * The pane's own read — the numbers, not the gate.
 *
 * Some dashboards read themselves on mount and declare no `read` here; the page then
 * has nothing to ask for, which is how "the connector that reads its own band" needs
 * no branch anywhere.
 */
export async function readPane(kind, { day = '', force = false } = {}) {
  const read = DASHBOARDS[kind]?.read
  return read ? read({ day, force }) : null
}

/**
 * Whether the Dashboard tab's body belongs in the document.
 *
 * Two of the seven gate the *render*, not only the click — Fitbit and Lynk.id —
 * because a dashboard reads on mount. The page mounts one pane component on this
 * answer, and derives the strip's `aria-controls` from the same boolean, so the tab
 * and the document cannot disagree about which pane exists.
 */
export function paneShown(kind, { tab = '', locked = false } = {}) {
  if (tab !== 'dashboard' || !kind) return false
  if (!locked) return true
  return !RENDER_LOCKED.has(kind)
}

/**
 * Whether the Lynk.id tab already holds an answer for the folder it is now pointed
 * at.
 *
 * This is the difference between "the numbers are on screen" and "the tab was opened
 * once". The read used to be guarded by `!lynk.readAt`, which is only ever set by a
 * successful read — so a refusal, a quota, or a folder picked a moment later left the
 * guard answering "already read" and the page stayed wrong until it was reloaded.
 * The folder the answer came from is the fact that makes the read unnecessary, and a
 * folder change is what triggers the next one.
 */
function needsLynkRead() {
  if (lynk.reading) return false
  if (!lynk.readAt) return true
  return Boolean(lynk.readFolderId) && lynk.readFolderId !== lynk.folderId
}
