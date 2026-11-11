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
/**
 * A recurring income or expense, expected every `period` months counted from `lastMonth` (the
 * month of its latest entry), until it shows up in the month. `amount` is one payment.
 */
export interface RecurringExpect { merchant: string; kind: 'income' | 'expense'; categoryName: string; amount: number; day: number; period: number; lastMonth: string; /** The interval came from the user, not from the history. */ periodSet?: boolean }

/** User's interval per merchant, in months (1 = monthly, 2 = bimonthly…), over the detected one. */
export type RecurringPeriods = Record<string, number>

/** Months from `a` to `b` (yyyy-mm), negative when `b` is before `a`. */
export function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number)
  return (yb - ya) * 12 + (mb - ma)
}

/** Whether a recurring line is expected in `month`: every `period` months after its latest entry. */
export function isDue(e: Pick<RecurringExpect, 'period' | 'lastMonth'>, month: string): boolean {
  if (e.period <= 1) return true
  const d = monthsBetween(e.lastMonth, month)
  return d >= 0 && d % e.period === 0
}

/**
 * The interval of a recurring line from the months it was paid in (sorted, distinct): the median
 * gap between them, so one late or skipped month does not change it. Fewer than 2 → monthly.
 */
export function detectPeriod(months: string[]): number {
  if (months.length < 2) return 1
  const gaps = months.slice(1).map((m, i) => monthsBetween(months[i], m)).sort((a, b) => a - b)
  const mid = gaps.length / 2
  const median = gaps.length % 2 ? gaps[Math.floor(mid)] : (gaps[mid - 1] + gaps[mid]) / 2
  return Math.min(12, Math.max(1, Math.round(median)))
}

/** How many complete months back the interval of a recurring line is read from. */
export const PERIOD_HISTORY = 12
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
  /** Set when the user typed `falta`: what the app had worked out, to show and to go back to. */
  faltaApp?: number
}
export interface PlanTotals { media: number; realizado: number; manual: number; recorrente: number; falta: number; previsto: number }
export interface MonthPlan { month: string; income: PlanRow[]; expense: PlanRow[]; totals: { income: PlanTotals; expense: PlanTotals }; resultado: number }

/** Sign that makes a value positive for its kind: income counts up, expense counts down (refunds reduce it). */
const signed = (kind: 'income' | 'expense', v: number) => (kind === 'income' ? v : -v)

/**
 * `recurring`: expected recurring lines; one due in the month (see isDue) and still missing (not
 * imported, not replaced by a manual line of the same merchant) counts in its category, so
 * falta = max(0, max(recorrentes mensais pendentes, média − realizado) + recorrentes de intervalo maior pendentes − manual).
 * An income category with a monthly recurring line (salary) follows that line alone, not the average:
 * once the salary of the month is in, nothing more is expected there.
 * A line paid every 2 months or more is left out of the average and of the realizado it is compared
 * with: it counts only in the months it is due, at its full value, not as a share every month.
 */
