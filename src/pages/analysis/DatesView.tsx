import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axis, compact, grid, tooltipStyle } from '../../components/charts'
import { bucketOf, bucketsOf, byDayOfMonth, byWeekday, type Grain } from '../../domain/explore'
import { Swatch } from './shared'
import { bucketLabel, fullDate, noun, WEEKDAYS, type ViewProps } from './util'

const MAX_COLS = 24
const MAX_ROWS = 12

export function DatesView(p: ViewProps) {
  const { fmt, measure, rows, range, months, colorOf } = p
  const week = useMemo(() => byWeekday(rows, range).map((w, i) => ({ label: WEEKDAYS[i], media: Math.round(w.avg), total: Math.round(w.total), count: w.count })), [rows, range])
  const dom = useMemo(() => byDayOfMonth(rows).map((d, i) => ({ label: String(i + 1), total: Math.round(d.total), count: d.count })), [rows])

  // Heat map: biggest categories × months (weeks under two months), color = share of the largest cell.
  const heat = useMemo(() => {
    const g: Grain = months.length >= 2 ? 'month' : 'week'
    const cols = bucketsOf(range, g).slice(-MAX_COLS)
    const idx = new Map(cols.map((c, i) => [c, i]))
    const cells = new Map<string, number[]>()
    for (const t of rows) {
      const i = idx.get(bucketOf(t.booking_date, g))
      if (i === undefined) continue
      const r = cells.get(t.categoryName) ?? cols.map(() => 0)
      r[i] += t.amt
      cells.set(t.categoryName, r)
    }
    const list = [...cells].map(([key, v]) => ({ key, v, total: v.reduce((s, x) => s + x, 0) })).sort((a, b) => b.total - a.total).slice(0, MAX_ROWS)
    const max = Math.max(1, ...list.flatMap((r) => r.v))
    return { cols: cols.map((c) => bucketLabel(c, g)), list, max }
  }, [rows, range, months.length])

  const biggest = useMemo(() => [...rows].sort((a, b) => b.amt - a.amt).slice(0, 10), [rows])
  const tip = { ...tooltipStyle, cursor: { fill: 'var(--line)', opacity: 0.4 } }
  const busiest = week.reduce((b, w, i) => (w.media > week[b].media ? i : b), 0)

  return (
    <div className="grid agrid">
      <div className="card">
        <h3>Por dia da semana</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Média por dia: {WEEKDAYS[busiest]} é o dia de maior valor ({fmt(week[busiest]?.media ?? 0)}).</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={week}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} formatter={(v, _n, item) => [`${fmt(Number(v))} por dia · total ${fmt(item.payload.total)} em ${item.payload.count} lanç.`, 'Média']} />
            <Bar dataKey="media" name="Média por dia" fill="var(--s1)" radius={[4, 4, 0, 0]} maxBarSize={56} />
          </BarChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>Pela data da compra (nos cartões, a data da nota, não a do débito). Divide pelo número de dias daquele tipo no período.</p>
      </div>

      <div className="card">
        <h3>Por dia do mês</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={dom}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} interval={2} /><YAxis {...axis} tickFormatter={compact} width={44} />
            <Tooltip {...tip} labelFormatter={(l) => `Dia ${l}`} formatter={(v, _n, item) => [`${fmt(Number(v))} em ${item.payload.count} lanç.`, 'Total']} />
            <Bar dataKey="total" name="Total" fill="var(--s1)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>Mostra onde caem os gastos fixos (aluguel, contas) e os picos do mês.</p>
      </div>

      <div className="card wide">
        <h3>Mapa de calor: categoria × {months.length >= 2 ? 'mês' : 'semana'}</h3>
        {heat.list.length === 0 ? <p className="muted">Nada no período.</p> : (
          <div className="scroll">
            <table className="heat">
              <thead><tr><th>Categoria</th>{heat.cols.map((c) => <th key={c} className="num">{c}</th>)}<th className="num">Total</th></tr></thead>
              <tbody>
                {heat.list.map((r) => (
                  <tr key={r.key} className="clickable" onClick={() => p.onCategory(r.key)}>
                    <td className="name"><Swatch color={colorOf(r.key)} />{r.key}</td>
                    {r.v.map((x, i) => (
                      <td key={i} className="cell" title={`${r.key} · ${heat.cols[i]}: ${fmt(x)}`}
                        style={{ background: x > 0 ? `color-mix(in srgb, var(--s1) ${Math.round(8 + (x / heat.max) * 67)}%, var(--card))` : undefined }}>
                        {Math.abs(x) >= 0.5 ? compact(Math.round(x)) : ''}
                      </td>
                    ))}
                    <td className="num"><strong>{compact(Math.round(r.total))}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12 }}>Quanto mais escuro, maior o valor. Mostra as {MAX_ROWS} maiores categorias; clique numa para o detalhe.</p>
      </div>

      <div className="card wide">
        <h3>Maiores lançamentos de {noun(measure).toLowerCase()} no período</h3>
        <div className="scroll">
          <table className="tight">
            <thead><tr><th>Data</th><th>Estabelecimento</th><th className="hide-sm">Categoria</th><th className="hide-sm">Conta</th><th className="num">Valor</th></tr></thead>
            <tbody>
              {biggest.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => p.onMerchant(t.merchant)}>
                  <td>{fullDate(t.day)}</td><td>{t.merchant}<div className="muted" style={{ fontSize: 12 }}>{t.description}</div></td>
                  <td className="hide-sm">{t.categoryName}</td><td className="hide-sm muted">{t.accountName}</td><td className="num">{fmt(t.amt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
