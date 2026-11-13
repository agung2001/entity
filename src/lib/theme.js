import { ref } from 'vue'
import { playSfx } from './sfx'

/**
 * One window preference, stored beside the other UI settings. The root data
 * attribute drives the token overrides in app.css; the tiny `theme-init.js`
 * applies the same value before the app module loads so dark mode does not
 * flash white on a cold open.
 */
const THEME_KEY = 'entity.theme'

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export const themeMode = ref(storedTheme())

function paint(mode) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#151411' : '#f8b956')
}

export function initTheme() {
  paint(themeMode.value)
}

export function setTheme(mode) {
  const next = mode === 'dark' ? 'dark' : 'light'
  if (next !== themeMode.value) playSfx(next === 'dark' ? 'theme-dark' : 'theme-light')
  themeMode.value = next
  paint(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* private mode — the choice still holds for this window */
  }
}

export function toggleTheme() {
  setTheme(themeMode.value === 'dark' ? 'light' : 'dark')
}
