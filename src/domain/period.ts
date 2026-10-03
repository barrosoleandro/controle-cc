import type { Subscription } from './subscriptions'
import type { Account, Currency, Transaction } from './types'
import { balanceSeries } from './analytics'

/** What the period view needs from an enriched transaction (value is signed, display currency). */
export interface PeriodTx { month: string; value: number; categoryName: string; merchant: string; kind: string }

export interface PeriodRow {
  key: string
  perMonth: (number | null)[] // spending per window month; null = nothing that month
  outlier: boolean[] // per window month: well above this row's usual month
  isNew: boolean[] // per window month: spending here and none in the six months before
  avg: number // usual month: mean over the baseline months, empty months counting as zero
  total: number // over the window
  flagged: boolean // some month in the window is an outlier
}

export interface CategoryGroup extends PeriodRow { merchants: PeriodRow[] }

// A month is out of pattern when it is at least 50% above the usual month and the
// difference is worth looking at (small amounts swing a lot and are noise).
const OUT_RATIO = 1.5
const OUT_MIN = 25

/** The n calendar months ending at `last` (YYYY-MM), oldest first. */
export function monthWindow(last: string, n: number): string[] {
  if (!last) return []
  const [y, m] = last.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7))
}

/**
 * Months the "usual month" is measured on: the window itself, except for a one-month
 * window, which is compared with the six months before it.
 */
export function baselineMonths(window: string[]): string[] {
  return window.length === 1 ? monthWindow(window[0], 7).slice(0, 6) : window
}

const NEW_LOOKBACK = 6
const MIN_HISTORY = 3

function finish(key: string, sums: Map<string, number>, window: string[], baseline: string[], since: string): PeriodRow {
  const perMonth = window.map((m) => (sums.has(m) ? sums.get(m)! : null))
  const avg = baseline.reduce((s, m) => s + (sums.get(m) ?? 0), 0) / Math.max(1, baseline.length)
  const outlier = perMonth.map((v) => v !== null && v >= avg * OUT_RATIO && v - avg >= OUT_MIN)
  // "New": nothing in the (up to six) months of history before it. With under three months of
  // history everything would look new, so nothing is marked then.
  const isNew = window.map((m, i) => {
    const before = monthWindow(m, NEW_LOOKBACK + 1).slice(0, NEW_LOOKBACK).filter((b) => b >= since)
    return (perMonth[i] ?? 0) > 0.005 && before.length >= MIN_HISTORY && before.every((b) => Math.abs(sums.get(b) ?? 0) < 0.005)
  })
  return { key, perMonth, outlier, isNew, avg, total: perMonth.reduce<number>((s, v) => s + (v ?? 0), 0), flagged: outlier.some(Boolean) }
}

/**
 * Per category and, inside each, per merchant, over the window: spending when kind is
 * "expense" (positive, refunds lowering the cell) or money received when it is "income"
 * (positive). Transfers are built separately by the caller, since they net out.
 */
export function buildPeriod(
  txs: PeriodTx[], window: string[], baseline = baselineMonths(window), kind: 'expense' | 'income' = 'expense',
): CategoryGroup[] {
  const months = new Set([...window, ...baseline, ...monthWindow(window.at(-1) ?? '', window.length + NEW_LOOKBACK)])
  const since = txs.reduce((m, t) => (t.month < m ? t.month : m), '9999-12')
  const sign = kind === 'expense' ? -1 : 1
  const cats = new Map<string, { sums: Map<string, number>; merchants: Map<string, Map<string, number>> }>()
  for (const t of txs) {
    if (t.kind !== kind || !months.has(t.month)) continue
    const c = cats.get(t.categoryName) ?? { sums: new Map(), merchants: new Map() }
    const mk = t.merchant || '(sem estabelecimento)'
    const ms = c.merchants.get(mk) ?? new Map<string, number>()
    // Both kinds read positive: spending is the negated value, income the value itself.
    // A refund inside an expense category still lowers that month's cell.
    c.sums.set(t.month, (c.sums.get(t.month) ?? 0) + sign * t.value)
    ms.set(t.month, (ms.get(t.month) ?? 0) + sign * t.value)
    c.merchants.set(mk, ms)
    cats.set(t.categoryName, c)
  }
  const inWindow = (r: PeriodRow) => r.perMonth.some((v) => v !== null && Math.abs(v) > 0.005)
  return [...cats].map(([name, c]) => ({
    ...finish(name, c.sums, window, baseline, since),
    merchants: [...c.merchants].map(([m, sums]) => finish(m, sums, window, baseline, since)).filter(inWindow).sort((a, b) => b.total - a.total),
  })).filter(inWindow).sort((a, b) => b.total - a.total)
}

const dayBefore = (month: string) => new Date(Date.parse(`${month}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }

/**
 * Per month, for the given accounts summed in the display currency: the balance at the
 * start (end of the previous day), money in, money out (positive) and the balance at the
 * end. Before an account's first transaction its balance is the opening balance. Transfers
 * between the accounts count on both sides, so start + in - out = end (up to exchange
 * rates moving within the month for accounts in another currency).
 */
export function monthBalances(
  accounts: Account[], txs: Transaction[], months: string[],
  convert: (amount: number, from: Currency, date: string) => number,
) {
  const series = accounts.map((a) => ({ a, s: balanceSeries(a, txs) }))
  const at = (date: string) => series.reduce((sum, { a, s }) => {
    let bal = Number(a.opening_balance)
    for (const p of s) { if (p.date > date) break; bal = p.balance }
    return sum + convert(bal, a.currency, date)
  }, 0)
  const ids = new Set(accounts.map((a) => a.id))
  const cur = new Map(accounts.map((a) => [a.id, a.currency]))
  const idx = new Map(months.map((m, i) => [m, i]))
  const inflow = months.map(() => 0), outflow = months.map(() => 0)
  for (const t of txs) {
    const i = idx.get(t.booking_date.slice(0, 7))
    if (i === undefined || !ids.has(t.account_id)) continue
    const v = convert(Number(t.amount), cur.get(t.account_id)!, t.booking_date)
    if (v >= 0) inflow[i] += v
    else outflow[i] -= v
  }
  return { opening: months.map((m) => at(dayBefore(m))), inflow, outflow, closing: months.map((m) => at(lastDay(m))) }
}

/** Why a recurring charge deserves a look, or null when it is running as usual. */
export function subscriptionReview(s: Subscription, today: string): string | null {
  const daysTo = Math.round((Date.parse(s.nextDate) - Date.parse(today)) / 86400000)
  if (s.status === 'possibly_cancelled') return 'parou de cobrar: confirme se foi cancelada'
  if (s.priceChangePct > 0.05) return `preço subiu ${Math.round(s.priceChangePct * 100)}%`
  if (s.status === 'new') return 'assinatura nova: confirme se é esperada'
  if (s.cadence === 'yearly' && daysTo >= 0 && daysTo <= 30) return `renovação anual em ${daysTo} dias`
  return null
}
