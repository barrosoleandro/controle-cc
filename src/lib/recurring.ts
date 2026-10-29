import { useCallback, useMemo } from 'react'
import type { Ctx } from '../App'
import { countryOf } from '../domain/countries'
import { billEffective, markHistory, monthlyBills } from '../domain/forecast'
import { isTithe } from '../domain/categorize'
import { currentMonth, today } from './hooks'

/** Never offered or guessed as recurring: tithe and the Itaú card bill (its purchases are counted instead). */
export const skipRecurring = (n: string) => isTithe(n) || n === 'Cartão Itaú'

/**
 * Recurring expenses. The flag is per merchant and one click marks its whole history; the latest
 * mark decides from then on. Unmarked merchants of the Brazilian checking account start as the
 * automatic guess (they feed the transfer estimate); the rest start as not recurring.
 */
export function useRecurring(ctx: Ctx) {
  const { data, etx } = ctx
  const brChecking = useMemo(() => new Set(data.accounts.filter((a) => countryOf(a.bank) === 'Brasil' && a.type !== 'card').map((a) => a.id)), [data.accounts])
  const marks = useMemo(() => data.settings.dashboard?.billMarks ?? {}, [data.settings.dashboard?.billMarks])
  const autoBills = useMemo(() => new Set(monthlyBills(
    etx.filter((t) => brChecking.has(t.account_id)).map((t) => ({ ...t, value: ctx.fx.convert(t.amount, t.currency, 'BRL', t.booking_date) })),
    today(), skipRecurring).map((l) => l.label)), [etx, brChecking, ctx.fx])
  const isBill = useCallback((t: { merchant: string }) => billEffective(t.merchant, marks, autoBills.has(t.merchant)), [marks, autoBills])
  async function setRecurring(merchant: string, on: boolean) {
    const months = [...etx.filter((t) => t.merchant === merchant).map((t) => t.month), currentMonth()]
    await ctx.patchSettings({ dashboard: { ...data.settings.dashboard, billMarks: markHistory(marks, merchant, months, on) } })
  }
  return { marks, isBill, setRecurring }
}
