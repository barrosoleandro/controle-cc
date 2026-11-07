/**
 * End-of-month estimate: what is already in the month (real) plus what is still expected, per
 * category. The baseline is the month plan (3-month average, recurring lines still to come, manual
 * lines). A local model may replace the per-category full-month figure, reading 12 months of
 * history (trend, seasonality); the code then bounds what it says, so a weak or confused model can
 * move an estimate inside a sane range but can never produce an absurd total.
 * Values are positive, in the display currency.
 */
import type { MonthPlan, PlanTx } from './monthPlan'
import { EXTERNAL } from './audit'

export interface MonthEndCat {
  key: string // `${kind}/${name}`
  name: string
  kind: 'income' | 'expense'
  /** Full-month totals of the complete months before, oldest first. */
  history: number[]
  realizado: number
  /** Already known for the rest of the month: manual lines plus recurring lines still to come. */
  known: number
  /** The month plan's figure (average-based): the fallback when the model has nothing usable. */
  base: number
}

export interface MonthEndRow extends MonthEndCat { previsto: number; source: 'ia' | 'media' }
export interface MonthEnd {
  rows: MonthEndRow[]
  income: number
  expense: number
  resultado: number
  /** Result of what has really happened so far (no manual lines, no expectations). */
  realResultado: number
  /** Still to come in the month: income − expense, beyond what is already in the accounts. */
  remaining: number
  /** True when at least one category came from the model. */
  usedAi: boolean
}

const signed = (kind: 'income' | 'expense', v: number) => (kind === 'income' ? v : -v)

/** The categories of the month plan with their monthly history, ready for the model and the combination. */
export function monthEndFacts(plan: MonthPlan, txs: PlanTx[], histMonths: string[]): MonthEndCat[] {
  const idx = new Map(histMonths.map((m, i) => [m, i]))
  const hist = new Map<string, number[]>()
  for (const t of txs) {
    const i = idx.get(t.month)
    // One-off money from or to outside never makes a pattern.
    if (i === undefined || t.kind === 'transfer' || t.categoryName === EXTERNAL) continue
    const key = `${t.kind}/${t.categoryName}`
    const h = hist.get(key) ?? histMonths.map(() => 0)
    h[i] += signed(t.kind, t.value)
    hist.set(key, h)
  }
  const round = (v: number) => Math.round(v * 100) / 100
  return [...plan.income, ...plan.expense].map((r) => {
    const key = `${r.kind}/${r.name}`
    return {
      key, name: r.name, kind: r.kind,
      history: (hist.get(key) ?? histMonths.map(() => 0)).map(round),
      realizado: round(r.realizado),
      known: round(r.manual + r.recorrente),
      base: round(r.previsto),
    }
  })
}

/**
 * The model's full-month figure, bounded: never below what is real plus already known (money
 * spent cannot be unspent), never above 1.5× the largest of the history, the real and the
 * baseline. Missing or invalid → the baseline.
 */
export function boundEstimate(c: MonthEndCat, ai: number | undefined): { previsto: number; source: 'ia' | 'media' } {
  if (ai === undefined || !Number.isFinite(ai) || ai < 0) return { previsto: c.base, source: 'media' }
  const floor = c.realizado + c.known
  const cap = Math.max(floor, c.base, ...c.history) * 1.5
  return { previsto: Math.min(cap, Math.max(floor, ai)), source: 'ia' }
}

export function combineMonthEnd(cats: MonthEndCat[], ai: Map<string, number> | null): MonthEnd {
  const rows = cats.map((c) => ({ ...c, ...boundEstimate(c, ai?.get(c.key)) }))
  const sum = (kind: 'income' | 'expense', f: (r: MonthEndRow) => number) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + f(r), 0)
  const income = sum('income', (r) => r.previsto), expense = sum('expense', (r) => r.previsto)
  const realResultado = sum('income', (r) => r.realizado) - sum('expense', (r) => r.realizado)
  const resultado = income - expense
  return { rows, income, expense, resultado, realResultado, remaining: resultado - realResultado, usedAi: rows.some((r) => r.source === 'ia') }
}
