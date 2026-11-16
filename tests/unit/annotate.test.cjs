/**
 * Annotating a preview: the data that crosses the iframe boundary.
 *
 * The frame is sandboxed and untrusted, so everything that arrives is treated as
 * hostile text — capped, stripped, and only ever rendered as data. These tests
 * pin that, and the message a person's notes turn into.
 */
const assert = require('node:assert/strict')
const test = require('node:test')

const load = () => import('../../src/lib/annotate.js')

test('page text is collapsed and capped before it becomes a note', async () => {
  const { sanitizeInline } = await load()
  assert.equal(sanitizeInline('  Spring\n\n   papers  '), 'Spring papers')
  const long = sanitizeInline('x'.repeat(400))
  assert.equal(long.length, 140)
  assert.ok(long.endsWith('…'))
  assert.equal(sanitizeInline(undefined), '')
})

test('a target from the frame is stripped to what a note needs', async () => {
  const { normaliseTarget } = await load()
  const target = normaliseTarget({
    tag: 'H1!!',
    id: 'h"ero',
    classes: ['title', '<script>', 'a b', 'c', 'd', 'e', 'f', 'g'],
    text: 'Spring\npapers',
    selector: 'section#hero > h1.title',
    rect: { w: '320.4', h: '48' },
    styles: { fontSize: '32px', fontFamily: 'Geist', fontWeight: '600', color: '#333', background: 'rgba(0,0,0,0)' },
  })
  assert.equal(target.tag, 'h1')
  assert.equal(target.id, 'hero')
  assert.deepEqual(target.classes, ['title', 'script', 'ab', 'c', 'd', 'e'])
  assert.equal(target.text, 'Spring papers')
  assert.deepEqual(target.rect, { w: 320, h: 48, x: 0, y: 0 })
  assert.match(target.styles.font, /600 32px Geist/)
})

test('a message that is not an element is refused, not guessed at', async () => {
  const { normaliseTarget } = await load()
  assert.equal(normaliseTarget(null), null)
  assert.equal(normaliseTarget('h1'), null)
  assert.equal(normaliseTarget({ tag: '' }), null)
  assert.equal(normaliseTarget({ tag: '%%%' }), null)
})

test('an element is named the way a person would point at it', async () => {
  const { describeTarget } = await load()
  assert.equal(
    describeTarget({ tag: 'h1', id: '', classes: ['title'], text: 'Spring papers' }),
    'h1.title “Spring papers”',
  )
  assert.equal(describeTarget({ tag: 'section', id: 'hero', classes: [], text: '' }), 'section#hero')
  assert.equal(describeTarget(null), '')
})

test('the chat message names the file and numbers the notes', async () => {
  const { annotationPrompt } = await load()
  const prompt = annotationPrompt({
    id: 'design/artifacts-archive/index.html',
    name: 'index.html',
    notes: [
      { target: { tag: 'h1', id: '', classes: ['title'], text: 'Spring papers', selector: 'main > h1' }, text: 'Make it warmer.' },
      { target: { tag: 'button', id: '', classes: ['cta'], text: 'Pre-order', selector: 'main > button' }, text: 'Move the price under here.' },
      { target: { tag: 'p', id: '', classes: [], text: 'x', selector: 'p' }, text: '   ' },
    ],
  })
  assert.match(prompt, /Annotation notes on `index\.html` \(`artifact:\/\/design\/artifacts-archive\/index\.html`\)/)
  assert.match(prompt, /1\. \*\*h1\.title “Spring papers”\*\* _\(main > h1\)_/)
  assert.match(prompt, /2\. \*\*button\.cta “Pre-order”\*\*/)
  assert.match(prompt, /Move the price under here\./)
  assert.doesNotMatch(prompt, /3\./)
  assert.match(prompt, /Keep everything I did not mention/)
  assert.equal(annotationPrompt({ notes: [] }), '')
})

test('the element under the pointer is the deepest node, not the retargeted host', async () => {
  const { elementAt } = await load()
  /* `composedPath` reaches the real node; a retargeted `target` would be the
     frame. Our own outline is skipped so it can never be picked. */
  const inner = { nodeType: 1, hasAttribute: () => false }
  const outline = { nodeType: 1, hasAttribute: (name) => name === 'data-entity-annotate' }
  const host = { nodeType: 1, hasAttribute: () => false }
  assert.equal(elementAt(null, { composedPath: () => [inner, host] }), inner)
  assert.equal(elementAt(null, { composedPath: () => [outline, host] }), host)
  assert.equal(elementAt(null, { composedPath: () => [] }), null)
  assert.equal(elementAt(null, {}), null)

  /* A click on the page background is not a note about `<body>`. */
  const body = { nodeType: 1, hasAttribute: () => false }
  const doc = { body, documentElement: body }
  assert.equal(elementAt({ ownerDocument: doc }, { composedPath: () => [body] }), null)
})

test('a preview renders the document and runs none of it', async () => {
  const { previewDocument } = await load()
  const page = previewDocument(
    '<!doctype html><html><head><style>body{margin:0}</style><script>alert(1)<\/script></head>' +
      '<body onload="steal()"><h1 onclick="x()">Hi</h1><script src="//evil.test/x.js"></script></body></html>',
  )
  assert.match(page, /body\{margin:0\}/, 'styles survive')
  assert.match(page, /<h1>Hi<\/h1>/, 'the markup survives')
  assert.doesNotMatch(page, /alert\(1\)/)
  assert.doesNotMatch(page, /evil\.test/)
  assert.doesNotMatch(page, /onload=|onclick=/)
})

test('a fragment becomes a whole document, so `body` styles apply', async () => {
  const { previewDocument } = await load()
  const page = previewDocument('<h1>only markup</h1>')
  assert.match(page, /^<!doctype html><html>/)
  assert.match(page, /<body><h1>only markup<\/h1><\/body>/)
})

test('a long review is capped so one message stays a message', async () => {
  const { annotationPrompt } = await load()
  const notes = Array.from({ length: 26 }, (_, index) => ({
    target: { tag: 'p', id: '', classes: [], text: `para ${index}`, selector: `p:nth-of-type(${index + 1})` },
    text: `change ${index}`,
  }))
  const prompt = annotationPrompt({ id: 'a.html', name: 'a.html', notes })
  assert.equal(prompt.match(/^\d+\. /gm).length, 20)
  assert.match(prompt, /20\. \*\*p “para 19”\*\*/)
  assert.doesNotMatch(prompt, /21\. /)
})
