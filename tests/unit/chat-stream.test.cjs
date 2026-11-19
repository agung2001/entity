const test = require('node:test')
const assert = require('node:assert/strict')

const { createParser } = require('../../electron/chat-transcript.cjs')

test('text updates carry a delta instead of the whole accumulated answer', () => {
  const events = []
  const parser = createParser('pi', {
    onStep: (event) =>
      events.push({
        action: event.action,
        delta: event.delta,
        step: event.step ? { ...event.step } : null,
      }),
  })

  parser.push(
    `${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
    })}\n`,
  )
  parser.push(
    `${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'world' },
    })}\n`,
  )

  assert.equal(events.length, 2)
  assert.equal(events[0].action, 'add')
  assert.equal(events[0].step.content, 'Hello ')
  assert.equal(events[1].action, 'update')
  assert.equal(events[1].delta, 'world')
  assert.equal(events[1].step.content, 'Hello world')
  assert.equal(parser.finish().answer, 'Hello world')
})

test('a cumulative codex message also reports the new suffix', () => {
  const events = []
  const parser = createParser('codex', {
    onStep: (event) =>
      events.push({
        action: event.action,
        delta: event.delta,
        step: event.step ? { ...event.step } : null,
      }),
  })

  for (const text of ['One', 'One two']) {
    parser.push(
      `${JSON.stringify({
        type: 'item.updated',
        item: { id: 'i1', type: 'agent_message', text },
      })}\n`,
    )
  }

  const update = events.find((event) => event.delta === ' two')
  assert.ok(update)
  assert.equal(update.step.content, 'One two')
})

test('an unstamped event is stamped when it happens, not when the first one was', () => {
  /* pi stamps `session` and nests a stamp on the message, and leaves
     `agent_start`, `turn_start` and every `message_update` bare. Falling back to
     the previous stamp collapsed a 400-step, 5.8-hour turn onto a single
     instant, so the timeline could not say where the hours went — every bar
     measured 0ms. An unstamped event therefore means *now*, not *last time*. */
  const parser = createParser('pi')
  parser.push(`${JSON.stringify({ type: 'session', timestamp: '2020-01-01T00:00:00.000Z' })}\n`)
  parser.push(
    `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })}\n`,
  )

  const step = parser.finish().steps.find((entry) => entry.type === 'text')
  assert.ok(step, 'the delta became a step')
  /* not the session's stamp (2020), and not an empty string */
  assert.notEqual(step.at, '2020-01-01T00:00:00.000Z')
  assert.ok(Date.parse(step.at) > Date.parse('2025-01-01T00:00:00.000Z'))
})

test('a stamp nested on the message is read, not ignored', () => {
  /* claude puts no stamp on the envelope: the turn's time is inside the
     message, and it arrives in milliseconds. */
  const parser = createParser('claude')
  parser.push(
    `${JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-x',
        content: [{ type: 'text', text: 'hi' }],
        timestamp: 1795044723181,
      },
    })}\n`,
  )
  const text = parser.finish().steps.find((step) => step.type === 'text')
  assert.equal(text.at, new Date(1795044723181).toISOString())
})
