import { useMemo } from 'react'
import type { Ctx } from '../App'
import { buildMonthPlan, recurringExpectations, shareOfSalary, steadyIncomes, withExpenseLine } from '../domain/monthPlan'
import { isTithe } from '../domain/categorize'
import { TITHE_RATE } from '../domain/simulation'
import { countryOf } from '../domain/countries'
import { useBrazilSend, WISE, WISE_LINE } from './brazil'
import { coveredMonth } from '../domain/forecast'
import { billEffective } from '../domain/forecast'
import { shiftSalary } from '../domain/monthEnd'
import { last3, today, useExternalized } from './hooks'
import { round2 } from '../domain/util'
import { useRecurring } from './recurring'

/**
 * What the user set as still to come in `month`, per category (rowKey → value in the display
 * currency, manual lines included), saved in the account. It wins over every estimate, on the
 * month-end box of Painel and on Previsão alike. `setPlanned(key, null)` goes back to the estimate.
 * Saving throws when it fails, so each screen says so its own way.
 */
export function usePlanned(ctx: Ctx, month: string) {
  const { data, fx, currency } = ctx
  const saved = data.settings.dashboard?.monthEndPlan?.[month]
  const planned = useMemo(() => (saved ? new Map(Object.entries(saved.falta).map(([k, v]) =>
    [k, saved.currency === currency ? v : round2(fx.convert(v, saved.currency, currency, today()))])) : undefined), [saved, currency, fx])
  async function savePlan(falta: Map<string, number>) {
    const all = { ...data.settings.dashboard?.monthEndPlan }
    if (falta.size) all[month] = { currency, falta: Object.fromEntries(falta) }
    else delete all[month]
    await ctx.patchSettings({ dashboard: { ...data.settings.dashboard, monthEndPlan: all } })
  }
  const setPlanned = (key: string, v: number | null) => {
    const next = new Map(planned)
    if (v === null) next.delete(key); else next.set(key, round2(Math.max(0, v)))
    return savePlan(next)
  }
  return { planned, savePlan, setPlanned }
}

/** The transfer to Brazil that pays for a month: sent so far (display currency), still to send, and when it went. */
export interface WiseMonth { realizado: number; falta: number; sentOn: string | null; arrivedBrl: number }

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
  // The transfer that pays the bills in Brazil (Wise → Itaú) leaves the accounts in scope, so it is a
  // line of the plan, in the month it pays for: one made from the 20th on, with the salary, is for the
  // month after (as the salary itself, see shiftSalary). Once a transfer for the month went (out of
  // the account here, or arrived in Brazil), nothing more is expected for it. Not when a Brazilian
  // account is in scope too: then its own bills already are in the plan.
  const send = useBrazilSend(ctx)
  const wise = useMemo(() => {
    const scope = data.accounts.filter((a) => a.type !== 'card' && inScope(a.id))
    if (!send || !scope.length || scope.some((a) => countryOf(a.bank) === 'Brasil')) return null
    const now = today()
    const toDisplay = (brl: number) => fx.convert(brl, 'BRL', ctx.currency, now)
    return (m: string): WiseMonth => {
      const out = txs.filter((t) => t.value < 0 && WISE.test(t.description) && coveredMonth(t.booking_date) === m)
      const arrived = send.arrivals.filter((a) => coveredMonth(a.date) === m)
      const dates = [...out.map((t) => t.booking_date), ...arrived.map((a) => a.date)].sort()
      return {
        // Sent as a transfer it is in no category; with no other side in the app it already counts as an expense.
        realizado: -out.filter((t) => t.kind === 'transfer').reduce((s, t) => s + t.value, 0),
        falta: dates.length ? 0 : toDisplay(send.transfer),
        sentOn: dates.at(-1) ?? null,
        arrivedBrl: arrived.reduce((s, a) => s + a.amount, 0),
      }
    }
  }, [send, data.accounts, inScope, txs, fx, ctx.currency])
  // The tithe is always 10% of the salary of the month: expected from the salary, not from its average.
  const tithe = useMemo(() => data.categories.find((c) => c.kind === 'expense' && isTithe(c.name))?.name, [data.categories])
  const plans = useMemo(() => months.map((m) => {
    const built = buildMonthPlan(txs, manual, m, avgMonths, recurring)
    const plan = tithe ? shareOfSalary(built, salary, tithe, TITHE_RATE) : built
    const w = wise?.(m)
    return w ? withExpenseLine(plan, WISE_LINE, w.realizado, w.falta) : plan
  }), [txs, manual, key, avgMonths, recurring, wise, tithe, salary]) // eslint-disable-line react-hooks/exhaustive-deps
  return { txs, lines, manual, plans, avgMonths, recurring, periods, send, wise }
}
