import { describe, expect, it } from 'vitest'
import { buildMonthPlan, type PlanTx } from '../src/domain/monthPlan'
import { boundEstimate, combineMonthEnd, monthEndFacts, type MonthEndCat } from '../src/domain/monthEnd'
import { monthEndPrompt, parseMonthEndAnswer } from '../src/domain/localAi'

const t = (month: string, value: number, categoryName: string, kind: PlanTx['kind'] = value >= 0 ? 'income' : 'expense'): PlanTx => ({ month, value, kind, categoryName })
const hist = ['2026-08', '2026-09', '2026-10']
const txs: PlanTx[] = [
  t('2026-08', 3000, 'Salário'), t('2026-09', 3000, 'Salário'), t('2026-10', 3000, 'Salário'),
  t('2026-08', -300, 'Mercado'), t('2026-09', -300, 'Mercado'), t('2026-10', -300, 'Mercado'),
  t('2026-11', -100, 'Mercado'),
  t('2026-10', -500, 'Contas', 'transfer'), // transfers never count
]

describe('monthEnd', () => {
  const plan = buildMonthPlan(txs, [], '2026-11', hist)
  const cats = monthEndFacts(plan, txs, hist)

  it('builds the history per category, oldest first', () => {
    const m = cats.find((c) => c.key === 'expense/Mercado')!
    expect(m).toMatchObject({ history: [300, 300, 300], realizado: 100, base: 300 })
    expect(cats.some((c) => c.name === 'Contas')).toBe(false)
  })

  it('falls back to the average without the model', () => {
    const e = combineMonthEnd(cats, null)
    expect(e).toMatchObject({ income: 3000, expense: 300, resultado: 2700, realResultado: -100, remaining: 2800, usedAi: false })
  })

  it('uses the model inside bounds', () => {
    const e = combineMonthEnd(cats, new Map([['expense/Mercado', 350], ['income/Salário', 99999]]))
    expect(e.rows.find((r) => r.key === 'expense/Mercado')).toMatchObject({ previsto: 350, source: 'ia' })
    expect(e.rows.find((r) => r.key === 'income/Salário')!.previsto).toBe(4500) // capped at 1.5× the largest
    expect(e.usedAi).toBe(true)
  })

  it('never goes below what is real plus known', () => {
    const c: MonthEndCat = { key: 'expense/X', name: 'X', kind: 'expense', history: [50], realizado: 80, known: 20, base: 100 }
    expect(boundEstimate(c, 10)).toEqual({ previsto: 100, source: 'ia' })
    expect(boundEstimate(c, -1)).toEqual({ previsto: 100, source: 'media' })
    expect(boundEstimate(c, Number.NaN).source).toBe('media')
  })

  it('parses the answer tolerantly and drops unknown keys', () => {
    const keys = cats.map((c) => c.key)
    const m = parseMonthEndAnswer('```json\n{"estimativas":[{"chave":"expense/Mercado","total":"320,5"},{"chave":"expense/Inventada","total":9}]}\n```', keys)
    expect([...m]).toEqual([['expense/Mercado', 320.5]])
    expect(() => parseMonthEndAnswer('não sei', keys)).toThrow()
    expect(() => parseMonthEndAnswer('{"estimativas":[]}', keys)).toThrow()
  })

  it('prompt carries every key', () => {
    const p = monthEndPrompt({ moeda: 'EUR', mes: '2026-11', dia: 7, diasNoMes: 30, meses: hist, categorias: cats })
    for (const c of cats) expect(p.prompt).toContain(c.key)
  })
})
