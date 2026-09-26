import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { addRule, markAiNote, reapplyRules, setCategoryForTransactions, setTransactionCategory, setTransactionNote, updateRule } from '../lib/data'
import { money } from '../lib/format'
import { useFmt, useSubscriptions } from '../lib/hooks'

const VIEWS = ['Lista', '6 meses'] as const

export function Transactions({ ctx }: { ctx: Ctx }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('Lista')
  return <>
    <div className="row">{VIEWS.map((v) => (
      <button key={v} className={v === view ? 'active' : ''} onClick={() => setView(v)}>{v}</button>
    ))}</div>
    {view === 'Lista' ? <Lista ctx={ctx} /> : <SeisMeses ctx={ctx} />}
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

interface PivotRow {
  key: string
  recurring: boolean
  perMonth: (number | null)[] // null = nothing that month, so a gap stays visible
  total: number
  months: number
}

/**
 * Six months side by side, one line per merchant (or category), so a recurring
 * charge reads across the row and a missing month shows up as a hole.
 */
function SeisMeses({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const subs = useSubscriptions(ctx)
  const [by, setBy] = useState<'merchant' | 'category'>('merchant')
  const [acc, setAcc] = useState('')
  const [end, setEnd] = useState('') // último mês da janela; vazio = o mais recente com dados
  const [onlyRecurring, setOnlyRecurring] = useState(false)

  const allMonths = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const lastMonth = end || allMonths.at(-1) || ''
  // A janela é sempre de seis meses de calendário, mesmo que algum não tenha lançamento.
  const window6 = useMemo(() => {
    if (!lastMonth) return []
    const [y, m] = lastMonth.split('-').map(Number)
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1))
      return d.toISOString().slice(0, 7)
    })
  }, [lastMonth])

  const recurringKeys = useMemo(
    () => new Set(subs.filter((s) => s.status !== 'possibly_cancelled').map((s) => s.merchant)),
    [subs],
  )

  const rows = useMemo(() => {
    const idx = new Map(window6.map((m, i) => [m, i]))
    const acc2 = new Map<string, PivotRow>()
    for (const t of etx) {
      if (t.kind !== 'expense') continue
      if (acc && t.account_id !== acc) continue
      const i = idx.get(t.month)
      if (i === undefined) continue
      const key = by === 'merchant' ? (t.merchant || '(sem estabelecimento)') : t.categoryName
      const row = acc2.get(key) ?? { key, recurring: by === 'merchant' && recurringKeys.has(key), perMonth: Array(6).fill(null) as (number | null)[], total: 0, months: 0 }
      // Despesas entram como número positivo; um reembolso no mês reduz a célula.
      row.perMonth[i] = (row.perMonth[i] ?? 0) - t.value
      acc2.set(key, row)
    }
    const out = [...acc2.values()].map((r) => {
      const months = r.perMonth.filter((v) => v !== null && Math.abs(v) > 0.005).length
      return { ...r, months, total: r.perMonth.reduce<number>((s, v) => s + (v ?? 0), 0) }
    }).filter((r) => Math.abs(r.total) > 0.005 && (!onlyRecurring || r.recurring))
    // Recorrentes primeiro e alinhados no topo, depois o resto pelo total.
    return out.sort((a, b) => Number(b.recurring) - Number(a.recurring) || b.total - a.total)
  }, [etx, window6, by, acc, recurringKeys, onlyRecurring])

  const columnTotals = window6.map((_, i) => rows.reduce((s, r) => s + (r.perMonth[i] ?? 0), 0))
  const grand = columnTotals.reduce((s, v) => s + v, 0)
  const recurringCount = rows.filter((r) => r.recurring).length

  if (!window6.length) return <div className="card"><p className="muted">Sem lançamentos para comparar.</p></div>

  return (
    <div className="card">
      <div className="row">
        <label className="inline">Agrupar por
          <select value={by} onChange={(e) => setBy(e.target.value as 'merchant' | 'category')}>
            <option value="merchant">Estabelecimento</option>
            <option value="category">Categoria</option>
          </select>
        </label>
        <label className="inline">Terminando em
          <select value={lastMonth} onChange={(e) => setEnd(e.target.value)}>
            {[...allMonths].reverse().map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <select value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="">Todas as contas</option>
          {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label className="inline">
          <input type="checkbox" checked={onlyRecurring} onChange={(e) => setOnlyRecurring(e.target.checked)} disabled={by === 'category'} /> só recorrentes
        </label>
      </div>
      <p className="muted">
        Despesas de {window6[0]} a {window6[5]} · {rows.length} linhas
        {by === 'merchant' && ` · ${recurringCount} recorrentes (↻) no topo`} · total {fmt(grand)}.
        Célula vazia significa nenhum lançamento naquele mês.
      </p>
      <div className="scroll"><table>
        <thead><tr>
          <th style={{ position: 'sticky', left: 0, background: 'var(--card)' }}>{by === 'merchant' ? 'Estabelecimento' : 'Categoria'}</th>
          {window6.map((m) => <th key={m} className="num">{m.slice(2)}</th>)}
          <th className="num">Média</th><th className="num">Total</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.recurring ? 'recorrente' : ''}>
              <td style={{ position: 'sticky', left: 0, background: 'var(--card)', whiteSpace: 'nowrap' }}>
                {r.recurring && <span title="cobrança recorrente">↻ </span>}{r.key}
              </td>
              {r.perMonth.map((v, i) => (
                <td key={i} className="num">{v === null ? <span className="muted">·</span> : fmt(v)}</td>
              ))}
              <td className="num">{fmt(r.total / Math.max(1, r.months))}</td>
              <td className="num"><strong>{fmt(r.total)}</strong></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr>
          <th style={{ position: 'sticky', left: 0, background: 'var(--card)' }}>Total do mês</th>
          {columnTotals.map((v, i) => <th key={i} className="num">{fmt(v)}</th>)}
          <th className="num">{fmt(grand / 6)}</th><th className="num">{fmt(grand)}</th>
        </tr></tfoot>
      </table></div>
    </div>
  )
}
