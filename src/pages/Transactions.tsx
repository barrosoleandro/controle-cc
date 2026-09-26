import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { addRule, reapplyRules, setTransactionCategory, setTransactionNote } from '../lib/data'
import { money } from '../lib/format'
import { useFmt } from '../lib/hooks'

export function Transactions({ ctx }: { ctx: Ctx }) {
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

  async function changeCategory(id: string, categoryId: string, merchant: string) {
    await setTransactionCategory(id, categoryId || null)
    if (categoryId && merchant && confirm(`Always use this category for "${merchant}"?`)) {
      const minPriority = Math.min(1000, ...data.rules.map((r) => r.priority))
      await addRule(merchant, categoryId, null, minPriority - 1) // user rules win over defaults
      const n = await reapplyRules({ ...data, rules: [{ id: 'new', pattern: merchant, category: data.categories.find((c) => c.id === categoryId)!.name, category_id: categoryId, priority: minPriority - 1 }, ...data.rules] })
      setMsg(`Rule created; ${n} other transactions updated.`)
    }
    await ctx.reload()
  }

  function exportCsv() {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const lines = ['date;account;description;amount;currency;category;notes', ...rows.map((t) =>
      [t.booking_date, esc(t.accountName), esc(t.description), t.amount.toFixed(2), t.currency, esc(t.categoryName), esc(t.notes ?? '')].join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'transactions.csv'; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <div className="row">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{months.map((m) => <option key={m}>{m}</option>)}</select>
        <select value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option><option value="__none">(none)</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button onClick={exportCsv}>Export CSV</button>
        <button onClick={async () => { const n = await reapplyRules(data); setMsg(`${n} transactions re-categorized.`); ctx.reload() }}>Re-apply rules</button>
      </div>
      <p className="muted">{rows.length} transactions · net {fmt(total)}{msg ? ` · ${msg}` : ''}</p>
      <div className="scroll"><table>
        <thead><tr><th>Date</th><th>Description</th><th className="hide-sm">Account</th><th>Category</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.slice(0, limit).map((t) => (
            <tr key={t.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{t.booking_date.slice(5)}</td>
              <td>{t.description}{t.bank_subcategory && <div className="muted" style={{ fontSize: 12 }}>{t.bank_subcategory}</div>}
                <input style={{ marginTop: 4, width: '100%', fontSize: 12, padding: '2px 6px' }} placeholder="note" defaultValue={t.notes ?? ''}
                  onBlur={(e) => { if (e.target.value !== (t.notes ?? '')) setTransactionNote(t.id, e.target.value) }} /></td>
              <td className="hide-sm">{t.accountName}</td>
              <td><select value={t.category_id ?? ''} onChange={(e) => changeCategory(t.id, e.target.value, t.merchant)} style={{ maxWidth: 160, fontWeight: t.category_locked ? 600 : 400 }}>
                <option value="">—</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
              <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{money(t.currency, 2)(t.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {rows.length > limit && <button onClick={() => setLimit(limit + 200)}>Show more</button>}
    </div>
  )
}
