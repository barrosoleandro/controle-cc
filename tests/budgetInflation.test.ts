import { describe, expect, it } from 'vitest'
import { averageIncome, averageSpendByCategory, salaryAt } from '../src/domain/budget'
import { payVsInflation, priceIndex } from '../src/domain/inflation'

describe('budget averages', () => {
  it('averages spending per category over the window, empty months as zero, rounded up to 10', () => {
    const tx = (month: string, value: number, category_id: string | null, kind = 'expense') => ({ month, value, kind, category_id })
    const avg = averageSpendByCategory([
      tx('2026-01', -300, 'mercado'), tx('2026-02', -310, 'mercado'), tx('2026-02', 10, 'mercado'), // refund
      tx('2026-03', -1200, 'seguro'), // yearly bill spread over the window
      tx('2026-03', 5000, 'salario', 'income'), tx('2026-03', -900, 'transf', 'transfer'), tx('2025-12', -999, 'mercado'), tx('2026-01', -50, null),
    ], ['2026-01', '2026-02', '2026-03'])
    expect(Object.fromEntries(avg)).toEqual({ mercado: 200, seguro: 400 })
  })
})

describe('salary', () => {
  it('averages the income received in a category, empty months as zero', () => {
    const tx = (month: string, value: number, category_id: string, kind = 'income') => ({ month, value, kind, category_id })
    expect(averageIncome([tx('2026-07', 4000, 'sal'), tx('2026-08', 4200, 'sal'), tx('2026-08', 50, 'reemb'), tx('2026-06', 9999, 'sal'), tx('2026-08', -10, 'sal', 'expense')],
      'sal', ['2026-07', '2026-08', '2026-09'])).toBeCloseTo(8200 / 3)
  })

  it('takes the latest dated value up to the month, ignoring the undated budget row', () => {
    const rows = [{ month: null, amount: 1 }, { month: '2026-05-01', amount: 4000 }, { month: '2026-09-01', amount: 4500 }]
    expect(salaryAt(rows, '2026-08')).toEqual({ amount: 4000, since: '2026-05' })
    expect(salaryAt(rows, '2026-09')).toEqual({ amount: 4500, since: '2026-09' })
    expect(salaryAt(rows, '2026-04')).toBeNull()
  })
})

describe('pay vs inflation', () => {
  it('compounds the yearly rate monthly', () => {
    expect(priceIndex('2025-01', '2025-12', { 2025: 12 })).toBeCloseTo(1.12, 6)
    expect(priceIndex('2025-07', '2026-06', { 2025: 2, 2026: 4 })).toBeCloseTo(Math.sqrt(1.02) * Math.sqrt(1.04), 6)
  })

  it('finds the peak and measures the real change against the first months', () => {
    const pts = ['2025-01', '2025-02', '2025-03', '2025-10', '2025-11', '2025-12'].map((month, i) => ({ month, gross: null, net: [1000, 1000, 1000, 1500, 1000, 1000][i] }))
    const r = payVsInflation(pts, { 2025: 12 })!
    expect(r.peak.month).toBe('2025-10')
    expect(r.base).toBe(1000)
    expect(r.recent).toBeCloseTo(3500 / 3)
    expect(r.inflation).toBeCloseTo(0.12, 6)
    expect(r.realChange).toBeCloseTo(3500 / 3 / 1120 - 1, 6)
    expect(r.rows.at(-1)!.corrected).toBeCloseTo(1120, 6)
    expect(payVsInflation(pts.slice(0, 1), { 2025: 2 })).toBeNull()
  })
})

describe('trend helpers', () => {
  it('fits a line and skips gaps', async () => {
    const { cumulative, linearTrend } = await import('../src/domain/trend')
    const t = linearTrend([10, null, 30, 40])!
    expect(t.slope).toBeCloseTo(10)
    expect(t.intercept).toBeCloseTo(10)
    expect(linearTrend([5])).toBeNull()
    expect(cumulative([1, 2, 3])).toEqual([1, 3, 6])
  })
})

describe('tithe categories', () => {
  it('are recognised with or without the accent', async () => {
    const { isTithe } = await import('../src/domain/categorize')
    expect(['Dizimo', 'Doações e dízimo', 'Mercado', 'Outros'].map(isTithe)).toEqual([true, true, false, false])
  })
})
