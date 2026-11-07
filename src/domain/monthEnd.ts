/**
 * The current month at its end: what is already in (real) plus what is still expected (estimate),
 * per category, from the month plan. Money comes in only through the BCP accounts: the other
 * accounts are fed by transfers from it, so their incomes are left out before the plan is built
 * (see lib/plan). The estimate of each category can come from the app (the plan's `falta`) or
 * from the local model, which only proposes `falta` per category: the sums are always done here.
 */
import type { MonthPlan, PlanRow } from './monthPlan'
import { nextMonth } from './monthPlan'

/** A salary credited from this day on is the next month's (it is paid at the end of the month before). */
export const SALARY_FROM_DAY = 20

/** Moves each salary credited late in a month to the month it is for, so each month has its own. */
export function shiftSalary<T extends { kind: string; categoryName: string; booking_date: string; month: string }>(txs: T[], salary: string | undefined): T[] {
  if (!salary) return txs
  return txs.map((t) => (t.kind === 'income' && t.categoryName === salary && Number(t.booking_date.slice(8, 10)) >= SALARY_FROM_DAY
    ? { ...t, month: nextMonth(t.month) } : t))
}

export const rowKey = (r: Pick<PlanRow, 'kind' | 'name'>) => `${r.kind}/${r.name}`

export interface MonthEndSide { real: number; estimado: number; total: number }
export interface MonthEndRow { key: string; name: string; kind: 'income' | 'expense'; real: number; app: number; usado: number }
export interface MonthEnd {
  month: string
  receitas: MonthEndSide
  despesas: MonthEndSide
  resultado: MonthEndSide
  saldoHoje: number
  /** Today's balance plus what is still to come in, less what is still to go out, this month. */
  saldoFim: number
  /** The next month's salary, when it is expected before the month ends and is not in yet. */
  proximoSalario: number
  /** saldoFim as the bank will show it: with the next month's salary already credited. */
  saldoFimBanco: number
  rows: MonthEndRow[]
}

/**
 * `estimate`: what is still expected per category (rowKey → value ≥ 0), replacing the app's `falta`;
 * a category it does not name keeps the app's. Manual lines are counted as still to come.
 */
export function monthEnd(plan: MonthPlan, saldoHoje: number, proximoSalario = 0, estimate?: Map<string, number>): MonthEnd {
  const rows: MonthEndRow[] = [...plan.income, ...plan.expense].map((r) => {
    const app = r.manual + r.falta
    const own = estimate?.get(rowKey(r))
    return { key: rowKey(r), name: r.name, kind: r.kind, real: r.realizado, app, usado: own === undefined ? app : r.manual + own }
  })
  const side = (kind: 'income' | 'expense'): MonthEndSide => {
    const list = rows.filter((r) => r.kind === kind)
    const real = list.reduce((s, r) => s + r.real, 0), estimado = list.reduce((s, r) => s + r.usado, 0)
    return { real, estimado, total: real + estimado }
  }
  const receitas = side('income'), despesas = side('expense')
  const resultado = { real: receitas.real - despesas.real, estimado: receitas.estimado - despesas.estimado, total: receitas.total - despesas.total }
  const saldoFim = saldoHoje + receitas.estimado - despesas.estimado
  return { month: plan.month, receitas, despesas, resultado, saldoHoje, saldoFim, proximoSalario, saldoFimBanco: saldoFim + proximoSalario, rows }
}
