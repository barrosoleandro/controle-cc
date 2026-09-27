import { useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { axis, compact, grid, tooltipStyle } from '../../components/charts'
import { monthLabel } from '../../lib/format'
import { addMonths, countForShare, firstSeen, groupRows, monthsOf, perMonth } from '../../domain/explore'
import { Delta, Kpi, Spark } from './shared'
import { cadence, fullDate, neutralFor, pct, useSort, type ViewProps } from './util'

const PAGE = 50

export function MerchantsView(p: ViewProps) {
  const { fmt, measure, rows, prevRows, hist, months, range, prevRange, focus } = p
  const [limit, setLimit] = useState(PAGE)
  const groups = useMemo(() => groupRows(rows, (t) => t.merchant, months), [rows, months])
  const prev = useMemo(() => new Map(groupRows(prevRows, (t) => t.merchant, []).map((g) => [g.key, g.total])), [prevRows])
  const first = useMemo(() => firstSeen(hist, (t) => t.merchant), [hist])
  const total = groups.reduce((s, g) => s + g.total, 0) || 1
  const table = useMemo(() => groups.map((g) => ({
    ...g, share: g.total / total, avgTicket: g.count ? g.total / g.count : 0, isNew: (first.get(g.key) ?? '') >= range.from,
    prev: prevRange ? prev.get(g.key) ?? 0 : null, delta: g.total - (prev.get(g.key) ?? 0), everyN: g.every ?? 9999,
  })), [groups, total, first, range.from, prev, prevRange])
  const { sorted, Th } = useSort(table, 'total')
  const top10 = groups.slice(0, 10).reduce((s, g) => s + Math.max(0, g.total), 0) / total
  const fresh = table.filter((m) => m.isNew)

  return (
    <div className="grid agrid">
      <div className="card wide">
        <div className="kpis">
          <Kpi label="Estabelecimentos" value={groups.length} />
          <Kpi label="Os 10 maiores" value={pct(Math.min(1, top10))} sub={<span className="muted">do total do período</span>} />
          <Kpi label="80% do total em" value={`${countForShare(groups, 0.8)} estab.`} sub={<span className="muted">quanto menor, mais concentrado</span>} />
          <Kpi label="Novos no período" value={fresh.length} sub={<span className="muted">{fmt(fresh.reduce((s, m) => s + m.total, 0))}</span>} />
        </div>
      </div>
      {focus && <MerchantDetail {...p} key={focus} />}
      <div className="card wide">
        <h3>Estabelecimentos no período</h3>
        {table.length === 0 ? <p className="muted">Nada no período.</p> : (
          <div className="scroll">
            <table className="tight">
              <thead><tr>
                <Th k="key">Estabelecimento</Th><Th k="category">Categoria</Th><Th k="total" num>Total</Th><Th k="share" num>%</Th>
                <Th k="count" num>Compras</Th><Th k="avgTicket" num>Valor médio</Th><Th k="everyN" num>Frequência</Th><Th k="last" num>Última</Th>
                {prevRange && <Th k="delta" num>vs comparação</Th>}
                {months.length > 1 && <th>Evolução</th>}
              </tr></thead>
              <tbody>
                {sorted.slice(0, limit).map((m) => (
                  <tr key={m.key} className={`clickable ${focus === m.key ? 'sel' : ''}`} onClick={() => p.setFocus(focus === m.key ? '' : m.key)}>
                    <td>{m.key} {m.isNew && <span className="badge b-new">novo</span>}</td>
                    <td className="muted">{m.category}</td>
                    <td className="num">{fmt(m.total)}</td><td className="num muted">{pct(m.share, 1)}</td><td className="num">{m.count}</td>
                    <td className="num">{fmt(m.avgTicket)}</td><td className="num muted">{cadence(m.every)}</td><td className="num">{fullDate(m.last)}</td>
                    {prevRange && <td className="num"><Delta cur={m.total} prev={m.prev} measure={measure} neutral={neutralFor(m.category)} money={fmt} /></td>}
                    {months.length > 1 && <td><Spark values={m.perMonth} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sorted.length > limit && <button style={{ marginTop: 8 }} onClick={() => setLimit(limit + PAGE * 4)}>Mostrar mais ({sorted.length - limit})</button>}
        <p className="muted" style={{ fontSize: 12 }}>"Novo": primeira compra do histórico dentro do período. "Frequência": intervalo típico entre compras. Clique numa linha para o histórico completo.</p>
      </div>
    </div>
  )
}

function MerchantDetail(p: ViewProps) {
  const { fmt, measure, hist, rows, range, focus } = p
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])
  const all = useMemo(() => hist.filter((t) => t.merchant === focus).sort((a, b) => a.day.localeCompare(b.day)), [hist, focus])
  const inRange = useMemo(() => rows.filter((t) => t.merchant === focus), [rows, focus])
  const [g] = groupRows(all, () => focus, [])
  const [gr] = groupRows(inRange, () => focus, [])
  const charges = all.filter((t) => t.amt > 0)

  // Month by month over the history, at most the last 24 months up to the end of the period.
  const monthly = useMemo(() => {
    if (!all.length) return []
    const end = range.to.slice(0, 7) > all.at(-1)!.month ? range.to.slice(0, 7) : all.at(-1)!.month
    const start = all[0].month > addMonths(end, -23) ? all[0].month : addMonths(end, -23)
    const ms = monthsOf({ from: `${start}-01`, to: `${end}-01` })
    const sums = new Map<string, number>()
    for (const t of all) sums.set(t.month, (sums.get(t.month) ?? 0) + t.amt)
    return ms.map((m) => ({ label: monthLabel(m), valor: Math.round(sums.get(m) ?? 0), inside: m >= range.from.slice(0, 7) && m <= range.to.slice(0, 7) }))
  }, [all, range])
  const points = charges.map((t) => ({ x: Date.parse(t.day), y: Math.round(t.amt * 100) / 100, d: t.day, inside: t.booking_date >= range.from && t.booking_date <= range.to }))
  const firstHalf = charges.slice(0, Math.ceil(charges.length / 2)), secondHalf = charges.slice(Math.ceil(charges.length / 2))
  const mean = (xs: typeof charges) => xs.reduce((s, t) => s + t.amt, 0) / Math.max(1, xs.length)

  return (
    <div className="card wide detail" ref={ref}>
      <div className="card-head">
        <h3>{focus} <span className="muted" style={{ fontWeight: 400 }}>· {g?.category}</span></h3>
        <div className="row" style={{ margin: 0 }}>
          <button onClick={() => p.filterMerchant(focus)}>Filtrar a página por este estabelecimento</button>
          <button className="icon-btn" aria-label="Fechar detalhe" onClick={() => p.setFocus('')}>✕</button>
        </div>
      </div>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="No período" value={fmt(gr?.total ?? 0)} sub={<span className="muted">{gr?.count ?? 0} compra(s) · {fmt(perMonth(gr?.total ?? 0, range))}/mês</span>} />
        <Kpi label="Histórico" value={fmt(g?.total ?? 0)} sub={<span className="muted">{g?.count ?? 0} compras desde {g ? fullDate(g.first) : '—'}</span>} />
        <Kpi label="Valor médio" value={fmt(g && g.count ? g.total / g.count : 0)}
          sub={charges.length >= 4 ? <><span className="muted">antes {fmt(mean(firstHalf))} → agora </span><Delta cur={mean(secondHalf)} prev={mean(firstHalf)} measure={measure} neutral={neutralFor(g?.category ?? '')} money={fmt} /></> : undefined} />
        <Kpi label="Frequência (histórico)" value={cadence(g?.every ?? null)} sub={<span className="muted">última em {g ? fullDate(g.last) : '—'}</span>} />
      </div>
      <div className="grid agrid">
        <div>
          <h4 className="sub">Por mês</h4>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthly}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--line)', opacity: 0.4 }} formatter={(v) => fmt(Number(v))} />
              <Bar dataKey="valor" name={focus} radius={[4, 4, 0, 0]} maxBarSize={56}>
                {monthly.map((m) => <Cell key={m.label} fill={m.inside ? 'var(--s1)' : 'var(--s-other)'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}><span className="swatch" style={{ background: 'var(--s1)' }} />no período · <span className="swatch" style={{ background: 'var(--s-other)' }} />fora dele</p>
        </div>
        <div>
          <h4 className="sub">Valor de cada compra</h4>
          <ResponsiveContainer width="100%" height={200}>
            <ScatterChart>
              <CartesianGrid {...grid} />
              <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} scale="time" {...axis} tickFormatter={(x) => monthLabel(new Date(x).toISOString().slice(0, 7))} minTickGap={16} />
              <YAxis dataKey="y" type="number" {...axis} tickFormatter={compact} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'y' || n === 'Valor' ? fmt(Number(v)) : fullDate(new Date(Number(v)).toISOString().slice(0, 10)))} />
              <Scatter data={points} name="Valor">
                {points.map((pt, i) => <Cell key={i} fill={pt.inside ? 'var(--s1)' : 'var(--s-other)'} stroke="var(--card)" strokeWidth={1} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>Cada ponto é uma compra: mostra se o preço subiu com o tempo.</p>
        </div>
      </div>
      <h4 className="sub">Compras (mais recentes primeiro)</h4>
      <div className="scroll" style={{ maxHeight: 320 }}>
        <table className="tight">
          <thead><tr><th>Data</th><th>Descrição</th><th className="hide-sm">Conta</th><th className="num">Valor</th></tr></thead>
          <tbody>
            {[...all].reverse().slice(0, 100).map((t) => (
              <tr key={t.id} className={t.booking_date >= range.from && t.booking_date <= range.to ? '' : 'faded'}>
                <td className="num" style={{ textAlign: 'left' }}>{fullDate(t.day)}</td><td>{t.description}</td>
                <td className="hide-sm muted">{t.accountName}</td><td className="num">{fmt(t.amt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
