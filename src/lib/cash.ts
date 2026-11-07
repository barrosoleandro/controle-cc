import { useMemo } from 'react'
import type { Ctx } from '../App'
import { CARD_BILL, matchBillDebits, matchCardPayments } from '../domain/cards'
import { countryOf } from '../domain/countries'
import { SENT_BR, transfersToBrazil } from '../domain/monthEnd'
import type { Currency } from '../domain/types'

/**
 * On Lançamentos and in the month estimate the Itaú card is one line: the bill paid from the account, under "Cartão Itaú"
 * (spending, not a transfer). Its purchases are left out (`shown` has no card accounts) and
 * stay on the Cartões page.
 */
export function useBillsAsSpending(ctx: Ctx): Ctx['etx'] {
  const { data } = ctx
  return useMemo(() => {
    const viaPayment = matchCardPayments(data.accounts, data.transactions).map((m) => m.bankTx.id)
    const paid = new Set([...viaPayment, ...matchBillDebits(data.accounts, data.cardStatements, data.transactions, new Set(viaPayment)).map((m) => m.bankTx.id)])
    return ctx.etx.map((t) => (paid.has(t.id) ? { ...t, kind: 'expense' as const, categoryName: CARD_BILL } : t))
  }, [ctx.etx, data.accounts, data.transactions, data.cardStatements])
}

/**
 * Cash rows of the accounts on screen (cards never: their bill is the line). With the Itaú checking
 * account not on screen, what the euro account sends there is cash out ("Transferência para o
 * Brasil", the Itaú card included in it); with it on screen, the transfer stays internal.
 */
export function useCashTxs(ctx: Ctx, shown: (accountId: string) => boolean): Ctx['etx'] {
  const billsEtx = useBillsAsSpending(ctx)
  const { accounts } = ctx.data
  const cash = useMemo(() => new Set(accounts.filter((a) => a.type !== 'card').map((a) => a.id)), [accounts])
  const brIds = useMemo(() => new Set(accounts.filter((a) => countryOf(a.bank) === 'Brasil').map((a) => a.id)), [accounts])
  const toBrazil = useMemo(() => transfersToBrazil(
    ctx.etx.map((t) => ({ id: t.id, account_id: t.account_id, date: t.booking_date, amount: Number(t.amount), currency: t.currency, description: t.description, kind: t.kind })),
    (id) => brIds.has(id), (a, from, to, d) => ctx.fx.convert(a, from as Currency, to as Currency, d)), [ctx.etx, brIds, ctx.fx])
  const brShown = accounts.some((a) => brIds.has(a.id) && cash.has(a.id) && shown(a.id))
  return useMemo(() => billsEtx.filter((t) => cash.has(t.account_id) && shown(t.account_id))
    .map((t) => (!brShown && toBrazil.has(t.id) ? { ...t, kind: 'expense' as const, categoryName: SENT_BR } : t)), [billsEtx, cash, shown, brShown, toBrazil])
}
