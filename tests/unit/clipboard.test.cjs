/**
 * One copy path.
 *
 * "Copy reference did nothing" was the symptom of a clipboard promise that
 * rejects in the packaged app: `navigator.clipboard.writeText` needs a focused
 * document, and `file://` inside `app.asar` is not always a friendly place for
 * it. The fallback is what makes a copy land anyway — and what makes a failure
 * reportable instead of silent.
 */
const assert = require('node:assert/strict')
const test = require('node:test')

const load = () => import('../../src/lib/clipboard.js')

function fakeDocument({ exec = true, onSelect } = {}) {
  const body = []
  return {
    created: [],
    body: {
      appendChild(node) {
        body.push(node)
        this.children = body
      },
    },
    createElement() {
      const node = {
        value: '',
        style: {},
        removed: false,
        setAttribute() {},
        select() {
          if (onSelect) onSelect(node)
        },
        setSelectionRange() {},
        remove() {
          node.removed = true
          const at = body.indexOf(node)
          if (at >= 0) body.splice(at, 1)
        },
      }
      this.created.push(node)
      return node
    },
    execCommand(command) {
      assert.equal(command, 'copy')
      return exec
    },
  }
}

/* `navigator` is a getter on the Node global, so a plain assignment is silently
   ignored and the test would exercise the real one. Redefine, then restore the
   original property descriptors. */
function withGlobals({ clipboard, document }, run) {
  const keys = ['navigator', 'document']
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  define('navigator', clipboard ? { clipboard } : {})
  define('document', document)
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of keys) {
        const descriptor = previous.get(key)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    })
}

test('the clipboard API is used when it accepts the write', async () => {
  const { copyText } = await load()
  let written = ''
  await withGlobals(
    {
      clipboard: {
        writeText: async (value) => {
          written = value
        },
      },
      document: fakeDocument(),
    },
    async () => {
      /* the route, not a bare `true`: the caller announces which one worked */
      assert.equal(await copyText('thread id'), 'clipboard')
    },
  )
  assert.equal(written, 'thread id')
})

test('a rejected clipboard promise falls back to the selection copy', async () => {
  const { copyText } = await load()
  const document = fakeDocument()
  await withGlobals(
    {
      clipboard: {
        writeText: async () => {
          throw new Error('Document is not focused')
        },
      },
      document,
    },
    async () => {
      assert.equal(await copyText('fallback text'), 'selection')
    },
  )
  /* the textarea carried the text, was selected, and was removed again */
  assert.equal(document.created.length, 1)
  assert.equal(document.created[0].value, 'fallback text')
  assert.equal(document.created[0].removed, true)
})

test('a missing clipboard API still copies', async () => {
  const { copyText } = await load()
  await withGlobals({ clipboard: null, document: fakeDocument() }, async () => {
    assert.equal(await copyText('no api here'), 'selection')
  })
})

test('a failed fallback is reported instead of pretending', async () => {
  const { copyText } = await load()
  await withGlobals({ clipboard: null, document: fakeDocument({ exec: false }) }, async () => {
    assert.equal(await copyText('nope'), false)
  })
  await withGlobals({ clipboard: null, document: null }, async () => {
    assert.equal(await copyText('nope'), false)
  })
})

test('an empty copy is not attempted', async () => {
  const { copyText } = await load()
  const document = fakeDocument()
  await withGlobals({ clipboard: null, document }, async () => {
    assert.equal(await copyText(''), false)
    assert.equal(await copyText(undefined), false)
  })
  assert.equal(document.created.length, 0)
})
