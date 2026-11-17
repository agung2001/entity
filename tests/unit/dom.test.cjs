/**
 * The one question every bare-key shortcut asks first.
 *
 * A `?` or `/` handler that fires while somebody is typing puts a character in a
 * field nobody was looking at. AppRail and HubLayout each carried their own copy
 * of this check; a third copy in the skills roster would have been the point
 * where one of them forgets `contentEditable`.
 */
const assert = require('node:assert/strict')
const test = require('node:test')

class FakeElement {
  constructor(tagName, { contentEditable = false } = {}) {
    this.tagName = tagName
    this.isContentEditable = contentEditable
  }
}

globalThis.HTMLElement = FakeElement

const load = () => import('../../src/lib/dom.js')

test('a field that takes typed characters is editable', async () => {
  const { isEditable } = await load()
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isEditable(new FakeElement(tag)), true, tag)
  }
})

test('a contenteditable region counts even without an input tag', async () => {
  const { isEditable } = await load()
  assert.equal(isEditable(new FakeElement('DIV', { contentEditable: true })), true)
})

test('a button, the body, or nothing at all is not editable', async () => {
  const { isEditable } = await load()
  assert.equal(isEditable(new FakeElement('BUTTON')), false)
  assert.equal(isEditable(new FakeElement('BODY')), false)
  assert.equal(isEditable(null), false)
  assert.equal(isEditable(undefined), false)
  /* not a DOM node at all: a `window` or a plain object must not throw */
  assert.equal(isEditable({ tagName: 'INPUT' }), false)
})
