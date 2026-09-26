import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthGate } from './components/Auth'
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

const TABS = ['Dashboard', 'Transactions', 'Subscriptions', 'Simulation', 'Import', 'Settings'] as const
type Tab = (typeof TABS)[number]
const IDLE_MS = 15 * 60 * 1000

export default function App() {
  if (!configured) return <main><div className="card"><h3>Setup needed</h3><p className="err">{configError}</p><p>Fix it in Vercel → Project → Settings → Environment Variables, then Deployments → ⋯ → Redeploy.</p></div></main>
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
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('tab') as Tab) || 'Dashboard')
  const [currency, setCurrency] = useState<Currency>('EUR')

  const reload = useCallback(async () => {
    try {
      let d = await loadAll()
      if (d.categories.length === 0) { await seedDefaults(); d = await loadAll() }
      // Keep EUR→BRL rates current (once a day is enough; failures are non-blocking).
      const lastFx = [...d.fx.keys()].sort().at(-1)
      const todayIso = new Date().toISOString().slice(0, 10)
      if (d.transactions.length && (!lastFx || Date.parse(todayIso) - Date.parse(lastFx) > 3 * 86400000)) {
        try {
          const from = lastFx ?? d.transactions[0].booking_date
          await saveFx(await fetchEurBrl(from, todayIso))
          d = await loadAll()
        } catch { /* offline or service down: fall back to stored rates */ }
      }
      setData(d)
      setCurrency(d.settings.display_currency)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { reload() }, [reload])
  useEffect(() => { try { sessionStorage.setItem('tab', tab) } catch { /* ignore */ } }, [tab])

  // Auto sign-out after 15 minutes without interaction.
  useEffect(() => {
    let timer = window.setTimeout(() => supabase.auth.signOut(), IDLE_MS)
    const reset = () => { clearTimeout(timer); timer = window.setTimeout(() => supabase.auth.signOut(), IDLE_MS) }
    const evs = ['pointerdown', 'keydown', 'scroll', 'visibilitychange']
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)) }
  }, [])

  const fx = useMemo(() => new FxTable(data?.fx ?? new Map()), [data])
  const etx = useMemo(() => (data ? enrich(data.transactions, data.categories, data.accounts, fx, currency) : []), [data, fx, currency])

  if (error) return <main><div className="card err">{error}</div></main>
  if (!data) return <main className="muted">Loading…</main>
  const ctx: Ctx = { data, reload, currency, fx, etx }

  return (
    <>
      <header className="top">
        <h1>Controle CC</h1>
        <select aria-label="Display currency" value={currency} onChange={async (e) => {
          const c = e.target.value as Currency; setCurrency(c); await saveSettings({ display_currency: c })
        }}>
          <option value="EUR">€ EUR</option>
          <option value="BRL">R$ BRL</option>
        </select>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <nav className="tabs">
        {TABS.map((t) => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <main>
        {tab === 'Dashboard' && <Dashboard ctx={ctx} />}
        {tab === 'Transactions' && <Transactions ctx={ctx} />}
        {tab === 'Subscriptions' && <Subscriptions ctx={ctx} />}
        {tab === 'Simulation' && <Simulation ctx={ctx} />}
        {tab === 'Import' && <ImportPage ctx={ctx} />}
        {tab === 'Settings' && <SettingsPage ctx={ctx} />}
      </main>
    </>
  )
}
