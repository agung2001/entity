/**
 * The pure half of voice mode: text shaping, engine-agnostic helpers and the
 * audio math the endpointed recorder depends on. Anything that needs a DOM or a
 * microphone is exercised by hand; these are the parts a regression can hide in.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../src/lib/voice.js')

test('speechText flattens markdown into something worth reading aloud', async () => {
  const { speechText } = await load()
  const text = speechText(
    [
      '# Heading',
      '',
      'Here is **bold**, _emphasis_ and `inline code`, plus a [link](https://example.com/page).',
      '',
      '```js',
      "console.log('never spoken')",
      '```',
      '',
      '- a bullet',
      '> a quote',
      '| a | b |',
      '<b>tag</b>',
    ].join('\n'),
  )
  assert.match(text, /^Heading/)
  assert.match(text, /bold/)
  assert.match(text, /emphasis/)
  assert.match(text, /inline code/)
  assert.match(text, /link/)
  assert.match(text, /a bullet/)
  assert.match(text, /a quote/)
  assert.doesNotMatch(text, /console\.log/)
  assert.doesNotMatch(text, /\*\*|`|#|<\/?b>/)
  assert.doesNotMatch(text, /example\.com/)
})

test('splitSpeech keeps sentences whole and caps the chunk size', async () => {
  const { splitSpeech } = await load()
  assert.deepEqual(splitSpeech('One line.'), ['One line.'])
  const long = `${'a'.repeat(120)}. ${'b'.repeat(120)}.`
  const chunks = splitSpeech(long, { max: 130 })
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 130))
  const run = splitSpeech('word '.repeat(200), { max: 100 })
  assert.ok(run.length > 1)
  assert.ok(run.every((chunk) => chunk.length <= 100))
  assert.deepEqual(splitSpeech('   '), [])
})

test('isStopPhrase only matches an instruction, never a sentence containing one', async () => {
  const { isStopPhrase } = await load()
  for (const phrase of ['stop', 'Stop.', 'stop it', 'never mind', 'cancel', 'Hold on!']) {
    assert.equal(isStopPhrase(phrase), true, phrase)
  }
  for (const phrase of [
    'stop the server and restart it',
    'do not cancel the deploy',
    'the wait was long',
    '',
  ]) {
    assert.equal(isStopPhrase(phrase), false, phrase)
  }
})

test('echoLikely recognises the entity hearing its own voice', async () => {
  const { echoLikely } = await load()
  const spoken = 'The build finished and all nine tests pass.'
  assert.equal(echoLikely('the build finished and all nine tests pass', spoken), true)
  assert.equal(echoLikely('the build finished', spoken), true)
  assert.equal(echoLikely('actually run the tests again', spoken), false)
  assert.equal(echoLikely('', spoken), false)
  assert.equal(echoLikely('anything', ''), false)
})

test('pickVoice prefers the page language, then a real enhanced voice', async () => {
  const { pickVoice } = await load()
  const voices = [
    { name: 'Samantha', lang: 'en-US', default: true },
    { name: 'Thomas', lang: 'fr-FR' },
    { name: 'Ava (Premium)', lang: 'en-US' },
    { name: 'Bells', lang: 'en-US' },
  ]
  assert.equal(pickVoice(voices, 'en-US').name, 'Ava (Premium)')
  assert.equal(pickVoice(voices, 'fr-FR').name, 'Thomas')
  assert.equal(pickVoice([], 'en-US'), null)
  /* a language with no match keeps the full list rather than nothing */
  assert.equal(pickVoice(voices, 'ja-JP').name, 'Ava (Premium)')
})

test('vadThreshold stays between a quiet room and a loud one', async () => {
  const { vadThreshold } = await load()
  assert.equal(vadThreshold(0), 0.012)
  assert.equal(vadThreshold(0.01), 0.033)
  assert.equal(vadThreshold(1), 0.12)
  assert.equal(vadThreshold(undefined), 0.012)
})

test('downsample averages windows instead of dropping samples', async () => {
  const { downsample } = await load()
  const input = Float32Array.from([1, 1, 0, 0, 1, 1, 0, 0])
  assert.equal(downsample(input, 48_000, 16_000).length, 2)
  assert.deepEqual([...downsample(input, 8, 4)], [1, 0, 1, 0])
  assert.equal(downsample(input, 16_000, 48_000).length, input.length)
  assert.equal(downsample(null, 48_000, 16_000).length, 0)
})

test('encodeWav writes a playable 16-bit mono PCM header', async () => {
  const { encodeWav } = await load()
  const wav = encodeWav(Float32Array.from([0, 1, -1]), 16_000)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (from, to) => String.fromCharCode(...wav.slice(from, to))
  assert.equal(ascii(0, 4), 'RIFF')
  assert.equal(ascii(8, 12), 'WAVE')
  assert.equal(ascii(12, 16), 'fmt ')
  assert.equal(ascii(36, 40), 'data')
  assert.equal(view.getUint16(20, true), 1, 'PCM')
  assert.equal(view.getUint16(22, true), 1, 'mono')
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getUint16(34, true), 16, 'bits per sample')
  assert.equal(view.getUint32(40, true), 6, 'data size')
  assert.equal(view.getInt16(46, true), 0x7fff)
  assert.equal(view.getInt16(48, true), -0x8000)
})

test('base64FromBytes matches the reference encoding and pads correctly', async () => {
  const { base64FromBytes, base64Length } = await load()
  const encode = (text) => base64FromBytes(new TextEncoder().encode(text))
  assert.equal(encode('any carnal pleasure.'), 'YW55IGNhcm5hbCBwbGVhc3VyZS4=')
  assert.equal(encode('ab'), 'YWI=')
  assert.equal(encode(''), '')
  assert.equal(base64Length('YW55IGNhcm5hbCBwbGVhc3VyZS4='), 20)
})

test('rms is zero for silence and one for full scale', async () => {
  const { rms } = await load()
  assert.equal(rms(Float32Array.from([0, 0, 0])), 0)
  assert.ok(Math.abs(rms(Float32Array.from([1, -1])) - 1) < 1e-6)
  assert.equal(rms(null), 0)
})
