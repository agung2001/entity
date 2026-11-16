/**
 * Annotating a rendered artifact.
 *
 * The preview is a `data:` iframe with `sandbox="allow-scripts"`: the artifact's
 * own JavaScript runs, it has an opaque origin, and the page cannot reach this
 * window. The picker is a small runtime injected into that document; it talks
 * back with `postMessage`, so the parent only ever receives plain data.
 *
 * Everything here is a pure function over DOM data, which is why the shape of a
 * note is testable without a browser.
 */

/* Page text is untrusted and can be paste-sized; a note is a prompt line. */
export const MAX_TEXT = 140
export const MAX_NOTE = 2000

/** Collapse whitespace and cap, so one element cannot flood the prompt. */
export function sanitizeInline(value, max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const clamp = (value, max) => String(value ?? '').slice(0, max)

/**
 * Keep only what a note needs, and only as strings and numbers. The iframe is
 * untrusted: a message can claim anything, so nothing here trusts its shape.
 */
export function normaliseTarget(raw) {
  if (!raw || typeof raw !== 'object') return null
  const tag = clamp(raw.tag, 24)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
  if (!tag) return null
  const id = clamp(raw.id, 80).replace(/[^A-Za-z0-9_-]/g, '')
  const classes = (Array.isArray(raw.classes) ? raw.classes : [])
    .slice(0, 6)
    .map((name) => clamp(name, 60).replace(/[^A-Za-z0-9_-]/g, ''))
    .filter(Boolean)
  const styles = raw.styles && typeof raw.styles === 'object' ? raw.styles : {}
  return {
    tag,
    id,
    classes,
    text: sanitizeInline(raw.text),
    selector: sanitizeInline(raw.selector, 220),
    styles: {
      font: sanitizeInline(`${styles.fontWeight || ''} ${styles.fontSize || ''} ${styles.fontFamily || ''}`, 90).trim(),
      color: sanitizeInline(styles.color, 40),
      background: sanitizeInline(styles.background, 40),
    },
    rect: {
      w: Math.max(0, Math.round(Number(raw.rect?.w) || 0)),
      h: Math.max(0, Math.round(Number(raw.rect?.h) || 0)),
      x: Math.round(Number(raw.rect?.x) || 0),
      y: Math.round(Number(raw.rect?.y) || 0),
    },
  }
}

/** A one-line name for the element, e.g. `h1.title "Spring papers"`. */
export function describeTarget(target) {
  if (!target) return ''
  const name = `${target.tag}${target.id ? `#${target.id}` : ''}${
    target.classes.length ? `.${target.classes.slice(0, 2).join('.')}` : ''
  }`
  return target.text ? `${name} “${target.text}”` : name
}

/** The line a note becomes in the message. */
export function noteLine(note, index = 0) {
  const name = describeTarget(note?.target)
  const where = note?.target?.selector ? ` _(${note.target.selector})_` : ''
  const text = sanitizeInline(note?.text, MAX_NOTE)
  return `${index + 1}. **${name}**${where}\n   ${text}`
}

/**
 * What the chat receives. It names the file, then one numbered note per picked
 * element, so the agent can find the element it is being asked about.
 */
export function annotationPrompt({ id = '', name = '', notes = [] } = {}) {
  const list = (Array.isArray(notes) ? notes : [])
    .filter((note) => note && note.target && sanitizeInline(note.text))
    .slice(0, 20)
  if (!list.length) return ''
  const file = name || id || 'the artifact'
  return [
    `Annotation notes on \`${file}\`${id && name ? ` (\`artifact://${id}\`)` : ''}:`,
    '',
    ...list.map((note, index) => noteLine(note, index)),
    '',
    'Apply these to the file and tell me what changed. Keep everything I did not mention.',
  ].join('\n')
}

/**
 * The document a preview renders.
 *
 * Not an iframe with a `data:` URL and not a shadow root:
 *
 *   - a `data:` / `blob:` / `srcdoc` frame inherits the app's policy, so any
 *     script inside it is refused — including one we would inject to catch
 *     clicks;
 *   - a shadow root parses the markup without `<html>`/`<head>`/`<body>`, so
 *     the `body { … }` rules every generated page starts with would never match
 *     and the preview would look nothing like the file.
 *
 * So the preview is a same-origin `srcdoc` document: real document structure,
 * real `body` styles, real media queries, and the picker runs in *our* code
 * against `contentDocument`. It renders; it does not run — scripts and inline
 * handlers are stripped, which is also what keeps a same-origin frame from
 * reaching this window.
 */
export function previewDocument(html) {
  const source = String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  if (/<html[\s>]/i.test(source)) return source
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${source}</body></html>`
}

/**
 * The element under the pointer, ignoring our own overlay — and ignoring the
 * document and the body, which are not things you can give a note to (a click
 * on the page background picks nothing, the same rule Orca's grab mode uses).
 */
export function elementAt(root, event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  const doc = root?.ownerDocument || (typeof document !== 'undefined' ? document : null)
  const target = path.find(
    (node) =>
      node &&
      node.nodeType === 1 &&
      !node.hasAttribute?.('data-entity-annotate') &&
      node !== doc?.documentElement &&
      node !== doc?.body,
  )
  return target || null
}

/**
 * The description of one element. It is built here, in the parent, from a live
 * node — the same fields the note needs and nothing else.
 */
export function targetOf(element) {
  if (!element || element.nodeType !== 1) return null
  const rect = element.getBoundingClientRect()
  const view = element.ownerDocument?.defaultView || null
  const scrollX = view?.scrollX || 0
  const scrollY = view?.scrollY || 0
  let styles = {}
  try {
    styles = getComputedStyle(element)
  } catch {
    styles = {}
  }
  return normaliseTarget({
    tag: element.tagName,
    id: element.id || '',
    classes: (element.getAttribute?.('class') || '').split(/\s+/).filter(Boolean),
    text: element.innerText || element.textContent || '',
    selector: selectorOf(element),
    rect: {
      w: rect.width,
      h: rect.height,
      x: rect.left + scrollX,
      y: rect.top + scrollY,
    },
    styles: {
      fontSize: styles.fontSize,
      fontFamily: styles.fontFamily,
      fontWeight: styles.fontWeight,
      color: styles.color,
      background: styles.backgroundColor,
    },
  })
}

/** `section#hero > h1.title:nth-of-type(1)` — four levels, id stops the walk. */
export function selectorOf(element, depth = 4) {
  const parts = []
  let node = element
  for (let level = 0; node && node.nodeType === 1 && level < depth; level += 1) {
    let part = String(node.tagName || '').toLowerCase()
    if (!part) break
    if (node.id) {
      parts.unshift(`${part}#${node.id}`)
      break
    }
    const parent = node.parentElement
    const siblings = parent
      ? [...parent.children].filter((item) => item.tagName === node.tagName)
      : []
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

