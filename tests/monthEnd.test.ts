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

  it('real + estimativa, e o saldo de hoje mais o que ainda falta', () => {
    const e = monthEnd(plan, 3000, 4800)
    expect(e.receitas).toEqual({ real: 5000, estimado: 0, total: 5000 })
    // Mercado: 200 real + 400 falta; Carro: 150 manual, still to come.
    expect(e.despesas).toEqual({ real: 200, estimado: 550, total: 750 })
    expect(e.resultado.total).toBe(4250)
    expect(e.saldoFim).toBe(3000 - 550)
    expect(e.saldoFimBanco).toBe(3000 - 550 + 4800)
  })

  it('a estimativa da IA troca só a falta das categorias que ela nomeou', () => {
    const e = monthEnd(plan, 3000, 0, new Map([['expense/Mercado', 250]]))
    expect(e.rows.find((r) => r.name === 'Mercado')).toMatchObject({ real: 200, app: 400, usado: 250 })
    expect(e.rows.find((r) => r.name === 'Carro')).toMatchObject({ app: 150, usado: 150 })
    expect(e.despesas.estimado).toBe(400)
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
