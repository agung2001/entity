import { hasDesktopBridge } from '@/composables/localBridge'

/**
 * The one keyboard-shortcut catalog.
 *
 * Every shortcut the app advertises lives here: the guide in the top bar
 * renders this list, and the handlers match against it with `matchesShortcut`.
 * That is deliberate — a shortcut added to a component but not to this file is
 * invisible, and a combo written twice drifts the first time one side changes.
 *
 * `desktop` and `browser` are the two variants of the same action. The packaged
 * app can use the native-looking combos; a browser tab cannot, because Chrome
 * owns several Cmd/Ctrl+Shift combinations, so the browser variant uses
 * Option/Alt+Shift instead. Both are accepted at runtime.
 */
export const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')

export const isDesktopApp = () => hasDesktopBridge()

const MOD = isMacPlatform ? '⌘' : 'Ctrl'
const SHIFT = isMacPlatform ? '⇧' : 'Shift'
const ALT = isMacPlatform ? '⌥' : 'Alt'

const DISPLAY = { mod: MOD, shift: SHIFT, alt: ALT, enter: '↵', esc: 'Esc', '?': '?' }

export const SHORTCUT_GROUPS = [
  {
    id: 'anywhere',
    label: 'Anywhere',
    items: [
      {
        id: 'guide',
        label: 'Keyboard shortcuts',
        desc: 'Open this guide from any screen.',
        desktop: ['?'],
        browser: ['?'],
      },
      {
        id: 'palette',
        label: 'Search and commands',
        desc: 'Jump to a page, workspace, conversation, entity, skill or machine.',
        desktop: ['mod', 'K'],
        browser: ['mod', 'K'],
      },
      {
        id: 'rail',
        label: 'Fold or unfold the rail',
        desc: 'Hide the second column when you need the width.',
        desktop: ['mod', 'B'],
        browser: ['mod', 'B'],
      },
      {
        id: 'new-thread',
        label: 'New conversation',
        desc: 'Open the new-thread dialog in the current workspace.',
        desktop: ['mod', 'N'],
        browser: ['alt', 'shift', 'N'],
      },
      {
        id: 'rail-search',
        label: 'Focus rail search',
        desc: 'Jump into the search field of the active second-tier rail.',
        desktop: ['alt', 'shift', 'F'],
        browser: ['alt', 'shift', 'F'],
      },
      {
        id: 'theme',
        label: 'Switch light and dark',
        desc: 'Flip the theme without leaving the page.',
        desktop: ['mod', 'shift', 'L'],
        browser: ['alt', 'shift', 'L'],
      },
      {
        id: 'escape',
        label: 'Close the top surface',
        desc: 'A menu, a dialog, a zoomed file or this guide.',
        desktop: ['esc'],
        browser: ['esc'],
      },
    ],
  },
  {
    id: 'chat',
    label: 'In a conversation',
    items: [
      {
        id: 'focus',
        label: 'Focus the composer',
        desc: 'Jump back into the message box from anywhere in the thread.',
        desktop: ['mod', 'shift', 'M'],
        browser: ['alt', 'shift', 'M'],
      },
      {
        id: 'send',
        label: 'Send the message',
        desc: 'Enter adds a line; this sends the turn.',
        desktop: ['mod', 'enter'],
        browser: ['mod', 'enter'],
      },
      {
        id: 'timeline',
        label: 'Execution timeline',
        desc: 'See every step of the last turn on one clock.',
        desktop: ['mod', 'shift', 'E'],
        browser: ['alt', 'shift', 'E'],
      },
      {
        id: 'prev-chat',
        label: 'Previous conversation',
        desc: 'Move to the previous conversation in the rail.',
        desktop: ['alt', 'shift', '['],
        browser: ['alt', 'shift', '['],
      },
      {
        id: 'next-chat',
        label: 'Next conversation',
        desc: 'Move to the next conversation in the rail.',
        desktop: ['alt', 'shift', ']'],
        browser: ['alt', 'shift', ']'],
      },
    ],
  },
]

const BY_ID = new Map(
  SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item])),
)

function comboFor(item, desktop) {
  return (desktop ? item.desktop : item.browser) || item.desktop || item.browser || []
}

/** The display tokens for one shortcut, e.g. `['⌘','⇧','L']`. */
export function shortcutKeys(id, { desktop = isDesktopApp() } = {}) {
  const item = BY_ID.get(id)
  if (!item) return []
  return comboFor(item, desktop).map((token) => DISPLAY[token] || token.toUpperCase())
}

/** The display string for one shortcut, e.g. `⌘⇧L` or `Ctrl+Shift+L`. */
export function shortcutLabel(id, options) {
  const keys = shortcutKeys(id, options)
  if (!keys.length) return ''
  return isMacPlatform ? keys.join('') : keys.join('+')
}

/** Every group, resolved for the surface it will be shown on. */
export function shortcutGroups({ desktop = isDesktopApp() } = {}) {
  return SHORTCUT_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      desc: item.desc,
      keys: shortcutKeys(item.id, { desktop }),
    })),
  }))
}

/**
 * Does this key event match the shortcut? Either variant counts, so a browser
 * that can also use the native combo keeps working.
 */
export function matchesShortcut(id, event) {
  const item = BY_ID.get(id)
  if (!item) return false
  return comboMatches(event, item.desktop) || comboMatches(event, item.browser)
}

function comboMatches(event, combo) {
  if (!event || !combo || !combo.length) return false
  const wants = (token) => combo.includes(token)
  const letter = combo.find((token) => /^[a-z0-9]$/i.test(token))
  const symbol = combo.find((token) => ['[', ']'].includes(token))
  const special = combo.find((token) => ['enter', 'esc', '?'].includes(token))

  /* `?` is Shift+/ on most layouts, so the shift flag is part of the key
     itself here rather than a modifier to compare. Some environments report
     the physical Slash key instead of the produced character. */
  if (special === '?') {
    return event.key === '?' || (event.code === 'Slash' && event.shiftKey)
  }

  if (Boolean(event.metaKey || event.ctrlKey) !== wants('mod')) return false
  if (event.shiftKey !== wants('shift')) return false
  if (event.altKey !== wants('alt')) return false

  if (special === 'enter') return event.key === 'Enter'
  if (special === 'esc') return event.key === 'Escape'
  if (symbol) {
    return (
      event.key === symbol ||
      event.code === (symbol === '[' ? 'BracketLeft' : 'BracketRight')
    )
  }
  if (!letter) return false

  const key = String(event.key || '').toLowerCase()
  if (key === letter.toLowerCase()) return true
  /* non-Latin layouts still have a physical key */
  return String(event.code || '') === `Key${letter.toUpperCase()}`
}
