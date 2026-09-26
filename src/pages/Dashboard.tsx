import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { byCategory, monthly, topMerchants } from '../domain/analytics'
import { savingsInsights } from '../domain/insights'
import { subscriptionAlerts } from '../domain/subscriptions'
import { monthLabel } from '../lib/format'
import { last3, today, useBalances, useFmt, useSubscriptions } from '../lib/hooks'
import { saveSettings } from '../lib/data'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { COUNTRIES, countryOf, flowsByCountry, type Country } from '../domain/countries'
import { monthWindow } from '../domain/period'
import { cumulative, linearTrend } from '../domain/trend'

/** yyyy-mm plus n months. */
const addMonths = (m: string, n: number) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 1 + n, 1)).toISOString().slice(0, 7) }

export const WIDGETS = [
  { id: 'kpis', label: 'Saldos e totais do mês' },
  { id: 'alerts', label: 'Alertas' },
  { id: 'insights', label: 'Sugestões de economia' },
  { id: 'monthly', label: 'Receitas e despesas por mês' },
  { id: 'country', label: 'Gastos por país' },
  { id: 'savings', label: 'Taxa de poupança' },
  { id: 'yoy', label: 'Gastos acumulados no ano x ano anterior' },
  { id: 'forecast', label: 'Tendência de receitas e despesas' },
  { id: 'categories', label: 'Gastos por categoria' },
  { id: 'budget', label: 'Orçado x realizado' },
  { id: 'trend', label: 'Evolução das principais categorias' },
  { id: 'balance', label: 'Evolução do saldo' },
  { id: 'merchants', label: 'Principais estabelecimentos' },
] as const

