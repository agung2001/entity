/**
 * A draft is per thread, and it outlives the thread being open.
 *
 * The composer is one box for every conversation; these tests pin the two
 * things that made lifting the draft into the store worth it — a switch keeps
 * the text, and the storage cost stays bounded (one write per burst of typing,
 * a capped map, a corrupt value treated as "no drafts" rather than a crash).
 */
const assert = require('node:assert/strict')
const test = require('node:test')

const load = () => import('../../src/lib/drafts.js')

function fakeStorage(initial = null) {
  const data = new Map()
  if (initial !== null) data.set('entity.drafts', initial)
  return {
    writes: 0,
    reads: 0,
    data,
    getItem(key) {
      this.reads += 1
      return data.has(key) ? data.get(key) : null
    },
    setItem(key, value) {
      this.writes += 1
      data.set(key, String(value))
    },
    removeItem(key) {
      this.writes += 1
      data.delete(key)
    },
  }
}

function fakeClock() {
  const timers = []
  return {
    timers,
    schedule(fn, delay) {
      timers.push({ fn, delay, done: false })
      return timers.length - 1
    },
    cancel(id) {
      if (timers[id]) timers[id].done = true
    },
    run() {
      const live = timers.filter((timer) => !timer.done)
      timers.length = 0
      for (const timer of live) timer.fn()
    },
  }
}

test('a draft survives leaving the thread and coming back', async () => {
  const { createDraftBook } = await load()
  const clock = fakeClock()
  const storage = fakeStorage()
  const book = createDraftBook({ storage, schedule: clock.schedule, cancel: clock.cancel })

  book.set('t_one', 'draft one')
  book.set('t_two', 'draft two')
  clock.run()

  assert.equal(book.get('t_one'), 'draft one')
  assert.equal(book.get('t_two'), 'draft two')
  /* a fresh book reads what the last window wrote, so a reload keeps them */
  const reopened = createDraftBook({ storage, schedule: clock.schedule, cancel: clock.cancel })
  assert.equal(reopened.get('t_one'), 'draft one')
  assert.deepEqual(reopened.all(), { t_one: 'draft one', t_two: 'draft two' })
})

test('ten keystrokes are one write', async () => {
  const { createDraftBook } = await load()
  const clock = fakeClock()
  const storage = fakeStorage()
  const book = createDraftBook({ storage, schedule: clock.schedule, cancel: clock.cancel })

  for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde']) book.set('t_one', text)
  assert.equal(storage.writes, 0, 'nothing is written while the person is still typing')

  clock.run()
  assert.equal(storage.writes, 1)
  assert.equal(book.get('t_one'), 'abcde')
})

test('emptying the box forgets the draft instead of storing whitespace', async () => {
  const { createDraftBook } = await load()
  const clock = fakeClock()
  const book = createDraftBook({ storage: fakeStorage(), schedule: clock.schedule, cancel: clock.cancel })

  book.set('t_one', 'typed')
  book.set('t_one', '')
  assert.equal(book.get('t_one'), '')
  book.set('t_two', '   \n  ')
  assert.deepEqual(book.all(), {})
})

test('a deleted thread takes its draft with it', async () => {
  const { createDraftBook } = await load()
  const clock = fakeClock()
  const book = createDraftBook({ storage: fakeStorage(), schedule: clock.schedule, cancel: clock.cancel })

  book.set('t_one', 'typed')
  book.drop('t_one')
  assert.deepEqual(book.all(), {})
})

test('the map is capped, and it drops the thread nobody touched', async () => {
  const { createDraftBook, MAX_DRAFTS } = await load()
  const clock = fakeClock()
  const book = createDraftBook({ storage: fakeStorage(), schedule: clock.schedule, cancel: clock.cancel })

  for (let index = 0; index < MAX_DRAFTS + 5; index += 1) book.set(`t_${index}`, `draft ${index}`)
  /* the oldest thread is edited last: it must be the survivor, not the casualty */
  book.set('t_0', 'edited again')

  const store = fakeStorage()
  const saved = createDraftBook({ storage: store, schedule: clock.schedule, cancel: clock.cancel })
  for (const [id, text] of Object.entries(book.all())) saved.set(id, text)
  saved.flush()

  const kept = JSON.parse(store.getItem('entity.drafts'))
  assert.equal(Object.keys(kept).length, MAX_DRAFTS)
  assert.equal(kept.t_0, 'edited again')
  assert.equal(kept[`t_${MAX_DRAFTS + 4}`], `draft ${MAX_DRAFTS + 4}`)
  assert.equal(kept.t_1, undefined, 'the stale draft was pruned')
})

test('a corrupt or foreign value costs the drafts, never the app', async () => {
  const { readDrafts, createDraftBook } = await load()
  assert.deepEqual(readDrafts(fakeStorage('{not json')), {})
  assert.deepEqual(readDrafts(fakeStorage('[1,2,3]')), {})
  assert.deepEqual(readDrafts(fakeStorage('"just a string"')), {})
  assert.deepEqual(readDrafts(null), {})

  const storage = fakeStorage('{"t_one":"kept","t_two":"   ","":  "no id"}')
  assert.deepEqual(readDrafts(storage), { t_one: 'kept' })
  assert.equal(createDraftBook({ storage }).get('t_two'), '')

  /* a storage that throws (quota, private mode) is not a broken composer */
  const angry = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('no space')
    },
    removeItem() {
      throw new Error('no space')
    },
  }
  const book = createDraftBook({ storage: angry })
  book.set('t_one', 'typed')
  book.flush()
  assert.equal(book.get('t_one'), 'typed')
})

test('a paste is capped, not rejected', async () => {
  const { normaliseDraft, MAX_LENGTH } = await load()
  assert.equal(normaliseDraft('x'.repeat(MAX_LENGTH + 500)).length, MAX_LENGTH)
  assert.equal(normaliseDraft(undefined), '')
  assert.equal(normaliseDraft(42), '42')
})
