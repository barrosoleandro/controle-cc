import { describe, expect, it } from 'vitest'
import { buildMonthPlan, type PlanTx } from '../src/domain/monthPlan'
import { monthEnd, shiftSalary } from '../src/domain/monthEnd'
import { monthEndPrompt, parseMonthEndAnswer, type MonthEndFacts } from '../src/domain/localAi'

const tx = (month: string, categoryName: string, value: number): PlanTx => ({ month, value, kind: value < 0 ? 'expense' : 'income', categoryName })
const AVG = ['2026-08', '2026-09', '2026-10']

describe('month end', () => {
  const txs = [
    ...AVG.flatMap((m) => [tx(m, 'Mercado', -600), tx(m, 'Salario', 5000)]),
    tx('2026-11', 'Mercado', -200), tx('2026-11', 'Salario', 5000),
  ]
  const plan = buildMonthPlan(txs, [{ month: '2026-11', value: -150, kind: 'expense', categoryName: 'Carro' }], '2026-11', AVG)

  it('real + estimativa, e o saldo de hoje mais o que ainda falta, sem o salário do mês seguinte', () => {
    const e = monthEnd(plan, 3000, 4800)
    expect(e.receitas).toEqual({ real: 5000, estimado: 0, total: 5000 })
    // Mercado: 200 real + 400 falta; Carro: 150 manual, still to come.
    expect(e.despesas).toEqual({ real: 200, estimado: 550, total: 750 })
    expect(e.resultado.total).toBe(4250)
    expect(e.saldoHoje).toBe(3000)
    expect(e.saldoFim).toBe(3000 - 4800 - 550)
    expect(monthEnd(plan, 3000).saldoFim).toBe(3000 - 550)
  })

  it('a estimativa da IA troca só a falta das categorias que ela nomeou', () => {
    const e = monthEnd(plan, 3000, 0, new Map([['expense/Mercado', 250]]))
    expect(e.rows.find((r) => r.name === 'Mercado')).toMatchObject({ real: 200, app: 400, usado: 250 })
    expect(e.rows.find((r) => r.name === 'Carro')).toMatchObject({ app: 150, usado: 150 })
    expect(e.despesas.estimado).toBe(400)
  })

  it('o planejado por você vale por cima da estimativa da IA e do app', () => {
    const e = monthEnd(plan, 3000, 0, new Map([['expense/Mercado', 250]]), new Map([['expense/Mercado', 100], ['expense/Carro', 0]]))
    expect(e.rows.find((r) => r.name === 'Mercado')).toMatchObject({ usado: 100, ajustado: true })
    expect(e.rows.find((r) => r.name === 'Carro')).toMatchObject({ app: 150, usado: 0, ajustado: true })
    expect(e.despesas.estimado).toBe(100)
  })

  it('salário creditado a partir do dia 20 conta no mês seguinte', () => {
    const s = shiftSalary([
      { kind: 'income', categoryName: 'Salario', booking_date: '2026-10-28', month: '2026-10' },
      { kind: 'income', categoryName: 'Salario', booking_date: '2026-10-05', month: '2026-10' },
      { kind: 'income', categoryName: 'Outros', booking_date: '2026-10-28', month: '2026-10' },
    ], 'Salario')
    expect(s.map((t) => t.month)).toEqual(['2026-11', '2026-10', '2026-10'])
  })
})

