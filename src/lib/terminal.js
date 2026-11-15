/**
 * The terminal emulator, loaded only when a terminal is opened.
 *
 * xterm is ~250 kB of parser and renderer that a conversation without a shell
 * never needs, so it is behind a dynamic import like the chart renderer (see
 * DESIGN.md → Loading budget). One module, one cache: the panel can close and
 * reopen without downloading it twice.
 *
 * The CSS comes with it. Leaving `@xterm/xterm/css/xterm.css` out produces a
 * terminal that renders *nothing* — every row is a positioned div with no size —
 * which looks like a backend bug rather than a missing stylesheet.
 */

let loading = null

export function loadTerminal() {
  if (!loading) {
    loading = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([core, fit]) => ({ Terminal: core.Terminal, FitAddon: fit.FitAddon }))
    /* A failed download should not be cached as a permanent failure: the next
       open retries instead of showing a dead panel for the rest of the session. */
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

/**
 * The colours come from the same custom properties as the rest of the app, so
 * the terminal follows light/dark without a second theme table.
 */
export function terminalTheme() {
  const style = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const read = (name, fallback) => (style?.getPropertyValue(name) || '').trim() || fallback
  const bg = read('--bg', '#ffffff')
  const ink = read('--ink', '#111111')
  const muted = read('--muted', '#8a8a8a')
  const accent = read('--accent', '#3b6cf6')
  return {
    background: bg,
    foreground: ink,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: read('--accent-soft', 'rgba(120,120,255,0.25)'),
    black: ink,
    red: '#c0392b',
    green: '#1f8a4c',
    yellow: '#b8860b',
    blue: accent,
    magenta: '#8e44ad',
    cyan: '#0e7490',
    white: muted,
    brightBlack: muted,
  }
}
