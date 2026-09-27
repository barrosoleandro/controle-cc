import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { byCategory, monthly } from '../domain/analytics'
import { savingsInsights } from '../domain/insights'
import { subscriptionAlerts } from '../domain/subscriptions'
import { monthLabel } from '../lib/format'
import { last3, today, useBalances, useFmt, useSubscriptions } from '../lib/hooks'
import { saveSettings } from '../lib/data'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { countryOf } from '../domain/countries'
import { monthWindow } from '../domain/period'
import { isTithe } from '../domain/categorize'
import { Menu } from './analysis/shared'

// A quick look at the month. Trends, merchants, dates and comparisons live on the Análises page.
export const WIDGETS = [
  { id: 'kpis', label: 'Saldos e totais do mês' },
  { id: 'monthly', label: 'Receitas e despesas por mês' },
  { id: 'categories', label: 'Gastos por categoria' },
  { id: 'budget', label: 'Orçado x realizado' },
  { id: 'balance', label: 'Evolução do saldo' },
  { id: 'alerts', label: 'Alertas' },
  { id: 'insights', label: 'Sugestões de economia' },
] as const

export function Dashboard({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx, currency, fx } = ctx
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  // Several months can be picked; totals, categories, budget and merchants add them up,
  // and the charts over time end at the latest picked month. Shortcuts end at the latest
  // month that already happened (card instalments can be dated in the future).
  const lastReal = [...months].reverse().find((m) => m <= today().slice(0, 7)) ?? months.at(-1) ?? today().slice(0, 7)
  const [picked, setPicked] = useState<Set<string>>(() => new Set([lastReal]))
  const selMonths = useMemo(() => [...picked].sort(), [picked])
  const selSet = useMemo(() => new Set(selMonths), [selMonths])
  const month = selMonths.at(-1) ?? lastReal
  const contiguous = monthWindow(month, selMonths.length).join() === selMonths.join()
  const period = selMonths.length === 1 ? monthLabel(month)
    : contiguous ? `${monthLabel(selMonths[0])} – ${monthLabel(month)}` : `${selMonths.length} meses`
  const pickLast = (n: number) => setPicked(new Set(monthWindow(lastReal, n)))
  const toggleMonth = (m: string) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(m)) { if (next.size > 1) next.delete(m) } else next.add(m)
    return next
  })
  // Unticked accounts: an account created by a later import shows up ticked.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const shown = (id: string) => !hidden.has(id)
  const [editing, setEditing] = useState(false)

  const txs = useMemo(() => etx.filter((t) => !hidden.has(t.account_id)), [etx, hidden])
  const series = useMemo(() => monthly(txs).slice(-12), [txs])
  const cur = useMemo(() => {
    const ms = monthly(txs).filter((m) => selSet.has(m.month))
    const income = ms.reduce((s, m) => s + m.income, 0), expense = ms.reduce((s, m) => s + m.expense, 0)
    return { income, expense, net: income - expense }
  }, [txs, selSet])
  const cats = useMemo(() => byCategory(txs, selSet), [txs, selSet])
  const balances = useBalances(ctx)
  const subs = useSubscriptions(ctx)
  const budgets = useMemo(() => {
    const catName = new Map(data.categories.map((c) => [c.id, c.name]))
    return new Map(data.budgets.filter((b) => b.month === null).map((b) => [catName.get(b.category_id) ?? '', b.amount * (currency === 'BRL' ? fx.latest() : 1)]))
  }, [data, currency, fx])
  const checking = balances.filter((b) => b.account.type === 'checking' && b.account.currency === 'EUR').reduce((s, b) => s + b.display, 0)
  const insights = useMemo(() => savingsInsights({ txs: txs.filter((t) => !isTithe(t.categoryName)), last3: last3(), current: today().slice(0, 7), budgets, subs, checkingBalance: checking, fmt }), [txs, subs, checking, fmt, budgets])
  const alerts = subscriptionAlerts(subs, today(), fmt).filter((a) => !data.settings.dismissed_alerts.includes(a.key))

  // Widget layout (order + visibility) is stored per user in user_settings.dashboard.
  const saved = data.settings.dashboard?.widgets ?? []
  const layout = [...saved.filter((w) => WIDGETS.some((x) => x.id === w.id)), ...WIDGETS.filter((w) => !saved.some((s) => s.id === w.id)).map((w) => ({ id: w.id, visible: true }))]
  const [widgets, setWidgets] = useState(layout)
  const persist = async (w: typeof widgets) => { setWidgets(w); await saveSettings({ dashboard: { ...data.settings.dashboard, widgets: w } }) }
  const move = (i: number, d: number) => { const w = [...widgets]; const [x] = w.splice(i, 1); w.splice(i + d, 0, x); persist(w) }

  const totalBalance = useMemo(() => {
    const days = new Map<string, number>()
    for (const b of balances) if (shown(b.account.id)) {
      // Carry each account's balance forward to month ends so the total is comparable over time.
      for (const m of months) {
        const pt = [...b.series].reverse().find((p) => p.date.slice(0, 7) <= m)
        const v = pt ? fx.convert(pt.balance, b.account.currency, currency, `${m}-28`) : 0
        days.set(m, (days.get(m) ?? 0) + v)
      }
    }
    return [...days].map(([m, v]) => ({ month: monthLabel(m), balance: Math.round(v) }))
  }, [balances, months, hidden, fx, currency]) // eslint-disable-line react-hooks/exhaustive-deps

  const widget = (id: string) => {
    switch (id) {
      case 'kpis': return (
        <div className="card" style={{ gridColumn: '1/-1' }}>
          <div className="kpis">
            {balances.filter((b) => shown(b.account.id)).map((b) => (
              <div className="kpi" key={b.account.id}><div className="l">{b.account.name}</div><div className="v">{fmt(b.display)}</div></div>
            ))}
            <div className="kpi"><div className="l">Total</div><div className="v">{fmt(balances.filter((b) => shown(b.account.id)).reduce((s, b) => s + b.display, 0))}</div></div>
            <div className="kpi"><div className="l">Receitas {period}</div><div className="v pos">{fmt(cur?.income ?? 0)}</div></div>
            <div className="kpi"><div className="l">Despesas {period}</div><div className="v neg">{fmt(cur?.expense ?? 0)}</div></div>
            <div className="kpi"><div className="l">Resultado {period}</div><div className={`v ${(cur?.net ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmt(cur?.net ?? 0)}</div></div>
          </div>
        </div>)
      case 'alerts': return (
        <div className="card"><h3>Alertas</h3>
          {alerts.length === 0 && <p className="muted">Nenhum alerta.</p>}
          {alerts.map((a) => (
            <div key={a.key} className={`alert ${a.level}`}><span>{a.level === 'warn' ? '⚠ ' : 'ℹ '}{a.text}</span>
              <button onClick={async () => { await saveSettings({ dismissed_alerts: [...data.settings.dismissed_alerts, a.key] }); ctx.reload() }}>Dispensar</button></div>
          ))}
        </div>)
      case 'insights': return (
        <div className="card"><h3>Sugestões de economia</h3>
          {insights.length === 0 && <p className="muted">Nada a destacar — importe mais dados para sugestões melhores.</p>}
          {insights.slice(0, 8).map((i) => (
            <div key={i.key} style={{ marginBottom: 10 }}>
              <strong>{i.title}</strong>{i.monthlySaving ? <span className="pos"> · economiza ~{fmt(i.monthlySaving)}/mês</span> : null}
              <div className="muted" style={{ fontSize: 13 }}>{i.detail}</div>
            </div>
          ))}
        </div>)
      case 'monthly': return (
        <div className="card"><h3>Receitas e despesas</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={series.map((s) => ({ ...s, label: monthLabel(s.month) }))} barGap={2}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} cursor={{ fill: 'var(--line)', opacity: 0.4 }} />
              <Legend />
              <Bar dataKey="income" name="Receitas" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" name="Despesas" fill={SERIES[1]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>)
      case 'categories': return (
        <div className="card"><h3>Gastos por categoria — {period}</h3>
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
        // Monthly budgets scale with the number of picked months.
        const rows = [...budgets].filter(([, b]) => b > 0).map(([name, b]) => ({ name, b: b * selMonths.length, a: actual.get(name) ?? 0 })).sort((x, y) => y.a / y.b - x.a / x.b)
        return (
          <div className="card"><h3>Orçado x realizado — {period}{selMonths.length > 1 ? ` (orçamento × ${selMonths.length} meses)` : ''}</h3>
            <p className="muted" style={{ fontSize: 12 }}>
              <span className="swatch" style={{ background: 'var(--budget)' }} />Orçado · <span className="swatch" style={{ background: 'var(--actual)' }} />Realizado
              {' '}— <span className="pos">✓</span> até 80% · <span className="warn">⚠</span> 80–100% · <span className="neg">▲</span> acima do orçado
            </p>
            <table><tbody>
              {rows.map((r) => {
                // Two bars on the same scale (the larger of the two), budget and actual each in its colour.
                const used = r.a / r.b
                const top = Math.max(r.a, r.b) || 1
                const st = isTithe(r.name) ? { text: '', mark: '' } : used > 1 ? { text: 'neg', mark: '▲' } : used >= 0.8 ? { text: 'warn', mark: '⚠' } : { text: 'pos', mark: '✓' }
                return (
                  <tr key={r.name}><td style={{ width: '30%' }}>{r.name}</td>
                    <td><div className="pair" title={`${Math.round(used * 100)}% do orçado`}>
                      <div className="bar b" aria-label={`Orçado ${fmt(r.b)}`}><div style={{ width: `${(r.b / top) * 100}%` }} /></div>
                      <div className="bar a" aria-label={`Realizado ${fmt(r.a)}`}><div style={{ width: `${(r.a / top) * 100}%` }} /></div>
                    </div></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <span className={st.text}>{st.mark}</span> <span className="v-actual">{fmt(r.a)}</span>
                      {' / '}<span className="v-budget">{fmt(r.b)}</span> <span className="muted">({Math.round(used * 100)}%)</span></td></tr>
                )
              })}
            </tbody></table>
          </div>)
      }
      case 'balance': return (
        <div className="card"><h3>Saldo total (contas marcadas, fim do mês)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={totalBalance}>
              <CartesianGrid {...grid} /><XAxis dataKey="month" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} />
              <Line dataKey="balance" name="Saldo" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>)
    }
  }

  return (
    <>
      <div className="row">
        <details className="monthpick">
          <summary aria-label="Meses">📅 {period}</summary>
          <div>
            <div className="row">
              <button onClick={() => pickLast(1)}>Último mês</button>
              <button onClick={() => pickLast(3)}>3 meses</button>
              <button onClick={() => pickLast(6)}>6 meses</button>
              <button onClick={() => pickLast(12)}>12 meses</button>
              <button onClick={() => setPicked(new Set(months.filter((m) => m.slice(0, 4) === lastReal.slice(0, 4) && m <= lastReal)))}>Ano {lastReal.slice(0, 4)}</button>
            </div>
            {[...new Set(months.map((m) => m.slice(0, 4)))].reverse().map((y) => (
              <div key={y} style={{ marginBottom: 6 }}>
                <strong>{y}</strong>
                <div className="row" style={{ marginBottom: 0 }}>
                  {months.filter((m) => m.startsWith(y)).map((m) => (
                    <label key={m} className="inline" style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={picked.has(m)} onChange={() => toggleMonth(m)} />{monthLabel(m).split(' ')[0]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
        <Menu label={`Contas: ${hidden.size ? `${data.accounts.length - hidden.size} de ${data.accounts.length}` : 'todas'}`} active={hidden.size > 0}>
          <div className="row" style={{ marginBottom: 8 }}>
            {[...new Set(data.accounts.map((a) => countryOf(a.bank)))].map((c) => (
              <button key={c} onClick={() => setHidden(new Set(data.accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>
            ))}
            <button onClick={() => setHidden(new Set())}>Todas</button>
          </div>
          {data.accounts.map((a) => (
            <label key={a.id} className="inline opt"><input type="checkbox" checked={shown(a.id)} onChange={() => setHidden((prev) => {
              const s = new Set(prev); if (s.has(a.id)) s.delete(a.id); else s.add(a.id); return s
            })} />{a.name}</label>
          ))}
        </Menu>
        <button onClick={() => setEditing(!editing)}>{editing ? 'Pronto' : 'Personalizar'}</button>
      </div>
      {editing && (
        <div className="card" style={{ marginBottom: 12 }}><h3>Blocos do painel</h3>
          {widgets.map((w, i) => (
            <div key={w.id} className="row" style={{ marginBottom: 4 }}>
              <label className="inline"><input type="checkbox" checked={w.visible} onChange={(e) => persist(widgets.map((x) => x.id === w.id ? { ...x, visible: e.target.checked } : x))} />
                {WIDGETS.find((x) => x.id === w.id)?.label}</label>
              <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Mover para cima">↑</button>
              <button disabled={i === widgets.length - 1} onClick={() => move(i, 1)} aria-label="Mover para baixo">↓</button>
            </div>
          ))}
        </div>
      )}
      <div className="grid">{widgets.filter((w) => w.visible).map((w) => <div key={w.id} style={{ display: 'contents' }}>{widget(w.id)}</div>)}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>Tendências, comparações, estabelecimentos e datas: aba <strong>Análises</strong>.</p>
    </>
  )
}
