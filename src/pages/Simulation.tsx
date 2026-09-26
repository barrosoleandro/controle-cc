import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { runScenario, savingsProposals, type Scenario } from '../domain/simulation'
import type { Country } from '../domain/tax'
import { byCategory, lastCompleteMonths, monthly } from '../domain/analytics'
import { deleteScenario, saveScenario } from '../lib/data'
import { money } from '../lib/format'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'

const HOUSING = ['Aluguel']
const SCHOOL = ['Educação', 'Preply', 'Sodexo', 'Aquasport']
const BRAZIL = ['Imóvel Brasil', 'Cartão Itaú']

/** Índice de custo de vida dos gastos variáveis frente à sua base atual na região de Paris — premissas editáveis. */
const PRESETS: Record<Country, { label: string; col: number; currency: 'EUR' | 'BRL' }> = {
  FR: { label: 'França (região de Paris)', col: 1, currency: 'EUR' },
  PT: { label: 'Portugal (Porto/Lisboa)', col: 0.75, currency: 'EUR' },
  LU: { label: 'Luxemburgo', col: 1.1, currency: 'EUR' },
  BR: { label: 'Brasil (BH/SP)', col: 0.55, currency: 'BRL' },
  CUSTOM: { label: 'Personalizado', col: 1, currency: 'EUR' },
}

export function Simulation({ ctx }: { ctx: Ctx }) {
  const { data, fx } = ctx
  const eur = money('EUR')
  // Baseline = last 6 complete months, always in EUR regardless of the display toggle.
  const base = useMemo(() => {
    const months = lastCompleteMonths(new Date(), 6)
    const set = new Set(months)
    const eurTx = ctx.etx.map((t) => ({ ...t, value: fx.convert(t.amount, t.currency, 'EUR', t.booking_date) }))
    const cats = new Map(byCategory(eurTx, set).map((c) => [c.name, c.value / 6]))
    const sum = (names: string[]) => names.reduce((s, n) => s + (cats.get(n) ?? 0), 0)
    const total = [...cats.values()].reduce((s, v) => s + v, 0)
    const salary = eurTx.filter((t) => t.categoryName === 'Salario' && set.has(t.month)).reduce((s, t) => s + t.value, 0) / 6
    const m = monthly(eurTx).filter((x) => set.has(x.month))
    return { rent: sum(HOUSING), school: sum(SCHOOL), brazil: sum(BRAZIL), variable: total - sum(HOUSING) - sum(SCHOOL) - sum(BRAZIL), total, salary, months, income: m.reduce((s, x) => s + x.income, 0) / 6 }
  }, [ctx.etx, fx])

  const make = (country: Country): Scenario => ({
    name: PRESETS[country].label, country, household: { married: true, children: 2 },
    grossYear: country === 'BR' ? 600000 : 150000, partnerGrossYear: 0, otherIncomeMonth: 0,
    rentMonth: country === 'FR' ? Math.round(base.rent) : 0, schoolYear: country === 'FR' ? Math.round(base.school * 12) : 0,
    baselineVariableMonth: Math.round(base.variable), costOfLivingIndex: PRESETS[country].col,
    extraLines: base.brazil > 0 && country !== 'BR' ? [{ name: 'Custos Brasil (imóvel, cartão)', monthly: Math.round(base.brazil) }] : [],
    savingsReturnPct: 3, inflationPct: 2, years: 10, startingSavings: 0, fxEurBrl: Math.round(fx.latest() * 100) / 100,
  })

  const saved = data.scenarios.map((s) => ({ id: s.id, s: s.data as Scenario }))
  const [s, setS] = useState<Scenario>(() => saved[0]?.s ?? make('FR'))
  const [editingId, setEditingId] = useState<string | null>(saved[0]?.id ?? null)
  const r = runScenario(s)
  const loc = money(r.currency)
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) => setS({ ...s, [k]: v })
  const num = (k: keyof Scenario) => ({ type: 'number', value: s[k] as number, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never) })

  const compare = [...saved.filter((x) => x.id !== editingId), { id: 'current', s }].map((x) => ({ ...x, r: runScenario(x.s) }))
  const chart = Array.from({ length: Math.max(...compare.map((c) => c.s.years)) }, (_, i) => {
    const row: Record<string, number> = { year: i + 1 }
    compare.forEach((c) => { const p = c.r.projection[i]; if (p) row[c.s.name] = Math.round(c.r.currency === 'BRL' ? p.savingsReal / c.s.fxEurBrl : p.savingsReal) })
    return row
  })

  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Sua base real (últimos 6 meses, EUR/mês)</h3>
      <div className="kpis">
        <div className="kpi"><div className="l">Salário líquido recebido</div><div className="v">{eur(base.salary)}</div></div>
        <div className="kpi"><div className="l">Todas as receitas</div><div className="v">{eur(base.income)}</div></div>
        <div className="kpi"><div className="l">Aluguel</div><div className="v">{eur(base.rent)}</div></div>
        <div className="kpi"><div className="l">Escola e filhos</div><div className="v">{eur(base.school)}</div></div>
        <div className="kpi"><div className="l">Custos no Brasil</div><div className="v">{eur(base.brazil)}</div></div>
        <div className="kpi"><div className="l">Outros gastos</div><div className="v">{eur(base.variable)}</div></div>
      </div>
      <p className="muted">Use o “salário líquido recebido” para calibrar: o modelo da França com o seu bruto real deve chegar perto desse valor.</p>
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="row">
        <strong>Cenário</strong>
        <select value={editingId ?? ''} onChange={(e) => { const x = saved.find((y) => y.id === e.target.value); setEditingId(x?.id ?? null); setS(x?.s ?? make('FR')) }}>
          <option value="">(novo)</option>{saved.map((x) => <option key={x.id} value={x.id}>{x.s.name}</option>)}
        </select>
        {(Object.keys(PRESETS) as Country[]).map((c) => <button key={c} onClick={() => { setEditingId(null); setS(make(c)) }}>{c}</button>)}
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
        <tr><td>Custos extras</td><td className="num">{loc(r.expenses.extras)}</td></tr>
        <tr><td><strong>Sobra / mês</strong></td><td className={`num ${r.surplusMonth >= 0 ? 'pos' : 'neg'}`}><strong>{loc(r.surplusMonth)}</strong> · {(r.savingsRate * 100).toFixed(0)}% de taxa de poupança</td></tr>
        <tr><td>Poupança após {s.years} anos (em moeda de hoje)</td><td className="num">{loc(r.projection.at(-1)?.savingsReal ?? 0)}</td></tr>
      </tbody></table>
      <p className="muted" style={{ fontSize: 12 }}>{r.net.notes.join(' ')} Modelo simplificado — confirme num simulador de folha local antes de decidir.</p>
    </div>

    <div className="card"><h3>Propostas de economia</h3>
      {savingsProposals(s, r, loc).map((p) => <div key={p.title} style={{ marginBottom: 10 }}><strong>{p.title}</strong><div className="muted" style={{ fontSize: 13 }}>{p.detail}</div></div>)}
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}><h3>Comparação de cenários (EUR)</h3>
      <div className="scroll"><table>
        <thead><tr><th>Cenário</th><th className="num">Renda líq./mês</th><th className="num">Custos/mês</th><th className="num">Sobra/mês</th><th className="num">Taxa</th><th className="num">Poupança real no fim</th></tr></thead>
        <tbody>{compare.map((c) => { const k = c.r.currency === 'BRL' ? 1 / c.s.fxEurBrl : 1; return (
          <tr key={c.id}><td>{c.id === 'current' ? `${c.s.name} (em edição)` : c.s.name}</td>
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
