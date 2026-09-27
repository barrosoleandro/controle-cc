import { describe, expect, it } from 'vitest'
import {
  bucketsOf, byDayOfMonth, byWeekday, compareRange, countForShare, firstSeen, groupRows, medianGap, monthsOf, movers,
  movingAverage, perMonth, rankCategories, select, summarize, totalsBy, trendPct, type ExTx, type Filter,
} from '../src/domain/explore'

let n = 0
const tx = (booking_date: string, value: number, merchant = 'CARREFOUR', categoryName = 'Mercado', extra: Partial<ExTx> = {}): ExTx => ({
  id: String(n++), account_id: 'bcp', booking_date, month: booking_date.slice(0, 7), value,
  kind: value >= 0 ? 'income' : 'expense', categoryName, merchant, description: `CB ${merchant}`, ...extra,
})
const all = () => true
const spend: Filter = { measure: 'expense', categories: [], search: '', min: 0 }

describe('periods', () => {
  it('compares whole months with the months just before, or a year earlier', () => {
    const r = { from: '2026-01-01', to: '2026-03-31' }
    expect(monthsOf(r)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(compareRange(r, 'prev')).toEqual({ from: '2025-10-01', to: '2025-12-31' })
    expect(compareRange(r, 'yoy')).toEqual({ from: '2025-01-01', to: '2025-03-31' })
    expect(compareRange(r, 'none')).toBeNull()
  })

  it('compares other ranges with the same number of days before, and clamps 29 February', () => {
    expect(compareRange({ from: '2026-03-10', to: '2026-03-19' }, 'prev')).toEqual({ from: '2026-02-28', to: '2026-03-09' })
    expect(compareRange({ from: '2024-02-10', to: '2024-02-29' }, 'yoy')).toEqual({ from: '2023-02-10', to: '2023-02-28' })
  })

  it('cuts a range into days, Monday weeks or months, and averages per month', () => {
    expect(bucketsOf({ from: '2026-09-02', to: '2026-09-15' }, 'week')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14'])
    expect(bucketsOf({ from: '2026-09-29', to: '2026-10-01' }, 'day')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
    expect(perMonth(300, { from: '2026-01-01', to: '2026-03-31' })).toBe(100)
  })
})

describe('select', () => {
  const txs = [
    tx('2026-01-05', -50), tx('2026-01-20', 10, 'CARREFOUR', 'Mercado', { kind: 'expense' }), // a refund in the same category lowers the spending
    tx('2026-02-03', -200, 'IKEA', 'Casa'), tx('2026-02-04', 3000, 'EMPLOYER', 'Salario'),
    tx('2026-02-05', -500, 'BCP', 'Transfer', { kind: 'transfer' }), tx('2026-03-01', -40, 'AMAZON', 'Compras', { account_id: 'itau' }),
  ]
  const r = { from: '2026-01-01', to: '2026-02-28' }

  it('keeps the measure inside the range, spending positive, never transfers', () => {
    const rows = select(txs, r, spend, all)
    expect(rows.map((t) => t.amt)).toEqual([50, -10, 200])
    expect(summarize(rows)).toMatchObject({ total: 240, count: 2, avgTicket: 120 })
    expect(select(txs, r, { ...spend, measure: 'income' }, all).map((t) => t.amt)).toEqual([3000])
  })

  it('filters by category, text (accents and case ignored), minimum and account', () => {
    expect(select(txs, null, { ...spend, categories: ['Casa'] }, all)).toHaveLength(1)
    expect(select(txs, null, { ...spend, search: 'íkea' }, all)).toHaveLength(1)
    expect(select(txs, null, { ...spend, min: 45 }, all).map((t) => t.merchant)).toEqual(['CARREFOUR', 'IKEA'])
    expect(select(txs, null, spend, (id) => id !== 'itau').some((t) => t.merchant === 'AMAZON')).toBe(false)
  })

  it('uses the purchase date printed on card lines', () => {
    const [row] = select([tx('2026-07-02', -80, 'HOTEL', 'Viagem', { description: 'CB IN SITU HOTEL FACT 230626' })], null, spend, all)
    expect(row.day).toBe('2026-06-23')
  })

  it('sums per bucket on the booking date', () => {
    const rows = select(txs, null, spend, all)
    expect(totalsBy(rows, ['2026-01', '2026-02', '2026-03'], 'month')).toEqual([40, 200, 40])
  })
})

describe('groups', () => {
  const rows = select([
    tx('2026-01-01', -10), tx('2026-01-08', -12), tx('2026-01-15', -14), tx('2026-02-01', -30, 'CARREFOUR', 'Casa'),
    tx('2026-02-10', -100, 'IKEA', 'Casa'),
  ], null, spend, all)

  it('groups by merchant with the months, the main category and the usual gap between charges', () => {
    const [ikea, carrefour] = groupRows(rows, (t) => t.merchant, ['2026-01', '2026-02'])
    expect(ikea).toMatchObject({ key: 'IKEA', total: 100, count: 1, every: null })
    expect(carrefour).toMatchObject({ key: 'CARREFOUR', total: 66, count: 4, perMonth: [36, 30], first: '2026-01-01', last: '2026-02-01', category: 'Mercado', every: 7 })
    expect(medianGap(['2026-01-01', '2026-01-02', '2026-01-10', '2026-01-10'])).toBe(4.5)
  })

  it('lists what moved most against the comparison, including what disappeared', () => {
    const cur = groupRows(rows, (t) => t.categoryName, [])
    const prev = groupRows(select([tx('2025-12-01', -80), tx('2025-12-02', -20, 'X', 'Saúde')], null, spend, all), (t) => t.categoryName, [])
    expect(movers(cur, prev).map((m) => [m.key, m.delta])).toEqual([['Casa', 130], ['Saúde', -20], ['Mercado', -44]])
  })

  it('measures concentration and first appearances', () => {
    const g = groupRows(rows, (t) => t.merchant, [])
    expect(countForShare(g, 0.5)).toBe(1)
    expect(countForShare(g, 0.8)).toBe(2)
    expect(firstSeen(rows, (t) => t.merchant).get('IKEA')).toBe('2026-02-10')
  })
})

describe('trend and calendar', () => {
  it('averages the last three months and expresses the slope as a share of a usual month', () => {
    expect(movingAverage([3, 6, 9, 12], 3)).toEqual([null, null, 6, 9])
    expect(trendPct([100, 110, 120, 130])).toBeCloseTo(10 / 115)
    expect(trendPct([100, 100])).toBeNull()
  })

  it('averages each weekday over the days of that kind in the range', () => {
    // September 2026: 1st is a Tuesday; there are five Tuesdays and four Mondays.
    const rows = select([tx('2026-09-01', -50), tx('2026-09-08', -50), tx('2026-09-07', -40)], null, spend, all)
    const w = byWeekday(rows, { from: '2026-09-01', to: '2026-09-30' })
    expect(w[1]).toEqual({ total: 100, count: 2, avg: 20 })
    expect(w[0]).toEqual({ total: 40, count: 1, avg: 10 })
    expect(byDayOfMonth(rows)[0]).toEqual({ total: 50, count: 1 })
  })

  it('ranks categories by all-time total for stable colors', () => {
    expect(rankCategories([tx('2026-01-01', -10), tx('2026-01-02', -50, 'IKEA', 'Casa'), tx('2026-01-03', 999, 'E', 'Salario')], 'expense')).toEqual(['Casa', 'Mercado'])
  })
})
