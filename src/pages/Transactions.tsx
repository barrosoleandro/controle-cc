import { Fragment, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { addRule, markAiNote, reapplyRules, setCategoryForTransactions, setTransactionCategory, setTransactionNote, updateRule } from '../lib/data'
import { money } from '../lib/format'
import { today, useFmt, useSubscriptions } from '../lib/hooks'
import { buildPeriod, monthWindow, subscriptionReview, type PeriodRow } from '../domain/period'

const VIEWS = ['1 mês', '6 meses', '12 meses', 'Lista'] as const
const MONTHS: Record<string, number> = { '1 mês': 1, '6 meses': 6, '12 meses': 12 }

export function Transactions({ ctx }: { ctx: Ctx }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('6 meses')
  return <>
    <div className="row">{VIEWS.map((v) => (
      <button key={v} className={v === view ? 'active' : ''} onClick={() => setView(v)}>{v}</button>
    ))}</div>
    {view === 'Lista' ? <Lista ctx={ctx} /> : <Periodo ctx={ctx} n={MONTHS[view]} />}
  </>
}

function Lista({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const [q, setQ] = useState('')
  const [month, setMonth] = useState('')
  const [cat, setCat] = useState('')
  const [acc, setAcc] = useState('')
  const [limit, setLimit] = useState(200)
  const [msg, setMsg] = useState<string | null>(null)
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort().reverse(), [etx])
  const sortedCats = [...data.categories].sort((a, b) => a.name.localeCompare(b.name))

  const rows = useMemo(() => {
    const qq = q.trim().toUpperCase()
    return etx.filter((t) => (!month || t.month === month) && (!acc || t.account_id === acc)
      && (!cat || (cat === '__none' ? !t.category_id : t.category_id === cat))
      && (!qq || t.description.toUpperCase().includes(qq) || (t.notes ?? '').toUpperCase().includes(qq)))
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date))
  }, [etx, q, month, cat, acc])
  const total = rows.reduce((s, t) => s + t.value, 0)

  /**
   * A category picked on one line applies to the whole history of that merchant, even rows
   * chosen earlier by hand or by the AI, and becomes (or updates) the merchant's rule.
   */
  async function changeCategory(t: { id: string; merchant: string }, categoryId: string) {
    const merchant = t.merchant
    const wide = Boolean(categoryId) && merchant.length >= 2
    const same = wide ? data.transactions.filter((x) => x.merchant === merchant) : data.transactions.filter((x) => x.id === t.id)
    if (wide) await setCategoryForTransactions(same.map((x) => x.id), categoryId)
    else await setTransactionCategory(t.id, categoryId || null)
    await markAiNote(same, false)
    if (wide) {
      const rule = data.rules.find((r) => r.pattern.toUpperCase() === merchant.toUpperCase())
      if (rule?.id) await updateRule(rule.id, { category_id: categoryId })
      else await addRule(merchant, categoryId, null, Math.min(1000, ...data.rules.map((r) => r.priority)) - 1) // regras suas vencem as padrão
      setMsg(`"${merchant}": ${same.length} lançamento(s) atualizados e regra salva para os próximos imports.`)
    }
    await ctx.reload()
  }

  function exportCsv() {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const lines = ['data;conta;descricao;valor;moeda;categoria;observacao', ...rows.map((t) =>
      [t.booking_date, esc(t.accountName), esc(t.description), t.amount.toFixed(2), t.currency, esc(t.categoryName), esc(t.notes ?? '')].join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'lancamentos.csv'; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <div className="row">
        <input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={month} onChange={(e) => setMonth(e.target.value)}><option value="">Todos os meses</option>{months.map((m) => <option key={m}>{m}</option>)}</select>
        <select value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">Todas as contas</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas as categorias</option><option value="__none">(sem categoria)</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button onClick={exportCsv}>Exportar CSV</button>
        <button onClick={async () => { const n = await reapplyRules(data); setMsg(`${n} lançamentos recategorizados.`); ctx.reload() }}>Reaplicar regras</button>
      </div>
      <p className="muted">{rows.length} lançamentos · saldo {fmt(total)}{msg ? ` · ${msg}` : ''}</p>
      <div className="scroll"><table>
        <thead><tr><th>Data</th><th>Descrição</th><th className="hide-sm">Conta</th><th>Categoria</th><th className="num">Valor</th></tr></thead>
        <tbody>
          {rows.slice(0, limit).map((t) => (
            <tr key={t.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{t.booking_date.slice(5)}</td>
              <td>{t.description}{t.bank_subcategory && <div className="muted" style={{ fontSize: 12 }}>{t.bank_subcategory}</div>}
                <input style={{ marginTop: 4, width: '100%', fontSize: 12, padding: '2px 6px' }} placeholder="observação" defaultValue={t.notes ?? ''}
                  onBlur={(e) => { if (e.target.value !== (t.notes ?? '')) setTransactionNote(t.id, e.target.value) }} /></td>
              <td className="hide-sm">{t.accountName}</td>
              <td><select value={t.category_id ?? ''} onChange={(e) => changeCategory(t, e.target.value)} style={{ maxWidth: 160, fontWeight: t.category_locked ? 600 : 400 }}>
                <option value="">—</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
              <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{money(t.currency, 2)(t.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {rows.length > limit && <button onClick={() => setLimit(limit + 200)}>Mostrar mais</button>}
    </div>
  )
}

/**
 * Spending per category over 1, 6 or 12 months, each category expandable into its
 * merchants. Months well above the usual are red, rows with such a month get a flag,
 * and recurring charges that deserve a look (price up, new, stopped, annual renewal
 * coming) are marked for review.
 */
function Periodo({ ctx, n }: { ctx: Ctx; n: number }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const subs = useSubscriptions(ctx)
  const [acc, setAcc] = useState('')
  const [end, setEnd] = useState('') // último mês da janela; vazio = o mais recente com dados
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  const allMonths = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const lastMonth = end || allMonths.at(-1) || ''
  const months = useMemo(() => monthWindow(lastMonth, n), [lastMonth, n])
  const subOf = useMemo(() => new Map(subs.map((s) => [s.merchant, { reason: subscriptionReview(s, today()), active: s.status !== 'possibly_cancelled' }])), [subs])
  const all = useMemo(() => buildPeriod(etx.filter((t) => !acc || t.account_id === acc), months), [etx, acc, months])

  const needsLook = (m: PeriodRow) => m.flagged || Boolean(subOf.get(m.key)?.reason)
  const groups = onlyAlerts
    ? all.map((g) => ({ ...g, merchants: g.merchants.filter(needsLook) })).filter((g) => g.flagged || g.merchants.length)
    : all
  const columnTotals = months.map((_, i) => groups.reduce((s, g) => s + (g.perMonth[i] ?? 0), 0))
  const grand = columnTotals.reduce((s, v) => s + v, 0)
  const toReview = all.reduce((s, g) => s + g.merchants.filter((m) => subOf.get(m.key)?.reason).length, 0)
  const flagged = all.filter((g) => g.flagged).length

  const toggle = (k: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next })
  const sticky = { position: 'sticky' as const, left: 0, background: 'var(--card)' }

  const cells = (r: PeriodRow) => <>
    {r.perMonth.map((v, i) => (
      <td key={i} className={`num ${r.outlier[i] ? 'neg' : ''}`} style={r.outlier[i] ? { fontWeight: 700 } : undefined}
        title={r.outlier[i] ? `Fora do padrão: média ${fmt(r.avg)}` : undefined}>
        {v === null ? <span className="muted">·</span> : fmt(v)}
      </td>
    ))}
    <td className="num muted">{fmt(r.avg)}</td>
    <td className="num"><strong>{fmt(r.total)}</strong></td>
  </>

  if (!months.length) return <div className="card"><p className="muted">Sem lançamentos para comparar.</p></div>

  return (
    <div className="card">
      <div className="row">
        <label className="inline">{n === 1 ? 'Mês' : 'Terminando em'}
          <select value={lastMonth} onChange={(e) => setEnd(e.target.value)}>
            {[...allMonths].reverse().map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <select value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="">Todas as contas</option>
          {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="inline"><input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} /> só o que precisa de atenção</label>
        <button onClick={() => setOpen(open.size ? new Set() : new Set(groups.map((g) => g.key)))}>{open.size ? 'Recolher tudo' : 'Expandir tudo'}</button>
      </div>
      <p className="muted">
        Despesas {n === 1 ? `de ${months[0]}` : `de ${months[0]} a ${months.at(-1)}`} · total {fmt(grand)}
        {flagged > 0 && <> · <span className="neg">⚑ {flagged} categoria(s) fora da média</span></>}
        {toReview > 0 && <> · <span className="warn">↻ {toReview} assinatura(s) para revisar</span></>}
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        <span className="neg"><strong>Vermelho</strong></span>: mês pelo menos 50% acima da média da linha{n === 1 ? ' (média dos 6 meses anteriores)' : ''}.
        ⚑: linha com algum mês fora da média. ↻: assinatura; <span className="warn">revisar</span> quando o preço subiu, é nova, parou de cobrar ou a renovação anual está perto.
      </p>
      <div className="scroll"><table>
        <thead><tr>
          <th style={sticky}>Categoria / estabelecimento</th>
          {months.map((m) => <th key={m} className="num">{m.slice(2)}</th>)}
          <th className="num">{n === 1 ? 'Média 6m' : 'Média'}</th><th className="num">Total</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = open.has(g.key) || onlyAlerts
            const reviews = g.merchants.filter((m) => subOf.get(m.key)?.reason).length
            return (
              <Fragment key={g.key}>
                <tr>
                  <td style={{ ...sticky, whiteSpace: 'nowrap' }}>
                    <button className="link" onClick={() => toggle(g.key)} aria-expanded={isOpen}>{isOpen ? '▾' : '▸'} {g.key}</button>
                    {g.flagged && <span className="neg" title="Algum mês fora da média"> ⚑</span>}
                    {reviews > 0 && <span className="warn" title="Assinaturas para revisar"> ↻{reviews}</span>}
                  </td>
                  {cells(g)}
                </tr>
                {isOpen && g.merchants.map((m) => {
                  const sub = subOf.get(m.key)
                  return (
                    <tr key={`${g.key}/${m.key}`} className={sub?.active ? 'recorrente' : ''}>
                      <td style={{ ...sticky, whiteSpace: 'nowrap', paddingLeft: 24, fontSize: 13 }}>
                        {sub && <span title="Cobrança recorrente">↻ </span>}{m.key}
                        {m.flagged && <span className="neg" title="Algum mês fora da média"> ⚑</span>}
                        {sub?.reason && <span className="warn" title={sub.reason}> revisar: {sub.reason}</span>}
                      </td>
                      {cells(m)}
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot><tr>
          <th style={sticky}>Total do mês</th>
          {columnTotals.map((v, i) => <th key={i} className="num">{fmt(v)}</th>)}
          <th /><th className="num">{fmt(grand)}</th>
        </tr></tfoot>
      </table></div>
    </div>
  )
}
