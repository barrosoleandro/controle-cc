import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { byCategory, monthly } from '../domain/analytics'
import { savingsInsights } from '../domain/insights'
import { subscriptionAlerts } from '../domain/subscriptions'
import { monthLabel, money } from '../lib/format'
import { currentMonth, hiddenByDefault, last3, today, useBalances, useFmt, useSubscriptions } from '../lib/hooks'
import { saveSettings } from '../lib/data'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { countryOf } from '../domain/countries'
import { monthWindow } from '../domain/period'
import { CARD_PAYMENT, isTithe } from '../domain/categorize'
import { findSalaryCategory, salaryAt } from '../domain/budget'
import { brazilCard, brazilTransfer, forecastNextMonth, monthlyBills, nextMonthOf, sentToBrazil } from '../domain/forecast'
import { Menu } from './analysis/shared'
import { VERSION, versionLabel } from '../lib/version'
import { Icon } from '../components/Icons'
import { AsOf, Stat } from '../components/Page'

// A quick look at the month. Trends, merchants, dates and comparisons live on the Análises page.
export const WIDGETS = [
  { id: 'transfer', label: 'Alerta: transferir do BCP para o Itaú' },
  { id: 'kpis', label: 'Saldos e totais do mês' },
  { id: 'nextMonth', label: 'Mês seguinte: gastos estimados' },
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
  // The current month is always pickable, even before its first transaction.
  const months = useMemo(() => [...new Set([...etx.map((t) => t.month), currentMonth()])].sort(), [etx])
  // Several months can be picked; totals, categories, budget and merchants add them up,
  // and the charts over time end at the latest picked month. Opens on the current month,
  // and the shortcuts end at it (card instalments can be dated in the future).
  const lastReal = currentMonth()
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
  // Unticked accounts: opens on the BCP joint account; the others are one click away.
  const [hidden, setHidden] = useState<Set<string>>(() => hiddenByDefault(data.accounts))
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
    // Expense categories only: the salary is kept in the same table, as an income category.
    const catName = new Map(data.categories.filter((c) => c.kind === 'expense').map((c) => [c.id, c.name]))
    return new Map(data.budgets.filter((b) => b.month === null && catName.has(b.category_id)).map((b) => [catName.get(b.category_id) ?? '', b.amount * (currency === 'BRL' ? fx.latest() : 1)]))
  }, [data, currency, fx])
  // Salary: planned per month from its history (Configurações → Orçamentos), received from the transactions.
  const salary = useMemo(() => {
    const cat = findSalaryCategory(data.categories)
    if (!cat) return null
    const rows = data.budgets.filter((b) => b.category_id === cat.id)
    const rate = currency === 'BRL' ? fx.latest() : 1
    const planned = selMonths.map((m) => salaryAt(rows, m)?.amount)
    return {
      name: cat.name,
      b: planned.reduce<number>((s, v) => s + (v ?? 0), 0) * rate,
      missing: selMonths.filter((_, i) => planned[i] === undefined),
      a: txs.filter((t) => t.category_id === cat.id && t.kind === 'income' && selSet.has(t.month)).reduce((s, t) => s + t.value, 0),
    }
  }, [data, currency, fx, selMonths, selSet, txs])
  const checking = balances.filter((b) => b.account.type === 'checking' && b.account.currency === 'EUR').reduce((s, b) => s + b.display, 0)
  const insights = useMemo(() => savingsInsights({ txs: txs.filter((t) => !isTithe(t.categoryName)), last3: last3(), current: today().slice(0, 7), budgets, subs, checkingBalance: checking, fmt }), [txs, subs, checking, fmt, budgets])
  const alerts = subscriptionAlerts(subs, today(), fmt).filter((a) => !data.settings.dismissed_alerts.includes(a.key))

  // Next month: what to expect in the accounts on screen, and what to send to Brazil.
  // The Brazil side ignores the account filter: it is about the Itaú accounts, always in reais.
  const nextMonth = useMemo(() => {
    const now = today()
    const skip = (n: string) => isTithe(n)
    const mine = forecastNextMonth(txs, now, skip)
    const brIds = new Set(data.accounts.filter((a) => countryOf(a.bank) === 'Brasil').map((a) => a.id))
    const brTx = ctx.etx.filter((t) => brIds.has(t.account_id)).map((t) => ({ ...t, value: fx.convert(t.amount, t.currency, 'BRL', t.booking_date) }))
    // The card payment in the checking account is the bill itself, counted apart: not a recurring charge.
    const skipBr = (n: string) => skip(n) || n === 'Cartão Itaú'
    const br0 = forecastNextMonth(brTx, now, skipBr)
    // Monthly bills come from the checking account (health plan, power, phone, condo…), whatever
    // the amount does from month to month; the non-monthly ones stay as detected.
    const checkingIds = new Set(data.accounts.filter((a) => brIds.has(a.id) && a.type !== 'card').map((a) => a.id))
    const periodicNames = new Set(br0.periodic.map((l) => l.label))
    const bills = monthlyBills(brTx.filter((t) => checkingIds.has(t.account_id)), now, skipBr).filter((l) => !periodicNames.has(l.label))
    const br = { ...br0, monthly: bills.reduce((a, l) => a + l.amount, 0), monthlyLines: bills }
    // The card bill that falls in the coming month: the imported open bills, or, while none is
    // imported, the card purchases already assigned to that month's bill (statement_due) or, failing
    // that, made this month, which is what that bill will carry.
    const next = nextMonthOf(now)
    const cardIds = new Set(data.accounts.filter((a) => brIds.has(a.id) && a.type === 'card').map((a) => a.id))
    const openBills = brazilCard(data.cardStatements, cardIds, now.slice(0, 7)).open
    const cardBuys = brTx.filter((t) => cardIds.has(t.account_id) && t.amount < 0 && t.bank_category !== CARD_PAYMENT)
    const dueNext = cardBuys.filter((t) => t.statement_due?.slice(0, 7) === next)
    const cardNext = openBills > 0 ? openBills
      : -(dueNext.length ? dueNext : cardBuys.filter((t) => t.month === now.slice(0, 7))).reduce((a, t) => a + t.value, 0)
    const balance = balances.filter((b) => brIds.has(b.account.id) && b.account.type === 'checking').reduce((s, b) => s + fx.convert(b.native, b.account.currency, 'BRL', now), 0)
    return { mine, br, send: brIds.size ? { ...brazilTransfer(br, cardNext, balance, now), lines: [{ label: 'Fatura do cartão Itaú', amount: cardNext, date: '' }, ...br.monthlyLines, ...br.periodic], sent: sentToBrazil(brTx, now.slice(0, 7)) } : null }
  }, [txs, ctx.etx, data.accounts, data.cardStatements, balances, fx])
  const brl = money('BRL')
  const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  const send = nextMonth.send
  const sendEur = send ? money('EUR')(send.transfer / fx.latest()) : ''
  // A transfer already made this month settles it: the alert only asks for one when none went yet.
  const open = !!send && send.transfer > 0 && !send.sent
  const sendLine = send && (send.sent
    ? <>Transferência para o Brasil já feita em {monthLabel(today().slice(0, 7))}: {brl(send.sent.amount)} (último envio em {dayMonth(send.sent.date)}).</>
    : send.transfer > 0
      ? <><strong>Transferir do BCP para o Itaú: {sendEur}</strong> (≈ {brl(send.transfer)}) até {dayMonth(send.by)}, para cobrir {monthLabel(send.month)}.</>
      : <>Sem transferência do BCP para o Itaú em {monthLabel(send.month)}: o saldo no Itaú cobre o gasto estimado.</>)

  // Widget layout (order + visibility) is stored per user in user_settings.dashboard.
  const saved = data.settings.dashboard?.widgets ?? []
  // A widget the saved layout does not know yet goes right after the one that precedes it by default.
  const layout = WIDGETS.reduce((acc, w, i) => {
    if (acc.some((x) => x.id === w.id)) return acc
    const at = i ? acc.findIndex((x) => x.id === WIDGETS[i - 1].id) : -1
    acc.splice(i && at < 0 ? acc.length : at + 1, 0, { id: w.id, visible: true })
    return acc
  }, saved.filter((w) => WIDGETS.some((x) => x.id === w.id)))
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
      case 'kpis': {
        // The four numbers that answer "how am I doing": balance today (with each account
        // under it), and money in, out and left over in the picked months.
        const mine = balances.filter((b) => shown(b.account.id))
        const net = cur?.net ?? 0
        return (
          <div className="stats">
            <Stat tone="accent" icon="carteira" label="Saldo hoje" value={fmt(mine.reduce((s, b) => s + b.display, 0))}>
              {mine.length > 1 && <div className="stat-list">
                {mine.map((b) => <div key={b.account.id}><span>{b.account.name}</span><span className={b.display < 0 ? 'neg' : ''}>{fmt(b.display)}</span></div>)}
              </div>}
            </Stat>
            <Stat tone="pos" icon="entrada" label="Receitas" value={<span className="pos">{fmt(cur?.income ?? 0)}</span>} sub={period} />
            <Stat tone="neg" icon="saida" label="Despesas" value={<span className="neg">{fmt(cur?.expense ?? 0)}</span>} sub={period} />
            <Stat tone="neutral" icon="resultado" label="Sobrou" value={<span className={net >= 0 ? 'pos' : 'neg'}>{fmt(net)}</span>}
              sub={(cur?.income ?? 0) > 0 ? `${Math.round((net / cur.income) * 100)}% das receitas` : period} />
          </div>)
      }
      case 'transfer': return !send ? (
        <div className="alert" style={{ display: 'block', gridColumn: '1/-1' }}>Transferência para o Brasil: ainda não há conta do Itaú no app. Importe um extrato do Itaú para eu estimar quanto enviar do BCP.</div>
      ) : (
        <div className={`alert ${open ? 'warn' : 'ok'}`} role="status" style={{ display: 'block', fontSize: 15, gridColumn: '1/-1' }}>
          {open ? '⚠ ' : '✔ '}{sendLine}
          <div className="muted" style={{ fontSize: 13 }}>Fatura do cartão a pagar: {brl(send.card)} · recorrentes do mês: {brl(send.recurring)} · saldo hoje no Itaú: {brl(send.balance)}.</div>
          {send.lines.length > 0 && <details><summary className="muted" style={{ fontSize: 13 }}>Ver a fatura e os recorrentes que entram na conta</summary>
            {send.lines.map((l) => <div key={l.label + l.date} className="muted" style={{ fontSize: 13 }}>{l.label} · {brl(l.amount)}</div>)}</details>}
        </div>)
      case 'nextMonth': {
        const { mine } = nextMonth
        return (
          <div className="card"><h3>Mês seguinte — {monthLabel(mine.month)}</h3>
            <p><strong>Gasto estimado nas contas em tela: {fmt(mine.total)}</strong></p>
            <table><tbody>
              <tr><td>Dia a dia (média dos 3 últimos meses)</td><td className="num">{fmt(mine.usual)}</td></tr>
              <tr><td>Recorrentes mensais</td><td className="num">{fmt(mine.monthly)}</td></tr>
              {mine.periodic.map((l) => <tr key={l.label + l.date}><td>{l.label} <span className="muted">· dia {dayMonth(l.date)} (não é mensal)</span></td><td className="num">{fmt(l.amount)}</td></tr>)}
            </tbody></table>
            <p className="muted" style={{ fontSize: 12 }}>Cobranças bimestrais, trimestrais e anuais entram só no mês em que caem. Parcelas de cartão já lançadas contam pelo menos o que já está datado no mês.</p>
          </div>)
      }
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
        // Totals: planned is every budget; actual is every expense, with or without a budget.
        const totalB = rows.reduce((s, r) => s + r.b, 0)
        const totalA = cats.reduce((s, c) => s + c.value, 0)
        const unbudgeted = cats.filter((c) => !rows.some((r) => r.name === c.name)).reduce((s, c) => s + c.value, 0)
        const pair = (b: number, a: number) => {
          const top = Math.max(Math.abs(a), Math.abs(b)) || 1
          return <div className="pair">
            <div className="bar b" aria-label={`Orçado ${fmt(b)}`}><div style={{ width: `${(Math.max(0, b) / top) * 100}%` }} /></div>
            <div className="bar a" aria-label={`Realizado ${fmt(a)}`}><div style={{ width: `${(Math.max(0, a) / top) * 100}%` }} /></div>
          </div>
        }
        const amounts = (a: number, b: number, cls = '') => <td className="num" style={{ whiteSpace: 'nowrap' }}>
          <span className={`v-actual ${cls}`}>{fmt(a)}</span>{' / '}<span className="v-budget">{fmt(b)}</span></td>
        return (
          <div className="card"><h3>Orçado x realizado — {period}{selMonths.length > 1 ? ` (orçamento × ${selMonths.length} meses)` : ''}</h3>
            <p className="muted" style={{ fontSize: 12 }}>
              <span className="swatch" style={{ background: 'var(--budget)' }} />Orçado · <span className="swatch" style={{ background: 'var(--actual)' }} />Realizado
              {' '}— <span className="pos">✓</span> até 80% · <span className="warn">⚠</span> 80–100% · <span className="neg">▲</span> acima do orçado
            </p>
            <table><tbody>
              {salary && <tr><td style={{ width: '30%' }}><strong>{salary.name}</strong>
                {salary.missing.length > 0 && <div className="muted" style={{ fontSize: 12 }}>
                  {salary.b ? `sem valor informado em ${salary.missing.map(monthLabel).join(', ')}` : <button className="link" onClick={() => ctx.go('Ajustes', 'Orçamentos')}>informar em Ajustes → Orçamentos</button>}</div>}</td>
                <td>{pair(salary.b, salary.a)}</td>
                {amounts(salary.a, salary.b, salary.b && salary.a < salary.b ? 'neg' : '')}</tr>}
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
            </tbody>
            <tfoot>
              <tr><th style={{ textAlign: 'left' }}>Total despesas
                {unbudgeted > 0.005 && <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>realizado inclui {fmt(unbudgeted)} sem orçamento</div>}</th>
                <td>{pair(totalB, totalA)}</td>
                {amounts(totalA, totalB, totalA > totalB ? 'neg' : '')}</tr>
              {salary && <tr><th style={{ textAlign: 'left' }}>Sobra ({salary.name.toLowerCase()} − despesas)</th>
                <td>{pair(salary.b - totalB, salary.a - totalA)}</td>
                {amounts(salary.a - totalA, salary.b - totalB, salary.a - totalA < 0 ? 'neg' : '')}</tr>}
            </tfoot></table>
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
      <div className="toolbar"><div className="toolbar-group">
        <details className="monthpick">
          <summary aria-label="Meses"><Icon name="calendario" size={17} />{period} ▾</summary>
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
        <AsOf data={data} ids={data.accounts.filter((a) => a.type !== 'card' && shown(a.id)).map((a) => a.id)} onImport={() => ctx.go('Importar')} />
        </div>
        <button className={editing ? 'primary' : ''} onClick={() => setEditing(!editing)}><Icon name="editar" size={16} /> {editing ? 'Pronto' : 'Personalizar painel'}</button>
      </div>
      {editing && (
        <div className="card" style={{ marginBottom: 20 }}><h3>Blocos do painel</h3>
          <p className="muted" style={{ marginTop: -6 }}>Escolha o que aparece e em que ordem.</p>
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
      <div className="row" style={{ marginTop: 20, justifyContent: 'space-between' }}>
        <button onClick={() => ctx.go('Análises')}>Tendências, estabelecimentos e comparações em Análises <Icon name="seta" size={15} /></button>
        <span className="muted" style={{ fontSize: 12 }} title={VERSION.message}>{versionLabel()}</span>
      </div>
    </>
  )
}
