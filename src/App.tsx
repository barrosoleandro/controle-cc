import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_NAME, AuthGate, ReauthLock } from './components/Auth'
import { trustedDevice } from './lib/trust'
import { syncDevice } from './lib/device'
import { configError, configured, supabase } from './lib/supabase'
import { loadAll, saveFx, saveSettings, seedDefaults, type AppData, type Settings } from './lib/data'
import { FxTable, fetchEurBrl } from './domain/fx'
import { enrich } from './domain/analytics'
import type { Currency } from './domain/types'
import { Icon } from './components/Icons'
import { CommandPalette } from './components/CommandPalette'
import { GROUPS, PAGES, PRIMARY, TABS, type Tab } from './lib/nav'
import { THEME_EVENT, isDark, loadTheme, saveTheme } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { Analysis } from './pages/Analysis'
import { Transactions } from './pages/Transactions'
import { ImportPage } from './pages/Import'
import { Subscriptions } from './pages/Subscriptions'
import { Simulation } from './pages/Simulation'
import { SettingsPage } from './pages/Settings'
import { Payslips } from './pages/Payslips'
import { Investments } from './pages/Investments'
import { Market } from './pages/Market'
import { Cards } from './pages/Cards'

// Aos 15 minutos a tela trava mas a sessão fica de pé: voltar custa só o código do
// autenticador. Aos 60 minutos parados, sai de verdade.
const LOCK_MS = 15 * 60 * 1000
const SIGNOUT_MS = 60 * 60 * 1000

export default function App() {
  if (!configured) return <main className="solo"><div className="card"><h3>Configuração pendente</h3><p className="err">{configError}</p><p>Ajuste em Vercel → Project → Settings → Environment Variables e depois em Deployments → ⋯ → Redeploy.</p></div></main>
  return <AuthGate><Shell /></AuthGate>
}

export interface Ctx {
  data: AppData
  reload: () => Promise<void>
  currency: Currency
  fx: FxTable
  etx: ReturnType<typeof enrich>
  /** Opens a page, optionally at one of its sections (see SECTIONS in lib/nav). */
  go: (tab: Tab, sub?: string) => void
  patchSettings: (patch: Partial<Settings>) => Promise<void>
}

interface Where { tab: Tab; sub?: string; n: number }

