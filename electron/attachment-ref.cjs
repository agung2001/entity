/**
 * `@file:` and `@mcp:` are attachments, not prose mentions.
 *
 * The composer keeps them below the prompt, but a person can also type them.
 * This parser removes the tokens from the text and returns the structured
 * attachment list; the rest of the `@` language stays with `mention-ref`.
 */
const TOKEN = /(^|[\s(\[])@(file|mcp):(?:"([^"]+)"|([^\s]+))/g

function cleanText(text) {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function extract(text) {
  const source = String(text || '')
  const attachments = []
  let out = ''
  let last = 0
  TOKEN.lastIndex = 0
  let match
  while ((match = TOKEN.exec(source))) {
    const value = String(match[3] || match[4] || '').trim()
    if (!value) continue
    const start = match.index + match[1].length
    out += source.slice(last, start)
    last = match.index + match[0].length
    attachments.push({ kind: match[2], value })
  }
  out += source.slice(last)
  const seen = new Set()
  return {
    text: cleanText(out),
    attachments: attachments.filter((entry) => {
      const key = `${entry.kind}:${entry.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}

module.exports = { extract }
