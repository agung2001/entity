/**
 * A dashboard file, read as data.
 *
 * A dashboard is an inert JSON artifact (`artifacts/<slug>.dashboard`) written by
 * a producer entity and painted by two surfaces: the band on Overview and the
 * dashboard page. Both decide the same things from the same file, so every
 * decision lives here — one module, no Vue, testable with `node --test`.
 *
 * Three rules are load-bearing, and each one is a defect the drawing caught:
 *
 *   1. **A number with no source is a bug.** A panel without `evidence[]` is not
 *      rendered at all, so a schema slip reads as a missing panel instead of an
 *      unsourced figure.
 *   2. **A newer file is not a blank page.** A `v` above this renderer's schema,
 *      or a `kind` we do not know, keeps every panel's place and says why.
 *   3. **A failed source is quoted, not translated.** The panel carries the
 *      producer's own sentence, byte for byte: `gh: not authenticated on this
 *      machine.` is fixable, "Something went wrong" is not.
 *
 * Nothing here computes a number the source did not return: `value`, `delta` and
 * `points` are passed through, and the renderer only formats them.
 */

/** The schema this renderer understands. A file above it is not an error page. */
export const SCHEMA = 2
export const KIND = 'entity.dashboard'
export const UNSUPPORTED_SENTENCE = 'This panel needs a newer Entity (schema v3)'
/** The ring's depth: 90 daily passes is a quarter, which is what it replaces. */
export const MAX_HISTORY = 90
/** Four cells is the band's width; a fifth panel opens the dashboard instead. */
export const BAND_LIMIT = 4
export const PANEL_KINDS = ['stat', 'series', 'table', 'progress', 'note', 'unsupported']
/** The six-column page grid: a third is 2, a half is 3, full is all 6. */
export const SPANS = { third: 2, half: 3, full: 6 }

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* ── the small readers ─────────────────────────────────────────────── */

