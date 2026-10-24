import { describe, expect, it } from 'vitest'
import { brazilCard, brazilTransfer, forecastNextMonth, lastDayOf, nextMonthOf, type FcTx } from '../src/domain/forecast'

const tx = (booking_date: string, value: number, merchant: string, categoryName = 'Outros'): FcTx =>
  ({ booking_date, month: booking_date.slice(0, 7), value, kind: 'expense', categoryName, merchant })

describe('forecastNextMonth', () => {
  const today = '2026-10-24'
  const history: FcTx[] = [
    // monthly rent
    tx('2026-07-05', -1000, 'ALUGUEL'), tx('2026-08-05', -1000, 'ALUGUEL'), tx('2026-09-05', -1000, 'ALUGUEL'), tx('2026-10-05', -1000, 'ALUGUEL'),
    // water bill every two months: last paid in September, so due in November
    tx('2026-03-10', -80, 'EAU'), tx('2026-05-10', -80, 'EAU'), tx('2026-07-10', -80, 'EAU'), tx('2026-09-10', -80, 'EAU'),
    // everyday spending, 300 a month
    tx('2026-07-12', -300, 'MERCADO', 'Mercado'), tx('2026-08-12', -300, 'MERCADO2', 'Mercado'), tx('2026-09-12', -300, 'MERCADO3', 'Mercado'),
  ]

  it('adds the bimonthly bill only in the month it falls due', () => {
    const f = forecastNextMonth(history, today)
    expect(f.month).toBe('2026-11')
    expect(f.periodic.map((l) => l.label)).toEqual(['EAU'])
    expect(f.periodic[0].amount).toBe(80)
    expect(f.monthly).toBe(1000)
    expect(f.usual).toBe(300)
    expect(f.total).toBe(1380)
    // a month later the bill is not there
    expect(forecastNextMonth(history, '2026-11-24').periodic).toEqual([])
  })

  it('leaves out skipped categories', () => {
    const withTithe = [...history, tx('2026-09-20', -900, 'IGREJA', 'Dízimo')]
    expect(forecastNextMonth(withTithe, today, (n) => /d[ií]zimo/i.test(n)).total).toBe(1380)
  })

  it('counts what is already dated in the month at least as much as the usual', () => {
    const f = forecastNextMonth([...history, tx('2026-11-03', -500, 'LOJA X', 'Mercado')], today)
    expect(f.usual).toBe(500)
  })
})

describe('brazilTransfer', () => {
  it('sends the estimate less the balance, rounded up to ten', () => {
    const f = { month: '2026-11', total: 0, usual: 900, monthly: 1000, monthlyLines: [], periodic: [{ label: 'EAU', amount: 3, date: '2026-11-10' }] }
    expect(brazilTransfer(f, 3000, 1500, '2026-10-24')).toMatchObject({ card: 3000, recurring: 1003, transfer: 2510, by: '2026-10-31' })
    expect(brazilTransfer(f, 3000, 9000, '2026-10-24').transfer).toBe(0)
  })
  it('month helpers', () => {
    expect(nextMonthOf('2026-12-10')).toBe('2027-01')
    expect(lastDayOf('2026-02')).toBe('2026-02-28')
  })
})

import { sentToBrazil } from '../src/domain/forecast'
describe('sentToBrazil', () => {
  const r = (d: string, value: number, description: string, kind = 'transfer') => ({ booking_date: d, month: d.slice(0, 7), value, kind, description })
  it('finds this month\'s arrivals from abroad only', () => {
    expect(sentToBrazil([r('2026-10-03', 3000, 'OP REC EXT WISE'), r('2026-10-08', 500, 'RESGATE CDB'), r('2026-09-30', 900, 'OP REC EXT')], '2026-10'))
      .toEqual({ amount: 3000, date: '2026-10-03' })
    expect(sentToBrazil([r('2026-09-30', 900, 'OP REC EXT')], '2026-10')).toBeNull()
  })
})

describe('brazilCard', () => {
  const bill = (due_date: string, status: 'paga' | 'aberta', total = 1000) => ({ account_id: 'c', due_date, total, status })
  it('knows what is open and whether this month was paid', () => {
    const ids = new Set(['c'])
    expect(brazilCard([bill('2026-10-10', 'paga'), bill('2026-11-10', 'aberta', 700)], ids, '2026-10')).toEqual({ open: 700, paidThisMonth: true })
    expect(brazilCard([bill('2026-10-10', 'paga')], ids, '2026-10')).toEqual({ open: 0, paidThisMonth: true })
    expect(brazilCard([bill('2026-10-10', 'aberta', 500)], ids, '2026-10')).toEqual({ open: 500, paidThisMonth: false })
  })
})
