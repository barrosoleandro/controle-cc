import { describe, expect, it } from 'vitest'
import { baselineMonths, buildPeriod, monthBalances, monthWindow, subscriptionReview, type PeriodTx } from '../src/domain/period'
import type { Account, Transaction } from '../src/domain/types'
import type { Subscription } from '../src/domain/subscriptions'

const tx = (month: string, spent: number, merchant = 'CARREFOUR', categoryName = 'Mercado'): PeriodTx =>
  ({ month, value: -spent, categoryName, merchant, kind: 'expense' })

describe('period view', () => {
  it('builds calendar windows across years and a 6-month baseline for one month', () => {
    expect(monthWindow('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(baselineMonths(['2026-09'])).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])
    expect(baselineMonths(['2026-08', '2026-09'])).toEqual(['2026-08', '2026-09'])
  })

  it('groups by category with merchants inside and flags the month well above the usual', () => {
    const w = monthWindow('2026-06', 6)
    const txs = [...w.map((m) => tx(m, 100)), tx('2026-06', 200, 'PICARD'), { ...tx('2026-06', 999), kind: 'income' }]
    const [mercado] = buildPeriod(txs, w)
    expect(mercado.key).toBe('Mercado')
    expect(mercado.perMonth).toEqual([100, 100, 100, 100, 100, 300])
    expect(mercado.avg).toBeCloseTo(800 / 6)
    expect(mercado.outlier).toEqual([false, false, false, false, false, true])
    expect(mercado.flagged).toBe(true)
    expect(mercado.merchants.map((m) => m.key)).toEqual(['CARREFOUR', 'PICARD'])
    expect(mercado.merchants[0].flagged).toBe(false)
  })

  it('ignores small swings and compares one month against the six before it', () => {
    const before = monthWindow('2026-08', 6).map((m) => tx(m, 10))
    const [small] = buildPeriod([...before, tx('2026-09', 30)], ['2026-09'])
    expect(small.perMonth).toEqual([30])
    expect(small.flagged).toBe(false) // +20 is below the minimum difference worth flagging
    const [big] = buildPeriod([...before.map((t) => ({ ...t, value: -100 })), tx('2026-09', 180)], ['2026-09'])
    expect(big.avg).toBe(100)
    expect(big.flagged).toBe(true)
  })
})

describe('new in the month', () => {
  it('marks a merchant with nothing in the months before, once there are three months of history', () => {
    const history = monthWindow('2026-08', 8).map((m) => tx(m, 50, 'CARREFOUR'))
    const [cat] = buildPeriod([...history, tx('2026-08', 30, 'LIDL'), tx('2026-02', 10, 'OLD'), tx('2026-08', 10, 'OLD')], ['2026-08'])
    const byKey = new Map(cat.merchants.map((m) => [m.key, m]))
    expect(byKey.get('LIDL')!.isNew).toEqual([true])
    expect(byKey.get('CARREFOUR')!.isNew).toEqual([false])
    expect(byKey.get('OLD')!.isNew).toEqual([false]) // bought in February, inside the six months
    const [young] = buildPeriod([tx('2026-07', 50), tx('2026-08', 30, 'LIDL')], ['2026-08'])
    expect(young.merchants.find((m) => m.key === 'LIDL')!.isNew).toEqual([false]) // one month of history: too little
    const [three] = buildPeriod([tx('2026-05', 50), tx('2026-08', 30, 'LIDL')], ['2026-08'])
    expect(three.merchants.find((m) => m.key === 'LIDL')!.isNew).toEqual([true]) // May–July is enough
  })
})

describe('month balances', () => {
  it('gives the balance at the start and end of each month, summed across accounts in one currency', () => {
    const eur = { id: 'a', currency: 'EUR', opening_balance: 1000 } as Account
    const brl = { id: 'b', currency: 'BRL', opening_balance: 600 } as Account
    const t = (account_id: string, booking_date: string, amount: number) => ({ account_id, booking_date, amount }) as Transaction
    const txs = [t('a', '2026-05-10', -200), t('a', '2026-06-01', 500), t('a', '2026-06-30', -100), t('b', '2026-06-15', -60)]
    const toEur = (n: number, from: string) => (from === 'BRL' ? n / 6 : n)
    const r = monthBalances([eur, brl], txs, ['2026-05', '2026-06'], toEur)
    expect(r.opening).toEqual([1100, 900]) // 1000 + 600/6; then 800 + 100
    expect(r.closing).toEqual([900, 1290]) // 800 + 100; then 1200 + 540/6
    expect(r.inflow).toEqual([0, 500])
    expect(r.outflow).toEqual([200, 110]) // 100 + 60/6
  })
})

describe('subscription review', () => {
  const sub = (over: Partial<Subscription>): Subscription => ({
    merchant: 'NETFLIX', cadence: 'monthly', intervalDays: 30, lastAmount: 10, avgAmount: 10, monthlyCost: 10, count: 6,
    firstDate: '2026-01-05', lastDate: '2026-09-05', nextDate: '2026-10-05', priceChangePct: 0, status: 'active', ...over,
  })
  it('says why a recurring charge needs a look', () => {
    expect(subscriptionReview(sub({}), '2026-09-26')).toBeNull()
    expect(subscriptionReview(sub({ priceChangePct: 0.2 }), '2026-09-26')).toBe('preço subiu 20%')
    expect(subscriptionReview(sub({ status: 'possibly_cancelled' }), '2026-09-26')).toMatch(/parou de cobrar/)
    expect(subscriptionReview(sub({ status: 'new' }), '2026-09-26')).toMatch(/nova/)
    expect(subscriptionReview(sub({ cadence: 'yearly', nextDate: '2026-10-10' }), '2026-09-26')).toBe('renovação anual em 14 dias')
  })
})
