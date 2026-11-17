/**
 * One copy path.
 *
 * `navigator.clipboard.writeText` needs a focused document and a secure context.
 * In the packaged app the renderer loads its bundle from `app.asar` over
 * `file://`, and the promise can reject while the window is not the key window —
 * which is how "Copy reference" came to do nothing at all, silently, with the
 * toast blaming the reference. The fallback below is the oldest path there is
 * and works wherever the first does not, so a copy either happens or says so.
 */
export async function copyText(text) {
  const value = String(text ?? '')
  if (!value) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through to the selection path */
  }

  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange?.(0, value.length)
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
