import type { Account } from './types'
import { CARD_PAYMENT } from './categorize'
import { countryOf } from './countries'

/** An account can pay a card's bill only in the card's own country (a BCP account never pays the Itaú bill directly: it sends a transfer to Brazil). */
export const canPay = (card: Pick<Account, 'bank'>, account: Pick<Account, 'bank' | 'type'>) => account.type !== 'card' && countryOf(account.bank) === countryOf(card.bank)

/**
 * Card → the account that pays its bill. A link to an account of another country is ignored:
 * a euro account does not pay the Itaú card, it funds Brazil with one transfer a month.
 */
export function payerOf(accounts: Account[]): Map<string, string> {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const out = new Map<string, string>()
  for (const a of accounts) {
    const p = a.type === 'card' && a.parent_account_id ? byId.get(a.parent_account_id) : undefined
    if (p && canPay(a, p)) out.set(a.id, p.id)
  }
  return out
}

export interface StoredCardStatement {
  account_id: string
  due_date: string
  total: number
  status: 'paga' | 'aberta'
}

/** What matching needs from a stored transaction. */
export interface PayTx { id: string; account_id: string; booking_date: string; amount: number; bank_category?: string | null; statement_due?: string | null }

/** Category of a bill payment shown as spending: the bill total, its purchases left aside. */
export const CARD_BILL = 'Cartão Itaú'

const DAY = 86400000
const WINDOW_DAYS = 5 // the card may credit the payment a day or two after the account debit

/**
 * Pairs each bill payment recorded on a card ("Pagamento Efetuado", imported from the
 * fatura) with the debit that paid it in the card's paying account: same amount to the
 * cent, closest date within WINDOW_DAYS, each debit used once.
 *
 * Those debits are transfers between the user's own accounts — the spending is the card
 * purchases themselves. Payments that no imported fatura mentions are left alone and
 * stay "Cartão Itaú" (an expense), so months without card detail keep their total. So do
 * payments of a bill whose purchases were not imported: the payment of the 11/10 bill shows
 * on the next bill, and without the 11/10 bill itself its purchases would be counted nowhere.
 * (Cards whose purchases carry no bill due date, imported before migration 004, are not checked.)
 */
export function matchCardPayments(accounts: Account[], txs: PayTx[]) {
  const parentOf = payerOf(accounts)
  const used = new Set<string>()
  const out: { cardTx: PayTx; bankTx: PayTx }[] = []
  const dues = new Map<string, number[]>() // per card: due dates of the bills whose purchases are imported
  for (const t of txs) if (parentOf.has(t.account_id) && t.statement_due && Number(t.amount) < 0) dues.set(t.account_id, [...(dues.get(t.account_id) ?? []), Date.parse(t.statement_due)])
  const payments = txs
    .filter((t) => parentOf.has(t.account_id) && t.bank_category === CARD_PAYMENT && Number(t.amount) > 0)
    .sort((a, b) => a.booking_date.localeCompare(b.booking_date))
  for (const p of payments) {
    const parent = parentOf.get(p.account_id)
    const at = Date.parse(p.booking_date)
    const billed = dues.get(p.account_id)
    // The bill paid is due from 15 days before to 10 days after the payment; the next one is a month away.
    if (billed && !billed.some((d) => (at - d) / DAY >= -10 && (at - d) / DAY <= 15)) continue // the paid bill is not imported
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
  const parentOf = payerOf(accounts)
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

/**
 * The debit in the paying account that paid a bill, from 10 days before to 5 days after the due
 * date: the one of the bill total to the cent, or else the card-bill debit (`isBillPayment`) nearest
 * the due date. The total stored can differ from the debit when the bill was imported before it
 * closed (the "fatura aberta" export), and the debit is still the payment of that bill.
 */
export function billDebit<T extends PayTx>(accounts: Account[], bill: StoredCardStatement, txs: T[], isBillPayment: (t: T) => boolean): T | undefined {
  const parent = payerOf(accounts).get(bill.account_id)
  if (!parent) return undefined
  const due = Date.parse(bill.due_date)
  const near = txs.filter((t) => t.account_id === parent && Number(t.amount) < 0)
    .map((t) => ({ t, d: (Date.parse(t.booking_date) - due) / DAY }))
    .filter((c) => c.d >= -10 && c.d <= 5)
    .sort((a, b) => Math.abs(a.d) - Math.abs(b.d))
  return (near.find((c) => Math.abs(Number(c.t.amount) + Number(bill.total)) < 0.005) ?? near.find((c) => isBillPayment(c.t)))?.t
}

/**
 * Bills with their status as of today: one imported while still open ("aberta") is paid once its
 * payment shows, either as its debit in the paying account (billDebit) or as the payment recorded
 * on the card, which comes on a later bill (billPayment). The stored
 * status is the one printed when the bill was imported and is not updated by later statements.
 */
export function withPaidStatus<B extends StoredCardStatement, T extends PayTx>(accounts: Account[], bills: B[], txs: T[], isBillPayment: (t: T) => boolean = () => false): B[] {
  return bills.map((b) => (b.status === 'aberta' && (billDebit(accounts, b, txs, isBillPayment) || billPayment(b, txs)) ? { ...b, status: 'paga' as const } : b))
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
