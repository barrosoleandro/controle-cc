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

/**
 * Debits in the paying account that settle an imported bill, even when the payment itself is
 * only recorded on the next (not imported) bill: exactly the bill total, from 10 days before
 * to 5 days after the due date, each debit used once. Its purchases are already in the card,
 * so the debit is a transfer, not a second expense.
 */
export function matchBillDebits(accounts: Account[], bills: StoredCardStatement[], txs: PayTx[], alreadyUsed: Set<string> = new Set()) {
  const parentOf = new Map(accounts.filter((a) => a.type === 'card' && a.parent_account_id).map((a) => [a.id, a.parent_account_id!]))
  const used = new Set(alreadyUsed)
  const out: { bill: StoredCardStatement; bankTx: PayTx }[] = []
  for (const bill of [...bills].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    const parent = parentOf.get(bill.account_id)
    if (!parent || !(Number(bill.total) > 0)) continue
    const due = Date.parse(bill.due_date)
    const best = txs
      .filter((t) => t.account_id === parent && !used.has(t.id) && Math.abs(Number(t.amount) + Number(bill.total)) < 0.005)
      .map((t) => ({ t, d: (Date.parse(t.booking_date) - due) / DAY }))
      .filter((c) => c.d >= -10 && c.d <= 5)
      .sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0]
    if (!best) continue
    used.add(best.t.id)
    out.push({ bill, bankTx: best.t })
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

/** What the instalment estimate needs from a card transaction. */
export interface InstalmentTx { description: string; amount: number; statement_due?: string | null; category_id?: string | null }

export interface FutureParcel { purchase: string; k: number; n: number; amount: number; category_id: string | null }
export interface FutureBill { due: string; total: number; parcels: FutureParcel[] }

const PARCEL = /^(.*?)\s*\((\d+)\/(\d+)\)$/

/** yyyy-mm-dd plus n months, clamped to the month's last day. */
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10)
}

/**
 * Estimate of the next `count` bills from the instalment purchases already billed: for each
 * purchase ("LOJA (3/10)"), its latest parcela seen and that bill's due date; parcelas
 * k+1…n are expected one per month after it, with the same amount. Bills are dated from
 * the latest imported bill on. Purchases not yet billed are unknown and not counted.
 */
export function futureInstalments(txs: InstalmentTx[], count = 6): FutureBill[] {
  const latest = new Map<string, { k: number; n: number; due: string; amount: number; purchase: string; category_id: string | null }>()
  let lastDue = ''
  for (const t of txs) {
    if (!t.statement_due) continue
    if (t.statement_due > lastDue) lastDue = t.statement_due
    const p = PARCEL.exec(t.description.trim())
    if (!p || Number(t.amount) >= 0) continue
    const k = Number(p[2]), n = Number(p[3])
    if (k >= n) continue
    const key = `${p[1].toUpperCase()}|${n}|${Number(t.amount).toFixed(2)}`
    const cur = latest.get(key)
    if (!cur || k > cur.k) latest.set(key, { k, n, due: t.statement_due, amount: -Number(t.amount), purchase: p[1], category_id: t.category_id ?? null })
  }
  if (!lastDue) return []
  const bills = Array.from({ length: count }, (_, i) => ({ due: addMonthsIso(lastDue, i + 1), total: 0, parcels: [] as FutureParcel[] }))
  const monthOf = (iso: string) => iso.slice(0, 7)
  for (const g of latest.values()) {
    for (let j = g.k + 1; j <= g.n; j++) {
      const due = monthOf(addMonthsIso(g.due, j - g.k))
      const b = bills.find((x) => monthOf(x.due) === due)
      if (!b) continue
      b.parcels.push({ purchase: g.purchase, k: j, n: g.n, amount: g.amount, category_id: g.category_id })
      b.total += g.amount
    }
  }
  for (const b of bills) { b.total = Math.round(b.total * 100) / 100; b.parcels.sort((x, y) => y.amount - x.amount) }
  return bills
}
