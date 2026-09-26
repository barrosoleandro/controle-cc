import { describe, expect, it } from 'vitest'
import { addMonthsIso, futureInstalments } from '../src/domain/cards'

describe('future instalments', () => {
  it('adds months keeping the day, clamped to the month end', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsIso('2025-11-11', 3)).toBe('2026-02-11')
  })

  it('projects the remaining parcelas of each purchase from its latest billed one', () => {
    const tx = (description: string, amount: number, statement_due: string) => ({ description, amount, statement_due })
    const bills = futureInstalments([
      tx('LOJA A (2/4)', -100, '2026-01-11'),
      tx('LOJA A (3/4)', -100, '2026-02-11'), // latest seen: 3/4 → only 4/4 left
      tx('LOJA B (1/3)', -50, '2026-02-11'),
      tx('LOJA C (5/5)', -30, '2026-02-11'), // finished
      tx('MERCADO', -80, '2026-02-11'), // not an instalment
      tx('ESTORNO (1/2)', 20, '2026-02-11'), // credit: ignored
    ], 3)
    expect(bills.map((b) => b.due)).toEqual(['2026-03-11', '2026-04-11', '2026-05-11'])
    expect(bills.map((b) => b.total)).toEqual([150, 50, 0])
    expect(bills[0].parcels.map((p) => `${p.purchase} ${p.k}/${p.n}`)).toEqual(['LOJA A 4/4', 'LOJA B 2/3'])
    expect(bills[1].parcels.map((p) => `${p.purchase} ${p.k}/${p.n}`)).toEqual(['LOJA B 3/3'])
  })
})

describe('bill debits', () => {
  it('match the paying-account debit to an imported bill total near the due date, once', async () => {
    const { matchBillDebits } = await import('../src/domain/cards')
    const accounts = [
      { id: 'card', type: 'card', parent_account_id: 'chk' },
      { id: 'chk', type: 'checking', parent_account_id: null },
    ] as never
    const bill = (due_date: string, total: number) => ({ account_id: 'card', due_date, total, status: 'paga' as const })
    const tx = (id: string, booking_date: string, amount: number) => ({ id, account_id: 'chk', booking_date, amount })
    const m = matchBillDebits(accounts, [bill('2026-09-11', 25996.24), bill('2026-02-11', 18890.24), bill('2026-03-11', -301.75)], [
      tx('a', '2026-09-10', -25996.24),
      tx('b', '2026-02-20', -18890.24), // 9 days after the due date: too late
      tx('c', '2026-02-09', -18890.24),
      tx('d', '2026-09-10', -100),
    ])
    expect(m.map((x) => x.bankTx.id)).toEqual(['c', 'a'])
  })
})
