import { detectSubscriptions, nextDate, type Subscription } from './subscriptions'
import { CARD_PAYMENT } from './categorize'

/** What the forecast needs from an enriched transaction (value signed, in the display currency). */
export interface FcTx { booking_date: string; month: string; value: number; kind: string; categoryName: string; merchant: string }

export interface ForecastLine { label: string; amount: number; date: string; /** Worth a second look, e.g. several charges a month under one name. */ note?: string }

export interface Forecast {
  month: string // the month being estimated, yyyy-mm
  total: number
  /** Everyday spending: the usual month, per category, of what does not repeat on a schedule. */
  usual: number
  /** Monthly recurring charges. */
  monthly: number
  /** The monthly recurring charges behind `monthly`, so the figure can be checked. */
  monthlyLines: ForecastLine[]
  /** Charges that are not monthly (bimonthly, quarterly, yearly) and fall in the month. */
  periodic: ForecastLine[]
}

export const nextMonthOf = (today: string): string => {
  const [y, m] = today.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
}
export const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** Dates on which a recurring charge is expected inside `month`. */
function dueIn(s: Subscription, month: string): string[] {
  const out: string[] = []
  let d = s.nextDate
  for (let i = 0; i < 80 && d.slice(0, 7) <= month; i++) {
    if (d.slice(0, 7) === month) out.push(d)
    d = nextDate(d, s.cadence, s.intervalDays)
  }
  return out
}

/**
 * Estimates the spending of the month after `today`:
 *  - recurring charges (found by detectSubscriptions) are placed on the date they fall due, so a
 *    bimonthly or yearly bill shows up only in the months it is really charged;
 *  - everything else is the usual month of the last three complete months, per category;
 *  - what is already dated in the month (card instalments) counts at least as much as the usual.
 * Transfers and the categories named in `skip` (tithe) are not spending here.
 */
export function forecastNextMonth(txs: FcTx[], today: string, skip: (categoryName: string) => boolean = () => false, window = 3, marks: BillMarks = {}): Forecast {
  const month = nextMonthOf(today)
  const spent = txs.filter((t) => t.kind === 'expense' && !skip(t.categoryName))
  const subs = detectSubscriptions(spent.map((t) => ({ booking_date: t.booking_date, amount: t.value, merchant: t.merchant, kind: t.kind })), today)
    .filter((s) => s.status !== 'possibly_cancelled' && billEffective(s.merchant, marks, true))
  // Merchants the user marked as recurring that the detection did not find: monthly, at the learned amount.
  const found = new Set(subs.map((s) => s.merchant))
  const marked = applyBillMarks([], spent, marks).filter((l) => !found.has(l.label))
  const recurring = new Set([...found, ...marked.map((l) => l.label)])

  const [y, m] = today.split('-').map(Number)
  const base = new Set(Array.from({ length: window }, (_, i) => new Date(Date.UTC(y, m - 1 - (window - i), 1)).toISOString().slice(0, 7)))
  const usualBy = new Map<string, number>(), knownBy = new Map<string, number>()
  const add = (map: Map<string, number>, k: string, v: number) => map.set(k, (map.get(k) ?? 0) - v)
  for (const t of spent) {
    if (recurring.has(t.merchant)) continue
    if (base.has(t.month)) add(usualBy, t.categoryName, t.value)
    else if (t.month === month) add(knownBy, t.categoryName, t.value)
  }
  let usual = 0
  for (const k of new Set([...usualBy.keys(), ...knownBy.keys()]))
    usual += Math.max((usualBy.get(k) ?? 0) / window, knownBy.get(k) ?? 0, 0)

  let monthly = 0
  const monthlyLines: ForecastLine[] = []
  const periodic: ForecastLine[] = []
  const inMonth = new Map<string, FcTx[]>()
  for (const t of spent) if (t.month === month) inMonth.set(t.merchant, [...(inMonth.get(t.merchant) ?? []), t])
  for (const s of subs) {
    const charged = inMonth.get(s.merchant) ?? []
    const known = -charged.reduce((a, t) => a + t.value, 0)
    const dates = charged.length ? [] : dueIn(s, month)
    const amount = known + dates.length * s.lastAmount
    if (s.cadence === 'monthly' || s.cadence === 'weekly') { monthly += amount; if (amount > 0) monthlyLines.push({ label: s.merchant, amount, date: dates[0] ?? charged[0]?.booking_date ?? '' }) }
    else if (amount > 0) periodic.push({ label: s.merchant, amount, date: charged.length ? charged[0].booking_date : dates[0] })
  }
  for (const l of marked) {
    const charged = -(inMonth.get(l.label) ?? []).reduce((a, t) => a + t.value, 0)
    const amount = charged > 0 ? charged : l.amount
    monthly += amount; monthlyLines.push({ label: l.label, amount, date: '' })
  }
  periodic.sort((a, b) => a.date.localeCompare(b.date))
  monthlyLines.sort((a, b) => b.amount - a.amount)
  return { month, usual, monthly, monthlyLines, periodic, total: usual + monthly + periodic.reduce((a, l) => a + l.amount, 0) }
}

