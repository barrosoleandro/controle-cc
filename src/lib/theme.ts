/**
 * Appearance: light / dark / follow the device, kept per device (localStorage) and applied
 * as a data attribute on <html>; the colours live in index.css.
 */
export type Mode = 'auto' | 'light' | 'dark'
export interface Theme { mode: Mode }

const KEY = 'appearance'
export const DEFAULT_THEME: Theme = { mode: 'auto' }

export function loadTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Theme>
    return { mode: t.mode === 'light' || t.mode === 'dark' ? t.mode : 'auto' }
  } catch { return DEFAULT_THEME }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement
  delete root.dataset.accent
  delete root.dataset.sidebar
  if (t.mode === 'auto') delete root.dataset.theme
  else root.dataset.theme = t.mode
  const dark = t.mode === 'dark' || (t.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = dark ? '#121826' : '#ffffff'
  document.head.appendChild(meta)
}

export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)) } catch { /* storage blocked: applies for this visit only */ }
  applyTheme(t)
}
