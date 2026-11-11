import { Fragment, useCallback, useMemo, useState } from 'react'
import { payerOf as cardPayers } from '../domain/cards'
import type { Ctx } from '../App'
import { nextMonth, type ManualLine, type PlanRow, type RecurringExpect } from '../domain/monthPlan'
import { applyPlanned, monthEnd, rowKey, salaryAhead, SALARY_FROM_DAY } from '../domain/monthEnd'
import { findSalaryCategory } from '../domain/budget'
import { useMonthPlans, usePlanned } from '../lib/plan'
import { monthLabel } from '../lib/format'
import { currentMonth, hiddenByDefault, today, useBalances, useFmt } from '../lib/hooks'
import { CategorySelect } from '../components/CategorySelect'
import { Help, Tabs } from '../components/Page'
import { AccountMenu } from '../components/AccountMenu'
import { prevMonth } from '../domain/util'

/**
 * Current and next month: what is already in (imported, locked), lines added by hand (editable)
 * and what is still expected from the average of the last 3 complete months.
 */
export function Previsao({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data } = ctx
  const cur = currentMonth()
  const months = [cur, nextMonth(cur)] as const
  const [month, setMonth] = useState<string>(cur)

  // Same account menu as Lançamentos: opens on the main account; a card counts with the account that pays it.
  const accounts = useMemo(() => data.accounts.filter((a) => a.type !== 'card'), [data.accounts])
  const [hidden, setHidden] = useState<Set<string>>(() => hiddenByDefault(accounts))
  const shown = useCallback((id: string) => accounts.some((a) => a.id === id) && !hidden.has(id), [accounts, hidden])
  const payerOf = useMemo(() => cardPayers(data.accounts), [data.accounts])
  const inScope = useCallback((id: string) => shown(id) || (payerOf.has(id) && shown(payerOf.get(id)!)), [shown, payerOf])

  // A transfer with no other side in the user's accounts (a resgate from savings not in the app) is money in or out here.
  // Same rule as the month-end box on Painel: the salary paid at the end of a month is the next month's.
  const salary = findSalaryCategory(data.categories)?.name
  const opts = useMemo(() => ({ salary }), [salary])
  const { txs, lines, manual, plans: appPlans, avgMonths, recurring, periods } = useMonthPlans(ctx, inScope, months, opts)
  // "Falta" typed by the user, per month and category: the same figures the month-end box of Painel uses.
  const mineNow = usePlanned(ctx, months[0]), mineNext = usePlanned(ctx, months[1])
  const plannedNow = mineNow.planned, plannedNext = mineNext.planned
  const plans = useMemo(() => [applyPlanned(appPlans[0], plannedNow), applyPlanned(appPlans[1], plannedNext)], [appPlans, plannedNow, plannedNext])
  /** Day and month a pending recurring line is expected on: the salary of a month comes at the end of the one before. */
  const expectedOn = (e: RecurringExpect, m: string) => {
    const early = e.kind === 'income' && e.categoryName === salary && e.day >= SALARY_FROM_DAY
    return `${String(e.day).padStart(2, '0')}/${(early ? prevMonth(m) : m).slice(5, 7)}`
  }
  // Balance each month is expected to end with: today's balance of the ticked accounts plus what is
  // still to come in, less what is still to go out; the month after starts from there.
  const balances = useBalances(ctx)
  const saldoHoje = balances.filter((b) => shown(b.account.id)).reduce((s, b) => s + b.display, 0)
  const fim = monthEnd(plans[0], saldoHoje, salaryAhead(txs, salary, cur))
  const saldoFim = [fim.saldoFim, fim.saldoFim + plans[1].resultado]
  const catById = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
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

  /** "Falta" of a category typed by hand (null = back to the app's figure). Stored with the manual lines included, as on Painel. */
  async function setFalta(r: PlanRow, v: number | null) {
    setErro(null)
    try { await (plan.month === months[1] ? mineNext : mineNow).setPlanned(rowKey(r), v === null ? null : r.manual + v) }
    catch (e) { setErro(`Não foi possível salvar o ajuste: ${(e as Error).message}`) }
  }

  /** The interval of a recurring line, set by hand (0 = back to the one read from the history). */
  async function setPeriod(merchant: string, months: number) {
    const next = { ...periods }
    if (months > 0) next[merchant] = months; else delete next[merchant]
    setErro(null)
    try { await ctx.patchSettings({ dashboard: { ...data.settings.dashboard, billPeriods: next } }) } catch (e) { setErro(e instanceof Error ? e.message : String(e)) }
  }

  /** "ajustar": the expected recurring line becomes a manual line of the month, ready to edit; it takes the expected one's place. */
  async function adoptRecurring(e: RecurringExpect) {
    const c = data.categories.find((x) => x.name === e.categoryName && x.kind === e.kind)
    if (!c) { setErro(`“${e.categoryName}” não é uma categoria cadastrada: use o formulário “Inserir linha”.`); return }
    const [y, m] = month.split('-').map(Number)
    const day = Math.min(e.day, new Date(y, m, 0).getDate())
    const line: ManualLine = { id: crypto.randomUUID(), month, date: `${month}-${String(day).padStart(2, '0')}`, description: e.merchant, merchant: e.merchant, category_id: c.id, amount: Math.round(e.amount * 100) / 100, currency: ctx.currency }
    if (await saveLines([...lines, line])) setOk(`“${e.merchant}” em ${monthLabel(month)} virou linha editável: ajuste o valor na própria linha.`)
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
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {r.pendentes.length > 0 && <span className="muted" style={{ fontSize: 12 }} title={`inclui ${fmt(r.recorrente)} de recorrentes ainda não lançados`}>↻{r.pendentes.length} </span>}
                <input key={`${key}/${r.falta}`} type="number" min={0} step="any" inputMode="decimal" defaultValue={Math.round(r.falta * 100) / 100}
                  style={{ width: 96, textAlign: 'right', fontWeight: r.faltaApp !== undefined ? 700 : undefined }} className={r.falta > 0 ? 'warn' : 'muted'}
                  aria-label={`Falta em ${r.name}`} title={r.faltaApp !== undefined ? `Ajustado por você; o app calculava ${fmt(r.faltaApp)}` : 'Calculado pelo app; digite outro valor para ajustar'}
                  onBlur={(ev) => { const v = Number(ev.target.value); if (ev.target.value !== '' && Number.isFinite(v) && v >= 0 && Math.abs(v - r.falta) > 0.005) void setFalta(r, v) }} />
                {r.faltaApp !== undefined && <button className="link" style={{ fontSize: 12, marginLeft: 4 }} onClick={() => setFalta(r, null)} aria-label={`Voltar ${r.name} para o cálculo do app`} title={`Voltar para o cálculo do app (${fmt(r.faltaApp)})`}>↺</button>}</td>
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
                  <td style={{ paddingLeft: 24 }} title="Recorrente ainda não lançado neste mês: valor pela média dele nos últimos meses">↻ previsto ~{expectedOn(e, plan.month)} · {e.merchant}{e.period > 1 && <span style={{ fontSize: 12 }}> · {everyLabel(e.period)}</span>}
                    {' '}<button className="link" style={{ fontSize: 12 }} onClick={() => adoptRecurring(e)}>ajustar</button></td>
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
                      <CategorySelect ctx={ctx} value={l.category_id} label="Categoria" onChange={(id) => { updateLine(l.id, { category_id: id }) }} />
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
        <AccountMenu align="right" accounts={accounts} hidden={hidden} onChange={setHidden} />
      </div>
      <div className="kpis">
        {plans.map((p) => (
          <div key={p.month} className={`kpi ${p.month === month ? 'total' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setMonth(p.month)}>
            <div className="l">{monthLabel(p.month)} · resultado previsto</div>
            <div className={`v ${p.resultado < 0 ? 'neg' : 'pos'}`}>{fmt(p.resultado)}</div>
            <div className="sub">receitas {fmt(p.totals.income.previsto)} · despesas {fmt(p.totals.expense.previsto)}</div>
          </div>
        ))}
        <div className="kpi" title="Saldo de hoje das contas marcadas, mais o que ainda entra, menos o que ainda sai neste mês">
          <div className="l">Saldo previsto no fim de {monthLabel(months[0])}</div>
          <div className={`v ${saldoFim[0] < 0 ? 'neg' : ''}`}>{fmt(saldoFim[0])}</div>
          <div className="sub">hoje {fmt(fim.saldoHoje)} · entra {fmt(fim.receitas.estimado)} · sai {fmt(fim.despesas.estimado)}
            {fim.salarioSeguinte > 0 && ` · sem o salário de ${monthLabel(months[1]).split(' ')[0]} já creditado (${fmt(fim.salarioSeguinte)})`}</div>
        </div>
        <div className="kpi" title="Saldo previsto no fim deste mês mais o resultado previsto do mês seguinte">
          <div className="l">Saldo previsto no fim de {monthLabel(months[1])}</div>
          <div className={`v ${saldoFim[1] < 0 ? 'neg' : ''}`}>{fmt(saldoFim[1])}</div>
          <div className="sub">{fmt(saldoFim[0])} {plans[1].resultado < 0 ? '−' : '+'} {fmt(Math.abs(plans[1].resultado))} do resultado do mês</div>
        </div>
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
      {recurring.length > 0 && <details style={{ marginTop: 12 }}>
        <summary><strong>↻ Intervalo dos recorrentes</strong> <span className="muted">· {recurring.filter((e) => e.period > 1).length} não são mensais</span></summary>
        <p className="muted" style={{ fontSize: 13 }}>Lido dos últimos 12 meses pelo espaço entre os pagamentos. Um bimestral só entra como previsto nos meses em que vence, pelo valor cheio. Se o app errou, escolha o intervalo certo.</p>
        <div className="scroll"><table>
          <thead><tr><th>Recorrente</th><th>Categoria</th><th className="num">Valor</th><th>Último</th><th>Próximo</th><th>Intervalo</th></tr></thead>
          <tbody>{[...recurring].sort((a, b) => b.period - a.period || a.merchant.localeCompare(b.merchant)).map((e) => (
            <tr key={`${e.kind}/${e.merchant}`}>
              <td>{e.merchant}</td><td className="muted">{e.categoryName}</td><td className="num">{fmt(e.amount)}</td>
              <td className="muted">{monthLabel(e.lastMonth)}</td><td>{monthLabel(nextDue(e, cur))}</td>
              <td><select aria-label={`Intervalo de ${e.merchant}`} value={e.periodSet ? e.period : 0} onChange={(ev) => setPeriod(e.merchant, Number(ev.target.value))}>
                <option value={0}>Automático ({everyLabel(e.periodSet ? 0 : e.period)})</option>
                {PERIODS.map((n) => <option key={n} value={n}>{everyLabel(n)}</option>)}
              </select></td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>}
      <Help title="Como ler">
        <p><strong>Média</strong>: dos 3 últimos meses fechados ({monthLabel(avgMonths[0])} a {monthLabel(avgMonths.at(-1)!)}), nas contas marcadas.
          <strong> Realizado</strong>: lançamentos importados no mês (🔒, não mudam aqui). <strong>Manual</strong>: as linhas que você inseriu, que podem ser editadas e excluídas.</p>
        <p><strong>Falta</strong> = média − realizado − manual, nunca abaixo de zero: uma linha manual ocupa o lugar da média em vez de somar a ela.
          Você pode digitar outro valor na própria coluna: ele fica em negrito, vale no lugar do cálculo do app (também na caixa de fim de mês do Painel) e o ↺ volta ao cálculo.
          O ajuste é guardado por mês e categoria; se depois você inserir uma linha manual na categoria, ela é descontada dele.
          <strong> Previsto</strong> = realizado + manual + falta. Transferências entre contas suas ficam de fora; uma transferência sem o outro lado em nenhuma conta sua (ex.: resgate de uma poupança que não está no app) entra como <strong>Transferência externa</strong>, receita ou despesa, só no mês em que aconteceu — não entra na média.</p>
        <p><strong>↻ Recorrentes</strong>: cada estabelecimento marcado como recorrente em Lançamentos, e cada receita que entrou nos 3 últimos meses (ex.: salário), aparece como previsto enquanto não for lançado no mês, pela média dos meses em que apareceu.
          O intervalo de cada um (mensal, bimestral, trimestral…) é lido dos últimos 12 meses: um bimestral só aparece nos meses em que vence, pelo valor cheio, e fica fora da média da categoria. Confira e corrija em <strong>Intervalo dos recorrentes</strong>.
          Na categoria, o que falta é pelo menos a soma desses recorrentes, mesmo que a média da categoria seja menor.
          <strong> ajustar</strong> transforma o previsto numa linha manual do mês, com data, descrição e valor editáveis; para um mês em que ele não vai acontecer, ajuste o valor para 0.</p>
        <p><strong>Salário</strong>: o que cai do dia {SALARY_FROM_DAY} em diante conta como receita do mês seguinte (é pago no fim do mês anterior), igual ao Painel.
          Por isso o salário recebido no fim do mês passado aparece no realizado deste mês com a data de lá, e o que ainda vai cair no fim deste mês está na previsão do próximo.</p>
        <p><strong>Saldo previsto no fim do mês</strong> = saldo de hoje das contas marcadas + o que ainda entra − o que ainda sai (as colunas Manual e Falta). O do mês seguinte parte dele e soma o resultado previsto daquele mês.
          Transferências para contas suas que não estão marcadas não entram na conta: se você costuma mandar dinheiro para outra conta, insira uma linha manual ou marque a conta de destino.</p>
        <p>As linhas manuais valem para qualquer conta marcada. Quando o lançamento de verdade for importado, exclua a linha manual correspondente.</p>
      </Help>
    </div>
  </div>
}

const PERIODS = [1, 2, 3, 4, 6, 12]
const everyLabel = (n: number) => (n === 0 ? 'detectado' : n === 1 ? 'mensal' : n === 2 ? 'bimestral' : n === 3 ? 'trimestral' : n === 6 ? 'semestral' : n === 12 ? 'anual' : `a cada ${n} meses`)
/** The next payment not in yet: every `period` months after the latest one, from `from` on. */
function nextDue(e: RecurringExpect, from: string): string {
  let m = e.lastMonth
  do { for (let k = 0; k < Math.max(1, e.period); k++) m = nextMonth(m) } while (m < from)
  return m
}
