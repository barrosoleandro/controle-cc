import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axis, compact, grid, tooltipStyle } from '../../components/charts'
import { bucketOf, bucketsOf, firstSeen, groupRows, movers, perMonth, summarize, totalsBy, type Grain, type Range } from '../../domain/explore'
import { countryOf } from '../../domain/countries'
import { isTithe } from '../../domain/categorize'
import { Delta, Kpi, Swatch } from './shared'
import { bucketLabel, defaultGrain, fullDate, noun, OTHER_COLOR, pct, seriesKeyOf, topWithOther, type ViewProps } from './util'

const GRAINS: [Grain, string][] = [['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês']]
export function Overview(p: ViewProps) {
  const { fmt, measure, range, prevRange, rows, prevRows, hist, colorOf, ctx } = p
  const [grain, setGrain] = useState<Grain>(() => defaultGrain(range))
  const s = useMemo(() => summarize(rows), [rows])
  // Filtered down to tithe only: the numbers stay, the good/bad colors go (the app does not comment on it).
  const quiet = rows.length > 0 && rows.every((t) => isTithe(t.categoryName))
  const ps = useMemo(() => (prevRange ? summarize(prevRows) : null), [prevRows, prevRange])

  // Income and spending of the accounts in scope, whatever the category filter: only shown without one.
  const flows = useMemo(() => {
    const sum = (r: Range | null) => {
      if (!r) return null
      let income = 0, expense = 0
      for (const t of ctx.etx) {
        if (t.kind === 'transfer' || t.booking_date < r.from || t.booking_date > r.to || !p.inScope(t.account_id)) continue
        if (t.kind === 'income') income += t.value
        else expense -= t.value
      }
      return { income, expense, net: income - expense, rate: income > 0 ? (income - expense) / income : null }
    }
    return { cur: sum(range)!, prev: sum(prevRange) }
  }, [ctx.etx, range, prevRange, p.inScope]) // eslint-disable-line react-hooks/exhaustive-deps

  const evo = useMemo(() => {
    const keys = bucketsOf(range, grain)
    const cur = totalsBy(rows, keys, grain)
    const pk = prevRange ? bucketsOf(prevRange, grain) : []
    const prev = totalsBy(prevRows, pk, grain)
    return keys.map((k, i) => ({ label: bucketLabel(k, grain), atual: Math.round(cur[i]), anterior: prevRange && i < pk.length ? Math.round(prev[i]) : null, prevLabel: pk[i] ? bucketLabel(pk[i], grain) : '' }))
  }, [rows, prevRows, range, prevRange, grain])

  const cats = useMemo(() => groupRows(rows, (t) => t.categoryName, p.months), [rows, p.months])
  const merchants = useMemo(() => groupRows(rows, (t) => t.merchant, p.months), [rows, p.months])

  // Composition: one stacked bar per month (per week under two months), categories in their color order.
  const comp = useMemo(() => {
    const g: Grain = p.months.length >= 2 ? 'month' : 'week'
    const keys = bucketsOf(range, g)
    const idx = new Map(keys.map((k, i) => [k, i]))
    const keyOf = seriesKeyOf(colorOf)
    const data = keys.map((k) => ({ label: bucketLabel(k, g) }) as Record<string, number | string>)
    const present = new Set<string>()
    for (const t of rows) {
      const i = idx.get(bucketOf(t.booking_date, g))
      if (i === undefined) continue
      const sk = keyOf(t.categoryName)
      present.add(sk)
      data[i][sk] = ((data[i][sk] as number) ?? 0) + t.amt
    }
    for (const d of data) for (const k of Object.keys(d)) if (k !== 'label') d[k] = Math.round(d[k] as number)
    const order = [...cats.map((c) => keyOf(c.key)), 'Outros'].filter((k, i, a) => present.has(k) && a.indexOf(k) === i)
    // Stack in color order (the order the palette was validated for adjacent segments).
    order.sort((a, b) => (a === 'Outros' ? 1 : b === 'Outros' ? -1 : 0) || slotOf(colorOf(a)) - slotOf(colorOf(b)))
    return { data, order }
  }, [rows, range, p.months, cats, colorOf])

  const moved = useMemo(() => {
    if (!prevRange) return null
    const m = movers(cats, groupRows(prevRows, (t) => t.categoryName, [])).filter((x) => !isTithe(x.key))
    return { up: m.filter((x) => x.delta > 0).slice(0, 5), down: m.filter((x) => x.delta < 0).reverse().slice(0, 5) }
  }, [cats, prevRows, prevRange])

  const fresh = useMemo(() => {
    const first = firstSeen(hist, (t) => t.merchant)
    return merchants.filter((m) => (first.get(m.key) ?? '') >= range.from && m.total > 0)
  }, [hist, merchants, range.from])

  const countries = useMemo(() => {
    const acc = new Map(ctx.data.accounts.map((a) => [a.id, countryOf(a.bank)]))
    return groupRows(rows, (t) => acc.get(t.account_id) ?? 'Outro', [])
  }, [rows, ctx.data.accounts])

  const total = s.total || 1
  const label = noun(measure)
  const catList = topWithOther(cats, 8)
  const merchList = merchants.slice(0, 8)
  const tip = { ...tooltipStyle, cursor: { fill: 'var(--line)', opacity: 0.4 } }

  return (
    <div className="grid agrid">
      <div className="card wide">
        <div className="kpis">
          <Kpi label={`${label} no período`} value={fmt(s.total)} sub={<Delta cur={s.total} prev={ps?.total ?? null} measure={measure} neutral={quiet} money={fmt} />} />
          <Kpi label="Média por mês" value={fmt(perMonth(s.total, range))} sub={prevRange ? <Delta cur={perMonth(s.total, range)} prev={ps ? perMonth(ps.total, prevRange) : null} measure={measure} neutral={quiet} money={fmt} /> : undefined} />
          <Kpi label="Lançamentos" value={s.count.toLocaleString('pt-BR')} sub={ps ? <span className="muted">antes {ps.count}</span> : undefined} />
          <Kpi label="Valor médio" value={fmt(s.avgTicket)} sub={<Delta cur={s.avgTicket} prev={ps?.avgTicket ?? null} measure={measure} neutral={quiet} money={fmt} />} />
          <Kpi label="Maior lançamento" value={s.top ? fmt(s.top.amt) : '—'} sub={s.top ? <button className="link" onClick={() => p.onMerchant(s.top!.merchant)}>{s.top.merchant} · {fullDate(s.top.day)}</button> : undefined} />
        </div>
        {p.unfiltered && (
          <div className="kpis" style={{ marginTop: 12 }}>
            <Kpi label="Receitas" value={fmt(flows.cur.income)} cls="pos" sub={<Delta cur={flows.cur.income} prev={flows.prev?.income ?? null} measure="income" />} />
            <Kpi label="Despesas" value={fmt(flows.cur.expense)} cls="neg" sub={<Delta cur={flows.cur.expense} prev={flows.prev?.expense ?? null} measure="expense" />} />
            <Kpi label="Resultado" value={fmt(flows.cur.net)} cls={flows.cur.net >= 0 ? 'pos' : 'neg'} sub={flows.prev ? <span className="muted">antes {fmt(flows.prev.net)}</span> : undefined} />
            <Kpi label="Taxa de poupança" value={flows.cur.rate === null ? '—' : pct(flows.cur.rate)} sub={flows.prev?.rate != null ? <span className="muted">antes {pct(flows.prev.rate)}</span> : <span className="muted">resultado ÷ receitas</span>} />
          </div>
        )}
      </div>

      <div className="card wide">
        <div className="card-head">
          <h3>{label} ao longo do período{prevRange ? ' x comparação' : ''}</h3>
          <div className="seg" role="group" aria-label="Agrupar por">
            {GRAINS.map(([g, l]) => <button key={g} className={grain === g ? 'on' : ''} aria-pressed={grain === g} onClick={() => setGrain(g)}>{l}</button>)}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={evo}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={12} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} formatter={(v, name, item) => [fmt(Number(v)), name === 'anterior' ? `Comparação (${item.payload.prevLabel})` : 'Período']} />
            <Bar dataKey="atual" name="Período" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
            {prevRange && <Line dataKey="anterior" name="Comparação" stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} />}
            {prevRange && <Legend itemSorter={null} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h3>Por categoria</h3>
        {catList.length === 0 && <p className="muted">Nada no período.</p>}
        <table className="tight"><tbody>
          {catList.map((c) => (
            <tr key={c.key} className={'other' in c ? '' : 'clickable'} onClick={'other' in c ? undefined : () => p.onCategory(c.key)}>
              <td style={{ width: '38%' }}><Swatch color={'other' in c ? OTHER_COLOR : colorOf(c.key)} />{c.key}</td>
              <td style={{ width: '32%', verticalAlign: 'middle' }}><div className="bar"><div style={{ width: `${Math.max(0, c.total / (catList[0]?.total || 1)) * 100}%`, background: 'other' in c ? OTHER_COLOR : colorOf(c.key) }} /></div></td>
              <td className="num">{fmt(c.total)}</td><td className="num muted">{pct(c.total / total)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>

      <div className="card">
        <h3>Principais estabelecimentos</h3>
        {merchList.length === 0 && <p className="muted">Nada no período.</p>}
        <table className="tight"><tbody>
          {merchList.map((m) => (
            <tr key={m.key} className="clickable" onClick={() => p.onMerchant(m.key)}>
              <td>{m.key}<div className="muted" style={{ fontSize: 12 }}>{m.category} · {m.count}×</div></td>
              <td className="num">{fmt(m.total)}</td><td className="num muted">{pct(m.total / total)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>

      {comp.order.length > 1 && (
        <div className="card wide">
          <h3>Composição por categoria</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={comp.data}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tip} formatter={(v) => fmt(Number(v))} itemSorter={(i) => -Number(i.value)} />
              <Legend itemSorter={null} />
              {comp.order.map((k, i) => (
                <Bar key={k} dataKey={k} name={k} stackId="c" fill={k === 'Outros' ? OTHER_COLOR : colorOf(k)} stroke="var(--card)" strokeWidth={1}
                  radius={i === comp.order.length - 1 ? [4, 4, 0, 0] : undefined} maxBarSize={56} cursor={k === 'Outros' ? undefined : 'pointer'}
                  onClick={k === 'Outros' ? undefined : () => p.onCategory(k)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12 }}>As 7 maiores categorias do histórico têm cor fixa; as demais somam em "Outros". Clique numa cor para ver a categoria.</p>
        </div>
      )}

      {moved && (
        <div className="card">
          <h3>O que mais mudou (por categoria)</h3>
          {moved.up.length + moved.down.length === 0 && <p className="muted">Sem mudanças relevantes.</p>}
          <table className="tight"><tbody>
            {[...moved.up, ...moved.down].map((m) => (
              <tr key={m.key} className="clickable" onClick={() => p.onCategory(m.key)}>
                <td>{m.key}<div className="muted" style={{ fontSize: 12 }}>{fmt(m.prev)} → {fmt(m.cur)}</div></td>
                <td className="num"><Delta cur={m.cur} prev={m.prev} measure={measure} /></td>
                <td className="num">{m.delta > 0 ? '+' : '−'}{fmt(Math.abs(m.delta))}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}

      <div className="card">
        <h3>Estabelecimentos novos no período</h3>
        {fresh.length === 0 ? <p className="muted">Nenhum: todos já apareciam antes.</p> : (
          <>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{fresh.length} novo(s), somando {fmt(fresh.reduce((x, m) => x + m.total, 0))}.</p>
            <table className="tight"><tbody>
              {fresh.slice(0, 6).map((m) => (
                <tr key={m.key} className="clickable" onClick={() => p.onMerchant(m.key)}>
                  <td>{m.key}<div className="muted" style={{ fontSize: 12 }}>{m.category} · desde {fullDate(m.first)}</div></td>
                  <td className="num">{fmt(m.total)}</td>
                </tr>
              ))}
            </tbody></table>
          </>
        )}
      </div>

      {countries.length > 1 && (
        <div className="card">
          <h3>Por país</h3>
          <table className="tight"><tbody>
            {countries.map((c) => (
              <tr key={c.key}><td>{c.key}</td>
                <td style={{ width: '40%', verticalAlign: 'middle' }}><div className="bar"><div style={{ width: `${Math.max(0, c.total / (countries[0].total || 1)) * 100}%` }} /></div></td>
                <td className="num">{fmt(c.total)}</td><td className="num muted">{pct(c.total / total)}</td></tr>
            ))}
          </tbody></table>
          <p className="muted" style={{ fontSize: 12 }}>Pelo banco da conta: Itaú = Brasil, BCP e CCF = França, Millennium = Portugal.</p>
        </div>
      )}
    </div>
  )
}

/** Position of a series color in the palette (var(--s3) → 3), to stack in validated order. */
const slotOf = (color: string) => Number(/--s(\d)/.exec(color)?.[1] ?? 99)
