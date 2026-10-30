import { describe, expect, it } from 'vitest'
import { buildMonthPlan, recurringExpectations, steadyIncomes, type PlanTx } from './monthPlan'

const avg = ['2026-07', '2026-08', '2026-09']
const salary = (month: string, value = 3000): PlanTx => ({ month, value, kind: 'income', categoryName: 'Salário', merchant: 'ACME', booking_date: `${month}-05` })
const rent = (month: string): PlanTx => ({ month, value: -1000, kind: 'expense', categoryName: 'Moradia', merchant: 'ALUGUEL', booking_date: `${month}-10` })
const txs = [...avg.map((m) => salary(m)), ...avg.map(rent), { month: '2026-08', value: 200, kind: 'income' as const, categoryName: 'Outros', merchant: 'REEMBOLSO', booking_date: '2026-08-12' }]
const isRec = (s: Set<string>) => (m: string, kind: 'income' | 'expense') => (kind === 'income' ? s.has(m) : m === 'ALUGUEL')

describe('recurring lines in the month plan', () => {
  it('treats an income present in every average month as recurring, a one-off one not', () => {
    expect([...steadyIncomes(txs, avg)]).toEqual(['ACME'])
  })

  it('repeats salary and rent in the next month as expected lines', () => {
    const rec = recurringExpectations(txs, isRec(steadyIncomes(txs, avg)), avg)
    const plan = buildMonthPlan(txs, [], '2026-11', avg, rec)
    expect(plan.income.find((r) => r.name === 'Salário')?.pendentes).toMatchObject([{ merchant: 'ACME', kind: 'income', amount: 3000, day: 5 }])
    expect(plan.expense.find((r) => r.name === 'Moradia')?.pendentes).toMatchObject([{ merchant: 'ALUGUEL', amount: 1000 }])
  })

  it('a manual line of the same merchant replaces the expected one', () => {
    const rec = recurringExpectations(txs, isRec(steadyIncomes(txs, avg)), avg)
    const plan = buildMonthPlan(txs, [{ month: '2026-11', value: 3500, kind: 'income', categoryName: 'Salário', merchant: 'ACME' }], '2026-11', avg, rec)
    const row = plan.income.find((r) => r.name === 'Salário')!
    expect(row.pendentes).toEqual([])
    expect(row.previsto).toBe(3500)
  })

  it('drops the expected line once the real one is imported', () => {
    const rec = recurringExpectations(txs, isRec(steadyIncomes(txs, avg)), avg)
    const plan = buildMonthPlan([...txs, salary('2026-10', 3100)], [], '2026-10', avg, rec)
    expect(plan.income.find((r) => r.name === 'Salário')).toMatchObject({ pendentes: [], realizado: 3100, previsto: 3100 })
  })
})
