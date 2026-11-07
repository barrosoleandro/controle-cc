import { useMemo } from 'react'
import type { Ctx } from '../App'
import { buildMonthPlan, recurringExpectations, steadyIncomes } from '../domain/monthPlan'
import { billEffective } from '../domain/forecast'
import { shiftSalary } from '../domain/monthEnd'
import { last3, useExternalized } from './hooks'
import { useRecurring } from './recurring'

export interface PlanOptions {
  /** Only incomes of these accounts count (e.g. BCP, the only way money comes in); the rest are fed by transfers. */
  incomeFrom?: (accountId: string) => boolean
  /** Salary category: a salary credited from the 20th on counts in the month it is for. */
  salary?: string
}

/**
 * The month plans of Previsão, for the accounts in scope: imported transactions (with transfers
 * that have no other side as money in or out), the manual lines, and the recurring lines still
 * expected, against the average of the last 3 complete months. One place, so the Previsão page
 * and the month-end box on Painel and Lançamentos give the same figures.
 */
export function useMonthPlans(ctx: Ctx, inScope: (accountId: string) => boolean, months: readonly string[], opts: PlanOptions = {}) {
  const { data, fx } = ctx
  const avgMonths = useMemo(() => last3(), [])
  const { incomeFrom, salary } = opts
  const all = useExternalized(ctx)
  const txs = useMemo(() => shiftSalary(all.filter((t) => inScope(t.account_id) && (t.kind !== 'income' || !incomeFrom || incomeFrom(t.account_id))), salary),
    [all, inScope, incomeFrom, salary])
  // Manual lines are not tied to an account: their incomes count only when an income account is in scope.
  const incomeInScope = useMemo(() => !incomeFrom || data.accounts.some((a) => inScope(a.id) && incomeFrom(a.id)), [data.accounts, inScope, incomeFrom])
  const lines = useMemo(() => data.settings.dashboard?.manualLines ?? [], [data.settings.dashboard?.manualLines])
  const catById = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  // A manual line takes its sign from its category: an income category adds, the rest subtract.
  const manual = useMemo(() => lines.map((l) => {
    const c = catById.get(l.category_id)
    const kind = c?.kind ?? 'expense'
    const v = fx.convert(Math.abs(l.amount), l.currency, ctx.currency, l.date)
    return { line: l, month: l.month, kind, categoryName: c?.name ?? 'Outros', value: kind === 'income' ? v : -v, merchant: l.merchant }
  }).filter((m) => m.kind !== 'income' || incomeInScope), [lines, catById, fx, ctx.currency, incomeInScope])
  // Recurring lines not in the month yet show as expected: expenses by the flag of Lançamentos,
  // incomes by that flag or, unmarked, by having come in every one of the last 3 months (salary).
  const { isBill, marks } = useRecurring(ctx)
  // Each one is expected every `period` months (bimonthly bills only every other month), see recurringExpectations.
  const periods = useMemo(() => data.settings.dashboard?.billPeriods ?? {}, [data.settings.dashboard?.billPeriods])
  const steady = useMemo(() => steadyIncomes(txs, avgMonths), [txs, avgMonths])
  const recurring = useMemo(() => recurringExpectations(txs,
    (m, kind) => (kind === 'expense' ? isBill({ merchant: m }) : billEffective(m, marks, steady.has(m))), avgMonths, periods), [txs, isBill, marks, steady, avgMonths, periods])
  const key = months.join()
  const plans = useMemo(() => months.map((m) => buildMonthPlan(txs, manual, m, avgMonths, recurring)), [txs, manual, key, avgMonths, recurring]) // eslint-disable-line react-hooks/exhaustive-deps
  return { txs, lines, manual, plans, avgMonths, recurring, periods }
}
