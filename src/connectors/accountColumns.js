import { googleCalendar, readAccounts as readCalendarAccounts } from '@/connectors/google-calendar/useCalendar'

/**
 * The extra column the accounts card draws for *some* connectors, and the read that
 * fills it.
 *
 * The card is shared by every account-bearing connector, so it must not name one.
 * Google Calendar is the connector that has an extra fact worth a column: the number
 * of calendars the grant actually answered, which is the same fact its Dashboard tab
 * is gated on — a column read elsewhere could disagree with the tab.
 *
 * One entry per connector that has such a column; everything else draws none. This is
 * the descriptor pattern in miniature: the card asks `accountColumn(id)`, and a
 * connector that grows a column is one line here rather than an `if` in shared UI.
 */
const COLUMNS = {
  'google-calendar': {
    label: 'Calendars',
    /* `null` is "nothing read yet" and prints `—`; `0` would claim a read that never
       happened. */
    value(account) {
      const row = googleCalendar.accounts.find(
        (entry) => String(entry.localpart || '') === String(account?.localpart || ''),
      )
      const count = row?.calendars
      if (!Number.isFinite(Number(count))) return '—'
      const n = Number(count)
      return `${n} ${n === 1 ? 'calendar' : 'calendars'}`
    },
    /** The column's evidence is the connector's own read, so it is asked for here. */
    read() {
      return readCalendarAccounts().catch(() => {})
    },
  },
}

/** The column for one connector, or null. */
export function accountColumn(id) {
  return COLUMNS[String(id || '')] || null
}
