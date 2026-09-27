import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axis, compact, grid, tooltipStyle } from '../../components/charts'
import { monthLabel } from '../../lib/format'
import { today } from '../../lib/hooks'
import { addMonths, groupRows, lastDayOf, movingAverage, trendPct } from '../../domain/explore'
import { linearTrend, cumulative } from '../../domain/trend'
import { isTithe } from '../../domain/categorize'
import { monthWindow } from '../../domain/period'
import { Delta, Spark, Swatch } from './shared'
import { neutralFor, noun, pct, useSort, type ViewProps } from './util'

export function TrendView(p: ViewProps) {
  const { fmt, measure, range, hist, colorOf, ctx } = p
  // A trend needs history: under six months, it looks at the twelve ending with the period.
  const extended = p.months.length < 6
  const tm = useMemo(() => (extended ? monthWindow(range.to.slice(0, 7), 12) : p.months), [extended, p.months, range.to])
  // The running month is still filling up: shown, but left out of the averages and the fitted line.
  const partial = tm.at(-1)! >= today().slice(0, 7) && today() < lastDayOf(tm.at(-1)!)
  const full = partial ? tm.slice(0, -1) : tm

  // Two months before the window too, so the 3-month average starts on the first bar.
  const monthly = useMemo(() => {
    const all = [addMonths(tm[0], -2), addMonths(tm[0], -1), ...tm]
    const idx = new Map(all.map((m, i) => [m, i]))
    const v = all.map(() => 0)
    for (const t of hist) { const i = idx.get(t.month); if (i !== undefined) v[i] += t.amt }
    const known = hist.length ? hist.reduce((m, t) => (t.month < m ? t.month : m), '9999-12') : '9999-12'
    return { v: v.slice(2), before: v.slice(0, 2), hasBefore: known <= all[0] }
  }, [hist, tm])

  const fit = useMemo(() => {
    const vals = monthly.v.slice(0, full.length)
    const line = linearTrend(vals)
    // Without the two months of history before the window, the average waits for three months of its own.
    const ma = monthly.hasBefore ? movingAverage([...monthly.before, ...vals], 3).slice(2) : movingAverage(vals, 3)
    const ahead = [1, 2, 3].map((n) => addMonths(tm.at(-1)!, n))
    const at = (x: number) => (line ? Math.max(0, Math.round(line.intercept + line.slope * x)) : null)
    const data = [...tm, ...ahead].map((m, x) => ({
      label: monthLabel(m) + (partial && m === tm.at(-1) ? '*' : ''),
      valor: x < tm.length ? Math.round(monthly.v[x]) : null,
      media: x < full.length ? (ma[x] === null ? null : Math.round(ma[x]!)) : null,
      tendencia: at(x),
    }))
    const avg = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)
    const last3 = vals.slice(-3).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(3, vals.length))
    return { data, slope: line?.slope ?? 0, rel: trendPct(vals), avg, last3 }
  }, [monthly, tm, full.length, partial])

  // Income, spending and result of the accounts in scope, whatever the category filter.
  const flows = useMemo(() => {
    const idx = new Map(tm.map((m, i) => [m, i]))
    const rows = tm.map((m) => ({ label: monthLabel(m), receitas: 0, despesas: 0, resultado: 0, taxa: null as number | null }))
    for (const t of ctx.etx) {
      const i = idx.get(t.month)
      if (i === undefined || t.kind === 'transfer' || !p.inScope(t.account_id)) continue
      if (t.kind === 'income') rows[i].receitas += t.value
      else rows[i].despesas -= t.value
    }
    for (const r of rows) {
      r.resultado = Math.round(r.receitas - r.despesas)
      r.taxa = r.receitas > 0 ? Math.round(((r.receitas - r.despesas) / r.receitas) * 100) : null
      r.receitas = Math.round(r.receitas); r.despesas = Math.round(r.despesas)
    }
    return rows
  }, [ctx.etx, tm, p.inScope]) // eslint-disable-line react-hooks/exhaustive-deps

  const year = Number(range.to.slice(0, 4))
  const yoy = useMemo(() => {
    const byMonth = new Map<string, number>()
    for (const t of hist) if (t.month.startsWith(String(year)) || t.month.startsWith(String(year - 1))) byMonth.set(t.month, (byMonth.get(t.month) ?? 0) + t.amt)
    const mms = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
    const cur = cumulative(mms.map((mm) => byMonth.get(`${year}-${mm}`) ?? 0))
    const prev = cumulative(mms.map((mm) => byMonth.get(`${year - 1}-${mm}`) ?? 0))
    const end = range.to.slice(0, 7)
    return mms.map((mm, i) => ({ label: monthLabel(`${year}-${mm}`).split(' ')[0], atual: `${year}-${mm}` <= end ? Math.round(cur[i]) : null, anterior: Math.round(prev[i]) }))
  }, [hist, year, range.to])

  const cats = useMemo(() => {
    const inTm = new Set(tm)
    const groups = groupRows(hist.filter((t) => inTm.has(t.month)), (t) => t.categoryName, tm)
    return groups.map((g) => {
      const vals = g.perMonth.slice(0, full.length)
      const avg = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)
      const last = vals.at(-1) ?? 0
      return { key: g.key, total: g.total, avg, last, rel: trendPct(vals) ?? 0, vals: g.perMonth, lastVsAvg: last - avg }
    })
  }, [hist, tm, full.length])
  const { sorted, Th } = useSort(cats, 'total')

  const lastFull = full.at(-1)
  const tip = { ...tooltipStyle, cursor: { fill: 'var(--line)', opacity: 0.4 } }
  const verb = fit.rel === null || Math.abs(fit.rel) < 0.01 ? 'estável' : fit.rel > 0 ? 'subindo' : 'caindo'
  // Filtered down to tithe only: show the chart, no verdict on it.
  const quiet = hist.length > 0 && hist.every((t) => isTithe(t.categoryName))

  return (
    <div className="grid agrid">
      <div className="card wide">
        <h3>{noun(measure)} por mês: média de 3 meses e tendência</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {!quiet && <>
            <strong style={{ color: 'var(--text)' }}>Tendência {verb}</strong>
            {fit.rel !== null && Math.abs(fit.rel) >= 0.01 && <> — {fit.slope > 0 ? '+' : '−'}{fmt(Math.abs(fit.slope))} por mês ({fit.rel > 0 ? '+' : '−'}{pct(Math.abs(fit.rel), 1)} de um mês típico)</>}
            {' · '}
          </>}média dos últimos 3 meses {fmt(fit.last3)} contra {fmt(fit.avg)} no período
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={fit.data}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} formatter={(v) => fmt(Number(v))} /><Legend itemSorter={null} />
            <Bar dataKey="valor" name={noun(measure)} fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
            <Line dataKey="media" name="Média de 3 meses" stroke="var(--s2)" strokeWidth={2} dot={false} connectNulls={false} />
            <Line dataKey="tendencia" name="Tendência (+3 meses)" stroke="var(--muted)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>
          {extended && 'O período escolhido tem menos de 6 meses: a tendência usa os 12 meses que terminam nele. '}
          {partial && '* Mês em curso: aparece, mas fica fora da média e da reta. '}
          A reta tracejada é a que melhor se ajusta aos meses, prolongada 3 meses: é tendência, não previsão.
        </p>
      </div>

      <div className="card">
        <h3>Receitas e despesas</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={flows} barGap={2}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} formatter={(v) => fmt(Number(v))} /><Legend itemSorter={null} />
            <Bar dataKey="receitas" name="Receitas" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
            <Bar dataKey="despesas" name="Despesas" fill="var(--s2)" radius={[4, 4, 0, 0]} maxBarSize={56} />
          </BarChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>Contas do filtro, todas as categorias. Transferências ficam de fora.</p>
      </div>

      <div className="card">
        <h3>Resultado do mês</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={flows}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} formatter={(v, _n, item) => [`${fmt(Number(v))}${item.payload.taxa !== null ? ` · poupança ${item.payload.taxa}%` : ''}`, 'Resultado']} />
            <ReferenceLine y={0} stroke="var(--muted)" />
            <Bar dataKey="resultado" name="Resultado" radius={[4, 4, 0, 0]} maxBarSize={56}>
              {flows.map((r) => <Cell key={r.label} fill={r.resultado >= 0 ? 'var(--pos)' : 'var(--neg)'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>Receitas − despesas. Abaixo de zero: gastou mais do que recebeu. A taxa de poupança está na dica de cada barra.</p>
      </div>

      <div className="card">
        <h3>{noun(measure)} acumulados: {year} x {year - 1}</h3>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={yoy}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} /><Legend itemSorter={null} />
            <Line dataKey="atual" name={String(year)} stroke="var(--s1)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
            <Line dataKey="anterior" name={String(year - 1)} stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 3" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card wide">
        <h3>Tendência por categoria — {monthLabel(tm[0])} a {monthLabel(tm.at(-1)!)}</h3>
        <div className="scroll">
          <table className="tight">
            <thead><tr>
              <Th k="key">Categoria</Th><th>Evolução</th><Th k="total" num>Total</Th><Th k="avg" num>Média/mês</Th>
              <Th k="last" num>{lastFull ? monthLabel(lastFull) : 'Último'}</Th><Th k="lastVsAvg" num>vs média</Th><Th k="rel" num>Tendência/mês</Th>
            </tr></thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.key} className="clickable" onClick={() => p.onCategory(c.key)}>
                  <td><Swatch color={colorOf(c.key)} />{c.key}</td>
                  <td><Spark values={c.vals} color={colorOf(c.key)} /></td>
                  <td className="num">{fmt(c.total)}</td><td className="num">{fmt(c.avg)}</td><td className="num">{fmt(c.last)}</td>
                  <td className="num"><Delta cur={c.last} prev={c.avg} measure={measure} neutral={neutralFor(c.key)} money={fmt} /></td>
                  <td className="num">{Math.abs(c.rel) < 0.01 ? <span className="muted">estável</span> : <span className={neutralFor(c.key) ? 'muted' : (c.rel > 0) === (measure === 'expense') ? 'neg' : 'pos'}>{c.rel > 0 ? '↗ +' : '↘ −'}{pct(Math.abs(c.rel), 1)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>"Tendência/mês": quanto a reta ajustada sobe ou desce por mês, em % do mês típico da categoria. Clique numa linha para o detalhe.</p>
      </div>
    </div>
  )
}

