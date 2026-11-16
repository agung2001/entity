/**
 * Whether a finished chat turn deserves a desktop banner, and what it says.
 *
 * Pure on purpose: the main process owns the Notification object and the
 * window, but the rule ("quiet while you are reading the thread that just
 * finished") is the kind of thing a test can pin without launching Electron.
 */
function turnNotification(event, { prefs = {}, window = null, activeView = {} } = {}) {
  const message = event?.data?.message
  if (!message) return null
  if (!prefs.enabled) return null
  const kind = message.error ? 'error' : 'reply'
  if (kind === 'error' && !prefs.errors) return null
  if (kind === 'reply' && !prefs.replies) return null
  /* A canceled turn ("Stopped by you") is not news; a harness failure is. */
  if (message.who === 'sys' && !message.error) return null

  const focused =
    Boolean(window) &&
    !window.isDestroyed() &&
    !window.isMinimized() &&
    window.isFocused()
  const watching =
    focused &&
    activeView.workspace === event.workspace &&
    activeView.thread === event.threadId
  /* Quiet only when the finished thread is the one on screen. A reply in
     another thread is worth a banner even while the app is in front. */
  if (prefs.backgroundOnly && watching) return null

  const entity = event.entity || 'Entity'
  const text = String(message.text || message.error || '').replace(/\s+/g, ' ').trim()
  const body = text.length > 160 ? `${text.slice(0, 159)}…` : text
  return {
    title: message.error ? `${entity} needs attention` : `${entity} replied`,
    body: body || (message.error ? 'The turn failed.' : 'A new reply is ready.'),
    route: `/${event.workspace}/chat?thread=${encodeURIComponent(event.threadId)}`,
    tag: `chat:${event.threadId}`,
  }
}

module.exports = { turnNotification }
