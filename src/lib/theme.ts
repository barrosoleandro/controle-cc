/**
 * Appearance: accent colour and light/dark mode, kept per device (localStorage) and applied as
 * data attributes on <html>; the colours themselves live in index.css. Text on every accent
 * fill (--on-accent) and accent-coloured text (--accent-ink) meet 4.5:1.
 */
export const ACCENTS = [
  { id: 'amarelo', label: 'Amarelo', light: '#f7c600', dark: '#f5c400' },
  { id: 'petroleo', label: 'Petróleo', light: '#0f6e8c', dark: '#4cc9e6' },
  { id: 'indigo', label: 'Índigo', light: '#4f46e5', dark: '#8b8cf8' },
  { id: 'esmeralda', label: 'Esmeralda', light: '#0f7a5a', dark: '#3ecf9a' },
  { id: 'vinho', label: 'Vinho', light: '#9f1d4f', dark: '#f472a8' },
  { id: 'grafite', label: 'Grafite', light: '#374151', dark: '#cbd5e1' },
] as const
export type Accent = (typeof ACCENTS)[number]['id']
export type Mode = 'auto' | 'light' | 'dark'
export const SIDEBARS = [
  { id: 'marinho', label: 'Marinho', color: '#14213d' },
  { id: 'grafite', label: 'Grafite', color: '#23262b' },
  { id: 'petroleo', label: 'Petróleo', color: '#0f3b46' },
  { id: 'vinho', label: 'Vinho', color: '#3b1024' },
  { id: 'amarelo', label: 'Amarelo', color: '#f7c600' },
  { id: 'claro', label: 'Clara', color: '#ffffff' },
] as const
export type Sidebar = (typeof SIDEBARS)[number]['id']
export interface Theme { accent: Accent; mode: Mode; sidebar: Sidebar }

const KEY = 'appearance'
export const DEFAULT_THEME: Theme = { accent: 'amarelo', mode: 'auto', sidebar: 'marinho' }

export function loadTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Theme>
    return {
      accent: ACCENTS.some((a) => a.id === t.accent) ? t.accent! : DEFAULT_THEME.accent,
      mode: t.mode === 'light' || t.mode === 'dark' ? t.mode : 'auto',
      sidebar: SIDEBARS.some((x) => x.id === t.sidebar) ? t.sidebar! : DEFAULT_THEME.sidebar,
    }
  } catch { return DEFAULT_THEME }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement
  root.dataset.accent = t.accent
  root.dataset.sidebar = t.sidebar
  if (t.mode === 'auto') delete root.dataset.theme
  else root.dataset.theme = t.mode
  // Browser/phone status bar follows the accent (light) or the dark surface.
  const a = ACCENTS.find((x) => x.id === t.accent)!
  const dark = t.mode === 'dark' || (t.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  // Phone status bar: the menu colour (the bottom bar and header line use it too).
  const menu = SIDEBARS.find((x) => x.id === t.sidebar)!
  meta.content = menu.id === 'claro' ? (dark ? '#161b24' : '#ffffff') : menu.color
  void a
  document.head.appendChild(meta)
}

export function saveTheme(t: Theme) {
  try { localStorage.setItem(KEY, JSON.stringify(t)) } catch { /* storage blocked: applies for this visit only */ }
  applyTheme(t)
}