const text = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const list = (value) => (Array.isArray(value) ? value : [])
const slug = (value) =>
  text(value, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** `third: 2` … and anything a producer invents falls back to a half. */
export function spanColumns(span) {
  return SPANS[span] || SPANS.half
}

/** The one glyph a band cell can wear: the source's own initial. */
export function initialOf(label) {
  const first = String(label ?? '').replace(/[^A-Za-z0-9]/g, '')[0]
  return first ? first.toUpperCase() : '·'
}

/* ── time, in the words the page uses ──────────────────────────────── */

/** `'2h'`, `'30m'`, `'1 d'` or a number of milliseconds. */
export function graceMs(grace, fallback = 2 * HOUR) {
  if (typeof grace === 'number' && Number.isFinite(grace) && grace >= 0) return grace
  const hit = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(text(grace, 20))
  if (!hit) return fallback
  const unit = (hit[2] || 'h').toLowerCase()
  return Number(hit[1]) * { s: 1000, m: 60 * 1000, h: HOUR, d: DAY }[unit]
}

const clockOf = (date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * `as of 06:31` today, `as of yesterday 06:31`, `as of May 3 06:31` before that.
 * A timestamp in the future (two machines, one clock) reads as today rather than
 * as a date nobody can explain.
 */
export function asOfLabel(at, now = new Date()) {
  const when = new Date(at)
  if (!Number.isFinite(when.getTime())) return 'as of —'
  const days = Math.round((midnight(new Date(now)) - midnight(when)) / DAY)
  const clock = clockOf(when)
  if (days <= 0) return `as of ${clock}`
  if (days === 1) return `as of yesterday ${clock}`
  return `as of ${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`
}

/** `27 h old` past the day; minutes below the hour; never `0 h old`. */
export function ageLabel(age) {
  const ms = Math.max(0, Number(age) || 0)
  const hours = Math.floor(ms / HOUR)
  if (hours >= 1) return `${hours} h old`
  return `${Math.max(1, Math.round(ms / 60_000))} min old`
}

/** The four words a snapshot can be, plus the two labels the stamp needs. */
export function freshness(snapshotAt, grace, now = new Date()) {
  const at = snapshotAt ? new Date(snapshotAt) : null
  if (!at || !Number.isFinite(at.getTime())) {
    return { state: 'never', asOfLabel: '', ageLabel: '', ageMs: 0 }
  }
  const ageMs = Math.max(0, new Date(now).getTime() - at.getTime())
  return {
    state: ageMs <= graceMs(grace) ? 'fresh' : 'stale',
    asOfLabel: asOfLabel(at, now),
    ageLabel: ageLabel(ageMs),
    ageMs,
  }
}

/* ── the ring ──────────────────────────────────────────────────────── */

/**
 * One pass onto the ring, keeping the last 90.
 *
 * A new array, never a splice: the caller may hold the old one (a page that is
 * mid-animation, a second writer), and a ring mutating under it is the "why did
 * the history lose a row" bug. `history` is the file's own list, so it is read
 * as-is and trimmed from the front.
 */
export function pushHistory(history, entry) {
  const ring = list(history).slice(-MAX_HISTORY + 1)
  return [...ring, entry].slice(-MAX_HISTORY)
}

/* ── the document ──────────────────────────────────────────────────── */

function sourceLabelOf(source) {
  return text(source.label, 60) || text(source.id, 40) || 'source'
}

function readSources(snapshot) {
  return list(snapshot?.sources).map((source) => ({
    id: text(source.id, 60),
    label: sourceLabelOf(source),
    initial: initialOf(sourceLabelOf(source)),
    status: source.status === 'failed' ? 'failed' : 'ok',
    asOf: text(source.asOf, 40),
    durationMs: num(source.durationMs),
    cost: num(source.cost),
    error: text(source.error, 600),
  }))
}

function evidenceOf(panel) {
  return list(panel?.evidence)
    .map((item) => ({
      label: text(item?.label, 80),
      value: text(item?.value, 120),
      url: text(item?.url, 400),
    }))
    .filter((item) => item.label || item.value)
}

/** Which source a panel answers to: named, else its first evidence label. */
function sourceIdFor(panel, sources) {
  const named = slug(panel?.source || panel?.sourceId || panel?.connector || '')
  if (named) return named
  const label = slug(panel?.evidence?.[0]?.label || '')
  if (!label) return ''
  if (sources.some((source) => slug(source.id) === label || slug(source.label) === label)) return label
  return ''
}

function columnsOf(panel) {
  return list(panel?.columns).map((column) => ({
    label: text(column?.label ?? column, 60),
    align: column?.align === 'right' ? 'right' : 'left',
  }))
}

function rowsOf(panel) {
  return list(panel?.rows).map((row) => (Array.isArray(row) ? row.map((cell) => text(cell, 200)) : [text(row, 200)]))
}

function panelOf(raw, index, context) {
  const evidence = evidenceOf(raw)
  /* A figure with no provenance is a bug, not a panel: drop it entirely rather
     than render a number nobody can check. */
  if (!evidence.length) return null
  const sources = context.sources
  const sourceId = sourceIdFor(raw, sources)
  const source = sources.find((item) => slug(item.id) === sourceId || slug(item.label) === sourceId) || null
  const named = PANEL_KINDS.includes(raw?.kind) ? raw.kind : 'unsupported'
  const state = named === 'unsupported' ? 'unsupported' : source?.status === 'failed' ? 'failed' : context.state
  const at = text(raw.asOf, 40) || source?.asOf || context.snapshotAt
  return {
    id: text(raw.id, 80) || `panel-${index + 1}`,
    kind: named,
    span: text(raw.span, 10) || 'half',
    title: text(raw.title, 120),
    state,
    sentence: named === 'unsupported' ? UNSUPPORTED_SENTENCE : '',
    source: source ? { ...source } : null,
    asOf: at ? asOfLabel(at, context.now) : '',
    value: num(raw.value),
    unit: text(raw.unit, 40),
    delta: text(raw.delta, 160),
    tone: ['up', 'down', 'flat', 'risk'].includes(raw.tone) ? raw.tone : '',
    evidence,
    /* every visual channel is data, so the renderer formats and never invents */
    points: list(raw.points || raw.series).map((point) => num(point)).filter((point) => point !== null),
    labels: list(raw.labels).map((label) => text(label, 20)),
    total: num(raw.total),
    parts: list(raw.parts).map((part) => ({
      name: text(part?.name, 80),
      value: num(part?.value),
      hint: text(part?.hint, 40),
    })),
    columns: columnsOf(raw),
    rows: rowsOf(raw),
    note: text(raw.note ?? raw.text ?? raw.caption, 400),
    /* a private panel is the one thing a share strips (spec §2, §3.4) */
    local: raw.local === true,
    /* the producer's own words, unmodified — that is the whole point */
    error: source?.status === 'failed' ? source.error : '',
    lastGood: text(raw.lastGoodAt, 40) ? asOfLabel(raw.lastGoodAt, context.now) : '',
  }
}

const EMPTY = {
  kind: KIND,
  v: SCHEMA,
  title: '',
  producer: '',
  schedule: null,
  connectors: [],
  layout: [],
  panels: [],
  sources: [],
  history: [],
  snapshot: null,
  state: 'never',
  sentence: '',
  problem: '',
}

/**
 * One file, everything the two surfaces need.
 *
 * `raw` is the file's text or its parsed object (the call table hands back the
 * object; the artifact page has the text). `now` is injected so a test — and a
 * page that ticks — can ask the same question twice.
 */
export function parseDashboard(raw, { now = new Date() } = {}) {
  let doc = raw
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc)
    } catch {
      /* A file that is not JSON is not a dashboard; say it once, draw no panels. */
      return { ...EMPTY, state: 'unsupported', sentence: 'This file is not an Entity dashboard.' }
    }
  }
  if (!doc || typeof doc !== 'object') {
    return { ...EMPTY, state: 'unsupported', sentence: 'This file is not an Entity dashboard.' }
  }

  const version = num(doc.v) ?? 0
  const kindKnown = doc.kind === KIND
  const versionKnown = version >= 1 && version <= SCHEMA
  const schedule = doc.schedule && typeof doc.schedule === 'object'
    ? {
        cadence: text(doc.schedule.cadence, 20) || 'daily',
        at: text(doc.schedule.at, 10),
        grace: text(doc.schedule.grace, 10) || '2h',
        enabled: doc.schedule.enabled !== false,
      }
    : null
  const snapshot = doc.snapshot && typeof doc.snapshot === 'object' ? doc.snapshot : null
  const snapshotAt = text(snapshot?.at, 40)
  const snapshotTime = freshness(snapshotAt, schedule?.grace, now)
  const sources = readSources(snapshot)
  const failedAll = sources.length > 0 && sources.every((source) => source.status === 'failed')

  const base = {
    ...EMPTY,
    kind: KIND,
    v: version,
    title: text(doc.title, 120),
    producer: text(doc.producer?.entity || doc.producer, 80),
    schedule,
    connectors: list(doc.connectors).map((connector) => text(connector, 60)),
    layout: list(doc.layout).map((entry) => ({
      id: text(entry?.id, 80),
      kind: text(entry?.kind, 40),
      span: text(entry?.span, 10),
      title: text(entry?.title, 120),
    })),
    sources,
    snapshot: snapshot
      ? { at: snapshotAt, run: text(snapshot.run, 60), cost: num(snapshot.cost) }
      : null,
    /* The producer's own sentence about a file it could not finish, so a broken
       write is quoted rather than rendered as a blank page. */
    problem: text(doc.problem || snapshot?.problem, 400),
    history: list(doc.history).slice(-MAX_HISTORY),
  }

  /* A newer schema is not an error page: the layout still holds the places. */
  if (!kindKnown || !versionKnown) {
    const layout = base.layout.length ? base.layout : list(snapshot?.panels)
    const sentence =
      kindKnown && version > SCHEMA
        ? UNSUPPORTED_SENTENCE
        : 'This file was not written by a dashboard producer Entity.'
    return {
      ...base,
      state: 'unsupported',
      sentence,
      panels: layout.map((entry, index) => ({
        ...panelOf(
          { id: entry.id, kind: entry.kind, span: entry.span, title: entry.title, evidence: [{ label: 'producer' }] },
          index,
          { sources: [], state: 'unsupported', snapshotAt, now },
        ),
        kind: 'unsupported',
        state: 'unsupported',
        sentence,
      })),
    }
  }

  const state = !snapshot ? 'never' : failedAll ? 'failed' : snapshotTime.state
  const context = { sources, state, snapshotAt, now }
  const panels = list(snapshot?.panels)
    .map((panel, index) => panelOf(panel, index, context))
    .filter(Boolean)

  return {
    ...base,
    state,
    sentence: state === 'failed' ? sources.find((source) => source.error)?.error || '' : '',
    asOfLabel: snapshotTime.asOfLabel,
    ageLabel: snapshotTime.ageLabel,
    panels,
  }
}

