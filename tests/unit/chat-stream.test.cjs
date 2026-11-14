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
