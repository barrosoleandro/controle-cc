import type { Subscription } from './subscriptions'

/** What the period view needs from an enriched transaction (value is signed, display currency). */
export interface PeriodTx { month: string; value: number; categoryName: string; merchant: string; kind: string }

export interface PeriodRow {
  key: string
  perMonth: (number | null)[] // spending per window month; null = nothing that month
  outlier: boolean[] // per window month: well above this row's usual month
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

function finish(key: string, sums: Map<string, number>, window: string[], baseline: string[]): PeriodRow {
  const perMonth = window.map((m) => (sums.has(m) ? sums.get(m)! : null))
  const avg = baseline.reduce((s, m) => s + (sums.get(m) ?? 0), 0) / Math.max(1, baseline.length)
  const outlier = perMonth.map((v) => v !== null && v >= avg * OUT_RATIO && v - avg >= OUT_MIN)
  return { key, perMonth, outlier, avg, total: perMonth.reduce<number>((s, v) => s + (v ?? 0), 0), flagged: outlier.some(Boolean) }
}

/** Spending per category and, inside each, per merchant, over the window. Expenses only. */
export function buildPeriod(txs: PeriodTx[], window: string[], baseline = baselineMonths(window)): CategoryGroup[] {
  const months = new Set([...window, ...baseline])
  const cats = new Map<string, { sums: Map<string, number>; merchants: Map<string, Map<string, number>> }>()
  for (const t of txs) {
    if (t.kind !== 'expense' || !months.has(t.month)) continue
    const c = cats.get(t.categoryName) ?? { sums: new Map(), merchants: new Map() }
    const mk = t.merchant || '(sem estabelecimento)'
    const ms = c.merchants.get(mk) ?? new Map<string, number>()
    // Spending is positive; a refund in the same month lowers the cell.
    c.sums.set(t.month, (c.sums.get(t.month) ?? 0) - t.value)
    ms.set(t.month, (ms.get(t.month) ?? 0) - t.value)
    c.merchants.set(mk, ms)
    cats.set(t.categoryName, c)
  }
  const inWindow = (r: PeriodRow) => r.perMonth.some((v) => v !== null && Math.abs(v) > 0.005)
  return [...cats].map(([name, c]) => ({
    ...finish(name, c.sums, window, baseline),
    merchants: [...c.merchants].map(([m, sums]) => finish(m, sums, window, baseline)).filter(inWindow).sort((a, b) => b.total - a.total),
  })).filter(inWindow).sort((a, b) => b.total - a.total)
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
