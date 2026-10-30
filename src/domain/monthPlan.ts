/**
 * Month plan: what is already in the month (imported transactions), what the user added by hand,
 * and what is still expected from the average of the last complete months. Per category:
 * falta = max(0, média − realizado − manual), so a known payment entered by hand takes the place
 * of the average instead of adding to it. Values are positive, in the display currency.
 */
import { EXTERNAL } from './audit'

/** A line added by hand to a month; editable, unlike the imported transactions. */
export interface ManualLine {
  id: string
  month: string // yyyy-mm
  date: string // yyyy-mm-dd
  description: string
  category_id: string
  amount: number // positive; the category decides whether it adds (income) or subtracts
  currency: 'EUR' | 'BRL'
  merchant?: string // set when the line was made from a recurring one: it takes that one's place in the month
}

export interface PlanTx { month: string; value: number; kind: 'income' | 'expense' | 'transfer'; categoryName: string; merchant?: string; booking_date?: string }
/** A recurring income or expense expected every month, until it shows up in the month. */
export interface RecurringExpect { merchant: string; kind: 'income' | 'expense'; categoryName: string; amount: number; day: number }
export interface PlanManual { month: string; value: number; kind: 'income' | 'expense' | 'transfer'; categoryName: string; merchant?: string }

export interface PlanRow {
  name: string
  kind: 'income' | 'expense'
  media: number
  realizado: number
  manual: number
  recorrente: number // recurring lines still to come this month
  pendentes: RecurringExpect[]
  falta: number
  previsto: number
}
export interface PlanTotals { media: number; realizado: number; manual: number; recorrente: number; falta: number; previsto: number }
export interface MonthPlan { month: string; income: PlanRow[]; expense: PlanRow[]; totals: { income: PlanTotals; expense: PlanTotals }; resultado: number }

/** Sign that makes a value positive for its kind: income counts up, expense counts down (refunds reduce it). */
const signed = (kind: 'income' | 'expense', v: number) => (kind === 'income' ? v : -v)

/**
 * `recurring`: expected recurring lines; one still missing from the month (not imported, not
 * replaced by a manual line of the same merchant) counts in its category, so falta = max(0, max(recorrentes pendentes, média − realizado) − manual).
 */
export function buildMonthPlan(txs: PlanTx[], manual: PlanManual[], month: string, avgMonths: string[], recurring: RecurringExpect[] = []): MonthPlan {
  const avgSet = new Set(avgMonths)
  const n = Math.max(1, avgMonths.length)
  const rows = new Map<string, PlanRow>()
  const row = (name: string, kind: 'income' | 'expense') => {
    const key = `${kind}/${name}`
    let r = rows.get(key)
    if (!r) { r = { name, kind, media: 0, realizado: 0, manual: 0, recorrente: 0, pendentes: [], falta: 0, previsto: 0 }; rows.set(key, r) }
    return r
  }
  for (const t of txs) {
    if (t.kind === 'transfer') continue
    // Money from or to outside (a resgate) is a one-off: it counts in its month, not in the average.
    if (avgSet.has(t.month) && t.categoryName !== EXTERNAL) row(t.categoryName, t.kind).media += signed(t.kind, t.value) / n
    if (t.month === month) row(t.categoryName, t.kind).realizado += signed(t.kind, t.value)
  }
  for (const m of manual) {
    if (m.kind === 'transfer' || m.month !== month) continue
    row(m.categoryName, m.kind).manual += signed(m.kind, m.value)
  }
  const done = new Set([
    ...txs.filter((t) => t.month === month && t.kind !== 'transfer' && t.merchant).map((t) => `${t.kind}/${t.merchant}`),
    ...manual.filter((m) => m.month === month && m.merchant).map((m) => `${m.kind}/${m.merchant}`),
  ])
  for (const e of recurring) {
    if (done.has(`${e.kind}/${e.merchant}`)) continue
    const r = row(e.categoryName, e.kind)
    r.recorrente += e.amount
    r.pendentes.push(e)
  }
  const all = [...rows.values()].map((r) => {
    const falta = Math.max(0, Math.max(r.recorrente, r.media - r.realizado) - r.manual)
    return { ...r, falta, previsto: r.realizado + r.manual + falta, pendentes: r.pendentes.sort((a, b) => a.day - b.day) }
  }).filter((r) => Math.abs(r.media) > 0.005 || Math.abs(r.realizado) > 0.005 || Math.abs(r.manual) > 0.005 || r.recorrente > 0.005)
  const pick = (kind: 'income' | 'expense') => all.filter((r) => r.kind === kind).sort((a, b) => b.previsto - a.previsto)
  const sum = (list: PlanRow[]): PlanTotals => list.reduce((s, r) => ({
    media: s.media + r.media, realizado: s.realizado + r.realizado, manual: s.manual + r.manual, recorrente: s.recorrente + r.recorrente,
    falta: s.falta + r.falta, previsto: s.previsto + r.previsto,
  }), { media: 0, realizado: 0, manual: 0, recorrente: 0, falta: 0, previsto: 0 })
  const income = pick('income'), expense = pick('expense')
  const totals = { income: sum(income), expense: sum(expense) }
  return { month, income, expense, totals, resultado: totals.income.previsto - totals.expense.previsto }
}

/**
 * What each recurring merchant is expected to bring in or charge: its average over the months it
 * appeared in `avgMonths`, in the category and on the day of its latest entry. Merchants with
 * nothing in those months are left out (nothing to base the value on).
 */
export function recurringExpectations(txs: PlanTx[], isRecurring: (merchant: string, kind: 'income' | 'expense') => boolean, avgMonths: string[]): RecurringExpect[] {
  const set = new Set(avgMonths)
  const by = new Map<string, { kind: 'income' | 'expense'; perMonth: Map<string, number>; last: PlanTx }>()
  for (const t of txs) {
    if (t.kind === 'transfer' || !t.merchant || !set.has(t.month) || !isRecurring(t.merchant, t.kind)) continue
    const key = `${t.kind}/${t.merchant}`
    const m = by.get(key) ?? { kind: t.kind, perMonth: new Map(), last: t }
    m.perMonth.set(t.month, (m.perMonth.get(t.month) ?? 0) + signed(t.kind, t.value))
    if ((t.booking_date ?? '') >= (m.last.booking_date ?? '')) m.last = t
    by.set(key, m)
  }
  return [...by.values()].map((m) => {
    const vals = [...m.perMonth.values()]
    return { merchant: m.last.merchant!, kind: m.kind, categoryName: m.last.categoryName, amount: vals.reduce((s, v) => s + v, 0) / vals.length, day: Number((m.last.booking_date ?? '').slice(8, 10)) || 1 }
  }).filter((e) => e.amount > 0.005)
}

/**
 * Incomes that came in every one of `avgMonths` (salary, rent received): recurring by default,
 * so next month already shows them. A mark in Lançamentos still overrides this.
 */
export function steadyIncomes(txs: PlanTx[], avgMonths: string[]): Set<string> {
  const seen = new Map<string, Set<string>>()
  for (const t of txs) {
    if (t.kind !== 'income' || !t.merchant || !avgMonths.includes(t.month)) continue
    seen.set(t.merchant, (seen.get(t.merchant) ?? new Set()).add(t.month))
  }
  return new Set([...seen].filter(([, ms]) => ms.size === avgMonths.length).map(([m]) => m))
}

/** The month after `month` (yyyy-mm). */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
