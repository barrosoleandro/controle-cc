/**
 * Month plan: what is already in the month (imported transactions), what the user added by hand,
 * and what is still expected from the average of the last complete months. Per category:
 * falta = max(0, média − realizado − manual), so a known payment entered by hand takes the place
 * of the average instead of adding to it. Values are positive, in the display currency.
 */

/** A line added by hand to a month; editable, unlike the imported transactions. */
export interface ManualLine {
  id: string
  month: string // yyyy-mm
  date: string // yyyy-mm-dd
  description: string
  category_id: string
  amount: number // positive; the category decides whether it adds (income) or subtracts
  currency: 'EUR' | 'BRL'
}

export interface PlanTx { month: string; value: number; kind: 'income' | 'expense' | 'transfer'; categoryName: string }
export interface PlanManual { month: string; value: number; kind: 'income' | 'expense' | 'transfer'; categoryName: string }

export interface PlanRow {
  name: string
  kind: 'income' | 'expense'
  media: number
  realizado: number
  manual: number
  falta: number
  previsto: number
}
export interface PlanTotals { media: number; realizado: number; manual: number; falta: number; previsto: number }
export interface MonthPlan { month: string; income: PlanRow[]; expense: PlanRow[]; totals: { income: PlanTotals; expense: PlanTotals }; resultado: number }

/** Sign that makes a value positive for its kind: income counts up, expense counts down (refunds reduce it). */
const signed = (kind: 'income' | 'expense', v: number) => (kind === 'income' ? v : -v)

export function buildMonthPlan(txs: PlanTx[], manual: PlanManual[], month: string, avgMonths: string[]): MonthPlan {
  const avgSet = new Set(avgMonths)
  const n = Math.max(1, avgMonths.length)
  const rows = new Map<string, PlanRow>()
  const row = (name: string, kind: 'income' | 'expense') => {
    const key = `${kind}/${name}`
    let r = rows.get(key)
    if (!r) { r = { name, kind, media: 0, realizado: 0, manual: 0, falta: 0, previsto: 0 }; rows.set(key, r) }
    return r
  }
  for (const t of txs) {
    if (t.kind === 'transfer') continue
    if (avgSet.has(t.month)) row(t.categoryName, t.kind).media += signed(t.kind, t.value) / n
    if (t.month === month) row(t.categoryName, t.kind).realizado += signed(t.kind, t.value)
  }
  for (const m of manual) {
    if (m.kind === 'transfer' || m.month !== month) continue
    row(m.categoryName, m.kind).manual += signed(m.kind, m.value)
  }
  const all = [...rows.values()].map((r) => {
    const falta = Math.max(0, r.media - r.realizado - r.manual)
    return { ...r, falta, previsto: r.realizado + r.manual + falta }
  }).filter((r) => Math.abs(r.media) > 0.005 || Math.abs(r.realizado) > 0.005 || Math.abs(r.manual) > 0.005)
  const pick = (kind: 'income' | 'expense') => all.filter((r) => r.kind === kind).sort((a, b) => b.previsto - a.previsto)
  const sum = (list: PlanRow[]): PlanTotals => list.reduce((s, r) => ({
    media: s.media + r.media, realizado: s.realizado + r.realizado, manual: s.manual + r.manual, falta: s.falta + r.falta, previsto: s.previsto + r.previsto,
  }), { media: 0, realizado: 0, manual: 0, falta: 0, previsto: 0 })
  const income = pick('income'), expense = pick('expense')
  const totals = { income: sum(income), expense: sum(expense) }
  return { month, income, expense, totals, resultado: totals.income.previsto - totals.expense.previsto }
}

/** The month after `month` (yyyy-mm). */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
