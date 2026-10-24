import { useMemo } from 'react'
import type { Ctx } from '../App'
import { balanceSeries, lastCompleteMonths } from '../domain/analytics'
import { detectSubscriptions } from '../domain/subscriptions'
import { isTithe } from '../domain/categorize'
import { money } from './format'
import type { AppData } from './data'
import type { Account } from '../domain/types'

export const today = () => new Date().toISOString().slice(0, 10)
/** The month every page opens on: the current one, even before its first transaction. */
export const currentMonth = () => today().slice(0, 7)

/**
 * The account every page opens on: the BCP checking account (the joint account). With
 * none yet, every account; the others are always one click away in each page's menu.
 */
export function mainAccountIds(accounts: Account[]): Set<string> {
  const main = accounts.filter((a) => a.bank === 'BCP' && a.type === 'checking')
  return new Set((main.length ? main : accounts).map((a) => a.id))
}
/** Every account but the main one(s): the starting "hidden" set of the account menus. */
export const hiddenByDefault = (accounts: Account[]) => {
  const main = mainAccountIds(accounts)
  return new Set(accounts.filter((a) => !main.has(a.id)).map((a) => a.id))
}

/**
 * How recent the numbers on screen are, per account: the latest date the app knows about
 * it — the last transaction up to today, or the last balance read from a bank statement,
 * whichever is later. Future-dated card instalments do not count.
 */
export function positionDates(data: AppData, ids: Iterable<string>) {
  const want = new Set(ids)
  const until = today()
  const last = new Map<string, string>()
  const bump = (id: string, d: string) => { if (want.has(id) && d <= until && d > (last.get(id) ?? '')) last.set(id, d) }
  for (const t of data.transactions) bump(t.account_id, t.booking_date)
  for (const c of data.checkpoints) bump(c.account_id, c.date)
  return data.accounts.filter((a) => want.has(a.id)).map((a) => ({ account: a, date: last.get(a.id) ?? null }))
}

/**
 * Current balance of each account in display currency. Cards are left out: without the
 * bank's statement balance their running sum is not a balance, and what they owe is
 * already paid from (and shown in) the linked account.
 */
export function useBalances(ctx: Ctx) {
  return useMemo(() => ctx.data.accounts.filter((a) => a.type !== 'card').map((a) => {
    const series = balanceSeries(a, ctx.data.transactions)
    const native = series.at(-1)?.balance ?? a.opening_balance
    return { account: a, native, display: ctx.fx.convert(native, a.currency, ctx.currency, today()), series }
  }), [ctx])
}

export function useSubscriptions(ctx: Ctx) {
  return useMemo(() => detectSubscriptions(
    ctx.etx.filter((t) => !isTithe(t.categoryName)).map((t) => ({ booking_date: t.booking_date, amount: t.value, merchant: t.merchant, kind: t.kind })), today(),
  ), [ctx.etx])
}

export const useFmt = (ctx: Ctx) => useMemo(() => money(ctx.currency), [ctx.currency])
export const last3 = () => lastCompleteMonths(new Date(), 3)
