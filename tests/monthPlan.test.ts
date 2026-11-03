import { describe, expect, it } from 'vitest'
import { buildMonthPlan, nextMonth, recurringExpectations, steadyIncomes, type PlanTx } from '../src/domain/monthPlan'

const tx = (month: string, categoryName: string, value: number, kind: PlanTx['kind'] = value < 0 ? 'expense' : 'income'): PlanTx => ({ month, value, kind, categoryName })
const AVG = ['2026-07', '2026-08', '2026-09']

describe('month plan', () => {
  it('falta = média − realizado − manual, nunca negativo', () => {
    const txs = [
      tx('2026-07', 'Mercado', -300), tx('2026-08', 'Mercado', -300), tx('2026-09', 'Mercado', -300),
      tx('2026-10', 'Mercado', -120),
      tx('2026-07', 'Salario', 6000), tx('2026-08', 'Salario', 6000), tx('2026-09', 'Salario', 6000),
      tx('2026-10', 'Lazer', -500), // sem média: só o realizado
      tx('2026-10', 'Transfer', -1000, 'transfer'),
    ]
    const p = buildMonthPlan(txs, [{ month: '2026-10', value: -100, kind: 'expense', categoryName: 'Mercado' }], '2026-10', AVG)
    const mercado = p.expense.find((r) => r.name === 'Mercado')!
    expect(mercado).toMatchObject({ media: 300, realizado: 120, manual: 100, falta: 80, previsto: 300 })
    expect(p.expense.find((r) => r.name === 'Lazer')).toMatchObject({ media: 0, realizado: 500, falta: 0, previsto: 500 })
    expect(p.income[0]).toMatchObject({ name: 'Salario', media: 6000, realizado: 0, falta: 6000 })
    expect(p.expense.some((r) => r.name === 'Transfer')).toBe(false)
    expect(p.totals.expense.previsto).toBe(800)
    expect(p.resultado).toBe(6000 - 800)
  })

  it('estorno reduz a despesa e linha manual acima da média zera o que falta', () => {
    const txs = [tx('2026-09', 'Viagem', -900), tx('2026-10', 'Viagem', 50, 'expense')]
    const p = buildMonthPlan(txs, [{ month: '2026-10', value: -400, kind: 'expense', categoryName: 'Viagem' }], '2026-10', AVG)
    expect(p.expense[0]).toMatchObject({ media: 300, realizado: -50, manual: 400, falta: 0, previsto: 350 })
  })

  it('recorrentes ainda não lançados entram como previstos, com no mínimo o valor deles', () => {
    const r = (month: string, merchant: string, value: number, day = '05'): PlanTx => ({ month, value, kind: 'expense', categoryName: 'Casa', merchant, booking_date: `${month}-${day}` })
    const txs = [
      r('2026-07', 'NETFLIX', -15), r('2026-08', 'NETFLIX', -15), r('2026-09', 'NETFLIX', -15),
      r('2026-08', 'ALUGUEL', -1000, '10'), r('2026-09', 'ALUGUEL', -1200, '10'),
      r('2026-10', 'NETFLIX', -15), // já cobrado em outubro
      r('2026-09', 'PADARIA', -30), // não é recorrente
    ]
    const exp = recurringExpectations(txs, (m) => m !== 'PADARIA', AVG)
    expect(exp.find((e) => e.merchant === 'ALUGUEL')).toMatchObject({ amount: 1100, day: 10, categoryName: 'Casa' })
    expect(exp.some((e) => e.merchant === 'PADARIA')).toBe(false)
    const out = buildMonthPlan(txs, [], '2026-10', AVG, exp).expense[0]
    // média da categoria (2260/3 ≈ 753) menos o realizado (15) fica abaixo do aluguel pendente (1100)
    expect(out.pendentes.map((e) => e.merchant)).toEqual(['ALUGUEL'])
    expect(out).toMatchObject({ realizado: 15, recorrente: 1100, falta: 1100, previsto: 1115 })
    // uma linha manual para o aluguel ocupa o lugar dele
    const withManual = buildMonthPlan(txs, [{ month: '2026-10', value: -1150, kind: 'expense', categoryName: 'Casa' }], '2026-10', AVG, exp).expense[0]
    expect(withManual.falta).toBe(0)
  })

  it('linhas manuais de outro mês não entram', () => {
    const p = buildMonthPlan([], [{ month: '2026-11', value: -100, kind: 'expense', categoryName: 'X' }], '2026-10', AVG)
    expect(p.expense).toEqual([])
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(nextMonth('2026-10')).toBe('2026-11')
  })
})


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

describe('money from or to outside', () => {
  it('a one-off resgate counts in its month but not in the average', async () => {
    const { EXTERNAL } = await import('../src/domain/audit')
    const txs = [tx('2026-08', EXTERNAL, 1000, 'income'), tx('2026-10', EXTERNAL, 1000, 'income')]
    const p = buildMonthPlan(txs, [], '2026-10', AVG)
    expect(p.income[0]).toMatchObject({ name: EXTERNAL, media: 0, realizado: 1000, previsto: 1000 })
  })
})

describe('recurring every two or three months', () => {
  it('detects the period from the gaps between months', async () => {
    const { recurrencePeriod } = await import('../src/domain/monthPlan')
    expect(recurrencePeriod(['2026-01', '2026-03', '2026-05'])).toBe(2)
    expect(recurrencePeriod(['2026-01', '2026-03', '2026-05', '2026-09'])).toBe(2) // one bill skipped
    expect(recurrencePeriod(['2026-01', '2026-04', '2026-07'])).toBe(3)
    expect(recurrencePeriod(['2025-11', '2026-01', '2026-03'])).toBe(2) // across New Year
    expect(recurrencePeriod(['2026-01', '2026-02', '2026-04'])).toBe(1) // came in two months in a row
    expect(recurrencePeriod(['2026-01', '2026-03'])).toBe(1) // too few to tell
    expect(recurrencePeriod(['2026-01', '2026-07', '2027-01'])).toBe(1) // half-yearly: not handled
  })

  const water = (month: string, value = -60): PlanTx => ({ month, value, kind: 'expense', categoryName: 'Casa', merchant: 'EAU', booking_date: `${month}-12` })
  const hist = [water('2026-03'), water('2026-05'), water('2026-07'), water('2026-09', -80)]
  const avg = ['2026-07', '2026-08', '2026-09']

  it('expects the full amount only in the months it is due', () => {
    const [e] = recurringExpectations(hist, () => true, avg)
    expect(e).toMatchObject({ merchant: 'EAU', period: 2, lastMonth: '2026-09', amount: 70, day: 12 })
    const pend = (month: string) => buildMonthPlan(hist, [], month, avg, [e]).expense[0]?.pendentes.map((p) => p.merchant) ?? []
    expect(pend('2026-10')).toEqual([])
    expect(pend('2026-11')).toEqual(['EAU'])
    expect(pend('2026-12')).toEqual([])
    expect(pend('2027-01')).toEqual(['EAU'])
  })

  it('a monthly one is still expected every month', () => {
    const rent = ['2026-06', '2026-07', '2026-08', '2026-09'].map((m): PlanTx => ({ month: m, value: -1000, kind: 'expense', categoryName: 'Moradia', merchant: 'ALUGUEL', booking_date: `${m}-10` }))
    const [e] = recurringExpectations(rent, () => true, avg)
    expect(e.period).toBe(1)
    expect(buildMonthPlan(rent, [], '2026-10', avg, [e]).expense[0].pendentes).toHaveLength(1)
  })
})
