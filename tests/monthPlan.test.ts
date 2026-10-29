import { describe, expect, it } from 'vitest'
import { buildMonthPlan, nextMonth, recurringExpectations, type PlanTx } from '../src/domain/monthPlan'

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
