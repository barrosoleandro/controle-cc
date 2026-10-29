import { Fragment, useCallback, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { buildMonthPlan, nextMonth, recurringExpectations, type ManualLine, type PlanRow } from '../domain/monthPlan'
import { useRecurring } from '../lib/recurring'
import { countryOf } from '../domain/countries'
import { monthLabel } from '../lib/format'
import { currentMonth, hiddenByDefault, last3, today, useFmt } from '../lib/hooks'
import { CategorySelect } from '../components/CategorySelect'
import { Help, Tabs } from '../components/Page'
import { Menu } from './analysis/shared'

/**
 * Current and next month: what is already in (imported, locked), lines added by hand (editable)
 * and what is still expected from the average of the last 3 complete months.
 */
export function Previsao({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, fx } = ctx
  const cur = currentMonth()
  const months = [cur, nextMonth(cur)] as const
  const [month, setMonth] = useState<string>(cur)
  const avgMonths = useMemo(() => last3(), [])

  // Same account menu as Lançamentos: opens on the main account; a card counts with the account that pays it.
  const accounts = useMemo(() => data.accounts.filter((a) => a.type !== 'card'), [data.accounts])
  const [hidden, setHidden] = useState<Set<string>>(() => hiddenByDefault(accounts))
  const shown = useCallback((id: string) => accounts.some((a) => a.id === id) && !hidden.has(id), [accounts, hidden])
  const payerOf = useMemo(() => new Map(data.accounts.filter((a) => a.type === 'card' && a.parent_account_id).map((a) => [a.id, a.parent_account_id!])), [data.accounts])
  const inScope = useCallback((id: string) => shown(id) || (payerOf.has(id) && shown(payerOf.get(id)!)), [shown, payerOf])
  const nShown = accounts.filter((a) => shown(a.id)).length
  const countries = [...new Set(accounts.map((a) => countryOf(a.bank)))]

  const txs = useMemo(() => ctx.etx.filter((t) => inScope(t.account_id)), [ctx.etx, inScope])
  const lines = useMemo(() => data.settings.dashboard?.manualLines ?? [], [data.settings.dashboard?.manualLines])
  const catById = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  // A manual line takes its sign from its category: an income category adds, the rest subtract.
  const manual = useMemo(() => lines.map((l) => {
    const c = catById.get(l.category_id)
    const kind = c?.kind ?? 'expense'
    const v = fx.convert(Math.abs(l.amount), l.currency, ctx.currency, l.date)
    return { line: l, month: l.month, kind, categoryName: c?.name ?? 'Outros', value: kind === 'income' ? v : -v }
  }), [lines, catById, fx, ctx.currency])
  // Recurring expenses (the flag of Lançamentos) not charged yet in the month show as expected lines.
  const { isBill } = useRecurring(ctx)
  const recurring = useMemo(() => recurringExpectations(txs, (m) => isBill({ merchant: m }), avgMonths), [txs, isBill, avgMonths])
  const plans = useMemo(() => months.map((m) => buildMonthPlan(txs, manual, m, avgMonths, recurring)), [txs, manual, months[0], avgMonths, recurring]) // eslint-disable-line react-hooks/exhaustive-deps
  const plan = plans[months.indexOf(month as typeof months[number])] ?? plans[0]

  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (k: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const [erro, setErro] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  async function saveLines(next: ManualLine[]): Promise<boolean> {
    setErro(null)
    try { await ctx.patchSettings({ dashboard: { ...data.settings.dashboard, manualLines: next } }); return true }
    catch (e) { setErro(`Não foi possível salvar: ${(e as Error).message}`); return false }
  }
  const updateLine = (id: string, patch: Partial<ManualLine>) => saveLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  const removeLine = (id: string) => saveLines(lines.filter((l) => l.id !== id))

  // New line form: the date picks the month; the category decides whether it adds or subtracts.
  const firstDay = (m: string) => (m === cur ? today() : `${m}-01`)
  const [novo, setNovo] = useState({ date: firstDay(cur), description: '', category_id: '', amount: 0 })
  const novoMes = novo.date.slice(0, 7)
  const novoCat = catById.get(novo.category_id)
  // Why "Adicionar" is off, said next to it instead of a silent disabled button.
  const falta = !novo.category_id ? 'escolha a categoria'
    : novoCat?.kind === 'transfer' ? 'categoria de transferência não entra na previsão: escolha uma de receita ou despesa'
      : !(novo.amount > 0) ? 'informe um valor maior que zero'
        : !months.includes(novoMes as typeof months[number]) ? `a data tem que ser em ${monthLabel(months[0])} ou ${monthLabel(months[1])}` : null
  async function addLine() {
    if (falta || !novoCat) return
    const line: ManualLine = { id: crypto.randomUUID(), month: novoMes, date: novo.date, description: novo.description.trim() || 'Linha manual', category_id: novo.category_id, amount: novo.amount, currency: ctx.currency }
    if (!(await saveLines([...lines, line]))) return
    // Show where it went: its month, with its category open.
    setMonth(novoMes)
    setOpen((prev) => new Set(prev).add(`${novoMes}/${novoCat.kind}/${novoCat.name}`))
    setOk(`Linha “${line.description}” adicionada em ${novoCat.name}, ${monthLabel(novoMes)}.`)
    setNovo({ ...novo, description: '', amount: 0 })
  }
  /** "+ linha nesta categoria": the line is created right there, with what is still missing, ready to edit. */
  async function addLineIn(row: PlanRow) {
    const c = data.categories.find((x) => x.name === row.name && x.kind === row.kind)
    if (!c) { setErro(`“${row.name}” não é uma categoria cadastrada: use o formulário “Inserir linha” e escolha a categoria.`); return }
    const line: ManualLine = { id: crypto.randomUUID(), month, date: firstDay(month), description: 'Linha manual', category_id: c.id, amount: Math.round(row.falta * 100) / 100, currency: ctx.currency }
    if (await saveLines([...lines, line])) setOk(`Linha adicionada em ${c.name}: ajuste a descrição e o valor na própria linha.`)
  }

  const section = (kind: 'income' | 'expense') => {
    const rows = kind === 'income' ? plan.income : plan.expense
    const t = plan.totals[kind]
    if (!rows.length) return null
    return <>
      <tr className="section"><th colSpan={6}>{kind === 'income' ? 'Receitas' : 'Despesas'}</th></tr>
      {rows.map((r) => {
        const key = `${plan.month}/${kind}/${r.name}`
        const isOpen = open.has(key)
        const auto = txs.filter((x) => x.month === plan.month && x.kind === kind && x.categoryName === r.name).sort((a, b) => a.booking_date.localeCompare(b.booking_date))
        const mine = manual.filter((m) => m.month === plan.month && m.kind === kind && m.categoryName === r.name)
        return (
          <Fragment key={key}>
            <tr>
              <td><button className="link" onClick={() => toggle(key)} aria-expanded={isOpen}>{isOpen ? '▾' : '▸'} {r.name}</button></td>
              <td className="num muted">{fmt(r.media)}</td>
              <td className="num">{fmt(r.realizado)}</td>
              <td className="num">{r.manual ? fmt(r.manual) : <span className="muted">·</span>}</td>
              <td className={`num ${r.falta > 0 ? 'warn' : 'muted'}`} title={r.recorrente ? `inclui ${fmt(r.recorrente)} de recorrentes ainda não lançados` : undefined}>
                {r.falta ? fmt(r.falta) : '·'}{r.pendentes.length > 0 && <span style={{ fontSize: 12 }}> ↻{r.pendentes.length}</span>}</td>
              <td className="num"><strong>{fmt(r.previsto)}</strong></td>
            </tr>
            {isOpen && <>
              {auto.map((x) => (
                <tr key={x.id} className="muted" style={{ fontSize: 13 }}>
                  <td style={{ paddingLeft: 24 }} title="Lançamento importado: não pode ser alterado aqui">🔒 {x.booking_date.slice(8, 10)}/{x.booking_date.slice(5, 7)} · {x.description} <span style={{ fontSize: 12 }}>· {x.accountName}</span></td>
                  <td /><td className="num">{fmt(kind === 'income' ? x.value : -x.value)}</td><td /><td /><td />
                </tr>
              ))}
              {r.pendentes.map((e) => (
                <tr key={`rec/${e.merchant}`} className="muted" style={{ fontSize: 13 }}>
                  <td style={{ paddingLeft: 24 }} title="Recorrente ainda não lançado neste mês: valor pela média dele nos últimos meses">↻ previsto ~{String(e.day).padStart(2, '0')}/{plan.month.slice(5, 7)} · {e.merchant}</td>
                  <td /><td /><td /><td className="num warn">{fmt(e.amount)}</td><td />
                </tr>
              ))}
              {mine.map(({ line: l }) => (
                <tr key={l.id} style={{ fontSize: 13 }}>
                  <td style={{ paddingLeft: 24 }}>
                    <div className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
                      <input type="date" defaultValue={l.date} style={{ width: 140 }} aria-label="Data"
                        onBlur={(e) => { const d = e.target.value; if (d && d !== l.date) updateLine(l.id, { date: d, month: d.slice(0, 7) }) }} />
                      <input defaultValue={l.description} aria-label="Descrição" style={{ minWidth: 140 }}
                        onBlur={(e) => { if (e.target.value !== l.description) updateLine(l.id, { description: e.target.value }) }} />
                      <CategorySelect ctx={ctx} value={l.category_id} label="Categoria" onChange={(id) => updateLine(l.id, { category_id: id })} />
                    </div>
                  </td>
                  <td /><td />
                  <td className="num"><input type="number" min={0} step="any" inputMode="decimal" defaultValue={l.amount} style={{ width: 110 }} aria-label="Valor"
                    onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== l.amount) updateLine(l.id, { amount: v }) }} />
                    {l.currency !== ctx.currency && <span className="muted" style={{ fontSize: 12 }}> {l.currency}</span>}</td>
                  <td /><td><button onClick={() => removeLine(l.id)} aria-label="Excluir linha">✕</button></td>
                </tr>
              ))}
              <tr><td colSpan={6} style={{ paddingLeft: 24 }}><button className="link" style={{ fontSize: 12 }} onClick={() => addLineIn(r)}>+ linha nesta categoria</button></td></tr>
            </>}
          </Fragment>
        )
      })}
      <tr><th>Total {kind === 'income' ? 'das receitas' : 'das despesas'}</th>
        <th className="num muted">{fmt(t.media)}</th><th className="num">{fmt(t.realizado)}</th><th className="num">{fmt(t.manual)}</th>
        <th className="num">{fmt(t.falta)}</th><th className="num">{fmt(t.previsto)}</th></tr>
    </>
  }

  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <Tabs label="Mês" items={months.map((m) => [m, monthLabel(m)] as const)} value={month} onChange={setMonth} />
        <Menu align="right" active={nShown < accounts.length}
          label={nShown === accounts.length ? 'Todas as contas' : nShown === 1 ? accounts.find((a) => shown(a.id))?.name ?? '1 conta' : `${nShown} de ${accounts.length} contas`}>
          <div className="row" style={{ marginBottom: 8 }}>
            {countries.map((c) => <button key={c} onClick={() => setHidden(new Set(accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>)}
            <button onClick={() => setHidden(new Set())}>Todas</button>
          </div>
          <div className="opts">
            {accounts.map((a) => (
              <label key={a.id} className="inline opt"><input type="checkbox" checked={shown(a.id)} onChange={() => setHidden((prev) => {
                const next = new Set(prev); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next
              })} />{a.name} <span className="muted" style={{ fontSize: 12 }}>· {countryOf(a.bank)}</span></label>
            ))}
          </div>
        </Menu>
      </div>
      <div className="kpis">
        {plans.map((p) => (
          <div key={p.month} className={`kpi ${p.month === month ? 'total' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setMonth(p.month)}>
            <div className="l">{monthLabel(p.month)} · resultado previsto</div>
            <div className={`v ${p.resultado < 0 ? 'neg' : 'pos'}`}>{fmt(p.resultado)}</div>
            <div className="sub">receitas {fmt(p.totals.income.previsto)} · despesas {fmt(p.totals.expense.previsto)}</div>
          </div>
        ))}
        <div className="kpi"><div className="l">Ainda falta pagar em {monthLabel(plan.month)}</div><div className="v warn">{fmt(plan.totals.expense.falta)}</div>
          <div className="sub">pela média de {monthLabel(avgMonths[0])} a {monthLabel(avgMonths.at(-1)!)}</div></div>
      </div>
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3 id="nova-linha">Inserir linha</h3>
      <div className="form">
        <label>Data<input type="date" value={novo.date} onChange={(e) => { setNovo((n) => ({ ...n, date: e.target.value })); setOk(null) }} /></label>
        <label>Descrição<input value={novo.description} placeholder="ex.: IPVA, conserto do carro" onChange={(e) => { setNovo((n) => ({ ...n, description: e.target.value })); setOk(null) }} /></label>
        <label>Categoria<CategorySelect ctx={ctx} value={novo.category_id} empty="Escolha…" label="Categoria da linha" onChange={(id) => { setNovo((n) => ({ ...n, category_id: id })); setOk(null) }} /></label>
        <label>Valor ({ctx.currency})<input type="number" min={0} step="any" inputMode="decimal" value={novo.amount || ''} onChange={(e) => { setNovo((n) => ({ ...n, amount: Number(e.target.value) || 0 })); setOk(null) }} /></label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!!falta} onClick={addLine}>Adicionar</button>
        {falta && <span className="muted">Para adicionar: {falta}.</span>}
        {ok && <span className="pos">✔ {ok}</span>}
        {erro && <span className="err">{erro}</span>}
      </div>
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>{monthLabel(plan.month)}</h3>
      <div className="scroll"><table>
        <thead><tr><th>Categoria</th><th className="num">Média 3 meses</th><th className="num">Realizado</th><th className="num">Manual</th><th className="num">Falta</th><th className="num">Previsto</th></tr></thead>
        <tbody>
          {section('income')}
          {section('expense')}
        </tbody>
        <tfoot><tr><th>Resultado previsto</th><th /><th /><th /><th />
          <th className={`num ${plan.resultado < 0 ? 'neg' : 'pos'}`}>{fmt(plan.resultado)}</th></tr></tfoot>
      </table></div>
      {!plan.income.length && !plan.expense.length && <p className="muted">Nada neste mês nem na média das contas marcadas.</p>}
      <Help title="Como ler">
        <p><strong>Média</strong>: dos 3 últimos meses fechados ({monthLabel(avgMonths[0])} a {monthLabel(avgMonths.at(-1)!)}), nas contas marcadas.
          <strong> Realizado</strong>: lançamentos importados no mês (🔒, não mudam aqui). <strong>Manual</strong>: as linhas que você inseriu, que podem ser editadas e excluídas.</p>
        <p><strong>Falta</strong> = média − realizado − manual, nunca abaixo de zero: uma linha manual ocupa o lugar da média em vez de somar a ela.
          <strong> Previsto</strong> = realizado + manual + falta. Transferências entre contas ficam de fora.</p>
        <p><strong>↻ Recorrentes</strong>: cada estabelecimento marcado como recorrente em Lançamentos que ainda não foi lançado no mês aparece como previsto, pela média dele nos meses em que cobrou.
          Na categoria, o que falta é pelo menos a soma desses recorrentes, mesmo que a média da categoria seja menor.</p>
        <p>As linhas manuais valem para qualquer conta marcada. Quando o lançamento de verdade for importado, exclua a linha manual correspondente.</p>
      </Help>
    </div>
  </div>
}