export interface BrazilTransfer {
  month: string
  card: number // card bill(s) still to pay
  recurring: number // recurring payments of the month (monthly and the non-monthly ones that fall in it)
  expected: number // card + recurring, in BRL
  balance: number // BRL on the Brazilian checking accounts today
  transfer: number // BRL to send before the month starts (0 when the balance covers it)
  by: string // last day to send it: the end of the current month
}

/**
 * What to send to Brazil before the month starts: the card bill still to pay plus the recurring
 * payments there (rent-like, utilities, bimonthly bills), less what is already in the account.
 * Day-to-day purchases are not in it: they go on the card and reach the next bill.
 */
export function brazilTransfer(f: Forecast, cardOpen: number, balanceBrl: number, today: string): BrazilTransfer {
  const recurring = f.monthly + f.periodic.reduce((a, l) => a + l.amount, 0)
  const expected = cardOpen + recurring
  return { month: f.month, card: cardOpen, recurring, expected, balance: balanceBrl, transfer: Math.max(0, Math.ceil((expected - balanceBrl) / 10) * 10), by: lastDayOf(today.slice(0, 7)) }
}

export interface CardBill { account_id: string; due_date: string; total: number; status: 'paga' | 'aberta' }

/** Brazilian card bills: what is still to pay, and whether this month's bill was already paid. */
export function brazilCard(bills: CardBill[], cardIds: Set<string>, month: string) {
  const mine = bills.filter((b) => cardIds.has(b.account_id) && b.due_date >= `${month}-01`)
  const open = mine.filter((b) => b.status === 'aberta').reduce((s, b) => s + b.total, 0)
  const thisMonth = mine.filter((b) => b.due_date.slice(0, 7) === month)
  return { open, paidThisMonth: thisMonth.length > 0 && thisMonth.every((b) => b.status === 'paga') }
}

/** The card bill paid from the checking account: counted apart from the account's own bills. */
export const isCardBillPayment = (t: { bank_category: string | null; description: string }) =>
  t.bank_category === CARD_PAYMENT || /FATURA|ITAUCARD|PAG(TO|AMENTO)? CART/i.test(t.description)

/** Money that arrived from abroad in the Brazilian accounts: what a transfer from the French account looks like there. */
const ARRIVAL = /OP REC EXT|WISE|REVOLUT|EXTERIOR|C[AÂ]MBIO|REMESSA/i

export interface SentToBrazil { amount: number; date: string }

/** Transfers already received in Brazil during `month` (txs: Brazilian accounts only, value in BRL). */
export function sentToBrazil(txs: { booking_date: string; month: string; value: number; kind: string; description: string }[], month: string): SentToBrazil | null {
  const hits = txs.filter((t) => t.month === month && t.kind === 'transfer' && t.value > 0 && ARRIVAL.test(t.description))
  if (!hits.length) return null
  return { amount: hits.reduce((s, t) => s + t.value, 0), date: hits.map((t) => t.booking_date).sort().at(-1)! }
}

/**
 * Bills that come every month with a changing amount (health plan, power, phone, condo fee):
 * charged in at least `minMonths` of the last `window` complete months and still in the last two.
 * The amount is the average of the last three months it was charged. Looser than
 * detectSubscriptions on purpose: a power bill never repeats within ±25%.
 */
export function monthlyBills(txs: FcTx[], today: string, skip: (categoryName: string) => boolean = () => false, window = 6, minMonths = 4): ForecastLine[] {
  const [y, m] = today.split('-').map(Number)
  const months = Array.from({ length: window }, (_, i) => new Date(Date.UTC(y, m - 1 - (window - i), 1)).toISOString().slice(0, 7))
  const by = new Map<string, Map<string, number>>()
  const count = new Map<string, number>()
  for (const t of txs) {
    if (t.kind !== 'expense' || skip(t.categoryName) || !t.merchant || !months.includes(t.month)) continue
    const per = by.get(t.merchant) ?? new Map<string, number>()
    per.set(t.month, (per.get(t.month) ?? 0) - t.value)
    by.set(t.merchant, per)
    count.set(t.merchant, (count.get(t.merchant) ?? 0) + 1)
  }
  const out: ForecastLine[] = []
  for (const [merchant, per] of by) {
    const seen = months.filter((mm) => (per.get(mm) ?? 0) > 0)
    if (seen.length < minMonths || !seen.some((mm) => mm >= months[window - 2])) continue
    const last = seen.slice(-3)
    const perMonth = count.get(merchant)! / seen.length
    out.push({ label: merchant, amount: last.reduce((s, mm) => s + per.get(mm)!, 0) / last.length, date: '',
      note: perMonth > 1.5 ? `≈ ${Math.round(perMonth)} lançamentos por mês com este nome — pode juntar vários pagamentos` : undefined })
  }
  return out.sort((a, b) => b.amount - a.amount)
}

