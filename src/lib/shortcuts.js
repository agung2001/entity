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
/* Deliberately the physical Control key on every platform, because this combo is
   Control+` on a Mac too — the same key a terminal uses everywhere else. */
const CTRL = isMacPlatform ? '⌃' : 'Ctrl'

const DISPLAY = { mod: MOD, ctrl: CTRL, shift: SHIFT, alt: ALT, enter: '↵', esc: 'Esc', '?': '?' }

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
        id: 'start-thread',
        label: 'Start the new thread',
        desc: 'In the New thread dialog: file it with the entity, machine, harness and model already picked.',
        desktop: ['mod', 'enter'],
        browser: ['mod', 'enter'],
      },
      {
        id: 'entity-chat',
        label: 'Chat with this entity',
        desc: 'On an entity page, open a conversation with that entity.',
        desktop: ['alt', 'shift', 'N'],
        browser: ['alt', 'shift', 'N'],
      },
      {
        id: 'inventory-search',
        label: 'Search the list',
        desc: 'Put the caret in the search field of this page’s list — the conversations rail, the skills roster, the tool list.',
        /* A modifier, not a bare `/`: a bare key fires wherever the caret is,
           and typing a URL into any field would land in the rail. */
        desktop: ['mod', '/'],
        browser: ['alt', '/'],
      },

      {
        id: 'theme',
        label: 'Switch light and dark',
        desc: 'Flip the theme without leaving the page.',
        desktop: ['mod', 'shift', 'L'],
        browser: ['alt', 'shift', 'L'],
      },
      {
        id: 'account-settings',
        label: 'Account settings',
        desc: 'Open the account settings page.',
        desktop: ['mod', ','],
        browser: ['alt', ','],
      },
      {
        id: 'escape',
        label: 'Close the top surface',
        desc: 'A menu, a dialog, a zoomed file or this guide.',
        desktop: ['esc'],
        browser: ['esc'],
      },
      {
        id: 'save',
        label: 'Save the open document',
        desc: 'Write the Markdown artifact you are editing back to disk.',
        desktop: ['mod', 'S'],
        browser: ['mod', 'S'],
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
        id: 'voice',
        label: 'Voice mode',
        desc: 'Talk to the entity instead of typing; it listens, answers out loud and takes an interruption.',
        desktop: ['mod', 'shift', 'V'],
        browser: ['alt', 'shift', 'V'],
      },
      {
        id: 'send',
        label: 'Send the message',
        desc: 'Enter adds a line; this sends the turn.',
        desktop: ['mod', 'enter'],
        browser: ['mod', 'enter'],
      },
      {
        id: 'terminal',
        label: 'Terminal',
        desc: 'Open a shell beside the conversation — on this machine, or on the thread’s host.',
        desktop: ['ctrl', '`'],
        browser: ['ctrl', '`'],
      },
      {
        id: 'timeline',
        label: 'Execution timeline',
        desc: 'See every step of the last turn on one clock.',
        /* `T` in a browser tab: the Option variant of `Shift+E` belongs to
           `thread-search`, and both variants are accepted at runtime, so two
           items may not share one. */
        desktop: ['mod', 'shift', 'E'],
        browser: ['alt', 'shift', 'T'],
      },
      {
        id: 'thread-search',
        label: 'Search this thread',
        desc: 'Put the caret in the thread search field and find a phrase in the transcript.',
        desktop: ['alt', 'shift', 'F'],
        browser: ['alt', 'shift', 'F'],
      },
      {
        id: 'metadata',
        label: 'Thread metadata',
        desc: 'Show the links and paths this conversation mentions.',
        /* `⌘/` and `⌥/` belong to `inventory-search` on this same page; both
           variants are accepted at runtime, so two items may not share one. */
        desktop: ['mod', 'shift', '/'],
        browser: ['alt', 'shift', '/'],
      },
      {
        id: 'pick-entity',
        label: 'Pick the entity',
        desc: 'In the New thread dialog: open the entity picker.',
        desktop: ['alt', 'shift', '1'],
        browser: ['alt', 'shift', '1'],
      },
      {
        id: 'pick-machine',
        label: 'Pick the machine',
        desc: 'In the New thread dialog: open the machine picker.',
        desktop: ['alt', 'shift', '2'],
        browser: ['alt', 'shift', '2'],
      },
      {
        id: 'pick-harness',
        label: 'Pick the harness',
        desc: 'In the New thread dialog: open the harness picker.',
        desktop: ['alt', 'shift', '3'],
        browser: ['alt', 'shift', '3'],
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
  {
    id: 'artifact',
    label: 'In an artifact preview',
    items: [
      {
        id: 'annotate',
        label: 'Annotate the preview',
        desc: 'Pick an element in a rendered page and write a note about it; the notes go to the open conversation.',
        /* Not an Option/Alt letter: on macOS that produces a dead-key character
           (Option+Shift+C is Ç) and the tab owns several Alt+Shift letters. */
        desktop: ['mod', 'shift', 'A'],
        browser: ['alt', 'shift', 'A'],
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
 * that can also use the native combo keeps working. When the native combo is
 * something the browser already owns (Ctrl/Cmd+Shift+V is paste-as-plain), the
 * handler also requires `isDesktopApp() || event.altKey` — see `voice` in
 * ChatView.
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
  const symbol = combo.find((token) => token.length === 1 && !/[a-z0-9]/i.test(token))
  const special = combo.find((token) => ['enter', 'esc', '?'].includes(token))

  /* `?` is Shift+/ on most layouts, so the shift flag is part of the key
     itself here rather than a modifier to compare. Some environments report
     the physical Slash key instead of the produced character. */
  if (special === '?') {
    return event.key === '?' || (event.code === 'Slash' && event.shiftKey)
  }

  /* `ctrl` and `mod` are different keys on a Mac: a combo that names `ctrl`
     wants Control and not Command, one that names `mod` accepts either. */
  if (wants('ctrl')) {
    if (!event.ctrlKey || event.metaKey) return false
  } else if (Boolean(event.metaKey || event.ctrlKey) !== wants('mod')) return false
  if (event.shiftKey !== wants('shift')) return false
  if (event.altKey !== wants('alt')) return false

  if (special === 'enter') return event.key === 'Enter'
  if (special === 'esc') return event.key === 'Escape'
  /* A digit never survives a modifier: ⌥⇧1 is "!" (and ⌥1 is "¡") on macOS, so
     the character is useless here and the physical key is the truth. */
  if (letter && /^[0-9]$/.test(letter)) {
    return (
      event.key === letter ||
      event.code === `Digit${letter}` ||
      event.code === `Numpad${letter}`
    )
  }
  if (symbol) {
    const codes = {
      '[': 'BracketLeft',
      ']': 'BracketRight',
      '/': 'Slash',
      ',': 'Comma',
      '.': 'Period',
      '-': 'Minus',
      '=': 'Equal',
      ';': 'Semicolon',
      "'": 'Quote',
      '`': 'Backquote',
    }
    return (
      event.key === symbol ||
      event.code === codes[symbol] ||
      (symbol === '/' && event.code === 'NumpadDivide')
    )
  }
  if (!letter) return false

  const key = String(event.key || '').toLowerCase()
  if (key === letter.toLowerCase()) return true
  /* non-Latin layouts still have a physical key */
  return String(event.code || '') === `Key${letter.toUpperCase()}`
}
