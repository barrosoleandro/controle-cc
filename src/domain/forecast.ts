import { detectSubscriptions, nextDate, type Subscription } from './subscriptions'

/** What the forecast needs from an enriched transaction (value signed, in the display currency). */
export interface FcTx { booking_date: string; month: string; value: number; kind: string; categoryName: string; merchant: string }

export interface ForecastLine { label: string; amount: number; date: string }

export interface Forecast {
  month: string // the month being estimated, yyyy-mm
  total: number
  /** Everyday spending: the usual month, per category, of what does not repeat on a schedule. */
  usual: number
  /** Monthly recurring charges. */
  monthly: number
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
export function forecastNextMonth(txs: FcTx[], today: string, skip: (categoryName: string) => boolean = () => false, window = 3): Forecast {
  const month = nextMonthOf(today)
  const spent = txs.filter((t) => t.kind === 'expense' && !skip(t.categoryName))
  const subs = detectSubscriptions(spent.map((t) => ({ booking_date: t.booking_date, amount: t.value, merchant: t.merchant, kind: t.kind })), today)
    .filter((s) => s.status !== 'possibly_cancelled')
  const recurring = new Set(subs.map((s) => s.merchant))

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
  const periodic: ForecastLine[] = []
  for (const s of subs) {
    const charged = spent.filter((t) => t.merchant === s.merchant && t.month === month)
    const known = -charged.reduce((a, t) => a + t.value, 0)
    const dates = charged.length ? [] : dueIn(s, month)
    const amount = known + dates.length * s.lastAmount
    if (s.cadence === 'monthly' || s.cadence === 'weekly') monthly += amount
    else if (amount > 0) periodic.push({ label: s.merchant, amount, date: charged.length ? charged[0].booking_date : dates[0] })
  }
  periodic.sort((a, b) => a.date.localeCompare(b.date))
  return { month, usual, monthly, periodic, total: usual + monthly + periodic.reduce((a, l) => a + l.amount, 0) }
}

export interface BrazilTransfer {
  month: string
  expected: number // BRL spending estimated for the month
  balance: number // BRL on the Brazilian checking accounts today
  transfer: number // BRL to send before the month starts (0 when the balance covers it)
  by: string // last day to send it: the end of the current month
}

/** What to send to Brazil before the month starts: the estimated spending there, less what is already there. */
export function brazilTransfer(f: Forecast, balanceBrl: number, today: string): BrazilTransfer {
  return { month: f.month, expected: f.total, balance: balanceBrl, transfer: Math.max(0, Math.ceil((f.total - balanceBrl) / 10) * 10), by: lastDayOf(today.slice(0, 7)) }
}

/** Money that arrived from abroad in the Brazilian accounts: what a transfer from the French account looks like there. */
const ARRIVAL = /OP REC EXT|WISE|REVOLUT|EXTERIOR|C[AÂ]MBIO|REMESSA/i

export interface SentToBrazil { amount: number; date: string }

/** Transfers already received in Brazil during `month` (txs: Brazilian accounts only, value in BRL). */
export function sentToBrazil(txs: { booking_date: string; month: string; value: number; kind: string; description: string }[], month: string): SentToBrazil | null {
  const hits = txs.filter((t) => t.month === month && t.kind === 'transfer' && t.value > 0 && ARRIVAL.test(t.description))
  if (!hits.length) return null
  return { amount: hits.reduce((s, t) => s + t.value, 0), date: hits.map((t) => t.booking_date).sort().at(-1)! }
}