function Shell() {
  const [data, setData] = useState<AppData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [where, setWhere] = useState<Where>(() => {
    const t = sessionStorage.getItem('tab') as Tab
    return { tab: TABS.includes(t) ? t : 'Painel', n: 0 }
  })
  const tab = where.tab
  const [moreOpen, setMoreOpen] = useState(false)
  const [search, setSearch] = useState(false)
  // A section asked for (from the search or a link) remounts the page so it opens there.
  const go = useCallback((t: Tab, sub?: string) => {
    setWhere((w) => ({ tab: t, sub, n: sub || t !== w.tab ? w.n + 1 : w.n }))
    setMoreOpen(false); setSearch(false); window.scrollTo({ top: 0 })
  }, [])
  const [currency, setCurrency] = useState<Currency>('EUR')
  const [locked, setLocked] = useState(false)
  const [dark, setDark] = useState(() => isDark(loadTheme()))
  useEffect(() => {
    const sync = () => setDark(isDark(loadTheme()))
    window.addEventListener(THEME_EVENT, sync)
    return () => window.removeEventListener(THEME_EVENT, sync)
  }, [])

  const reload = useCallback(async () => {
    try {
      let d = await loadAll()
      if (d.categories.length === 0) { await seedDefaults(); d = await loadAll() }
      // Mantém as cotações EUR→BRL em dia (uma vez por dia basta; falha não bloqueia).
      const lastFx = [...d.fx.keys()].sort().at(-1)
      const todayIso = new Date().toISOString().slice(0, 10)
      if (d.transactions.length && (!lastFx || Date.parse(todayIso) - Date.parse(lastFx) > 3 * 86400000)) {
        try {
          const from = lastFx ?? d.transactions[0].booking_date
          await saveFx(await fetchEurBrl(from, todayIso))
          d = await loadAll()
        } catch { /* offline ou serviço fora: usa as cotações já guardadas */ }
      }
      setData(d)
      setCurrency(d.settings.display_currency)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { reload() }, [reload])
  // Which computer this is, and its local-AI settings. In the background: the AI is optional.
  useEffect(() => { syncDevice() }, [])
  useEffect(() => { try { sessionStorage.setItem('tab', tab) } catch { /* ignore */ } }, [tab])
  // Ctrl/⌘+K opens the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch((s) => !s) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Inatividade: primeiro trava a tela, depois encerra a sessão (exceto em dispositivo lembrado).
  useEffect(() => {
    if (trustedDevice()) return
    if (locked) {
      // Já travado: o relógio do logout corre sozinho e digitar no cadeado não o reinicia.
      const bye = window.setTimeout(() => supabase.auth.signOut(), SIGNOUT_MS - LOCK_MS)
      return () => clearTimeout(bye)
    }
    let lock = window.setTimeout(() => setLocked(true), LOCK_MS)
    const reset = () => { clearTimeout(lock); lock = window.setTimeout(() => setLocked(true), LOCK_MS) }
    const evs = ['pointerdown', 'keydown', 'scroll', 'visibilitychange']
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    return () => { clearTimeout(lock); evs.forEach((e) => window.removeEventListener(e, reset)) }
  }, [locked])

  // Keyed on the pieces each one reads: a settings change must not re-enrich every transaction.
  const fx = useMemo(() => new FxTable(data?.fx ?? new Map()), [data?.fx])
  const etx = useMemo(() => (data ? enrich(data.transactions, data.categories, data.accounts, fx, currency) : []), [data?.transactions, data?.categories, data?.accounts, fx, currency]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Saves settings and applies them on screen at once, without reloading everything. */
  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    setData((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d))
    await saveSettings(patch)
  }, [])
  // One ctx per change, so the pages' memos (balances, subscriptions…) are not recomputed on every render.
  const ctx = useMemo<Ctx | null>(() => (data ? { data, reload, currency, fx, etx, go, patchSettings } : null), [data, reload, currency, fx, etx, go, patchSettings])

  if (error) return <main className="solo"><div className="card err">{error}</div></main>
  if (!data || !ctx) return <main className="solo"><div className="loading"><span className="spinner" />Carregando suas finanças…</div></main>
  const key = `${tab}:${where.n}`

  return (
    <>
      {locked && <ReauthLock onUnlock={() => setLocked(false)} />}
      {search && <CommandPalette onGo={go} onClose={() => setSearch(false)} />}
      {/* Desktop: side menu with every page, in groups. */}
      <aside className="side">
        <div className="brand"><span className="brand-mark"><Icon name="logo" size={20} /></span><span className="brand-name">{APP_NAME}</span></div>
        <nav aria-label="Menu">
          {GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {g.tabs.map((t) => (
                <button key={t} className={t === tab ? 'active' : ''} aria-current={t === tab ? 'page' : undefined} onClick={() => go(t)}>
                  <Icon name={PAGES[t].icon} size={19} /><span>{t}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <header className="top">
        <span className="brand-mark mobile-only"><Icon name="logo" size={18} /></span>
        <span className="top-title mobile-only">{tab}</span>
        <button className="search-btn" onClick={() => setSearch(true)} aria-label="Buscar página ou seção">
          <Icon name="busca" size={17} /><span>Ir para…</span><kbd>Ctrl K</kbd>
        </button>
        <div className="top-actions">
          <div className="seg" role="group" aria-label="Moeda de exibição">
            {(['EUR', 'BRL'] as Currency[]).map((c) => (
              <button key={c} className={currency === c ? 'on' : ''} aria-pressed={currency === c}
                onClick={async () => { setCurrency(c); await saveSettings({ display_currency: c }) }}>{c === 'EUR' ? '€' : 'R$'}</button>
            ))}
          </div>
          <button className="icon-btn" onClick={() => saveTheme({ mode: dark ? 'light' : 'dark' })} title={dark ? 'Modo claro' : 'Modo escuro'}
            aria-label={dark ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}>
            <Icon name={dark ? 'sol' : 'lua'} size={19} />
          </button>
          <button className="icon-btn" onClick={() => setLocked(true)} title="Bloquear" aria-label="Bloquear"><Icon name="bloquear" size={19} /></button>
          <button className="icon-btn" onClick={() => supabase.auth.signOut()} title="Sair" aria-label="Sair"><Icon name="sair" size={19} /></button>
        </div>
      </header>
      {/* Phone: bottom bar with the main pages and "Mais" for the rest. */}
      <nav className="bottom" aria-label="Menu">
        {PRIMARY.map((t) => (
          <button key={t} className={t === tab && !moreOpen ? 'active' : ''} aria-current={t === tab ? 'page' : undefined} onClick={() => go(t)}>
            <Icon name={PAGES[t].icon} /><span>{t}</span>
          </button>
        ))}
        <button className={moreOpen || !PRIMARY.includes(tab) ? 'active' : ''} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          <Icon name={moreOpen ? 'fechar' : 'mais'} /><span>Mais</span>
        </button>
      </nav>
      {moreOpen && (
        <div className="sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="sheet" role="dialog" aria-label="Mais páginas" onClick={(e) => e.stopPropagation()}>
            {GROUPS.map((g) => {
              const rest = g.tabs.filter((t) => !PRIMARY.includes(t))
              return rest.length > 0 && (
                <div key={g.label} className="sheet-group">
                  <div className="nav-label">{g.label}</div>
                  <div className="sheet-grid">
                    {rest.map((t) => (
                      <button key={t} className={t === tab ? 'active' : ''} onClick={() => go(t)}><Icon name={PAGES[t].icon} size={24} /><span>{t}</span></button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <main>
        <div className="page-head">
          <h1>{tab}</h1>
          <p>{PAGES[tab].desc}</p>
        </div>
        {tab === 'Painel' && <Dashboard key={key} ctx={ctx} />}
        {tab === 'Análises' && <Analysis key={key} ctx={ctx} sub={where.sub} />}
        {tab === 'Lançamentos' && <Transactions key={key} ctx={ctx} sub={where.sub} />}
        {tab === 'Cartões' && <Cards key={key} ctx={ctx} />}
        {tab === 'Recorrentes' && <Subscriptions key={key} ctx={ctx} />}
        {tab === 'Simulação' && <Simulation key={key} ctx={ctx} />}
        {tab === 'Investimentos' && <Investments key={key} ctx={ctx} />}
        {tab === 'Mercado' && <Market key={key} />}
        {tab === 'Holerites' && <Payslips key={key} ctx={ctx} />}
        {tab === 'Importar' && <ImportPage key={key} ctx={ctx} />}
        {tab === 'Ajustes' && <SettingsPage key={key} ctx={ctx} sub={where.sub} />}
      </main>
    </>
  )
}
