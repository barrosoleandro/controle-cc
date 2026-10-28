import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { applyRealBase, realBaseChanges, runScenario, savingsProposals, type RealBase, type Scenario } from '../domain/simulation'
import type { Country } from '../domain/tax'
import { byCategory, lastCompleteMonths, monthly } from '../domain/analytics'
import { deleteScenario, saveScenario } from '../lib/data'
import { money } from '../lib/format'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { countryOf } from '../domain/countries'
import { ExplicarIA } from '../components/ExplicarIA'
import { simulationPrompt } from '../domain/localAi'
import { isTithe } from '../domain/categorize'
import { isRescisao } from '../domain/rescisao'

/** Measurement windows offered for the real base, in complete months. */
const WINDOWS = [3, 6, 12]

const HOUSING = ['Moradia', 'Aluguel']
const SCHOOL = ['Educação', 'Frances']
const BRAZIL = ['Imóvel Brasil', 'Cartão Itaú']
const REIMBURSED = ['Business Trips'] // paid back by the employer: not part of the cost of living

/** Índice de custo de vida dos gastos variáveis frente à sua base atual na região de Paris — premissas editáveis. */
const PRESETS: Record<Country, { label: string; col: number; currency: 'EUR' | 'BRL' }> = {
  FR: { label: 'França (região de Paris)', col: 1, currency: 'EUR' },
  PT: { label: 'Portugal (Porto/Lisboa)', col: 0.75, currency: 'EUR' },
  LU: { label: 'Luxemburgo', col: 1.1, currency: 'EUR' },
  BR: { label: 'Brasil (BH/SP)', col: 0.55, currency: 'BRL' },
  CUSTOM: { label: 'Personalizado', col: 1, currency: 'EUR' },
}

type Group = 'rent' | 'school' | 'brazil' | 'variable'
interface Line { name: string; group: Group; value: number }

const groupOf = (name: string): Group =>
  HOUSING.includes(name) ? 'rent' : SCHOOL.includes(name) ? 'school' : BRAZIL.includes(name) ? 'brazil' : 'variable'
const GROUP_LABEL: Record<Group, string> = { rent: 'Moradia', school: 'Escola e filhos', brazil: 'Custos no Brasil', variable: 'Outros gastos (França)' }

/** The real base the scenario receives: the measured lines with the user's edits laid over them. */
function realBaseOf(lines: Line[], edits: Record<string, number>, months: string[]): RealBase {
  const sum = (g: Group) => lines.filter((l) => l.group === g).reduce((t, l) => t + (edits[l.name] ?? l.value), 0)
  return { rent: sum('rent'), school: sum('school'), brazil: sum('brazil'), variable: sum('variable'), months }
}

