/**
 * The Markdown engine, kept out of the entry chunk.
 *
 * `marked` (parser) and `dompurify` (sanitizer) are the two heaviest libraries
 * the renderer uses, and only Markdown surfaces need them: chat replies and the
 * entity editor. Importing this module pulls both into their own chunk, which
 * arrives the first time a Markdown surface mounts. See `prose.js` for the
 * lazily-loaded facade the components import instead.
 */
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/* Replies are Markdown. Keep links safe and open them outside the app. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noreferrer noopener')
})

/** Markdown in, sanitized HTML out. */
export function render(text) {
  const html = marked.parse(String(text || ''), { gfm: true, breaks: true })
  return DOMPurify.sanitize(String(html), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  })
}
