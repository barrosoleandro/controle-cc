import type { Account } from './types'
import { CARD_PAYMENT } from './categorize'

export interface StoredCardStatement {
  account_id: string
  due_date: string
  total: number
  status: 'paga' | 'aberta'
}

/** What matching needs from a stored transaction. */
export interface PayTx { id: string; account_id: string; booking_date: string; amount: number; bank_category?: string | null }

const DAY = 86400000
const WINDOW_DAYS = 5 // the card may credit the payment a day or two after the account debit

/**
 * Pairs each bill payment recorded on a card ("Pagamento Efetuado", imported from the
 * fatura) with the debit that paid it in the card's paying account: same amount to the
 * cent, closest date within WINDOW_DAYS, each debit used once.
 *
 * Those debits are transfers between the user's own accounts — the spending is the card
 * purchases themselves. Payments that no imported fatura mentions are left alone and
 * stay "Cartão Itaú" (an expense), so months without card detail keep their total.
 */
export function matchCardPayments(accounts: Account[], txs: PayTx[]) {
  const parentOf = new Map(accounts.filter((a) => a.type === 'card' && a.parent_account_id).map((a) => [a.id, a.parent_account_id!]))
  const used = new Set<string>()
  const out: { cardTx: PayTx; bankTx: PayTx }[] = []
  const payments = txs
    .filter((t) => parentOf.has(t.account_id) && t.bank_category === CARD_PAYMENT && Number(t.amount) > 0)
    .sort((a, b) => a.booking_date.localeCompare(b.booking_date))
  for (const p of payments) {
    const parent = parentOf.get(p.account_id)
    const at = Date.parse(p.booking_date)
    const best = txs
      .filter((t) => t.account_id === parent && !used.has(t.id) && Math.abs(Number(t.amount) + Number(p.amount)) < 0.005)
      .map((t) => ({ t, gap: Math.abs(Date.parse(t.booking_date) - at) / DAY }))
      .filter((c) => c.gap <= WINDOW_DAYS)
      .sort((a, b) => a.gap - b.gap)[0]
    if (!best) continue
    used.add(best.t.id)
    out.push({ cardTx: p, bankTx: best.t })
  }
  return out
}

/** The payment that settled a bill: recorded on the card near the due date, for the billed amount. */
export function billPayment<T extends PayTx>(bill: StoredCardStatement, cardTxs: T[]): T | undefined {
  const due = Date.parse(bill.due_date)
  return cardTxs
    .filter((t) => t.account_id === bill.account_id && t.bank_category === CARD_PAYMENT && Math.abs(Number(t.amount) - bill.total) < 0.005)
    .map((t) => ({ t, gap: Math.abs(Date.parse(t.booking_date) - due) / DAY }))
    .filter((c) => c.gap <= 10)
    .sort((a, b) => a.gap - b.gap)[0]?.t
}