export function buildMonthPlan(txs: PlanTx[], manual: PlanManual[], month: string, avgMonths: string[], recurring: RecurringExpect[] = []): MonthPlan {
  const avgSet = new Set(avgMonths)
  const n = Math.max(1, avgMonths.length)
  const rows = new Map<string, PlanRow>()
  const periodic = new Set(recurring.filter((e) => e.period > 1).map((e) => `${e.kind}/${e.merchant}`))
  const isPeriodic = (t: { kind: string; merchant?: string }) => !!t.merchant && periodic.has(`${t.kind}/${t.merchant}`)
  const extra = new Map<PlanRow, { realPeriodic: number; recPeriodic: number }>()
  const extraOf = (r: PlanRow) => extra.get(r) ?? extra.set(r, { realPeriodic: 0, recPeriodic: 0 }).get(r)!
  const row = (name: string, kind: 'income' | 'expense') => {
    const key = `${kind}/${name}`
    let r = rows.get(key)
    if (!r) { r = { name, kind, media: 0, realizado: 0, manual: 0, recorrente: 0, pendentes: [], falta: 0, previsto: 0 }; rows.set(key, r) }
    return r
  }
  for (const t of txs) {
    if (t.kind === 'transfer') continue
    // Money from or to outside (a resgate) is a one-off: it counts in its month, not in the average.
    const p = isPeriodic(t)
    if (avgSet.has(t.month) && t.categoryName !== EXTERNAL && !p) row(t.categoryName, t.kind).media += signed(t.kind, t.value) / n
    if (t.month === month) {
      const r = row(t.categoryName, t.kind)
      r.realizado += signed(t.kind, t.value)
      if (p) extraOf(r).realPeriodic += signed(t.kind, t.value)
    }
  }
  for (const m of manual) {
    if (m.kind === 'transfer' || m.month !== month) continue
    row(m.categoryName, m.kind).manual += signed(m.kind, m.value)
  }
  const done = new Set([
    ...txs.filter((t) => t.month === month && t.kind !== 'transfer' && t.merchant).map((t) => `${t.kind}/${t.merchant}`),
    ...manual.filter((m) => m.month === month && m.merchant).map((m) => `${m.kind}/${m.merchant}`),
  ])
  const byRecurring = new Set<PlanRow>() // income rows driven by their monthly recurring lines
  for (const e of recurring) {
    if (e.kind === 'income' && e.period <= 1) byRecurring.add(row(e.categoryName, e.kind))
    if (done.has(`${e.kind}/${e.merchant}`) || !isDue(e, month)) continue
    const r = row(e.categoryName, e.kind)
    r.recorrente += e.amount
    if (e.period > 1) extraOf(r).recPeriodic += e.amount
    r.pendentes.push(e)
  }
  const all = [...rows.values()].map((r) => {
    const x = extra.get(r) ?? { realPeriodic: 0, recPeriodic: 0 }
    const pending = r.recorrente - x.recPeriodic
    const base = byRecurring.has(r) ? pending : Math.max(pending, r.media - (r.realizado - x.realPeriodic))
    const falta = Math.max(0, base + x.recPeriodic - r.manual)
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
 * The plan with one more expense line that is not a category: money that leaves the accounts in
 * scope for another account of the user (the transfer that pays the bills in Brazil).
 * `realizado`: already sent in the month; `falta`: still to send. Totals and result follow.
 */
export function withExpenseLine(plan: MonthPlan, name: string, realizado: number, falta: number): MonthPlan {
  if (realizado <= 0.005 && falta <= 0.005) return plan
  const row: PlanRow = { name, kind: 'expense', media: 0, realizado, manual: 0, recorrente: 0, pendentes: [], falta, previsto: realizado + falta }
  const expense = [...plan.expense, row].sort((a, b) => b.previsto - a.previsto)
  const t = plan.totals.expense
  const totals = { income: plan.totals.income, expense: { ...t, realizado: t.realizado + realizado, falta: t.falta + falta, previsto: t.previsto + row.previsto } }
  return { ...plan, expense, totals, resultado: totals.income.previsto - totals.expense.previsto }
}

/**
 * What each recurring merchant is expected to bring in or charge, and how often. The interval is
 * read from the last PERIOD_HISTORY complete months (see detectPeriod), unless the user set one.
 * Monthly ones: the average over the months of `avgMonths` they appeared in, left out when they
 * did not appear in any (nothing to base the value on). A monthly income (salary) is expected at
 * its latest full month instead (see latestFull): a raise or the end of a bonus shows at once. Every 2 months or more: the average of
 * their last 3 payments, left out when the latest is more than two intervals old (stopped).
 * Category and day are the latest entry's.
 */
export function recurringExpectations(txs: PlanTx[], isRecurring: (merchant: string, kind: 'income' | 'expense') => boolean, avgMonths: string[], periods: RecurringPeriods = {}): RecurringExpect[] {
  const avgSet = new Set(avgMonths)
  const end = [...avgMonths].sort().at(-1)
  if (!end) return []
  const current = nextMonth(end)
  const inHistory = (m: string) => { const d = monthsBetween(m, end); return d >= 0 && d < PERIOD_HISTORY }
  const by = new Map<string, { kind: 'income' | 'expense'; perMonth: Map<string, number>; last: PlanTx }>()
  for (const t of txs) {
    if (t.kind === 'transfer' || !t.merchant || !(inHistory(t.month) || t.month === current) || !isRecurring(t.merchant, t.kind)) continue
    const key = `${t.kind}/${t.merchant}`
    const m = by.get(key) ?? { kind: t.kind, perMonth: new Map(), last: t }
    m.perMonth.set(t.month, (m.perMonth.get(t.month) ?? 0) + signed(t.kind, t.value))
    if ((t.booking_date ?? t.month) >= (m.last.booking_date ?? m.last.month)) m.last = t
    by.set(key, m)
  }
  const out: RecurringExpect[] = []
  for (const m of by.values()) {
    const merchant = m.last.merchant!
    const paid = [...m.perMonth].filter(([, v]) => v > 0.005).map(([mo]) => mo).sort()
    if (!paid.length) continue
    const mine = periods[merchant]
    const period = mine && mine >= 1 ? Math.min(12, Math.round(mine)) : detectPeriod(paid.filter(inHistory))
    const lastMonth = paid.at(-1)!
    let amount: number
    if (period === 1) {
      const vals = [...m.perMonth].filter(([mo]) => avgSet.has(mo)).map(([, v]) => v)
      if (!vals.length) continue
      amount = vals.reduce((s, v) => s + v, 0) / vals.length
      if (m.kind === 'income') amount = latestFull(m.perMonth, amount, (mo) => avgSet.has(mo) || mo === current)
    } else {
      if (monthsBetween(lastMonth, current) > 2 * period) continue
      const vals = paid.slice(-3).map((mo) => m.perMonth.get(mo)!)
      amount = vals.reduce((s, v) => s + v, 0) / vals.length
    }
    if (amount <= 0.005) continue
    out.push({ merchant, kind: m.kind, categoryName: m.last.categoryName, amount, day: Number((m.last.booking_date ?? '').slice(8, 10)) || 1, period, lastMonth, ...(mine ? { periodSet: true } : {}) })
  }
  return out
}

/**
 * The total of the latest month that looks like a full payment: at least half of `average`, so a
 * month that so far has only a small extra (an expense refund before the salary) is passed over.
 */
function latestFull(perMonth: Map<string, number>, average: number, counts: (month: string) => boolean): number {
  const full = [...perMonth].filter(([mo, v]) => counts(mo) && v >= average / 2).sort(([a], [b]) => a.localeCompare(b)).at(-1)
  return full ? full[1] : average
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
