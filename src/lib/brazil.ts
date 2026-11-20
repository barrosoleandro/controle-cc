import { useMemo } from 'react'
import type { Ctx } from '../App'
import { CARD_PAYMENT, isTithe } from '../domain/categorize'
import { countryOf } from '../domain/countries'
import { applyBillMarks, arrivalsInBrazil, brazilCard, brazilTransfer, forecastNextMonth, isCardBillPayment, monthlyBills, nextMonthOf, sentToBrazil } from '../domain/forecast'
import { today, useBalances } from './hooks'

export const CARD_LINE = 'Fatura do cartão Itaú'
/** The transfer that feeds the Brazilian account, as a line of the month plan. */
export const WISE_LINE = 'Transferência para o Itaú (Wise)'
/** How that transfer reads in the account it leaves from. */
export const WISE = /\bWISE\b/i

/**
 * What to send from the French account to Brazil before next month starts, in reais: the card bill
 * and the recurring payments of the Itaú checking account, less its balance today; with the lines
 * behind the figure and the transfer already received there this month. Null with no Brazilian
 * account in the app. It ignores any account filter: it is about the Itaú accounts.
 * One place, so the alert on Painel and the line on Previsão give the same figure.
 */
export function useBrazilSend(ctx: Ctx) {
  const { data, fx } = ctx
  const balances = useBalances(ctx)
  return useMemo(() => {
    const now = today()
    const brIds = new Set(data.accounts.filter((a) => countryOf(a.bank) === 'Brasil').map((a) => a.id))
    if (!brIds.size) return null
    const brTx = ctx.etx.filter((t) => brIds.has(t.account_id)).map((t) => ({ ...t, value: fx.convert(t.amount, t.currency, 'BRL', t.booking_date) }))
    // The card payment in the checking account is the bill itself, counted apart: not a recurring charge.
    const skipBr = (n: string) => isTithe(n) || n === 'Cartão Itaú'
    // Only the Itaú checking account counts here: card purchases already are in the bill, so a
    // yearly charge on the card would be counted twice.
    const checkingIds = new Set(data.accounts.filter((a) => brIds.has(a.id) && a.type !== 'card').map((a) => a.id))
    // The bill payment itself is left out (the bill is counted apart); the account's own fees stay.
    const brChecking = brTx.filter((t) => checkingIds.has(t.account_id) && !isCardBillPayment(t))
    const marksBr = data.settings.dashboard?.billMarks ?? {}
    const br0 = forecastNextMonth(brChecking, now, skipBr, 3, marksBr)
    // Monthly bills come from the checking account (health plan, power, phone, condo…), whatever
    // the amount does from month to month; the non-monthly ones stay as detected.
    const periodicNames = new Set(br0.periodic.map((l) => l.label))
    const bills = applyBillMarks(monthlyBills(brChecking, now, skipBr).filter((l) => !periodicNames.has(l.label)), brChecking, marksBr)
    const br = { ...br0, monthly: bills.reduce((a, l) => a + l.amount, 0), monthlyLines: bills }
    // The card bill that falls in the coming month: the imported open bills, or, while none is
    // imported, the card purchases already assigned to that month's bill (statement_due) or, failing
    // that, made this month, which is what that bill will carry.
    const next = nextMonthOf(now)
    const cardIds = new Set(data.accounts.filter((a) => brIds.has(a.id) && a.type === 'card').map((a) => a.id))
    const openBills = brazilCard(data.cardStatements, cardIds, now.slice(0, 7)).open
    const cardBuys = brTx.filter((t) => cardIds.has(t.account_id) && t.amount < 0 && t.bank_category !== CARD_PAYMENT)
    const dueNext = cardBuys.filter((t) => t.statement_due?.slice(0, 7) === next)
    const cardNext = openBills > 0 ? openBills
      : -(dueNext.length ? dueNext : cardBuys.filter((t) => t.month === now.slice(0, 7))).reduce((a, t) => a + t.value, 0)
    const balance = balances.filter((b) => brIds.has(b.account.id) && b.account.type === 'checking').reduce((s, b) => s + fx.convert(b.native, b.account.currency, 'BRL', now), 0)
    return {
      ...brazilTransfer(br, cardNext, balance, now),
      lines: [{ label: CARD_LINE, amount: cardNext, date: '' }, ...br.monthlyLines, ...br.periodic],
      sent: sentToBrazil(brTx, now.slice(0, 7)),
      arrivals: arrivalsInBrazil(brTx),
    }
  }, [ctx.etx, data.accounts, data.cardStatements, data.settings.dashboard?.billMarks, balances, fx])
}
