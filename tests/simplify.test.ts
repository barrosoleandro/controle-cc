import { describe, expect, it } from 'vitest'
import { planMerges, purchaseDate, SIMPLIFICATION } from '../src/domain/simplify'
import type { Category } from '../src/domain/types'

const cat = (name: string, kind: Category['kind'] = 'expense'): Category => ({ id: `id-${name}`, name, kind, color: '#888', sort: 0 } as Category)

describe('category simplification', () => {
  it('keeps an existing target, renames the first source when the target is new, and skips no-ops', () => {
    const cats = [cat('Mercado'), cat('Picard'), cat('Aluguel'), cat('Engie'), cat('Dizimo'), cat('Salario', 'income')]
    const steps = planMerges(cats)
    const mercado = steps.find((s) => s.target === 'Mercado')!
    expect(mercado.keep?.name).toBe('Mercado')
    expect(mercado.absorb.map((c) => c.name)).toEqual(['Picard'])
    const moradia = steps.find((s) => s.target === 'Moradia')!
    expect(moradia.keep?.name).toBe('Aluguel') // renamed, keeps its id and rules
    expect(moradia.absorb.map((c) => c.name)).toEqual(['Engie'])
    expect(steps.find((s) => s.target === 'Doações e dízimo')?.absorb).toEqual([]) // rename only
    expect(steps.some((s) => s.target === 'Salario')).toBe(false) // nothing to do
  })

  it('matches names without accents or case', () => {
    const steps = planMerges([cat('saude'), cat('Dentista')], [{ target: 'Saúde e bem-estar', kind: 'expense', sources: ['Saúde', 'Dentista'] }])
    expect(steps[0].keep?.name).toBe('saude')
    expect(steps[0].absorb.map((c) => c.name)).toEqual(['Dentista'])
  })

  it('never merges the names the code relies on into something else', () => {
    const sources = SIMPLIFICATION.flatMap((g) => g.sources.filter((s) => s !== g.target))
    for (const fixed of ['Transfer', 'Cartão Itaú', 'Imóvel Brasil', 'Outras receitas', 'Business Trips', 'Reembolso']) expect(sources).not.toContain(fixed)
  })
})

describe('purchase date', () => {
  it('reads the card date from the description', () => {
    expect(purchaseDate('CB IN SITU HOTEL FACT 230626', '2026-06-26')).toBe('2026-06-23')
    expect(purchaseDate('PRLV FREE MOBILE', '2026-06-24')).toBe('2026-06-24')
  })
})