describe('month end, local model', () => {
  const asked: MonthEndFacts['categorias'] = [
    { tipo: 'despesa', nome: 'Mercado', media: 600, realizado: 200, manual: 0, recorrentesPendentes: 0, estimativaApp: 400 },
    { tipo: 'receita', nome: 'Salario', media: 5000, realizado: 5000, manual: 0, recorrentesPendentes: 0, estimativaApp: 0 },
  ]

  it('o prompt leva as categorias e pede JSON', () => {
    const { prompt } = monthEndPrompt({ moeda: 'EUR', mes: 'novembro 2026', dia: 7, diasNoMes: 30, mediaDe: 'agosto 2026', mediaAte: 'outubro 2026', categorias: asked })
    expect(prompt).toContain('despesa | Mercado | 600,00 | 200,00')
    expect(prompt).toContain('Hoje é dia 7 de 30')
    expect(prompt).toMatch(/somente com JSON/)
  })

  it('aceita só categorias pedidas, valores razoáveis, e tolera texto em volta', () => {
    const r = parseMonthEndAnswer('Claro! {"categorias":[{"tipo":"despesa","nome":"mercado","falta":"310,5"},{"tipo":"despesa","nome":"Viagem","falta":900},{"tipo":"receita","nome":"Salario","falta":-1}],"comentario":"Ritmo abaixo da média."} fim', asked)
    expect([...r.falta]).toEqual([['expense/Mercado', 310.5]])
    expect(r.ignoradas).toEqual(['Salario'])
    expect(r.comentario).toBe('Ritmo abaixo da média.')
  })

  it('descarta valor absurdo e recusa resposta sem nada utilizável', () => {
    expect(() => parseMonthEndAnswer('{"categorias":[{"tipo":"despesa","nome":"Mercado","falta":99999}]}', asked)).toThrow(/nenhum valor/)
    expect(() => parseMonthEndAnswer('não sei', asked)).toThrow(/JSON/)
  })
})

describe('falta typed by the user', () => {
  const avg = ['2026-08', '2026-09', '2026-10']
  const txs: PlanTx[] = [
    ...avg.map((month): PlanTx => ({ month, value: -900, kind: 'expense', categoryName: 'Mercado' })),
    ...avg.map((month): PlanTx => ({ month, value: 3000, kind: 'income', categoryName: 'Salário' })),
    { month: '2026-11', value: -300, kind: 'expense', categoryName: 'Mercado' },
  ]
  it('replaces the app figure in its category and the totals follow', async () => {
    const { applyPlanned } = await import('../src/domain/monthEnd')
    const plan = buildMonthPlan(txs, [], '2026-11', avg)
    expect(plan.expense[0]).toMatchObject({ name: 'Mercado', falta: 600, previsto: 900 })
    const mine = applyPlanned(plan, new Map([['expense/Mercado', 200]]))
    expect(mine.expense[0]).toMatchObject({ falta: 200, previsto: 500, faltaApp: 600 })
    expect(mine.totals.expense).toMatchObject({ falta: 200, previsto: 500 })
    expect(mine.resultado).toBe(plan.resultado + 400)
    expect(mine.income).toEqual(plan.income)
    expect(applyPlanned(plan, new Map())).toBe(plan)
  })
  it('a manual line of the category is taken off the typed value', async () => {
    const { applyPlanned } = await import('../src/domain/monthEnd')
    const plan = buildMonthPlan(txs, [{ month: '2026-11', value: -150, kind: 'expense', categoryName: 'Mercado' }], '2026-11', avg)
    expect(applyPlanned(plan, new Map([['expense/Mercado', 200]])).expense[0]).toMatchObject({ manual: 150, falta: 50, previsto: 500 })
  })
})

describe('salary paid ahead', () => {
  it('is the next month salary already credited this month, and nothing else', async () => {
    const { salaryAhead } = await import('../src/domain/monthEnd')
    const rows = shiftSalary([
      { kind: 'income', categoryName: 'Salário', booking_date: '2026-10-28', month: '2026-10', value: 3000 },
      { kind: 'income', categoryName: 'Salário', booking_date: '2026-11-27', month: '2026-11', value: 3100 },
      { kind: 'income', categoryName: 'Salário', booking_date: '2026-11-05', month: '2026-11', value: 50 },
      { kind: 'income', categoryName: 'Outros', booking_date: '2026-11-28', month: '2026-11', value: 70 },
    ], 'Salário')
    expect(salaryAhead(rows, 'Salário', '2026-11')).toBe(3100)
    expect(salaryAhead(rows, undefined, '2026-11')).toBe(0)
  })
})
