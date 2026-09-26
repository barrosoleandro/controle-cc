import { describe, expect, it } from 'vitest'
import { suggestRules, type LearnTx } from '../src/domain/learn'
import { ALOCACAO, projetar, reservaRecomendada, retornoRealCarteira } from '../src/domain/investments'
import type { BankMapEntry, Rule } from '../src/domain/types'

const NOMES: Record<string, string> = { c1: 'Padaria', c2: 'Mercado' }
const nameOf = (id: string) => NOMES[id]
const noRules: Rule[] = []
const noMap: BankMapEntry[] = []

const tx = (over: Partial<LearnTx> = {}): LearnTx => ({
  description: 'CB TEKEL PARIS FACT 120725',
  amount: -20,
  bankCategory: null,
  bankSubcategory: null,
  merchant: 'TEKEL PARIS',
  bank: 'BCP',
  categoryId: 'c1',
  categoryLocked: false,
  ...over,
})

describe('learning rules from history', () => {
  it('suggests a merchant rule when a hand-picked category disagrees with the rules', () => {
    const out = suggestRules([tx({ categoryLocked: true }), tx()], noRules, noMap, nameOf)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ pattern: 'TEKEL PARIS', categoryId: 'c1', categoryName: 'Padaria', support: 2, total: 2, locked: 1 })
    expect(out[0].confidence).toBe(1)
    expect(out[0].wouldFix).toBe(2) // ambas cairiam em "Outros" hoje
  })

  it('ignores merchants nobody categorized by hand', () => {
    expect(suggestRules([tx(), tx()], noRules, noMap, nameOf)).toEqual([])
  })

  it('learns without a hand-picked choice only when explicitly allowed', () => {
    const out = suggestRules([tx(), tx()], noRules, noMap, nameOf, { requireLocked: false })
    expect(out).toHaveLength(1)
    expect(out[0].locked).toBe(0)
  })

  it('skips a merchant that already has its own rule', () => {
    const rules: Rule[] = [{ pattern: 'TEKEL PARIS', category: 'Padaria', priority: 1 }]
    expect(suggestRules([tx({ categoryLocked: true }), tx()], rules, noMap, nameOf)).toEqual([])
  })

  it('skips a merchant whose history disagrees with itself', () => {
    const txs = [tx({ categoryLocked: true }), tx(), tx({ categoryId: 'c2' }), tx({ categoryId: 'c2' })]
    expect(suggestRules(txs, noRules, noMap, nameOf)).toEqual([]) // 2/4 = 50% < 75%
  })

  it('skips a merchant the current rules already get right', () => {
    // A regra casa por prefixo, então categorize() já devolve Padaria: nada a aprender.
    const rules: Rule[] = [{ pattern: 'TEKEL', category: 'Padaria', priority: 1 }]
    expect(suggestRules([tx({ categoryLocked: true }), tx()], rules, noMap, nameOf)).toEqual([])
  })

  it('ignores merchant keys too short to be a valid rule pattern', () => {
    expect(suggestRules([tx({ merchant: 'A', categoryLocked: true }), tx({ merchant: 'A' })], noRules, noMap, nameOf)).toEqual([])
  })

  it('ranks by how much the rule would fix', () => {
    const many = [
      ...Array.from({ length: 4 }, () => tx({ merchant: 'PICARD', categoryLocked: true })),
      tx({ categoryLocked: true }), tx(),
    ]
    const out = suggestRules(many, noRules, noMap, nameOf)
    expect(out.map((o) => o.pattern)).toEqual(['PICARD', 'TEKEL PARIS'])
  })
})

describe('investment scenarios', () => {
  it('emergency reserve is six months of expenses, never negative', () => {
    expect(reservaRecomendada(1000)).toBe(6000)
    expect(reservaRecomendada(1000, 3)).toBe(3000)
    expect(reservaRecomendada(-50)).toBe(0)
  })

  it('a zero real return grows only by what was contributed', () => {
    const p = projetar(100, 1, 0)
    expect(p.at(-1)).toMatchObject({ ano: 1, aportado: 1200, valor: 1200 })
  })

  it('a positive real return beats the contributions', () => {
    const p = projetar(100, 10, 5)
    expect(p.at(-1)!.aportado).toBe(12000)
    expect(p.at(-1)!.valor).toBeGreaterThan(12000)
  })

  it('counts the starting balance and every year of the horizon', () => {
    const p = projetar(0, 5, 0, 500)
    expect(p).toHaveLength(6) // ano 0 mais cinco anos
    expect(p.at(-1)).toMatchObject({ aportado: 500, valor: 500 })
  })

  it('a bolder profile carries a higher expected real return', () => {
    expect(retornoRealCarteira('arrojado')).toBeGreaterThan(retornoRealCarteira('moderado'))
    expect(retornoRealCarteira('moderado')).toBeGreaterThan(retornoRealCarteira('conservador'))
  })

  it('every profile allocates exactly 100%', () => {
    for (const [perfil, pesos] of Object.entries(ALOCACAO)) {
      const soma = Object.values(pesos).reduce((s, v) => s + v, 0)
      expect(soma, perfil).toBeCloseTo(1, 10)
    }
  })
})