export function Simulation({ ctx }: { ctx: Ctx }) {
  const { data, fx } = ctx
  const eur = money('EUR')
  // Baseline = last 6 complete months, always in EUR regardless of the display toggle.
  // Living costs come from the French accounts (BCP, CCF): the life being simulated is the
  // one in France. Costs in Brazil are measured on all accounts and kept as their own line.
  const baseFor = useMemo(() => (n: number) => {
    const months = lastCompleteMonths(new Date(), n)
    const set = new Set(months)
    const eurTx = ctx.etx.map((t) => ({ ...t, value: fx.convert(t.amount, t.currency, 'EUR', t.booking_date) }))
    const france = new Set(data.accounts.filter((a) => countryOf(a.bank) === 'França').map((a) => a.id))
    const frTx = france.size ? eurTx.filter((t) => france.has(t.account_id)) : eurTx
    const perMonth = (txs: typeof eurTx) => new Map(byCategory(txs, set).map((c) => [c.name, c.value / n]))
    const fr = perMonth(frTx)
    const all = perMonth(eurTx)
    const sum = (cats: Map<string, number>, names: string[]) => names.reduce((s, n) => s + (cats.get(n) ?? 0), 0)
    const totalFr = [...fr.values()].reduce((s, v) => s + v, 0)
    const rent = sum(fr, HOUSING), school = sum(fr, SCHOOL)
    // Tithe is left out: the scenario charges 10% of its own net income instead of the history.
    const tithe = sum(fr, [...fr.keys()].filter(isTithe))
    const variable = totalFr - rent - school - sum(fr, BRAZIL) - sum(fr, REIMBURSED) - tithe
    const salary = eurTx.filter((t) => t.categoryName === 'Salario' && set.has(t.month)).reduce((s, t) => s + t.value, 0) / n
    const m = monthly(eurTx).filter((x) => set.has(x.month))
    // The averages divide by the whole window, so a month that was never imported pulls them
    // down. Count what is really there: a diluted base must say so, not pass as measured.
    const covered = new Set(eurTx.filter((t) => set.has(t.month)).map((t) => t.month)).size
    const lines: Line[] = [
      ...[...fr].filter(([n]) => !BRAZIL.includes(n) && !REIMBURSED.includes(n) && !isTithe(n)).map(([name, value]) => ({ name, group: groupOf(name), value })),
      ...BRAZIL.filter((n) => (all.get(n) ?? 0) > 0).map((name) => ({ name, group: 'brazil' as Group, value: all.get(name) ?? 0 })),
    ].sort((a, b) => b.value - a.value)
    return { lines, rent, school, brazil: sum(all, BRAZIL), variable, reimbursed: sum(fr, REIMBURSED), total: totalFr, salary, months, covered, income: m.reduce((s, x) => s + x.income, 0) / n }
  }, [ctx.etx, fx, data.accounts])
  // No window chosen at the start: the scenario begins with the 110k salary and no school,
  // and only takes the statements' numbers once a window is picked.
  const [win, setWin] = useState<number | null>(null)
  const [edits, setEdits] = useState<Record<string, number>>({})
  const base = useMemo(() => baseFor(win ?? 6), [baseFor, win])
  /** No statements in the window: refreshing from it would zero the scenario, so it is blocked. */
  const temBase = base.total > 0
  /** Window only partly imported: the averages are real but diluted. */
  const parcial = base.covered > 0 && base.covered < (win ?? 6)
  const lines = base.lines.map((l) => ({ ...l, value: edits[l.name] ?? l.value }))

  const make = (country: Country): Scenario => ({
    name: PRESETS[country].label, country, household: { married: true, children: 2 },
    grossYear: country === 'BR' ? 600000 : 110000, partnerGrossYear: 0, otherIncomeMonth: 0,
    rentMonth: 0, schoolYear: 0, baselineVariableMonth: 0, costOfLivingIndex: PRESETS[country].col,
    extraLines: [],
    savingsReturnPct: 3, inflationPct: 2, years: 10, startingSavings: 0, fxEurBrl: Math.round(fx.latest() * 100) / 100,
  })

  const saved = data.scenarios.filter((s) => !isRescisao(s.data)).map((s) => ({ id: s.id, s: s.data as Scenario }))
  const [s, setS] = useState<Scenario>(() => make('FR'))
  const [editingId, setEditingId] = useState<string | null>(null)
  const r = runScenario(s)
  const loc = money(r.currency)
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) => setS({ ...s, [k]: v })
  const num = (k: keyof Scenario) => ({ type: 'number', value: s[k] as number, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never) })

  const [aviso, setAviso] = useState<string | null>(null)
  const janela = (b = base) => `${b.months[0]} a ${b.months.at(-1)}`

  /** Puts a measured base (with the user's edits) into the scenario and says what moved. */
  function aplicarBase(sc: Scenario, rb: RealBase) {
    const next = applyRealBase(sc, rb)
    const changes = realBaseChanges(sc, next)
    setS(next)
    setAviso(changes.length === 0 ? null
      : `Base de ${rb.months[0]} a ${rb.months.at(-1)} aplicada: ` + changes.map((c) => `${c.label} ${eur(c.from)} → ${eur(c.to)}`).join(' · ')
        + (editingId ? ' — clique em Salvar para guardar no cenário.' : ''))
  }

  function escolherJanela(n: number) {
    if (n === win) { setWin(null); setEdits({}); setAviso(null); return }
    const b = baseFor(n)
    setWin(n); setEdits({})
    if (b.total <= 0) { setAviso(null); return }
    aplicarBase(s, realBaseOf(b.lines, {}, b.months))
  }

  function editarLinha(name: string, value: number) {
    const e = { ...edits, [name]: value }
    setEdits(e)
    aplicarBase(s, realBaseOf(base.lines, e, base.months))
  }

  const compare = [...saved.filter((x) => x.id !== editingId), { id: 'current', s }].map((x) => ({ ...x, r: runScenario(x.s) }))
  const chart = Array.from({ length: Math.max(...compare.map((c) => c.s.years)) }, (_, i) => {
    const row: Record<string, number> = { year: i + 1 }
    compare.forEach((c) => { const p = c.r.projection[i]; if (p) row[c.s.name] = Math.round(c.r.currency === 'BRL' ? p.savingsReal / c.s.fxEurBrl : p.savingsReal) })
    return row
  })

  const nome = (c: { id: string; s: Scenario }) => (c.id === 'current' ? `${c.s.name} (em edição)` : c.s.name)
  /** Facts for the local model: everything here was computed above and is on screen. */
  const aiFacts = () => simulationPrompt({
    moeda: 'EUR',
    base: {
      de: base.months[0], ate: base.months.at(-1) ?? base.months[0],
      moradia: base.rent, escola: base.school, brasil: base.brazil, outros: base.variable, salarioLiquido: base.salary,
    },
    cenario: {
      nome: s.name, pais: PRESETS[s.country].label, moeda: r.currency,
      brutoAno: r.net.grossYear, liquidoMes: r.net.netMonth, aliquota: r.net.effectiveRate,
      rendaMes: r.incomeMonth, moradia: r.expenses.rent, escola: r.expenses.school, outros: r.expenses.variable,
      indiceCustoVida: s.costOfLivingIndex, extras: r.expenses.extras, dizimo: r.expenses.tithe,
      sobraMes: r.surplusMonth, taxaPoupanca: r.savingsRate, anos: s.years, poupancaFinalReal: r.projection.at(-1)?.savingsReal ?? 0,
    },
    comparacao: compare.map((c) => {
      const k = c.r.currency === 'BRL' ? 1 / c.s.fxEurBrl : 1
      return {
        nome: nome(c), rendaMesEur: c.r.incomeMonth * k, custosMesEur: c.r.expenses.total * k,
        sobraMesEur: c.r.surplusMonth * k, taxaPoupanca: c.r.savingsRate,
        poupancaFinalEur: (c.r.projection.at(-1)?.savingsReal ?? 0) * k,
      }
    }),
  })

  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Sua base real {win ? `(últimos ${win} meses, EUR/mês)` : '(escolha um período)'}</h3>
        <div className="row">
          {WINDOWS.map((n) => <button key={n} className={n === win ? 'on' : ''} aria-pressed={n === win} onClick={() => escolherJanela(n)}>{n} meses</button>)}
        </div>
      </div>
      {!win && <p className="muted" style={{ fontSize: 13 }}>
        A simulação começa com salário bruto de 110.000 e escola zerada. Escolha 3, 6 ou 12 meses para trazer
        o que foi gasto de fato, linha por linha, e ajuste os valores que quiser.</p>}
      {aviso && <p className="alert" style={{ display: 'block', fontSize: 13 }}>{aviso}</p>}
      {win && !temBase && <p className="err" style={{ fontSize: 13 }}>Nenhum lançamento em {janela()}: importe os extratos desse período, ou escolha uma janela maior.</p>}
      {win && parcial && <p className="err" style={{ fontSize: 13 }}>Só {base.covered} dos {win} meses de {janela()} têm lançamentos: as médias dividem pela janela inteira, então estão para baixo.</p>}
      {win && temBase && <>
        <p className="muted" style={{ fontSize: 12 }}>
          {janela()}. Média por mês. Moradia, escola e outros gastos vêm das contas da França (BCP e CCF); os custos no Brasil,
          de todas as contas. Business Trips ({eur(base.reimbursed)}/mês) ficam de fora porque são reembolsadas.
          {s.country !== 'FR' && ` No cenário de ${PRESETS[s.country].label}, moradia e escola são estimativas do destino e não mudam.`}
        </p>
        <div className="scroll"><table>
          <thead><tr><th>Linha</th><th>Grupo</th><th className="num">Atual (EUR/mês)</th><th className="num">Ajustado</th></tr></thead>
          <tbody>{base.lines.map((l) => (
            <tr key={l.name}><td>{l.name}</td><td className="muted">{GROUP_LABEL[l.group]}</td>
              <td className="num">{eur(l.value)}</td>
              <td className="num"><input type="number" step={10} style={{ width: 100 }} aria-label={`${l.name} por mês`}
                value={Math.round(edits[l.name] ?? l.value)} onChange={(e) => editarLinha(l.name, Number(e.target.value))} /></td></tr>))}</tbody>
          <tfoot>{(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
            <tr key={g}><td colSpan={3}><strong>{GROUP_LABEL[g]}</strong></td>
              <td className="num"><strong>{eur(lines.filter((l) => l.group === g).reduce((t, l) => t + l.value, 0))}</strong></td></tr>))}</tfoot>
        </table></div>
        <div className="kpis">
          <div className="kpi"><div className="l">Salário líquido recebido</div><div className="v">{eur(base.salary)}</div></div>
          <div className="kpi"><div className="l">Todas as receitas</div><div className="v">{eur(base.income)}</div></div>
        </div>
        <p className="muted">Use o “salário líquido recebido” para calibrar: o modelo da França com o seu bruto real deve chegar perto desse valor.</p>
      </>}
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="row">
        <strong>Cenário</strong>
        <select value={editingId ?? ''} onChange={(e) => { const x = saved.find((y) => y.id === e.target.value); setEditingId(x?.id ?? null); setS(x?.s ?? make('FR')); setAviso(null) }}>
          <option value="">(novo)</option>{saved.map((x) => <option key={x.id} value={x.id}>{x.s.name}</option>)}
        </select>
        {(Object.keys(PRESETS) as Country[]).map((c) => <button key={c} onClick={() => { setEditingId(null); setAviso(null); const n = make(c); setS(win && temBase ? applyRealBase(n, realBaseOf(base.lines, edits, base.months)) : n) }}>{c}</button>)}
      </div>
      <div className="form">
        <label>Nome<input value={s.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>País<select value={s.country} onChange={(e) => { const c = e.target.value as Country; setS({ ...s, country: c, costOfLivingIndex: PRESETS[c].col }) }}>
          {(Object.keys(PRESETS) as Country[]).map((c) => <option key={c} value={c}>{PRESETS[c].label}</option>)}</select></label>
        <label>Seu salário bruto / ano ({PRESETS[s.country].currency})<input {...num('grossYear')} step={1000} /></label>
        <label>Bruto do cônjuge / ano<input {...num('partnerGrossYear')} step={1000} /></label>
        <label className="inline" style={{ alignSelf: 'end' }}><input type="checkbox" checked={s.household.married} onChange={(e) => set('household', { ...s.household, married: e.target.checked })} />Casado / declaração conjunta</label>
        <label>Filhos<input type="number" min={0} value={s.household.children} onChange={(e) => set('household', { ...s.household, children: Number(e.target.value) })} /></label>
        {s.country === 'PT' && <label className="inline" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!s.household.ptIfici} onChange={(e) => set('household', { ...s.household, ptIfici: e.target.checked })} />Regime IFICI 20%</label>}
        {s.country === 'CUSTOM' && <label>Alíquota total %<input type="number" value={(s.household.customEffectiveRate ?? 0.35) * 100} onChange={(e) => set('household', { ...s.household, customEffectiveRate: Number(e.target.value) / 100 })} /></label>}
        <label>Outras receitas líquidas / mês<input {...num('otherIncomeMonth')} /></label>
        <label>Aluguel / mês<input {...num('rentMonth')} step={50} /></label>
        <label>Escola / ano (todos os filhos)<input {...num('schoolYear')} step={500} /></label>
        <label>Base de outros gastos (EUR/mês)<input {...num('baselineVariableMonth')} step={50} /></label>
        <label>Índice de custo de vida<input {...num('costOfLivingIndex')} step={0.05} /></label>
        <label>Rendimento da poupança % / ano<input {...num('savingsReturnPct')} step={0.5} /></label>
        <label>Inflação % / ano<input {...num('inflationPct')} step={0.5} /></label>
        <label>Anos<input {...num('years')} min={1} max={40} /></label>
        <label>Poupança inicial (EUR)<input {...num('startingSavings')} step={1000} /></label>
        <label>EUR→BRL<input {...num('fxEurBrl')} step={0.05} /></label>
      </div>
      <h4>Custos mensais extras</h4>
      {s.extraLines.map((l, i) => (
        <div className="row" key={i}>
          <input value={l.name} onChange={(e) => set('extraLines', s.extraLines.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input type="number" value={l.monthly} onChange={(e) => set('extraLines', s.extraLines.map((x, j) => j === i ? { ...x, monthly: Number(e.target.value) } : x))} />
          <button onClick={() => set('extraLines', s.extraLines.filter((_, j) => j !== i))}>✕</button>
        </div>))}
      <div className="row">
        <button onClick={() => set('extraLines', [...s.extraLines, { name: 'Novo custo', monthly: 0 }])}>+ custo</button>
        <button className="primary" onClick={async () => { await saveScenario(editingId, s.name, s); await ctx.reload() }}>{editingId ? 'Salvar' : 'Salvar como novo'}</button>
        {editingId && <button onClick={async () => { await deleteScenario(editingId); setEditingId(null); await ctx.reload() }}>Excluir</button>}
      </div>
    </div>

    <div className="card"><h3>Resultado — {s.name}</h3>
      <table><tbody>
        <tr><td>Bruto / ano</td><td className="num">{loc(r.net.grossYear)}</td></tr>
        <tr><td>Contribuições sociais</td><td className="num neg">−{loc(r.net.social)}</td></tr>
        <tr><td>Imposto de renda</td><td className="num neg">−{loc(r.net.incomeTax)}</td></tr>
        <tr><td><strong>Líquido / mês (você)</strong></td><td className="num"><strong>{loc(r.net.netMonth)}</strong> ({(r.net.effectiveRate * 100).toFixed(1)}% de descontos no total)</td></tr>
        {r.partnerNet && <tr><td>Líquido / mês (cônjuge)</td><td className="num">{loc(r.partnerNet.netMonth)}</td></tr>}
        <tr><td>Renda da família / mês</td><td className="num pos">{loc(r.incomeMonth)}</td></tr>
        <tr><td>Aluguel</td><td className="num">{loc(r.expenses.rent)}</td></tr>
        <tr><td>Escola</td><td className="num">{loc(r.expenses.school)}</td></tr>
        <tr><td>Outros gastos (× {s.costOfLivingIndex})</td><td className="num">{loc(r.expenses.variable)}</td></tr>
        <tr><td>Dízimo (10% do líquido do mês)</td><td className="num">{loc(r.expenses.tithe)}</td></tr>
        <tr><td>Custos extras</td><td className="num">{loc(r.expenses.extras)}</td></tr>
        <tr><td><strong>Sobra / mês</strong></td><td className={`num ${r.surplusMonth >= 0 ? 'pos' : 'neg'}`}><strong>{loc(r.surplusMonth)}</strong> · {(r.savingsRate * 100).toFixed(0)}% de taxa de poupança</td></tr>
        <tr><td>Poupança após {s.years} anos (em moeda de hoje)</td><td className="num">{loc(r.projection.at(-1)?.savingsReal ?? 0)}</td></tr>
      </tbody></table>
      <p className="muted" style={{ fontSize: 12 }}>{r.net.notes.join(' ')} Modelo simplificado — confirme num simulador de folha local antes de decidir.</p>
    </div>

    <div className="card"><h3>Propostas de economia</h3>
      {savingsProposals(s, r, loc).map((p) => <div key={p.title} style={{ marginBottom: 10 }}><strong>{p.title}</strong><div className="muted" style={{ fontSize: 13 }}>{p.detail}</div></div>)}
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}><h3>Leitura da IA local</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Roda sozinha quando esta tela abre, sobre os números já calculados acima. Mudou uma premissa? O texto sai de cena e o botão volta.
      </p>
      <ExplicarIA build={aiFacts} auto={temBase} label="Ler a simulação com a IA local"
        signature={`${s.name}|${s.country}|${Math.round(r.incomeMonth)}|${Math.round(r.surplusMonth)}|${compare.length}|${base.months[0]}`}
        note="Texto escrito por um modelo local a partir dos números desta tela. As contas são do aplicativo; a leitura é do modelo e pode estar errada — as tabelas são a fonte. O modelo de imposto é simplificado." />
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}><h3>Comparação de cenários (EUR)</h3>
      <div className="scroll"><table>
        <thead><tr><th>Cenário</th><th className="num">Renda líq./mês</th><th className="num">Custos/mês</th><th className="num">Sobra/mês</th><th className="num">Taxa</th><th className="num">Poupança real no fim</th></tr></thead>
        <tbody>{compare.map((c) => { const k = c.r.currency === 'BRL' ? 1 / c.s.fxEurBrl : 1; return (
          <tr key={c.id}><td>{nome(c)}</td>
            <td className="num">{eur(c.r.incomeMonth * k)}</td><td className="num">{eur(c.r.expenses.total * k)}</td>
            <td className={`num ${c.r.surplusMonth >= 0 ? 'pos' : 'neg'}`}>{eur(c.r.surplusMonth * k)}</td>
            <td className="num">{(c.r.savingsRate * 100).toFixed(0)}%</td><td className="num">{eur((c.r.projection.at(-1)?.savingsReal ?? 0) * k)}</td></tr>) })}</tbody>
      </table></div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chart}>
          <CartesianGrid {...grid} /><XAxis dataKey="year" {...axis} tickFormatter={(y) => `A${y}`} /><YAxis {...axis} tickFormatter={compact} width={48} />
          <Tooltip {...tooltipStyle} formatter={(v) => eur(Number(v))} labelFormatter={(y) => `Ano ${y}`} /><Legend />
          {compare.slice(0, 5).map((c, i) => <Line key={c.id} dataKey={c.s.name} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 3 }} />)}
        </LineChart>
      </ResponsiveContainer>
      {compare.length > 5 && <p className="muted">O gráfico mostra os 5 primeiros cenários; a tabela mostra todos.</p>}
    </div>
  </div>
}