export function Dashboard({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx, currency, fx } = ctx
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const [month, setMonth] = useState(() => months.at(-1) ?? today().slice(0, 7))
  // Unticked accounts: an account created by a later import shows up ticked.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const shown = (id: string) => !hidden.has(id)
  const [editing, setEditing] = useState(false)

  const txs = useMemo(() => etx.filter((t) => !hidden.has(t.account_id)), [etx, hidden])
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
  const persist = async (w: typeof widgets) => { setWidgets(w); await saveSettings({ dashboard: { ...data.settings.dashboard, widgets: w } }) }
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

  // Last 12 months ending at the selected month, for the country and year charts.
  const window12 = useMemo(() => monthWindow(month, 12), [month])
  const countryOfAccount = useMemo(() => new Map(data.accounts.filter((a) => !hidden.has(a.id)).map((a) => [a.id, countryOf(a.bank)] as [string, Country])), [data.accounts, hidden])
  const byCountry = useMemo(() => flowsByCountry(txs, countryOfAccount, window12), [txs, countryOfAccount, window12])
  const countryRows = window12.map((m) => ({ label: monthLabel(m), ...Object.fromEntries(byCountry.countries.map((c) => [c, Math.round(byCountry.cell(m, c).expense)])) }))
  const savingsRows = series.map((s) => ({ label: monthLabel(s.month), rate: s.income > 0 ? Math.round((s.net / s.income) * 100) : null }))
  const yoyRows = useMemo(() => {
    const year = Number(month.slice(0, 4))
    const spent = new Map(monthly(txs).map((m) => [m.month, m.expense]))
    const mms = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
    const cur = cumulative(mms.map((mm) => spent.get(`${year}-${mm}`) ?? 0))
    const prev = cumulative(mms.map((mm) => spent.get(`${year - 1}-${mm}`) ?? 0))
    return mms.map((mm, i) => ({
      label: monthLabel(`${year}-${mm}`).split(' ')[0],
      atual: `${year}-${mm}` <= month ? Math.round(cur[i]) : null,
      anterior: Math.round(prev[i]),
    }))
  }, [txs, month])
  // Trend: 12 months of income and spending with a fitted line, carried 3 months ahead.
  const trendRows = useMemo(() => {
    const flows = new Map(monthly(txs).map((m) => [m.month, m]))
    const hist = window12.map((m) => ({ m, income: flows.get(m)?.income ?? null, expense: flows.get(m)?.expense ?? null }))
    const ti = linearTrend(hist.map((h) => h.income))
    const te = linearTrend(hist.map((h) => h.expense))
    const ahead = [1, 2, 3].map((n) => addMonths(month, n))
    const at = (t: ReturnType<typeof linearTrend>, x: number) => (t ? Math.max(0, Math.round(t.intercept + t.slope * x)) : null)
    return [...hist, ...ahead.map((m) => ({ m, income: null, expense: null }))].map((h, x) => ({
      label: monthLabel(h.m), receitas: h.income === null ? null : Math.round(h.income), despesas: h.expense === null ? null : Math.round(h.expense),
      tendReceitas: at(ti, x), tendDespesas: at(te, x),
    }))
  }, [txs, window12, month])

  const widget = (id: string) => {
    switch (id) {
      case 'kpis': return (
        <div className="card" style={{ gridColumn: '1/-1' }}>
          <div className="kpis">
            {balances.filter((b) => shown(b.account.id)).map((b) => (
              <div className="kpi" key={b.account.id}><div className="l">{b.account.name}</div><div className="v">{fmt(b.display)}</div></div>
            ))}
            <div className="kpi"><div className="l">Total</div><div className="v">{fmt(balances.filter((b) => shown(b.account.id)).reduce((s, b) => s + b.display, 0))}</div></div>
            <div className="kpi"><div className="l">Receitas {monthLabel(month)}</div><div className="v pos">{fmt(cur?.income ?? 0)}</div></div>
            <div className="kpi"><div className="l">Despesas {monthLabel(month)}</div><div className="v neg">{fmt(cur?.expense ?? 0)}</div></div>
            <div className="kpi"><div className="l">Resultado {monthLabel(month)}</div><div className={`v ${(cur?.net ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmt(cur?.net ?? 0)}</div></div>
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
      case 'country': return (
        <div className="card"><h3>Gastos por país — 12 meses até {monthLabel(month)}</h3>
          {byCountry.countries.length === 0 ? <p className="muted">Sem gastos nas contas marcadas.</p> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={countryRows}>
                <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
                <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} cursor={{ fill: 'var(--line)', opacity: 0.4 }} />
                {byCountry.countries.length > 1 && <Legend />}
                {/* Colour follows the country (fixed order), not its position in the filter. */}
                {byCountry.countries.map((c, i) => (
                  <Bar key={c} dataKey={c} name={c} stackId="p" fill={SERIES[COUNTRIES.indexOf(c)]} stroke="var(--card)" strokeWidth={1}
                    radius={i === byCountry.countries.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
          <p className="muted" style={{ fontSize: 12 }}>Itaú = Brasil, BCP e CCF = França, Millennium = Portugal. Transferências entre contas ficam de fora.</p>
        </div>)
      case 'savings': return (
        <div className="card"><h3>Taxa de poupança — quanto das receitas sobrou</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={savingsRows}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} unit="%" width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => `${v}%`} cursor={{ fill: 'var(--line)', opacity: 0.4 }} />
              <ReferenceLine y={0} stroke="var(--muted)" />
              <Bar dataKey="rate" name="Poupança" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12 }}>Resultado do mês ÷ receitas. Abaixo de zero: gastou mais do que recebeu.</p>
        </div>)
      case 'yoy': return (
        <div className="card"><h3>Gastos acumulados no ano: {month.slice(0, 4)} x {Number(month.slice(0, 4)) - 1}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={yoyRows}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} /><Legend />
              <Line dataKey="atual" name={month.slice(0, 4)} stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              <Line dataKey="anterior" name={String(Number(month.slice(0, 4)) - 1)} stroke={SERIES[1]} strokeWidth={2} strokeDasharray="4 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>)
      case 'forecast': return (
        <div className="card"><h3>Tendência de receitas e despesas (+3 meses)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trendRows}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} /><Legend />
              <Line dataKey="receitas" name="Receitas" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} />
              <Line dataKey="despesas" name="Despesas" stroke={SERIES[1]} strokeWidth={2} dot={{ r: 3 }} />
              <Line dataKey="tendReceitas" name="Tendência receitas" stroke={SERIES[0]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
              <Line dataKey="tendDespesas" name="Tendência despesas" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12 }}>Linha tracejada: reta que melhor se ajusta aos últimos 12 meses, prolongada 3 meses. É tendência, não previsão.</p>
        </div>)
      case 'categories': return (
        <div className="card"><h3>Gastos por categoria — {monthLabel(month)}</h3>
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
          <div className="card"><h3>Orçado x realizado — {monthLabel(month)}</h3>
            <p className="muted" style={{ fontSize: 12 }}>
              <span className="pos">✓ dentro</span> (até 80%) · <span className="warn">⚠ perto do limite</span> (80–100%) · <span className="neg">▲ acima do orçado</span>
            </p>
            <table><tbody>
              {rows.map((r) => {
                // Status = share of the budget used; each colour also has its own symbol.
                const used = r.a / r.b
                const st = used > 1 ? { cls: 'over', text: 'neg', mark: '▲' } : used >= 0.8 ? { cls: 'near', text: 'warn', mark: '⚠' } : { cls: 'ok', text: 'pos', mark: '✓' }
                return (
                  <tr key={r.name}><td style={{ width: '32%' }}>{r.name}</td>
                    <td><div className="bar" title={`${Math.round(used * 100)}% do orçado`}><div className={st.cls} style={{ width: `${Math.min(100, used * 100)}%` }} /></div></td>
                    <td className={`num ${st.text}`}>{st.mark} {fmt(r.a)} / {fmt(r.b)} <span className="muted">({Math.round(used * 100)}%)</span></td></tr>
                )
              })}
            </tbody></table>
          </div>)
      }
      case 'trend': return (
        <div className="card"><h3>5 maiores categorias ao longo do tempo</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trend}>
              <CartesianGrid {...grid} /><XAxis dataKey="month" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} /><Legend />
              {top5.map((n, i) => <Line key={n} dataKey={n} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 3 }} />)}
            </LineChart>
          </ResponsiveContainer>
        </div>)
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
      case 'merchants': return (
        <div className="card"><h3>Principais estabelecimentos — {monthLabel(month)}</h3>
          <table><thead><tr><th>Estabelecimento</th><th className="num">#</th><th className="num">Total</th></tr></thead><tbody>
            {topMerchants(txs, new Set([month])).map((m) => <tr key={m.merchant}><td>{m.merchant}</td><td className="num">{m.count}</td><td className="num">{fmt(m.total)}</td></tr>)}
          </tbody></table>
        </div>)
    }
  }

  return (
    <>
      <div className="row">
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês">
          {[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        {[...new Set(data.accounts.map((a) => countryOf(a.bank)))].map((c) => (
          <button key={c} onClick={() => setHidden(new Set(data.accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>
        ))}
        <button onClick={() => setHidden(new Set())}>Todas</button>
        {data.accounts.map((a) => (
          <label key={a.id} className="inline"><input type="checkbox" checked={shown(a.id)} onChange={() => setHidden((prev) => {
            const s = new Set(prev); if (s.has(a.id)) s.delete(a.id); else s.add(a.id); return s
          })} />{a.name}</label>
        ))}
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
    </>
  )
}
