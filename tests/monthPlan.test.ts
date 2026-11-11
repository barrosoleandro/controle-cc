import { describe, expect, it } from 'vitest'
import { buildMonthPlan, detectPeriod, isDue, nextMonth, recurringExpectations, steadyIncomes, type PlanTx } from '../src/domain/monthPlan'

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

  it('a salary lower than the average is the whole month: nothing is added to reach the average', () => {
    const history = [salary('2026-07', 4000), salary('2026-08', 4000), salary('2026-09', 3000), salary('2026-10', 2900)]
    const rec = recurringExpectations(history, isRec(new Set(['ACME'])), avg)
    expect(buildMonthPlan(history, [], '2026-10', avg, rec).income[0]).toMatchObject({ realizado: 2900, falta: 0, previsto: 2900 })
  })

  it('expects a monthly income at its latest full month, passing over a month with only a small extra', () => {
    const history = [salary('2026-07', 4000), salary('2026-08', 4000), salary('2026-09', 3000)]
    const expected = (list: PlanTx[]) => recurringExpectations(list, isRec(new Set(['ACME'])), avg)[0].amount
    expect(expected(history)).toBe(3000)
    expect(expected([...history, salary('2026-10', 150)])).toBe(3000)
    expect(expected([...history, salary('2026-10', 3200)])).toBe(3200)
    // The month after still expects the salary, at that value, not at the average.
    expect(buildMonthPlan(history, [], '2026-11', avg, recurringExpectations(history, isRec(new Set(['ACME'])), avg)).income[0]).toMatchObject({ falta: 3000, previsto: 3000 })
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

describe('recorrentes com intervalo', () => {
  const avg = ['2026-08', '2026-09', '2026-10']
  const bill = (month: string, value = -120): PlanTx => ({ month, value, kind: 'expense', categoryName: 'Agua', merchant: 'AGUA', booking_date: `${month}-10` })
  const rent = (month: string): PlanTx => ({ month, value: -1000, kind: 'expense', categoryName: 'Moradia', merchant: 'ALUGUEL', booking_date: `${month}-05` })
  const history = [...['2026-02', '2026-04', '2026-06', '2026-08', '2026-10'].map((m) => bill(m)), ...['2026-08', '2026-09', '2026-10'].map(rent)]
  const all = () => true

  it('detecta o intervalo pela mediana dos espaços entre pagamentos', () => {
    expect(detectPeriod(['2026-02', '2026-04', '2026-06', '2026-08'])).toBe(2)
    expect(detectPeriod(['2026-01', '2026-02', '2026-04', '2026-05', '2026-06'])).toBe(1)
    expect(detectPeriod(['2026-10'])).toBe(1)
    expect(isDue({ period: 2, lastMonth: '2026-10' }, '2026-11')).toBe(false)
    expect(isDue({ period: 2, lastMonth: '2026-10' }, '2026-12')).toBe(true)
  })

  it('um bimestral só entra no mês em que vence, pelo valor cheio, e fica fora da média', () => {
    const rec = recurringExpectations(history, all, avg)
    expect(rec.find((e) => e.merchant === 'AGUA')).toMatchObject({ period: 2, lastMonth: '2026-10', amount: 120 })
    expect(rec.find((e) => e.merchant === 'ALUGUEL')).toMatchObject({ period: 1, amount: 1000 })
    const nov = buildMonthPlan(history, [], '2026-11', avg, rec)
    expect(nov.expense.find((r) => r.name === 'Agua')).toBeUndefined()
    const dec = buildMonthPlan(history, [], '2026-12', avg, rec)
    expect(dec.expense.find((r) => r.name === 'Agua')).toMatchObject({ media: 0, falta: 120, previsto: 120 })
    expect(dec.expense.find((r) => r.name === 'Moradia')).toMatchObject({ falta: 1000 })
  })

  it('na categoria, o bimestral soma ao que falta da média das outras despesas', () => {
    const txs = [...history, ...avg.map((m) => ({ ...bill(m, -60), merchant: 'MERCADINHO', booking_date: `${m}-15` })),
      { ...bill('2026-12', -20), merchant: 'MERCADINHO', booking_date: '2026-12-02' }]
    const rec = recurringExpectations(txs, (m) => m === 'AGUA', avg)
    const dec = buildMonthPlan(txs, [], '2026-12', avg, rec)
    expect(dec.expense.find((r) => r.name === 'Agua')).toMatchObject({ media: 60, realizado: 20, falta: 40 + 120 })
    const paid = buildMonthPlan([...txs, bill('2026-12', -130)], [], '2026-12', avg, rec)
    expect(paid.expense.find((r) => r.name === 'Agua')).toMatchObject({ realizado: 150, falta: 40, previsto: 190 })
  })

  it('o intervalo escolhido por você vale por cima do detectado, e um que parou sai', () => {
    const rec = recurringExpectations(history, all, avg, { AGUA: 1, ALUGUEL: 3 })
    expect(rec.find((e) => e.merchant === 'AGUA')).toMatchObject({ period: 1, periodSet: true })
    expect(rec.find((e) => e.merchant === 'ALUGUEL')).toMatchObject({ period: 3, periodSet: true })
    const old = ['2026-01', '2026-03', '2026-05'].map((m) => bill(m))
    expect(recurringExpectations(old, all, avg)).toEqual([])
  })
})

describe('a line that is not a category (the transfer that pays the bills abroad)', () => {
  it('adds to the expenses what was sent and what is still to send, and the result follows', async () => {
    const { withExpenseLine } = await import('../src/domain/monthPlan')
    const plan = buildMonthPlan(txs, [], '2026-10', avg)
    const mine = withExpenseLine(plan, 'Envio', 200, 500)
    expect(mine.expense.find((r) => r.name === 'Envio')).toMatchObject({ kind: 'expense', realizado: 200, falta: 500, previsto: 700, media: 0 })
    expect(mine.totals.expense.previsto).toBe(plan.totals.expense.previsto + 700)
    expect(mine.totals.expense.falta).toBe(plan.totals.expense.falta + 500)
    expect(mine.resultado).toBe(plan.resultado - 700)
    expect(mine.income).toBe(plan.income)
    expect(withExpenseLine(plan, 'Envio', 0, 0)).toBe(plan)
  })
})

describe('tithe: 10% of the salary of the month', () => {
  it('expects 10% of the salary previsto, less what was paid, and adds the row when there is none', async () => {
    const { shareOfSalary } = await import('../src/domain/monthPlan')
    const tithe = (month: string, value: number): PlanTx => ({ month, value, kind: 'expense', categoryName: 'Dízimo', booking_date: `${month}-28` })
    const history = [...avg.map((m) => salary(m, 3000)), ...avg.map((m) => tithe(m, -250)), salary('2026-10', 3200), tithe('2026-10', -100)]
    const plan = shareOfSalary(buildMonthPlan(history, [], '2026-10', avg), 'Salário', 'Dízimo', 0.1)
    expect(plan.expense.find((r) => r.name === 'Dízimo')).toMatchObject({ realizado: 100, falta: 220, previsto: 320 })
    expect(plan.totals.expense.previsto).toBe(320)
    expect(plan.resultado).toBe(3200 - 320)
    const fresh = shareOfSalary(buildMonthPlan([salary('2026-10', 3000)], [], '2026-10', avg), 'Salário', 'Dízimo', 0.1)
    expect(fresh.expense).toMatchObject([{ name: 'Dízimo', falta: 300, previsto: 300 }])
    const noSalary = buildMonthPlan([tithe('2026-10', -100)], [], '2026-10', avg)
    expect(shareOfSalary(noSalary, 'Salário', 'Dízimo', 0.1)).toBe(noSalary)
  })
})
