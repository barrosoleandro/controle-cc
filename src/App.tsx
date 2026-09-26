import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_NAME, AuthGate, ReauthLock } from './components/Auth'
import { configError, configured, supabase } from './lib/supabase'
import { loadAll, saveFx, saveSettings, seedDefaults, type AppData } from './lib/data'
import { FxTable, fetchEurBrl } from './domain/fx'
import { enrich } from './domain/analytics'
import type { Currency } from './domain/types'
import { Dashboard } from './pages/Dashboard'
import { Transactions } from './pages/Transactions'
import { ImportPage } from './pages/Import'
import { Subscriptions } from './pages/Subscriptions'
import { Simulation } from './pages/Simulation'
import { SettingsPage } from './pages/Settings'
import { Payslips } from './pages/Payslips'
import { Investments } from './pages/Investments'

const TABS = ['Painel', 'Lançamentos', 'Recorrentes', 'Simulação', 'Investimentos', 'Holerites', 'Importar', 'Ajustes'] as const
type Tab = (typeof TABS)[number]
// Aos 15 minutos a tela trava mas a sessão fica de pé: voltar custa só o código do
// autenticador. Aos 60 minutos parados, sai de verdade.
const LOCK_MS = 15 * 60 * 1000
const SIGNOUT_MS = 60 * 60 * 1000

export default function App() {
  if (!configured) return <main><div className="card"><h3>Configuração pendente</h3><p className="err">{configError}</p><p>Ajuste em Vercel → Project → Settings → Environment Variables e depois em Deployments → ⋯ → Redeploy.</p></div></main>
  return <AuthGate><Shell /></AuthGate>
}

export interface Ctx {
  data: AppData
  reload: () => Promise<void>
  currency: Currency
  fx: FxTable
  etx: ReturnType<typeof enrich>
}

function Shell() {
  const [data, setData] = useState<AppData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('tab') as Tab) || 'Painel')
  const [currency, setCurrency] = useState<Currency>('EUR')
  const [locked, setLocked] = useState(false)

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
  useEffect(() => { try { sessionStorage.setItem('tab', tab) } catch { /* ignore */ } }, [tab])

  // Inatividade: primeiro trava a tela, depois encerra a sessão.
  useEffect(() => {
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

  const fx = useMemo(() => new FxTable(data?.fx ?? new Map()), [data])
  const etx = useMemo(() => (data ? enrich(data.transactions, data.categories, data.accounts, fx, currency) : []), [data, fx, currency])

  if (error) return <main><div className="card err">{error}</div></main>
  if (!data) return <main className="muted">Carregando…</main>
  const ctx: Ctx = { data, reload, currency, fx, etx }

  return (
    <>
      {locked && <ReauthLock onUnlock={() => setLocked(false)} />}
      <header className="top">
        <h1>{APP_NAME}</h1>
        <select aria-label="Moeda de exibição" value={currency} onChange={async (e) => {
          const c = e.target.value as Currency; setCurrency(c); await saveSettings({ display_currency: c })
        }}>
          <option value="EUR">€ EUR</option>
          <option value="BRL">R$ BRL</option>
        </select>
        <button onClick={() => setLocked(true)}>Bloquear</button>
        <button onClick={() => supabase.auth.signOut()}>Sair</button>
      </header>
      <nav className="tabs">
        {TABS.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <main>
        {tab === 'Painel' && <Dashboard ctx={ctx} />}
        {tab === 'Lançamentos' && <Transactions ctx={ctx} />}
        {tab === 'Recorrentes' && <Subscriptions ctx={ctx} />}
        {tab === 'Simulação' && <Simulation ctx={ctx} />}
        {tab === 'Investimentos' && <Investments ctx={ctx} />}
        {tab === 'Holerites' && <Payslips ctx={ctx} />}
        {tab === 'Importar' && <ImportPage ctx={ctx} />}
        {tab === 'Ajustes' && <SettingsPage ctx={ctx} />}
      </main>
    </>
  )
}
