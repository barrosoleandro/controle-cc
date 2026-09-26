import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { byCategory, monthly, topMerchants } from '../domain/analytics'
import { savingsInsights } from '../domain/insights'
import { subscriptionAlerts } from '../domain/subscriptions'
import { monthLabel } from '../lib/format'
import { last3, today, useBalances, useFmt, useSubscriptions } from '../lib/hooks'
import { saveSettings } from '../lib/data'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'

export const WIDGETS = [
  { id: 'kpis', label: 'Balances & month totals' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'insights', label: 'Savings suggestions' },
  { id: 'monthly', label: 'Income vs expenses per month' },
  { id: 'categories', label: 'Spending by category' },
  { id: 'budget', label: 'Budget vs actual' },
  { id: 'trend', label: 'Top categories trend' },
  { id: 'balance', label: 'Balance evolution' },
  { id: 'merchants', label: 'Top merchants' },
] as const

export function Dashboard({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx, currency, fx } = ctx
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const [month, setMonth] = useState(() => months.at(-1) ?? today().slice(0, 7))
  const [accFilter, setAccFilter] = useState<Set<string>>(new Set(data.accounts.map((a) => a.id)))
  const [editing, setEditing] = useState(false)

  const txs = useMemo(() => etx.filter((t) => accFilter.has(t.account_id)), [etx, accFilter])
  const series = useMemo(() => monthly(txs).slice(-12), [txs])
  const cur = series.find((m) => m.month === month)
  const cats = useMemo(() => byCategory(txs, new Set([month])), [txs, month])
  const balances = useBalances(ctx)
  const subs = useSubscriptions(ctx)
  const budgets = useMemo(() => {
    const catName = new Map(data.categories.map((c) => [c.id, c.name]))
    return new Map(data.budgets.filter((b) => b.month === null).map((b) => [catName.get(b.category_id) ?? '', b.amount * (currency === 'BRL' ? fx.latest() : 1)]))
  }, [data, currency, fx])
  const checking = balances.filter((b) => b.account.type === 'checking' && b.account.currency === 'EUR').reduce((s, b) => s + b.display, 0)
  const insights = useMemo(() => savingsInsights({ txs, last3: last3(), current: today().slice(0, 7), budgets, subs, checkingBalance: checking, fmt }), [txs, subs, checking, fmt, budgets])
  const alerts = subscriptionAlerts(subs, today(), fmt).filter((a) => !data.settings.dismissed_alerts.includes(a.key))

  // Widget layout (order + visibility) is stored per user in user_settings.dashboard.
  const saved = data.settings.dashboard?.widgets ?? []
  const layout = [...saved.filter((w) => WIDGETS.some((x) => x.id === w.id)), ...WIDGETS.filter((w) => !saved.some((s) => s.id === w.id)).map((w) => ({ id: w.id, visible: true }))]
  const [widgets, setWidgets] = useState(layout)
  const persist = async (w: typeof widgets) => { setWidgets(w); await saveSettings({ dashboard: { widgets: w } }) }
  const move = (i: number, d: number) => { const w = [...widgets]; const [x] = w.splice(i, 1); w.splice(i + d, 0, x); persist(w) }

  const top5 = useMemo(() => byCategory(txs, new Set(series.map((s) => s.month))).slice(0, 5).map((c) => c.name), [txs, series])
  const trend = useMemo(() => series.map((m) => {
    const row: Record<string, number | string> = { month: monthLabel(m.month) }
    const bc = new Map(byCategory(txs, new Set([m.month])).map((c) => [c.name, c.value]))
    top5.forEach((n) => { row[n] = Math.round(bc.get(n) ?? 0) })
    return row
  }), [series, txs, top5])
  const totalBalance = useMemo(() => {
    const days = new Map<string, number>()
    for (const b of balances) if (accFilter.has(b.account.id)) {
      // Carry each account's balance forward to month ends so the total is comparable over time.
      for (const m of months) {
        const pt = [...b.series].reverse().find((p) => p.date.slice(0, 7) <= m)
        const v = pt ? fx.convert(pt.balance, b.account.currency, currency, `${m}-28`) : 0
        days.set(m, (days.get(m) ?? 0) + v)
      }
    }
    return [...days].map(([m, v]) => ({ month: monthLabel(m), balance: Math.round(v) }))
  }, [balances, months, accFilter, fx, currency])

  const widget = (id: string) => {
    switch (id) {
      case 'kpis': return (
        <div className="card" style={{ gridColumn: '1/-1' }}>
          <div className="kpis">
            {balances.filter((b) => accFilter.has(b.account.id)).map((b) => (
              <div className="kpi" key={b.account.id}><div className="l">{b.account.name}</div><div className="v">{fmt(b.display)}</div></div>
            ))}
            <div className="kpi"><div className="l">Total</div><div className="v">{fmt(balances.filter((b) => accFilter.has(b.account.id)).reduce((s, b) => s + b.display, 0))}</div></div>
            <div className="kpi"><div className="l">Income {monthLabel(month)}</div><div className="v pos">{fmt(cur?.income ?? 0)}</div></div>
            <div className="kpi"><div className="l">Expenses {monthLabel(month)}</div><div className="v neg">{fmt(cur?.expense ?? 0)}</div></div>
            <div className="kpi"><div className="l">Net {monthLabel(month)}</div><div className={`v ${(cur?.net ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmt(cur?.net ?? 0)}</div></div>
          </div>
        </div>)
      case 'alerts': return (
        <div className="card"><h3>Alerts</h3>
          {alerts.length === 0 && <p className="muted">No alerts.</p>}
          {alerts.map((a) => (
            <div key={a.key} className={`alert ${a.level}`}><span>{a.level === 'warn' ? '⚠ ' : 'ℹ '}{a.text}</span>
              <button onClick={async () => { await saveSettings({ dismissed_alerts: [...data.settings.dismissed_alerts, a.key] }); ctx.reload() }}>Dismiss</button></div>
          ))}
        </div>)
      case 'insights': return (
        <div className="card"><h3>Savings suggestions</h3>
          {insights.length === 0 && <p className="muted">Nothing to flag — import more data for better suggestions.</p>}
          {insights.slice(0, 8).map((i) => (
            <div key={i.key} style={{ marginBottom: 10 }}>
              <strong>{i.title}</strong>{i.monthlySaving ? <span className="pos"> · save ~{fmt(i.monthlySaving)}/mo</span> : null}
              <div className="muted" style={{ fontSize: 13 }}>{i.detail}</div>
            </div>
          ))}
        </div>)
      case 'monthly': return (
        <div className="card"><h3>Income vs expenses</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={series.map((s) => ({ ...s, label: monthLabel(s.month) }))} barGap={2}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} cursor={{ fill: 'var(--line)', opacity: 0.4 }} />
              <Legend />
              <Bar dataKey="income" name="Income" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" name="Expenses" fill={SERIES[1]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>)
      case 'categories': return (
        <div className="card"><h3>Spending by category — {monthLabel(month)}</h3>
          <table><tbody>
            {cats.map((c) => (
              <tr key={c.name}><td style={{ width: '38%' }}>{c.name}</td>
                <td><div className="bar"><div style={{ width: `${(c.value / (cats[0]?.value || 1)) * 100}%` }} /></div></td>
                <td className="num">{fmt(c.value)}</td></tr>
            ))}
          </tbody></table>
        </div>)
      case 'budget': {
        const actual = new Map(cats.map((c) => [c.name, c.value]))
        const rows = [...budgets].filter(([, b]) => b > 0).map(([name, b]) => ({ name, b, a: actual.get(name) ?? 0 })).sort((x, y) => y.a / y.b - x.a / x.b)
        return (
          <div className="card"><h3>Budget vs actual — {monthLabel(month)}</h3>
            <table><tbody>
              {rows.map((r) => (
                <tr key={r.name}><td style={{ width: '32%' }}>{r.name}</td>
                  <td><div className="bar"><div className={r.a > r.b ? 'over' : ''} style={{ width: `${Math.min(100, (r.a / r.b) * 100)}%` }} /></div></td>
                  <td className={`num ${r.a > r.b ? 'neg' : ''}`}>{fmt(r.a)} / {fmt(r.b)}{r.a > r.b ? ' ▲' : ''}</td></tr>
              ))}
            </tbody></table>
          </div>)
      }
      case 'trend': return (
        <div className="card"><h3>Top 5 categories over time</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trend}>
              <CartesianGrid {...grid} /><XAxis dataKey="month" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} /><Legend />
              {top5.map((n, i) => <Line key={n} dataKey={n} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 3 }} />)}
            </LineChart>
          </ResponsiveContainer>
        </div>)
      case 'balance': return (
        <div className="card"><h3>Total balance (selected accounts, month end)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={totalBalance}>
              <CartesianGrid {...grid} /><XAxis dataKey="month" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} />
              <Line dataKey="balance" name="Balance" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>)
      case 'merchants': return (
        <div className="card"><h3>Top merchants — {monthLabel(month)}</h3>
          <table><thead><tr><th>Merchant</th><th className="num">#</th><th className="num">Total</th></tr></thead><tbody>
            {topMerchants(txs, new Set([month])).map((m) => <tr key={m.merchant}><td>{m.merchant}</td><td className="num">{m.count}</td><td className="num">{fmt(m.total)}</td></tr>)}
          </tbody></table>
        </div>)
    }
  }

  return (
    <>
      <div className="row">
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        {data.accounts.map((a) => (
          <label key={a.id} className="inline"><input type="checkbox" checked={accFilter.has(a.id)} onChange={(e) => {
            const s = new Set(accFilter); if (e.target.checked) s.add(a.id); else s.delete(a.id); setAccFilter(s)
          }} />{a.name}</label>
        ))}
        <button onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Customize'}</button>
      </div>
      {editing && (
        <div className="card" style={{ marginBottom: 12 }}><h3>Dashboard widgets</h3>
          {widgets.map((w, i) => (
            <div key={w.id} className="row" style={{ marginBottom: 4 }}>
              <label className="inline"><input type="checkbox" checked={w.visible} onChange={(e) => persist(widgets.map((x) => x.id === w.id ? { ...x, visible: e.target.checked } : x))} />
                {WIDGETS.find((x) => x.id === w.id)?.label}</label>
              <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button disabled={i === widgets.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            </div>
          ))}
        </div>
      )}
      <div className="grid">{widgets.filter((w) => w.visible).map((w) => <div key={w.id} style={{ display: 'contents' }}>{widget(w.id)}</div>)}</div>
    </>
  )
}
