/**
 * Chat execution transcripts.
 *
 * A chat turn is a real harness process. This module reads the JSONL stream the
 * CLI writes on stdout and turns it into the same small event vocabulary the
 * window paints: thinking, Assistant text, one record per tool call (with its
 * output), and an error. Nothing here interprets the *meaning* of a tool; it
 * only retains what the harness reported.
 *
 * The transcript is stored on the assistant message in the thread's own JSON
 * file. There is no database and no second copy on disk.
 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const MAX_STEP_TEXT = 60_000
const MAX_TOOL_OUTPUT = 12_000
const MAX_STEPS = 400
const MAX_RAW = 8_000

const STEP_TYPES = new Set(['thinking', 'text', 'tool_use', 'tool_result', 'error'])

const clean = (value) => String(value || '').replace(ANSI, '').trim()
const clip = (value, limit = MAX_STEP_TEXT) => {
  const text = String(value || '')
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text
}

/** Tool input can carry a whole file. Keep the shape, clip the payloads. */
function clipInput(value, depth = 0) {
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}\n… (truncated)` : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= 4) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 40).map((entry) => clipInput(entry, depth + 1))
    if (value.length > 40) items.push(`… ${value.length - 40} more`)
    return items
  }
  const out = {}
  for (const key of Object.keys(value).slice(0, 80)) {
    out[key] = clipInput(value[key], depth + 1)
  }
  return out
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        return ''
      })
      .join('')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text
  }
  return ''
}

function eventAt(event, previous) {
  const stamp = event?.timestamp ?? event?.time ?? event?.at
  if (typeof stamp === 'number' && Number.isFinite(stamp)) {
    const ms = stamp > 10_000_000_000 ? stamp : stamp * 1000
    return new Date(ms).toISOString()
  }
  if (typeof stamp === 'string' && stamp) {
    const ms = Date.parse(stamp)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  return previous || new Date().toISOString()
}

function stepDuration(step) {
  if (Number.isFinite(step.durationMs)) return Math.max(0, step.durationMs)
  if (!step.at || !step.endedAt) return undefined
  const start = Date.parse(step.at)
  const end = Date.parse(step.endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function createParser(harness, { onStep = () => {} } = {}) {
  let buffer = ''
  let raw = ''
  let sawJson = false
  let seq = 0
  let lastAt = ''
  let finalText = ''
  let resultText = ''
  let error = ''
  let usage = null
  let model = ''
  let costUsd = null
  const steps = []
  const calls = new Map()
  const items = new Map()

  const emit = (action, step) => {
    try {
      onStep({ action, step })
    } catch {
      /* a renderer that has gone away must not break the run */
    }
  }

  const remember = (line) => {
    if (raw.length < MAX_RAW) raw += `${line}\n`
  }

  const add = (type, fields = {}, at = lastAt) => {
    if (!STEP_TYPES.has(type)) type = 'text'
    const step = {
      seq: ++seq,
      type,
      at: at || new Date().toISOString(),
      ...fields,
    }
    steps.push(step)
    /* A run that calls hundreds of tools is a wall of rows; keep the proof
       useful by dropping the earliest detail rather than the newest. */
    if (steps.length > MAX_STEPS) {
      const removed = steps.splice(0, steps.length - MAX_STEPS)
      const removedSet = new Set(removed)
      for (const old of removed) {
        if (old.callId) calls.delete(old.callId)
      }
      for (const [key, step] of items) {
        if (removedSet.has(step)) items.delete(key)
      }
    }
    emit('add', step)
    return step
  }

  const update = (step, fields = {}) => {
    Object.assign(step, fields)
    const duration = stepDuration(step)
    if (duration !== undefined) step.durationMs = duration
    emit('update', step)
    return step
  }

  const append = (type, value, at = lastAt) => {
    /* Deltas arrive as fragments; trimming each one turns "hello world" into
       "helloworld". Only a whitespace-only fragment can be dropped here. */
    const text = String(value || '').replace(ANSI, '')
    if (!text) return null
    const last = steps[steps.length - 1]
    if (last && last.type === type) {
      return update(last, { content: clip(`${last.content || ''}${text}`) })
    }
    return add(type, { content: clip(text) }, at)
  }

  const addTool = ({ tool = 'tool', callId = '', input = null, at = lastAt } = {}) => {
    const key = String(callId || '')
    const safeInput = input === null || input === undefined ? null : clipInput(input)
    let step = key ? calls.get(key) : null
    if (step) {
      if (safeInput !== null) update(step, { input: safeInput, tool: tool || step.tool })
      return step
    }
    step = add('tool_use', { tool: tool || 'tool', callId: key, input: safeInput }, at)
    if (key) calls.set(key, step)
    return step
  }

  const addResult = ({
    callId = '',
    tool = '',
    output = '',
    isError = false,
    durationMs,
    at = lastAt,
  } = {}) => {
    const key = String(callId || '')
    let step = key ? calls.get(key) : null
    if (!step) {
      /* A result can arrive without its call after a reconnect. Keep it as its
         own row so output is never silently dropped. */
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].type === 'tool_use' && !steps[i].endedAt) {
          step = steps[i]
          break
        }
      }
    }
    const fields = {
      output: clip(String(output || '').replace(ANSI, ''), MAX_TOOL_OUTPUT),
      endedAt: at,
      ...(isError ? { isError: true } : {}),
      ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    }
    if (step) return update(step, fields)
    return add('tool_result', { tool, callId: key, output: fields.output, at, ...fields })
  }

  // ── harness-specific readers ───────────────────────────────────────────────

  function claude(event) {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      if (event.model !== '<synthetic>') model = event.model
    }
    if (event.type === 'assistant' && event.message) {
      if (event.message.model && event.message.model !== '<synthetic>') {
        model = String(event.message.model)
      }
      const content = Array.isArray(event.message.content) ? event.message.content : []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'thinking') append('thinking', block.thinking, lastAt)
        else if (block.type === 'redacted_thinking') append('thinking', '[Reasoning redacted]', lastAt)
        else if (block.type === 'text') append('text', block.text, lastAt)
        else if (block.type === 'tool_use') {
          addTool({
            tool: block.name,
            callId: block.id,
            input: block.input,
            at: lastAt,
          })
        }
      }
    }
    if (event.type === 'user' && event.message) {
      const content = Array.isArray(event.message.content) ? event.message.content : []
      for (const block of content) {
        if (block?.type !== 'tool_result') continue
        addResult({
          callId: block.tool_use_id,
          output: contentText(block.content),
          isError: Boolean(block.is_error),
          at: lastAt,
        })
      }
    }
    if (event.type === 'result') {
      if (event.usage && typeof event.usage === 'object') usage = { ...event.usage }
      if (Number.isFinite(event.total_cost_usd)) costUsd = event.total_cost_usd
      if (event.modelUsage && typeof event.modelUsage === 'object') {
        const names = Object.keys(event.modelUsage)
        if (names.length) model = names[0]
      }
      if (typeof event.result === 'string' && event.result.trim()) {
        if (event.is_error) error = event.result
        else resultText = event.result
      }
      if (event.is_error) error = error || String(event.subtype || 'The harness reported an error.')
    }
  }

  function pi(event) {
    if (event.type === 'message_update' && event.assistantMessageEvent) {
      const updateEvent = event.assistantMessageEvent
      if (updateEvent.type === 'text_delta') append('text', updateEvent.delta, lastAt)
      else if (updateEvent.type === 'thinking_delta') append('thinking', updateEvent.delta, lastAt)
      else if (updateEvent.type === 'toolcall_end' && updateEvent.toolCall) {
        addTool({
          tool: updateEvent.toolCall.name,
          callId: updateEvent.toolCall.id,
          input: updateEvent.toolCall.arguments,
          at: lastAt,
        })
      } else if (updateEvent.type === 'error') {
        error =
          updateEvent.error?.errorMessage ||
          updateEvent.error?.message ||
          updateEvent.error?.error ||
          error
      }
    }
    if (event.type === 'tool_execution_start') {
      addTool({
        tool: event.toolName,
        callId: event.toolCallId,
        input: event.args,
        at: lastAt,
      })
    }
    if (event.type === 'tool_execution_end') {
      addResult({
        callId: event.toolCallId,
        tool: event.toolName,
        output: contentText(event.result?.content) || JSON.stringify(event.result || ''),
        isError: Boolean(event.isError),
        durationMs: event.durationMs,
        at: lastAt,
      })
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.model) model = String(event.message.model)
      if (event.message.usage) usage = event.message.usage
      if (event.message.stopReason === 'error') {
        error = event.message.errorMessage || error || 'The model stopped with an error.'
      }
      const text = contentText(event.message.content)
      if (text.trim()) finalText = text
      /* Some providers do not stream deltas. If this turn produced no text rows,
         use the authoritative completed message so the answer is not lost. */
      if (text.trim() && !steps.some((step) => step.type === 'text')) {
        append('text', text, lastAt)
      }
    }
    if (event.type === 'auto_retry_end' && event.success === false) {
      error = event.finalError || error || 'The harness retry failed.'
    }
  }

  function opencode(event) {
    const part = event.part
    if (event.type === 'text' && typeof part?.text === 'string') {
      append('text', part.text, lastAt)
    } else if (event.type === 'reasoning' && typeof part?.text === 'string') {
      append('thinking', part.text, lastAt)
    } else if ((event.type === 'tool' || event.type === 'tool_use') && part) {
      const callId = part.callID || part.id || ''
      addTool({ tool: part.tool, callId, input: part.state?.input, at: lastAt })
      if (part.state?.status === 'completed' || part.state?.status === 'error') {
        addResult({
          callId,
          tool: part.tool,
          output:
            contentText(part.state?.output) ||
            contentText(part.state?.metadata?.output) ||
            JSON.stringify(part.state?.output || ''),
          isError: part.state?.status === 'error',
          durationMs:
            Number.isFinite(part.state?.time?.start) && Number.isFinite(part.state?.time?.end)
              ? Math.max(0, part.state.time.end - part.state.time.start)
              : undefined,
          at: lastAt,
        })
      }
    } else if (event.type === 'step_finish') {
      if (part?.tokens) usage = part.tokens
      if (Number.isFinite(part?.cost)) costUsd = part.cost
    } else if (event.type === 'error') {
      error = event.error?.message || event.message || error
    }
  }

  function codex(event) {
    if (event.type === 'turn.completed' && event.usage) usage = event.usage
    if (event.type === 'turn.failed') {
      error = event.error?.message || event.error || event.message || 'The turn failed.'
    }
    if (event.type === 'error') error = event.message || event.error?.message || error

    const item = event.item
    if (!item || typeof item !== 'object') return
    const kind = String(item.type || '')
    const itemId = String(item.id || '')
    const status = String(event.type || '').split('.').pop()

    if (kind === 'agent_message' || kind === 'reasoning') {
      const text = typeof item.text === 'string' ? item.text : contentText(item.content)
      if (!text) return
      const itemKey = `${kind}:${itemId || text.slice(0, 24)}`
      let step = items.get(itemKey)
      if (!step) {
        step = add(kind === 'reasoning' ? 'thinking' : 'text', { content: '' }, lastAt)
        items.set(itemKey, step)
      }
      const previous = step.content || ''
      /* Codex has emitted both cumulative text and deltas across versions:
         replace when the new value extends the old, append otherwise. */
      update(step, { content: clip(text.startsWith(previous) ? text : `${previous}${text}`) })
      if (kind === 'agent_message' && status === 'completed') finalText = text
      return
    }

    if (kind === 'command_execution' || kind === 'command') {
      const itemKey = `command:${itemId || item.command}`
      let step = items.get(itemKey)
      if (!step) {
        step = addTool({
          tool: 'command',
          callId: itemId,
          input: { command: item.command || item.cmd || '' },
          at: lastAt,
        })
        items.set(itemKey, step)
      }
      if (item.aggregated_output || item.output) {
        update(step, {
          output: clip(String(item.aggregated_output || item.output), MAX_TOOL_OUTPUT),
          ...(Number.isFinite(item.exit_code) ? { exitCode: item.exit_code } : {}),
          ...(item.status === 'failed' ? { isError: true } : {}),
        })
      }
      return
    }

    if (kind === 'file_change') {
      const itemKey = `file:${itemId || JSON.stringify(item.changes || '').slice(0, 24)}`
      if (!items.has(itemKey)) {
        items.set(
          itemKey,
          addTool({
            tool: 'file_change',
            callId: itemId,
            input: { changes: item.changes || [] },
            at: lastAt,
          }),
        )
      }
      return
    }

    if (kind === 'mcp_tool_call') {
      const itemKey = `mcp:${itemId || `${item.server}:${item.tool}`}`
      let step = items.get(itemKey)
      if (!step) {
        step = addTool({
          tool: `${item.server || 'mcp'}/${item.tool || 'tool'}`,
          callId: itemId,
          input: item.arguments || {},
          at: lastAt,
        })
        items.set(itemKey, step)
      }
      if (item.result || item.error) {
        update(step, {
          output: clip(contentText(item.result) || JSON.stringify(item.result || item.error), MAX_TOOL_OUTPUT),
          ...(item.error ? { isError: true } : {}),
        })
      }
      return
    }

    if (kind === 'error') {
      error = item.message || error
    }
  }

  function gemini(event) {
    if (event.type === 'init' && event.model) model = String(event.model)
    if (event.type === 'message' && event.role === 'assistant') {
      append('text', event.content, lastAt)
    } else if (event.type === 'tool_use') {
      addTool({
        tool: event.tool_name,
        callId: event.tool_id,
        input: event.parameters,
        at: lastAt,
      })
    } else if (event.type === 'tool_result') {
      addResult({
        callId: event.tool_id,
        tool: event.tool_name,
        output: event.output || contentText(event.content) || event.error?.message || '',
        isError: event.status === 'error',
        at: lastAt,
      })
    } else if (event.type === 'error') {
      if (event.severity !== 'warning') error = event.message || error
    } else if (event.type === 'result') {
      if (event.stats) usage = event.stats
      if (event.status === 'error') error = event.error?.message || error || 'The turn failed.'
    }
  }

  const readers = { claude, pi, opencode, codex, gemini }

  function readEvent(event) {
    if (!event || typeof event !== 'object') return
    const at = eventAt(event, lastAt)
    lastAt = at
    readers[harness]?.(event)
  }

  function readLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      remember(trimmed)
      try {
        const event = JSON.parse(trimmed)
        sawJson = true
        readEvent(event)
        return
      } catch {
        /* not JSON after all */
      }
    }
    if (!sawJson) remember(line)
  }

  function trailingAnswer() {
    if (resultText.trim()) return resultText.trim()
    if (finalText.trim()) return finalText.trim()
    let from = 0
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].type === 'tool_use' || steps[i].type === 'tool_result') {
        from = i + 1
        break
      }
    }
    const tail = steps
      .slice(from)
      .filter((step) => step.type === 'text')
      .map((step) => step.content || '')
      .join('\n\n')
      .trim()
    if (tail) return tail
    return steps
      .filter((step) => step.type === 'text')
      .map((step) => step.content || '')
      .join('\n\n')
      .trim()
  }

  return {
    push(chunk) {
      buffer += String(chunk || '')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) readLine(line)
    },
    finish() {
      if (buffer) {
        readLine(buffer)
        buffer = ''
      }
      const answer = trailingAnswer()
      const rawText = clean(raw)
      return {
        answer: answer || (!sawJson ? rawText : ''),
        steps: steps.map((step) => ({ ...step })),
        error: clean(error),
        usage,
        model,
        ...(Number.isFinite(costUsd) ? { costUsd } : {}),
        raw: rawText,
        sawJson,
      }
    },
  }
}

module.exports = { createParser }
