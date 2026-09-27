import type { EnrichedTx } from './analytics'
import { purchaseDate } from './simplify'
import { linearTrend } from './trend'

/**
 * The Análises page: one filter (dates, accounts, measure, categories, text, minimum) sliced
 * several ways — over time, by category, by merchant, by weekday and day of month — and
 * compared with an earlier period. Everything here is pure; amounts are in display currency.
 */

/** What the analysis reads from an enriched transaction (value signed, display currency). */
export type ExTx = Pick<EnrichedTx, 'id' | 'account_id' | 'booking_date' | 'month' | 'value' | 'kind' | 'categoryName' | 'merchant' | 'description'>

export type Measure = 'expense' | 'income'
export type Grain = 'day' | 'week' | 'month'
export type CompareMode = 'prev' | 'yoy' | 'none'
/** Inclusive ISO dates. */
export interface Range { from: string; to: string }

export interface Filter {
  measure: Measure
  categories: string[] // empty = every category
  search: string // merchant or description, accents and case ignored
  min: number // smallest amount kept (absolute), 0 = all
}

/** A selected row: `amt` is the flow of the measure (spending positive; a refund in an expense category is negative). */
export type Row<T extends ExTx = ExTx> = T & { amt: number; day: string }

const DAY = 86400000
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase()
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
export const daysIn = (r: Range) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY) + 1
export const lastDayOf = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }
export const addMonths = (month: string, n: number) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7) }
export const monthRange = (first: string, last: string): Range => ({ from: `${first}-01`, to: lastDayOf(last) })
/** Monday = 0 … Sunday = 6. */
export const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7

/** Calendar months the range touches, oldest first. */
export function monthsOf(r: Range): string[] {
  const out: string[] = []
  for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7); m = addMonths(m, 1)) out.push(m)
  return out
}

const wholeMonths = (r: Range) => r.from.endsWith('-01') && r.to === lastDayOf(r.to.slice(0, 7))

/**
 * The period the range is compared with: the one just before it (same number of months when
 * the range is whole months, otherwise the same number of days), or the same dates a year earlier.
 */
export function compareRange(r: Range, mode: CompareMode): Range | null {
  if (mode === 'none') return null
  const first = r.from.slice(0, 7), last = r.to.slice(0, 7)
  const shift = mode === 'yoy' ? 12 : monthsOf(r).length
  if (wholeMonths(r)) return monthRange(addMonths(first, -shift), addMonths(last, -shift))
  if (mode === 'yoy') {
    const back = (d: string) => { const m = addMonths(d.slice(0, 7), -12); const end = lastDayOf(m); return `${m}-${d.slice(8)}` > end ? end : `${m}-${d.slice(8)}` }
    return { from: back(r.from), to: back(r.to) }
  }
  const n = daysIn(r)
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) }
}

/** Rows of the measure inside the range that pass the filter and belong to an account in scope. Transfers never count. */
export function select<T extends ExTx>(txs: T[], r: Range | null, f: Filter, inScope: (accountId: string) => boolean): Row<T>[] {
  const q = fold(f.search)
  const cats = f.categories.length ? new Set(f.categories) : null
  const out: Row<T>[] = []
  for (const t of txs) {
    if (t.kind !== f.measure || !inScope(t.account_id)) continue
    if (r && (t.booking_date < r.from || t.booking_date > r.to)) continue
    if (cats && !cats.has(t.categoryName)) continue
    const amt = f.measure === 'expense' ? -t.value : t.value
    if (f.min > 0 && Math.abs(amt) < f.min) continue
    if (q && !fold(t.merchant).includes(q) && !fold(t.description).includes(q)) continue
    out.push({ ...t, amt, day: purchaseDate(t.description, t.booking_date) })
  }
  return out
}

/** Bucket a date falls in: the day, the Monday of its week, or its month. */
export const bucketOf = (d: string, g: Grain) => (g === 'month' ? d.slice(0, 7) : g === 'week' ? addDays(d, -weekday(d)) : d)

export function bucketsOf(r: Range, g: Grain): string[] {
  if (g === 'month') return monthsOf(r)
  const out: string[] = []
  for (let d = bucketOf(r.from, g); d <= r.to; d = addDays(d, g === 'week' ? 7 : 1)) out.push(d)
  return out
}

/** Sum of `amt` per bucket, in the order of `keys` (booking date, like every monthly total in the app). */
export function totalsBy(rows: { booking_date: string; amt: number }[], keys: string[], g: Grain): number[] {
  const idx = new Map(keys.map((k, i) => [k, i]))
  const out = keys.map(() => 0)
  for (const t of rows) {
    const i = idx.get(bucketOf(t.booking_date, g))
    if (i !== undefined) out[i] += t.amt
  }
  return out
}

export interface Summary<T extends ExTx> { total: number; count: number; avgTicket: number; top: Row<T> | null }

/** Total, number of charges (refunds are not counted as charges), average charge and the largest one. */
export function summarize<T extends ExTx>(rows: Row<T>[]): Summary<T> {
  let total = 0, count = 0, top: Row<T> | null = null
  for (const t of rows) {
    total += t.amt
    if (t.amt > 0) { count++; if (!top || t.amt > top.amt) top = t }
  }
  return { total, count, avgTicket: count ? total / count : 0, top }
}

/** Average per month: whole months divide by their count, other ranges by their length in months. */
export const perMonth = (total: number, r: Range) => total / (wholeMonths(r) ? monthsOf(r).length : daysIn(r) / 30.4375)

