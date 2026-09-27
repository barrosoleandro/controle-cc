import { useEffect, useMemo, useRef } from 'react'
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axis, compact, grid, tooltipStyle } from '../../components/charts'
import { bucketsOf, groupRows, perMonth, totalsBy, type Grain } from '../../domain/explore'
import { Delta, Spark, Swatch } from './shared'
import { bucketLabel, cadence, neutralFor, pct, useSort, type ViewProps } from './util'

export function CategoriesView(p: ViewProps) {
  const { fmt, measure, range, prevRange, rows, prevRows, colorOf, months, focus } = p
  const groups = useMemo(() => groupRows(rows, (t) => t.categoryName, months), [rows, months])
  const prev = useMemo(() => new Map(groupRows(prevRows, (t) => t.categoryName, []).map((g) => [g.key, g.total])), [prevRows])
  const total = groups.reduce((s, g) => s + g.total, 0) || 1
  const table = useMemo(() => groups.map((g) => ({
    ...g, share: g.total / total, avgTicket: g.count ? g.total / g.count : 0, monthly: perMonth(g.total, range),
    prev: prevRange ? prev.get(g.key) ?? 0 : null, delta: g.total - (prev.get(g.key) ?? 0),
  })), [groups, total, range, prev, prevRange])
  const { sorted, Th } = useSort(table, 'total')

  return (
    <div className="grid agrid">
      {focus && <CategoryDetail {...p} key={focus} />}
      <div className="card wide">
        <h3>Categorias no período</h3>
        {table.length === 0 ? <p className="muted">Nada no período.</p> : (
          <div className="scroll">
            <table className="tight">
              <thead><tr>
                <Th k="key">Categoria</Th><Th k="total" num>Total</Th><Th k="share" num>%</Th><Th k="count" num>Lanç.</Th>
                <Th k="avgTicket" num>Valor médio</Th><Th k="monthly" num>Média/mês</Th>
                {prevRange && <Th k="delta" num>vs comparação</Th>}
                {months.length > 1 && <th>Evolução</th>}
              </tr></thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.key} className={`clickable ${focus === c.key ? 'sel' : ''}`} onClick={() => p.setFocus(focus === c.key ? '' : c.key)}>
                    <td><Swatch color={colorOf(c.key)} />{c.key}</td>
                    <td className="num">{fmt(c.total)}</td><td className="num muted">{pct(c.share, 1)}</td><td className="num">{c.count}</td>
                    <td className="num">{fmt(c.avgTicket)}</td><td className="num">{fmt(c.monthly)}</td>
                    {prevRange && <td className="num"><Delta cur={c.total} prev={c.prev} measure={measure} neutral={neutralFor(c.key)} money={fmt} /></td>}
                    {months.length > 1 && <td><Spark values={c.perMonth} color={colorOf(c.key)} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12 }}>Clique numa categoria para ver o detalhe: mês a mês e os estabelecimentos dentro dela.</p>
      </div>
    </div>
  )
}

function CategoryDetail(p: ViewProps) {
  const { fmt, measure, range, prevRange, rows, prevRows, colorOf, months, focus } = p
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  const mine = useMemo(() => rows.filter((t) => t.categoryName === focus), [rows, focus])
  const before = useMemo(() => prevRows.filter((t) => t.categoryName === focus), [prevRows, focus])
  const total = mine.reduce((s, t) => s + t.amt, 0)
  const prevTotal = before.reduce((s, t) => s + t.amt, 0)
  const grain: Grain = months.length >= 2 ? 'month' : 'week'
  const chart = useMemo(() => {
    const keys = bucketsOf(range, grain)
    const v = totalsBy(mine, keys, grain)
    return keys.map((k, i) => ({ label: bucketLabel(k, grain), valor: Math.round(v[i]) }))
  }, [mine, range, grain])
  const avg = chart.reduce((s, r) => s + r.valor, 0) / Math.max(1, chart.length)
  const merchants = useMemo(() => groupRows(mine, (t) => t.merchant, months), [mine, months])
  const prevM = useMemo(() => new Map(groupRows(before, (t) => t.merchant, []).map((g) => [g.key, g.total])), [before])

  return (
    <div className="card wide detail" ref={ref}>
      <div className="card-head">
        <h3><Swatch color={colorOf(focus)} />{focus}</h3>
        <div className="row" style={{ margin: 0 }}>
          <button onClick={() => p.filterCategory(focus)}>Filtrar a página por esta categoria</button>
          <button className="icon-btn" aria-label="Fechar detalhe" onClick={() => p.setFocus('')}>✕</button>
        </div>
      </div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <div className="kpi"><div className="l">Total</div><div className="v">{fmt(total)}</div><div className="d"><Delta cur={total} prev={prevRange ? prevTotal : null} measure={measure} neutral={neutralFor(focus)} money={fmt} /></div></div>
        <div className="kpi"><div className="l">Média por mês</div><div className="v">{fmt(perMonth(total, range))}</div></div>
        <div className="kpi"><div className="l">Lançamentos</div><div className="v">{mine.filter((t) => t.amt > 0).length}</div></div>
        <div className="kpi"><div className="l">Estabelecimentos</div><div className="v">{merchants.length}</div></div>
      </div>
      <div className="grid agrid">
        <div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chart}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--line)', opacity: 0.4 }} formatter={(v) => fmt(Number(v))} />
              <ReferenceLine y={avg} stroke="var(--muted)" strokeDasharray="4 3" label={{ value: `média ${fmt(avg)}`, position: 'insideTopRight', fill: 'var(--muted)', fontSize: 11 }} />
              <Bar dataKey="valor" name={focus} fill={colorOf(focus)} radius={[4, 4, 0, 0]} maxBarSize={56} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="scroll" style={{ maxHeight: 260 }}>
          <table className="tight">
            <thead><tr><th>Estabelecimento</th><th className="num">Total</th><th className="num">%</th><th className="num">#</th><th className="num">Frequência</th>{prevRange && <th className="num">vs comp.</th>}</tr></thead>
            <tbody>
              {merchants.map((m) => (
                <tr key={m.key} className="clickable" onClick={() => p.onMerchant(m.key)}>
                  <td>{m.key}</td><td className="num">{fmt(m.total)}</td><td className="num muted">{pct(m.total / (total || 1))}</td>
                  <td className="num">{m.count}</td><td className="num muted">{cadence(m.every)}</td>
                  {prevRange && <td className="num"><Delta cur={m.total} prev={prevM.get(m.key) ?? 0} measure={measure} neutral={neutralFor(focus)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