/** The user's marks on Brazilian bills: merchant → month (yyyy-mm) → counted in the transfer or not. */
export type BillMarks = Record<string, Record<string, boolean>>

/** Is the merchant a recurring bill? The latest month marked decides; with no mark, the automatic guess. */
export function billEffective(merchant: string, marks: BillMarks, auto: boolean): boolean {
  const m = marks[merchant]
  const last = m && Object.keys(m).sort().at(-1)
  return last ? m[last] : auto
}

/**
 * Lays the user's marks over the automatic list. A merchant marked in the latest month is kept
 * (or added); one unmarked is dropped. Its amount is learned from the months marked as a bill
 * (average of the last three, taken from the statements); with none, the automatic amount.
 */
export function applyBillMarks(auto: ForecastLine[], txs: FcTx[], marks: BillMarks): ForecastLine[] {
  // One pass over the transactions, only for the marked merchants: the marks may cover hundreds.
  const sums = new Map<string, number>()
  for (const t of txs) if (t.kind === 'expense' && marks[t.merchant]) sums.set(`${t.merchant}|${t.month}`, (sums.get(`${t.merchant}|${t.month}`) ?? 0) - t.value)
  const spentIn = (merchant: string, month: string) => sums.get(`${merchant}|${month}`) ?? 0
  const learned = (merchant: string): number | null => {
    const months = Object.entries(marks[merchant] ?? {}).filter(([, on]) => on).map(([mo]) => mo).sort().slice(-3)
    const sums = months.map((mo) => spentIn(merchant, mo)).filter((v) => v > 0)
    return sums.length ? sums.reduce((a, b) => a + b, 0) / sums.length : null
  }
  const names = new Set(auto.map((l) => l.label))
  const kept = auto.filter((l) => billEffective(l.label, marks, true)).map((l) => ({ ...l, amount: learned(l.label) ?? l.amount }))
  const added = Object.keys(marks).filter((m) => !names.has(m) && billEffective(m, marks, false))
    .map((m) => ({ label: m, amount: learned(m) ?? 0, date: '' })).filter((l) => l.amount > 0)
  return [...kept, ...added].sort((a, b) => b.amount - a.amount)
}

export interface Candidate { merchant: string; months: string[]; amounts: number[]; avg: number }

/**
 * Merchants worth asking about: spent in three months of the last six (the three most recent
 * ones) with monthly totals within `tolerance` of their median, and never answered (`marks`).
 */
export function recurrenceCandidates(txs: FcTx[], marks: BillMarks, today: string, skip: (categoryName: string) => boolean = () => false, tolerance = 0.2, window = 6): Candidate[] {
  const [y, m] = today.split('-').map(Number)
  const months = new Set(Array.from({ length: window }, (_, i) => new Date(Date.UTC(y, m - 1 - (window - 1 - i), 1)).toISOString().slice(0, 7)))
  const by = new Map<string, Map<string, number>>()
  for (const t of txs) {
    if (t.kind !== 'expense' || skip(t.categoryName) || !t.merchant || marks[t.merchant] || !months.has(t.month)) continue
    const per = by.get(t.merchant) ?? new Map<string, number>()
    per.set(t.month, (per.get(t.month) ?? 0) - t.value)
    by.set(t.merchant, per)
  }
  const out: Candidate[] = []
  for (const [merchant, per] of by) {
    const seen = [...per].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b)).slice(-3)
    if (seen.length < 3) continue
    const amounts = seen.map(([, v]) => v)
    const med = [...amounts].sort((a, b) => a - b)[1]
    if (amounts.some((v) => Math.abs(v - med) > med * tolerance)) continue
    out.push({ merchant, months: seen.map(([mo]) => mo), amounts, avg: amounts.reduce((a, b) => a + b, 0) / 3 })
  }
  return out.sort((a, b) => b.avg - a.avg)
}

/** Marks (or unmarks) a merchant for its whole history, so one click settles every month. */
export function markHistory(marks: BillMarks, merchant: string, months: Iterable<string>, on: boolean): BillMarks {
  return { ...marks, [merchant]: Object.fromEntries([...new Set(months)].map((mo) => [mo, on])) }
}