export interface Group {
  key: string
  total: number
  count: number
  perMonth: number[] // in the order of the months given
  first: string // first and last charge (purchase date)
  last: string
  category: string // for merchants: the category holding most of their amount
  every: number | null // median days between charges, with three or more
}

/** Median gap in days between consecutive distinct dates; null under three dates. */
export function medianGap(days: string[]): number | null {
  const ds = [...new Set(days)].sort()
  if (ds.length < 3) return null
  const gaps = ds.slice(1).map((d, i) => (Date.parse(d) - Date.parse(ds[i])) / DAY).sort((a, b) => a - b)
  const mid = gaps.length >> 1
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
}

/** Rows grouped by a key (category, merchant…), biggest total first. */
export function groupRows<T extends ExTx>(rows: Row<T>[], keyOf: (t: Row<T>) => string, months: string[]): Group[] {
  const idx = new Map(months.map((m, i) => [m, i]))
  const acc = new Map<string, { g: Group; days: string[]; cats: Map<string, number> }>()
  for (const t of rows) {
    const key = keyOf(t) || '(sem nome)'
    let a = acc.get(key)
    if (!a) {
      a = { g: { key, total: 0, count: 0, perMonth: months.map(() => 0), first: t.day, last: t.day, category: '', every: null }, days: [], cats: new Map() }
      acc.set(key, a)
    }
    a.g.total += t.amt
    const i = idx.get(t.month)
    if (i !== undefined) a.g.perMonth[i] += t.amt
    a.cats.set(t.categoryName, (a.cats.get(t.categoryName) ?? 0) + t.amt)
    if (t.amt > 0) {
      a.g.count++
      a.days.push(t.day)
      if (t.day < a.g.first) a.g.first = t.day
      if (t.day > a.g.last) a.g.last = t.day
    }
  }
  return [...acc.values()].map(({ g, days, cats }) => ({
    ...g,
    category: [...cats].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '',
    every: medianGap(days),
  })).sort((a, b) => b.total - a.total)
}

export interface Mover { key: string; cur: number; prev: number; delta: number }

/** Change per key between two sets of groups (keys missing on one side count as zero), largest rise first. */
export function movers(cur: Group[], prev: Group[]): Mover[] {
  const p = new Map(prev.map((g) => [g.key, g.total]))
  const keys = new Set([...cur.map((g) => g.key), ...p.keys()])
  const c = new Map(cur.map((g) => [g.key, g.total]))
  return [...keys].map((key) => {
    const a = c.get(key) ?? 0, b = p.get(key) ?? 0
    return { key, cur: a, prev: b, delta: a - b }
  }).filter((m) => Math.abs(m.delta) > 0.5).sort((a, b) => b.delta - a.delta)
}

/** Relative change, null when there is nothing to compare with. */
export const pctChange = (cur: number, prev: number) => (Math.abs(prev) < 0.005 ? null : (cur - prev) / Math.abs(prev))

/** Mean of the last `n` values at each point; null until there are `n` of them. */
export function movingAverage(values: number[], n: number): (number | null)[] {
  return values.map((_, i) => (i + 1 < n ? null : values.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n))
}

/**
 * Slope of the line fitted through the values, as a share of their mean: 0.05 means the
 * amount grows by 5% of a usual month every month. Null with under three points or no spending.
 */
export function trendPct(values: number[]): number | null {
  if (values.length < 3) return null
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const t = linearTrend(values)
  return t && mean > 0.005 ? t.slope / mean : null
}

/**
 * Per weekday (Monday first), on the purchase date: total, charges and the average per
 * calendar day of that weekday in the range, so a month with five Fridays does not tip the scale.
 */
export function byWeekday(rows: { day: string; amt: number }[], r: Range) {
  const total = Array(7).fill(0), count = Array(7).fill(0), days = Array(7).fill(0)
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) days[weekday(d)]++
  for (const t of rows) {
    const i = weekday(t.day)
    total[i] += t.amt
    if (t.amt > 0) count[i]++
  }
  return total.map((v: number, i) => ({ total: v, count: count[i] as number, avg: days[i] ? v / days[i] : 0 }))
}

/** Per day of the month (1–31), on the purchase date. */
export function byDayOfMonth(rows: { day: string; amt: number }[]) {
  const out = Array.from({ length: 31 }, () => ({ total: 0, count: 0 }))
  for (const t of rows) {
    const c = out[Number(t.day.slice(8, 10)) - 1]
    if (!c) continue
    c.total += t.amt
    if (t.amt > 0) c.count++
  }
  return out
}

/** How many of the biggest groups make up `share` of the total (e.g. 80%). */
export function countForShare(groups: Group[], share: number): number {
  const total = groups.reduce((s, g) => s + Math.max(0, g.total), 0)
  if (total <= 0) return 0
  let acc = 0
  for (let i = 0; i < groups.length; i++) {
    acc += Math.max(0, groups[i].total)
    if (acc >= total * share - 1e-9) return i + 1
  }
  return groups.length
}

/** First charge of each key over the whole history, to tell a new merchant from a known one. */
export function firstSeen<T extends ExTx>(rows: Row<T>[], keyOf: (t: Row<T>) => string): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of rows) {
    if (t.amt <= 0) continue
    const k = keyOf(t), f = out.get(k)
    if (!f || t.day < f) out.set(k, t.day)
  }
  return out
}

/** Categories of the measure ranked by their all-time total: the order that fixes each category's color. */
export function rankCategories(txs: ExTx[], measure: Measure): string[] {
  const sums = new Map<string, number>()
  for (const t of txs) if (t.kind === measure) sums.set(t.categoryName, (sums.get(t.categoryName) ?? 0) + (measure === 'expense' ? -t.value : t.value))
  return [...sums].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}