/* ── the band ──────────────────────────────────────────────────────── */

/**
 * At most four panels, in the dashboard's own layout order.
 *
 * `[]` without a snapshot: the band renders nothing at all — no heading, no
 * empty frame — so an Overview with no dashboard looks exactly like one that
 * never had the feature. That is the whole of "never" on this surface.
 */
export function bandPanels(dashboard) {
  const panels = list(dashboard?.panels)
  if (!dashboard?.snapshot || !panels.length) return []
  const order = new Map(list(dashboard.layout).map((entry, index) => [entry.id, index]))
  const ranked = panels.map((panel, index) => ({ panel, rank: order.has(panel.id) ? order.get(panel.id) : order.size + index }))
  ranked.sort((left, right) => left.rank - right.rank)
  return ranked.slice(0, BAND_LIMIT).map((entry) => entry.panel)
}

/**
 * The one visual a band cell can wear, derived from the panel kind so a producer
 * never names a component: a series is a spark, a progress is a bar, a table is
 * a list, a stat is its own number.
 */
export function panelVisual(panel) {
  if (panel?.kind === 'series' && panel.points?.length) {
    const top = Math.max(...panel.points.map((point) => Math.abs(point)), 0) || 1
    return { kind: 'spark', bars: panel.points.map((point) => Math.round((Math.abs(point) / top) * 100)) }
  }
  if (panel?.kind === 'progress' && panel.total) {
    return { kind: 'bar', pct: Math.max(0, Math.min(100, Math.round(((panel.value || 0) / panel.total) * 100))) }
  }
  if (panel?.kind === 'table' && panel.rows?.length) {
    return { kind: 'list', rows: panel.rows.slice(0, 3).map((row) => row.join(' · ')) }
  }
  return { kind: '' }
}

/** `1 source` / `3 sources`; `1 panel` / `4 of 6 panels`. */
export function countLabel(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * What one pass is expected to cost, from the ring's own last entry.
 *
 * The price is named *before* the run, so it cannot come from the run it is
 * about to make. A dashboard that has never run says `$0.04`, which is what the
 * producer's brief quotes for a four-source pass; the number is never computed
 * from anything the renderer invented.
 */
export const DEFAULT_PRICE = 0.04

export function priceLabel(dashboard) {
  const cost = num(list(dashboard?.history).at(-1)?.cost)
  const amount = cost && cost > 0 ? cost : DEFAULT_PRICE
  return amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`
}

/** `11 s` from a run record's milliseconds. */
export function durationLabel(ms) {
  const value = num(ms)
  if (!value || value < 0) return ''
  return value < 1000 ? `${Math.max(1, Math.round(value))} ms` : `${Math.round(value / 1000)} s`
}
