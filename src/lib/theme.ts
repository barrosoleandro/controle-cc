/**
 * Appearance: light / dark / follow the device, kept per device (localStorage) and applied
 * as a data attribute on <html>; the colours live in index.css.
 *
 * Light is the default. Following the device used to be, and on a phone in dark mode the
 * whole app opened dark; the key changed with that so earlier "auto" picks start light too.
 */
export type Mode = 'auto' | 'light' | 'dark'
export interface Theme { mode: Mode }

const KEY = 'appearance.v2'
export const THEME_EVENT = 'themechange'
export const DEFAULT_THEME: Theme = { mode: 'light' }

export function loadTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Theme>
    return { mode: t.mode === 'auto' || t.mode === 'dark' ? t.mode : 'light' }
  } catch { return DEFAULT_THEME }
}

export const isDark = (t: Theme) => t.mode === 'dark' || (t.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)

export function applyTheme(t: Theme) {
  const root = document.documentElement
  delete root.dataset.accent
  delete root.dataset.sidebar
  if (t.mode === 'auto') delete root.dataset.theme
  else root.dataset.theme = t.mode
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = isDark(t) ? '#1a2033' : '#ffffff'
  document.head.appendChild(meta)
}

export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)) } catch { /* storage blocked: applies for this visit only */ }
  applyTheme(t)
  window.dispatchEvent(new Event(THEME_EVENT))
}
