/**
 * The main-process transcriber: model discovery, output cleanup, argument
 * safety and the refusal path. No whisper run here — a test must not depend on
 * an installed model — but every guard before the spawn is covered.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const voice = require('../../electron/voice.cjs')

test('pickModel prefers the smallest usable model', () => {
  assert.equal(
    voice.pickModel(['ggml-large-v3.bin', 'ggml-base.bin', 'ggml-tiny.en.bin']),
    'ggml-tiny.en.bin',
  )
  assert.equal(voice.pickModel(['ggml-small.bin', 'ggml-base.bin']), 'ggml-base.bin')
  assert.equal(voice.pickModel(['notes.txt', 'model.pt']), '')
  assert.equal(voice.pickModel([]), '')
  /* an unknown ggml file is still a candidate rather than silence */
  assert.equal(voice.pickModel(['ggml-custom.bin']), 'ggml-custom.bin')
})

test('cleanTranscript drops whisper artefacts instead of reading them aloud', () => {
  assert.equal(voice.cleanTranscript('[BLANK_AUDIO]'), '')
  assert.equal(voice.cleanTranscript('[00:00:00.000 --> 00:00:02.000]   Hello there.'), 'Hello there.')
  assert.equal(voice.cleanTranscript('one\n\ntwo   three'), 'one two three')
  assert.equal(voice.cleanTranscript('(silence)  real words [MUSIC]'), 'real words')
  assert.equal(voice.cleanTranscript(null), '')
})

test('safeLanguage refuses anything that is not a language tag', () => {
  assert.equal(voice.safeLanguage('en-US'), 'en-US')
  assert.equal(voice.safeLanguage('id'), 'id')
  assert.equal(voice.safeLanguage('---; rm -rf /'), 'en')
  assert.equal(voice.safeLanguage(''), 'en')
})

test('cliLanguage hands whisper.cpp the bare language it understands', () => {
  /* whisper.cpp rejects `en-US` and then exits 0 after printing its usage */
  assert.equal(voice.cliLanguage('en-US'), 'en')
  assert.equal(voice.cliLanguage('id-ID'), 'id')
  assert.equal(voice.cliLanguage('auto'), 'en')
  assert.equal(voice.cliLanguage('-l; rm -rf /'), 'en')
})

test('status is a shape the renderer can read and never throws', () => {
  voice.reset()
  const status = voice.status()
  assert.equal(typeof status.maxSeconds, 'number')
  assert.equal(typeof status.stt.available, 'boolean')
  if (status.stt.available) {
    assert.ok(['whisper-cli', 'whisper'].includes(status.stt.engine))
    assert.ok(status.stt.model)
  } else {
    assert.ok(status.stt.reason.length > 10, 'an unavailable engine must say why')
  }
})

test('transcribe refuses audio it did not expect before starting a process', async () => {
  await assert.rejects(() => voice.transcribe({}), /No audio/)
  await assert.rejects(
    () => voice.transcribe({ audio: 'AAAA', mime: 'audio/webm' }),
    /WAV/,
  )
  await assert.rejects(
    () => voice.transcribe({ audio: Buffer.alloc(10).toString('base64') }),
    /empty/,
  )
  const notWav = Buffer.alloc(600, 7).toString('base64')
  await assert.rejects(() => voice.transcribe({ audio: notWav }), /not a WAV/)
})
