import { useMemo } from 'react'
import type { Ctx } from '../App'
import { balanceSeries, lastCompleteMonths } from '../domain/analytics'
import { detectSubscriptions } from '../domain/subscriptions'
import { money } from './format'

export const today = () => new Date().toISOString().slice(0, 10)

/** Current balance of each account in display currency. */
export function useBalances(ctx: Ctx) {
  return useMemo(() => ctx.data.accounts.map((a) => {
    const series = balanceSeries(a, ctx.data.transactions)
    const native = series.at(-1)?.balance ?? a.opening_balance
    return { account: a, native, display: ctx.fx.convert(native, a.currency, ctx.currency, today()), series }
  }), [ctx])
}

export function useSubscriptions(ctx: Ctx) {
  return useMemo(() => detectSubscriptions(
    ctx.etx.map((t) => ({ booking_date: t.booking_date, amount: t.value, merchant: t.merchant, kind: t.kind })), today(),
  ), [ctx.etx])
}

export const useFmt = (ctx: Ctx) => useMemo(() => money(ctx.currency), [ctx.currency])
export const last3 = () => lastCompleteMonths(new Date(), 3)
